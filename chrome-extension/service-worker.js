const COLLECTOR_URL = "http://127.0.0.1:8799/ingest";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzwda-czjme7PVG1CBkUH9OiIkI7Bi_Djks2eSY2_X1ZnAEjcjfvutvgNz50PJap6hG/exec";
const APPS_SCRIPT_TOKEN = "ec920266c4d443c162ff2dfad1ee322dbdbf5323279c3118";
const DEBUGGER_VERSION = "1.3";
const MAX_BODY_CHARS = 300000;
const REFRESH_INTERVAL_MINUTES = 10;
const REMOTE_BATCH_MAX_RECORDS = 25;
const REMOTE_BATCH_MAX_BYTES = 450000;

const attachedTabs = new Set();
const requestState = new Map();
const remoteBuffers = new Map();
let remoteFlushTimer = null;

ensureAlarms();

const INCLUDE_URL = [
  /ads\.tiktok\.com\/api\/oec\//i,
  /ads\.tiktok\.com\/api\/v\d+\/oec\//i,
  /ads\.tiktok\.com\/api\/oec_shopping\/v1\//i,
  /ads\.tiktok\.com\/api\/shopping\/v1\/gmv_max/i,
  /ads\.tiktok\.com\/api\/.+(?:gmv|max|campaign|adgroup|material|creative|asset|video|rank|bid|recommend|diagnos|delivery|traffic|auction|stat|report|estimate|predict)/i,
  /ads\.tiktok\.com\/api\/v\d+\/i18n\/shark\/event/i,
  /mcs-[^/]+\.tiktokv\.com\/(?:v1\/)?list/i,
  /mon\.tiktokv\.com\/monitor/i,
  /libraweb-[^/]+\.tiktok\.com\/service\/2\/abtest_config/i
];

const SECRET_KEYS = [
  "cookie",
  "authorization",
  "x-bogus",
  "x-gnarly",
  "x-secsdk-csrf-token",
  "x-tt-passport-csrf-token",
  "msToken",
  "sessionid",
  "sid_guard",
  "passport_csrf_token"
];

chrome.runtime.onInstalled.addListener(() => {
  void attachToExistingTabs();
  ensureAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  void attachToExistingTabs();
  ensureAlarms();
});

function ensureAlarms() {
  chrome.alarms.create("gmvmax-heartbeat", { periodInMinutes: 1 });
  chrome.alarms.create("gmvmax-refresh-tabs", { periodInMinutes: REFRESH_INTERVAL_MINUTES });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "gmvmax-page-seen") {
    void maybeAttach(sender.tab?.id, sender.tab?.url || message.url || "");
  } else if (message?.type === "gmvmax-page-snapshot") {
    void postEvent({
      ...(message.snapshot || {}),
      tabId: sender.tab?.id,
      pageUrl: sanitizeUrl(sender.tab?.url || message.snapshot?.url || "")
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gmvmax-heartbeat") void attachToExistingTabs();
  if (alarm.name === "gmvmax-refresh-tabs") void refreshTargetTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || tab.url) void maybeAttach(tabId, tab.url || "");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  for (const key of requestState.keys()) {
    if (key.startsWith(`${tabId}:`)) requestState.delete(key);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId || !attachedTabs.has(source.tabId)) return;
  if (method === "Network.requestWillBeSent") {
    onRequest(source.tabId, params);
  } else if (method === "Network.responseReceived") {
    onResponse(source.tabId, params);
  } else if (method === "Network.loadingFinished") {
    void onFinished(source.tabId, params);
  } else if (method === "Network.loadingFailed") {
    onFailed(source.tabId, params);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

async function attachToExistingTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://ads.tiktok.com/*"] });
  await Promise.all(tabs.map((tab) => maybeAttach(tab.id, tab.url || "")));
}

async function refreshTargetTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://ads.tiktok.com/*"] });
  for (const tab of tabs) {
    if (!tab.id || !isTargetPage(tab.url || "")) continue;
    await postEvent({
      kind: "extension_refresh",
      tabId: tab.id,
      pageUrl: sanitizeUrl(tab.url || ""),
      timestamp: new Date().toISOString()
    });
    chrome.tabs.reload(tab.id, { bypassCache: true }).catch(() => {});
  }
}

async function maybeAttach(tabId, url) {
  if (!tabId || attachedTabs.has(tabId) || !isTargetPage(url)) return;
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    attachedTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: 100000000,
      maxResourceBufferSize: 50000000,
      maxPostDataSize: MAX_BODY_CHARS
    });
    await postEvent({
      kind: "extension_attached",
      tabId,
      pageUrl: sanitizeUrl(url),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await postEvent({
      kind: "extension_attach_error",
      tabId,
      pageUrl: sanitizeUrl(url),
      error: String(error?.message || error),
      timestamp: new Date().toISOString()
    });
  }
}

function isTargetPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "ads.tiktok.com" &&
      /gmv-max|campaign|adgroup|material|creative|asset|video/i.test(`${parsed.pathname} ${parsed.search}`);
  } catch {
    return false;
  }
}

function shouldCapture(url) {
  return INCLUDE_URL.some((pattern) => pattern.test(url));
}

function keyFor(tabId, requestId) {
  return `${tabId}:${requestId}`;
}

function onRequest(tabId, params) {
  const url = params.request?.url || "";
  if (!shouldCapture(url)) return;
  const key = keyFor(tabId, params.requestId);
  requestState.set(key, {
    tabId,
    requestId: params.requestId,
    timestamp: new Date().toISOString(),
    type: params.type,
    method: params.request?.method,
    url,
    requestHeaders: sanitizeHeaders(params.request?.headers || {}),
    requestPostData: truncateBody(params.request?.postData || null),
    initiator: params.initiator?.type || null
  });
}

function onResponse(tabId, params) {
  const key = keyFor(tabId, params.requestId);
  const existing = requestState.get(key);
  if (!existing) return;
  existing.status = params.response?.status;
  existing.mimeType = params.response?.mimeType;
  existing.responseHeaders = sanitizeHeaders(params.response?.headers || {});
}

async function onFinished(tabId, params) {
  const key = keyFor(tabId, params.requestId);
  const entry = requestState.get(key);
  if (!entry) return;
  requestState.delete(key);

  let responseBody = null;
  let responseBase64Encoded = false;
  try {
    const body = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", {
      requestId: params.requestId
    });
    responseBody = truncateBody(body?.body || null);
    responseBase64Encoded = Boolean(body?.base64Encoded);
  } catch (error) {
    entry.responseBodyError = String(error?.message || error);
  }

  await postEvent({
    kind: "network_exchange",
    ...entry,
    encodedDataLength: params.encodedDataLength,
    responseBase64Encoded,
    responseBody,
    url: sanitizeUrl(entry.url),
    timestampFinished: new Date().toISOString()
  });
}

function onFailed(tabId, params) {
  const key = keyFor(tabId, params.requestId);
  const entry = requestState.get(key);
  if (!entry) return;
  requestState.delete(key);
  void postEvent({
    kind: "network_failed",
    ...entry,
    url: sanitizeUrl(entry.url),
    errorText: params.errorText,
    timestampFinished: new Date().toISOString()
  });
}

async function postEvent(payload) {
  enqueueRemoteEvent(payload);
  try {
    await fetch(COLLECTOR_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    // Collector may not be running yet; keep monitoring without interrupting the page.
  }
}

function enqueueRemoteEvent(payload) {
  const stream = streamForEvent(payload);
  const line = `${JSON.stringify(sanitizeForRemote(stream, payload))}\n`;
  const buffer = remoteBuffers.get(stream) || { lines: [], bytes: 0 };
  buffer.lines.push(line);
  buffer.bytes += byteLength(line);
  remoteBuffers.set(stream, buffer);
  if (buffer.lines.length >= REMOTE_BATCH_MAX_RECORDS || buffer.bytes >= REMOTE_BATCH_MAX_BYTES) {
    void flushRemoteStream(stream);
    return;
  }
  scheduleRemoteFlush();
}

function scheduleRemoteFlush() {
  if (remoteFlushTimer) return;
  remoteFlushTimer = setTimeout(() => {
    remoteFlushTimer = null;
    void flushRemoteBuffers();
  }, 10000);
}

async function flushRemoteBuffers() {
  await Promise.all([...remoteBuffers.keys()].map((stream) => flushRemoteStream(stream)));
}

async function flushRemoteStream(stream) {
  const buffer = remoteBuffers.get(stream);
  if (!buffer || buffer.lines.length === 0) return;
  remoteBuffers.delete(stream);
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gmvmax-token": APPS_SCRIPT_TOKEN
      },
      body: JSON.stringify({
        token: APPS_SCRIPT_TOKEN,
        sentAt: new Date().toISOString(),
        source: "chrome-extension",
        stream,
        format: "jsonl",
        lineCount: buffer.lines.length,
        content: buffer.lines.join("")
      })
    });
  } catch {
    // Keep browser monitoring passive; remote failures must not interrupt TikTok pages.
  }
}

function streamForEvent(payload) {
  if (payload?.kind === "page_snapshot") return isMaterialEvidenceEvent(payload) ? "material-page-snapshots" : "gmvmax-page-snapshots";
  if (payload?.kind === "network_exchange") return isMaterialEvidenceEvent(payload) ? "material-network-exchanges" : "gmvmax-network-exchanges";
  if (/material|creative|asset|video/i.test(`${payload?.pageUrl || ""} ${payload?.url || ""}`)) return "material-network";
  return "gmvmax-network";
}

function sanitizeForRemote(stream, payload = {}) {
  if (/network|exchange/i.test(stream)) return sanitizeNetworkRecord(payload);
  return redactValue(payload);
}

function sanitizeNetworkRecord(payload) {
  return {
    kind: payload.kind,
    timestamp: payload.timestamp,
    timestampFinished: payload.timestampFinished,
    source: "chrome-extension",
    tabId: payload.tabId,
    endpointKey: endpointKey(payload.url || payload.pageUrl),
    endpointFamily: endpointFamily(payload.url || payload.pageUrl),
    method: payload.method,
    status: payload.status,
    type: payload.type,
    mimeType: payload.mimeType,
    initiator: payload.initiator,
    encodedDataLength: payload.encodedDataLength,
    responseBase64Encoded: payload.responseBase64Encoded,
    responseBodyError: payload.responseBodyError,
    errorText: payload.errorText,
    urlPath: endpointKey(payload.url),
    pageUrlPath: endpointKey(payload.pageUrl),
    requestBodyKeyPaths: extractJsonKeyPaths(payload.requestPostData),
    responseBodyKeyPaths: extractJsonKeyPaths(payload.responseBody),
    requestBodyKeys: extractJsonKeys(payload.requestPostData),
    responseBodyKeys: extractJsonKeys(payload.responseBody),
    requestBodyBytes: payload.requestPostData ? byteLength(payload.requestPostData) : undefined,
    responseBodyBytes: payload.responseBody ? byteLength(payload.responseBody) : undefined
  };
}

function redactValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (depth > 8) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? "[redacted]" : redactValue(child, depth + 1);
  }
  return output;
}

function redactString(value) {
  return String(value || "")
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^&\s",}]+/gi, "$1[redacted]")
    .replace(/(cookie\s*[:=]\s*)[^"\n\r}]+/gi, "$1[redacted]");
}

function endpointKey(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "unknown";
  }
}

function endpointFamily(rawUrl) {
  const key = endpointKey(rawUrl);
  if (key.includes("/oec/stat/post_campaign_list")) return "campaign_list";
  if (/campaign|adgroup|ad_plan/.test(key)) return "campaign_control";
  if (/creative|material|asset|video/.test(key)) return "creative_material";
  if (/recommend|diagnos|suggest/.test(key)) return "recommendation";
  if (/bid|auction|rank|delivery|traffic/.test(key)) return "delivery_signal";
  if (key.includes("/gmv_max/shops")) return "shop_context";
  if (key.includes("/shop_allow_list")) return "feature_allow_list";
  if (key.includes("/waiver_status")) return "commission_waiver";
  if (key.includes("/get_platform_promotion_days")) return "promotion_days";
  if (key.includes("/shark/event")) return "ads_event";
  if (key.includes("mcs-") && key.endsWith("/list")) return "analytics_event";
  if (key.includes("monitor")) return "browser_monitoring";
  return "other";
}

function isMaterialEvidenceEvent(payload = {}) {
  const text = [
    payload.endpointFamily,
    endpointFamily(payload.url || payload.pageUrl || ""),
    payload.url,
    payload.pageUrl,
    payload.title,
    payload.reason,
    ...(payload.visibleSignals || [])
  ].join(" ");
  return /creative_material|delivery_signal|recommendation|material|素材|creative|创意|asset|video|视频|rank|排序|bid|出价|diagnos|诊断/i.test(text);
}

function extractJsonKeys(text) {
  const parsed = parseJson(text);
  if (!parsed) return [];
  const keys = new Set();
  collectKeys(parsed, keys, 0);
  return [...keys].slice(0, 200);
}

function extractJsonKeyPaths(text) {
  const parsed = parseJson(text);
  if (!parsed) return [];
  const paths = new Set();
  collectKeyPaths(parsed, paths, "$", 0);
  return [...paths].slice(0, 300);
}

function parseJson(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectKeys(value, keys, depth) {
  if (depth > 4 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item) => collectKeys(item, keys, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys, depth + 1);
  }
}

function collectKeyPaths(value, paths, prefix, depth) {
  if (depth > 5 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 0) collectKeyPaths(value[0], paths, `${prefix}[]`, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const pathKey = `${prefix}.${key}`;
    paths.add(pathKey);
    collectKeyPaths(child, paths, pathKey, depth + 1);
  }
}

function byteLength(value) {
  return new Blob([String(value || "")]).size;
}

function sanitizeHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = isSecretKey(key) ? "[redacted]" : String(value);
  }
  return output;
}

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretKey(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function isSecretKey(key) {
  const lower = String(key || "").toLowerCase();
  return SECRET_KEYS.some((secret) => lower.includes(secret.toLowerCase()));
}

function truncateBody(body) {
  if (body == null) return null;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}...[truncated ${text.length - MAX_BODY_CHARS} chars]`;
}
