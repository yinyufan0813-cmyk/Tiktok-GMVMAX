const DEFAULT_BATCH_MAX_RECORDS = 50;
const DEFAULT_BATCH_MAX_BYTES = 900_000;
const REDACTED = "[redacted]";
const MAX_REMOTE_STRING_LENGTH = 200_000;
const SECRET_KEY_PATTERN = /cookie|authorization|csrf|token|secret|session|passport|sid|x-bogus|x-gnarly|mstoken|msToken/i;
const NETWORK_STREAM_PATTERN = /(^|-)network($|-)|exchange/i;
const warnedMissingUrlModes = new Set();

export function remoteStorageConfig(config = {}) {
  const storage = config.storage || {};
  const appsScript = storage.appsScript || {};
  const mode = process.env.GMVMAX_STORAGE_MODE || storage.mode || "local";
  return {
    enabled: mode === "appsScript",
    mode,
    localPersistence: process.env.GMVMAX_LOCAL_PERSISTENCE
      ? process.env.GMVMAX_LOCAL_PERSISTENCE !== "0"
      : storage.localPersistence !== false,
    strict: process.env.GMVMAX_REMOTE_STRICT
      ? process.env.GMVMAX_REMOTE_STRICT === "1"
      : Boolean(storage.strict),
    webAppUrl: process.env.GMVMAX_APPS_SCRIPT_URL || appsScript.webAppUrl || appsScript.url || "",
    token: process.env.GMVMAX_APPS_SCRIPT_TOKEN || appsScript.token || appsScript.secret || "",
    batchMaxRecords: Number(process.env.GMVMAX_APPS_SCRIPT_BATCH_RECORDS || appsScript.batchMaxRecords || DEFAULT_BATCH_MAX_RECORDS),
    batchMaxBytes: Number(process.env.GMVMAX_APPS_SCRIPT_BATCH_BYTES || appsScript.batchMaxBytes || DEFAULT_BATCH_MAX_BYTES)
  };
}

export function shouldWriteLocalFiles(config = {}) {
  const storage = remoteStorageConfig(config);
  if (storage.mode === "local") return true;
  if (storage.enabled && !storage.webAppUrl) return true;
  return storage.localPersistence;
}

export function createAppsScriptSink(config = {}, options = {}) {
  const storage = remoteStorageConfig(config);
  if (!storage.enabled) return null;
  if (!storage.webAppUrl && storage.strict) {
    throw new Error("Apps Script storage is enabled, but storage.appsScript.webAppUrl / GMVMAX_APPS_SCRIPT_URL is not configured.");
  }
  if (!storage.webAppUrl) {
    warnOnce("missing-apps-script-url", "[GMVMAX] Apps Script storage requested, but no Web App URL is configured. Falling back to local capture buffer.");
    return null;
  }
  return new AppsScriptSink(storage, options);
}

export async function appendAppsScriptJsonl(config = {}, stream, value, options = {}) {
  const sink = createAppsScriptSink(config, options);
  if (!sink) return false;
  await sink.appendJsonl(stream, value);
  await sink.flush();
  return true;
}

class AppsScriptSink {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.source = options.source || "gmvmax";
    this.buffers = new Map();
  }

  async appendJsonl(stream, value) {
    this.assertConfigured();
    const line = `${JSON.stringify(sanitizeForRemote(stream, value))}\n`;
    const buffer = this.buffers.get(stream) || { lines: [], bytes: 0 };
    buffer.lines.push(line);
    buffer.bytes += Buffer.byteLength(line);
    this.buffers.set(stream, buffer);
    if (buffer.lines.length >= this.storage.batchMaxRecords || buffer.bytes >= this.storage.batchMaxBytes) {
      await this.flushStream(stream);
    }
    return true;
  }

  async flush() {
    for (const stream of [...this.buffers.keys()]) {
      await this.flushStream(stream);
    }
  }

  async flushStream(stream) {
    const buffer = this.buffers.get(stream);
    if (!buffer || buffer.lines.length === 0) return;
    this.buffers.delete(stream);
    try {
      await postToAppsScript(this.storage, {
        source: this.source,
        stream,
        format: "jsonl",
        lineCount: buffer.lines.length,
        content: buffer.lines.join("")
      });
    } catch (error) {
      if (this.storage.strict) throw error;
      console.warn(`[GMVMAX] Apps Script sync skipped for ${stream}: ${error.message}`);
    }
  }

  assertConfigured() {
    if (!this.storage.webAppUrl) {
      throw new Error("Apps Script storage is enabled, but storage.appsScript.webAppUrl / GMVMAX_APPS_SCRIPT_URL is not configured.");
    }
  }
}

async function postToAppsScript(storage, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(storage.webAppUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(storage.token ? { "x-gmvmax-token": storage.token } : {})
      },
      body: JSON.stringify({
        token: storage.token || undefined,
        sentAt: new Date().toISOString(),
        ...payload
      }),
      signal: controller.signal
    });
    if (response.ok) return response.json().catch(() => ({}));
    const text = await response.text().catch(() => "");
    throw new Error(`Apps Script HTTP ${response.status}: ${text.slice(0, 300)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeForRemote(stream, value) {
  if (NETWORK_STREAM_PATTERN.test(String(stream || ""))) {
    return sanitizeNetworkRecord(value);
  }
  return redactValue(value);
}

function sanitizeNetworkRecord(value = {}) {
  const record = redactValue(value);
  const requestPostData = typeof value.requestPostData === "string" ? value.requestPostData : "";
  const responseBody = typeof value.responseBody === "string" ? value.responseBody : "";
  return {
    kind: record.kind,
    timestamp: record.timestamp,
    collectorTimestamp: record.collectorTimestamp,
    timestampFinished: record.timestampFinished,
    source: record.source,
    endpointKey: record.endpointKey || endpointKeyFromUrl(record.url),
    endpointFamily: record.endpointFamily,
    method: record.method,
    status: record.status,
    type: record.type,
    mimeType: record.mimeType,
    initiator: record.initiator,
    encodedDataLength: record.encodedDataLength,
    responseBase64Encoded: record.responseBase64Encoded,
    responseBodyError: record.responseBodyError,
    errorText: record.errorText,
    urlPath: pathFromUrl(value.url),
    pageUrlPath: pathFromUrl(value.pageUrl),
    title: record.title,
    requestBodyKeyPaths: record.requestBodyKeyPaths || keyPathsFromJson(requestPostData),
    responseBodyKeyPaths: record.responseBodyKeyPaths || keyPathsFromJson(responseBody),
    requestBodyKeys: record.requestBodyKeys || keysFromJson(requestPostData),
    responseBodyKeys: record.responseBodyKeys || keysFromJson(responseBody),
    requestBodyBytes: requestPostData ? Buffer.byteLength(requestPostData) : undefined,
    responseBodyBytes: responseBody ? Buffer.byteLength(responseBody) : undefined,
    visibleSignals: record.visibleSignals,
    summary: record.summary ? redactValue(record.summary) : undefined
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
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactValue(child, depth + 1);
  }
  return output;
}

function redactString(value) {
  let text = value;
  text = text.replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^&\s",}]+/gi, `$1${REDACTED}`);
  text = text.replace(/(cookie\s*[:=]\s*)[^"\n\r}]+/gi, `$1${REDACTED}`);
  text = text.replace(/(["?&](?:token|secret|sessionid|sid_guard|passport_csrf_token|msToken|csrf|x-bogus|x-gnarly)["=:\s]+)[^&",}\s]+/gi, `$1${REDACTED}`);
  if (text.length > MAX_REMOTE_STRING_LENGTH) {
    return `${text.slice(0, MAX_REMOTE_STRING_LENGTH)}...[truncated ${text.length - MAX_REMOTE_STRING_LENGTH} chars]`;
  }
  return text;
}

function pathFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

function endpointKeyFromUrl(rawUrl) {
  return pathFromUrl(rawUrl) || undefined;
}

function keysFromJson(text) {
  const parsed = parseJson(text);
  if (!parsed) return [];
  const keys = new Set();
  collectKeys(parsed, keys, 0);
  return [...keys].slice(0, 200);
}

function keyPathsFromJson(text) {
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

function warnOnce(key, message) {
  if (warnedMissingUrlModes.has(key)) return;
  warnedMissingUrlModes.add(key);
  console.warn(message);
}
