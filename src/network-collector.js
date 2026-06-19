import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createAppsScriptSink, shouldWriteLocalFiles } from "./apps-script-storage.js";

const DEFAULT_PORT = 8799;
const DEFAULT_OUTPUT_DIR = "./logs";

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

const outputDir = path.resolve(process.env.GMVMAX_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
const port = Number(process.env.GMVMAX_COLLECTOR_PORT || DEFAULT_PORT);
const rawLogPath = path.join(outputDir, "gmvmax-network.jsonl");
const exchangeLogPath = path.join(outputDir, "gmvmax-network-exchanges.jsonl");
const endpointSummaryPath = path.join(outputDir, "gmvmax-network-endpoints.json");
const pageSnapshotPath = path.join(outputDir, "gmvmax-page-snapshots.jsonl");
const materialRawLogPath = path.join(outputDir, "material-network.jsonl");
const materialExchangeLogPath = path.join(outputDir, "material-network-exchanges.jsonl");
const materialPageSnapshotPath = path.join(outputDir, "material-page-snapshots.jsonl");
let remoteSink = null;
let writeLocalFiles = true;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const config = await loadConfig();
  remoteSink = createAppsScriptSink(config, { source: "network-collector" });
  writeLocalFiles = shouldWriteLocalFiles(config);
  if (writeLocalFiles) await fs.mkdir(outputDir, { recursive: true });

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true, service: "gmvmax-network-collector" });
        return;
      }

      if (request.method !== "POST" || request.url !== "/ingest") {
        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }

      const body = await readRequestBody(request);
      const payload = sanitizePayload(JSON.parse(body));
      await appendEvent(payload);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: String(error?.message || error) });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[GMVMAX] Network collector listening on http://127.0.0.1:${port}`);
    console.log(writeLocalFiles ? `[GMVMAX] Network logs: ${rawLogPath}` : "[GMVMAX] Local network persistence disabled.");
    if (remoteSink) console.log("[GMVMAX] Apps Script remote sink enabled.");
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await remoteSink?.flush().catch((error) => console.warn(`[GMVMAX] Remote flush failed: ${error.message}`));
      process.exit(0);
    });
  }
}

async function appendEvent(event) {
  const enriched = {
    collectorTimestamp: new Date().toISOString(),
    endpointKey: endpointKey(event.url),
    endpointFamily: endpointFamily(event.url),
    ...event
  };

  await appendRemoteJsonl("gmvmax-network", enriched);
  if (writeLocalFiles) await fs.appendFile(rawLogPath, `${JSON.stringify(enriched)}\n`, "utf8");
  if (event.kind === "page_snapshot") {
    await appendRemoteJsonl("gmvmax-page-snapshots", enriched);
    if (writeLocalFiles) await fs.appendFile(pageSnapshotPath, `${JSON.stringify(enriched)}\n`, "utf8");
    if (isMaterialEvidenceEvent(enriched)) {
      await appendRemoteJsonl("material-page-snapshots", enriched);
      if (writeLocalFiles) await fs.appendFile(materialPageSnapshotPath, `${JSON.stringify(enriched)}\n`, "utf8");
    }
  }
  if (event.kind === "network_exchange") {
    await appendRemoteJsonl("gmvmax-network-exchanges", enriched);
    if (writeLocalFiles) {
      await fs.appendFile(exchangeLogPath, `${JSON.stringify(enriched)}\n`, "utf8");
      await updateEndpointSummary(enriched);
    }
    if (isMaterialEvidenceEvent(enriched)) {
      await appendRemoteJsonl("material-network", enriched);
      await appendRemoteJsonl("material-network-exchanges", enriched);
      if (writeLocalFiles) {
        await fs.appendFile(materialRawLogPath, `${JSON.stringify(enriched)}\n`, "utf8");
        await fs.appendFile(materialExchangeLogPath, `${JSON.stringify(enriched)}\n`, "utf8");
      }
    }
  }
}

async function appendRemoteJsonl(stream, record) {
  if (!remoteSink) return;
  try {
    await remoteSink.appendJsonl(stream, record);
  } catch (error) {
    console.warn(`[GMVMAX] Remote sync skipped for ${stream}: ${error.message}`);
  }
}

async function loadConfig() {
  const configPath = process.env.GMVMAX_CONFIG || "config.json";
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

async function updateEndpointSummary(event) {
  const summary = await readJson(endpointSummaryPath, {});
  const key = event.endpointKey || "unknown";
  const item = summary[key] || {
    endpointKey: key,
    endpointFamily: event.endpointFamily || "unknown",
    count: 0,
    methods: {},
    statuses: {},
    lastSeen: null,
    sampleUrl: event.url,
    responseBodyKeys: [],
    requestBodyKeys: [],
    responseBodyKeyPaths: [],
    requestBodyKeyPaths: []
  };

  item.count += 1;
  item.lastSeen = event.collectorTimestamp;
  item.methods[event.method || "GET"] = (item.methods[event.method || "GET"] || 0) + 1;
  item.statuses[String(event.status || "unknown")] = (item.statuses[String(event.status || "unknown")] || 0) + 1;
  item.responseBodyKeys = mergeKeys(item.responseBodyKeys, extractJsonKeys(event.responseBody));
  item.requestBodyKeys = mergeKeys(item.requestBodyKeys, extractJsonKeys(event.requestPostData));
  item.responseBodyKeyPaths = mergeKeys(item.responseBodyKeyPaths, extractJsonKeyPaths(event.responseBody));
  item.requestBodyKeyPaths = mergeKeys(item.requestBodyKeyPaths, extractJsonKeyPaths(event.requestPostData));
  summary[key] = item;

  await fs.writeFile(endpointSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
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

function isMaterialEvidenceEvent(event) {
  const family = event.endpointFamily || endpointFamily(event.url || event.pageUrl || "");
  const text = [
    family,
    event.endpointKey,
    event.url,
    event.pageUrl,
    event.title,
    event.reason,
    ...(event.visibleSignals || []),
    ...(event.summary?.visibleSignals || [])
  ].join(" ");
  return /creative_material|delivery_signal|recommendation|material|素材|creative|创意|asset|video|视频|rank|排序|bid|出价|diagnos|诊断/i.test(text);
}

function sanitizePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (isSecretKey(key)) {
      output[key] = "[redacted]";
    } else if (key.toLowerCase().includes("body") && typeof rawValue === "string") {
      output[key] = sanitizeBody(rawValue);
    } else {
      output[key] = sanitizePayload(rawValue);
    }
  }
  return output;
}

function sanitizeBody(body) {
  let text = body;
  for (const secret of SECRET_KEYS) {
    text = text.replace(new RegExp(`("${escapeRegex(secret)}"\\s*:\\s*)"[^"]*"`, "gi"), `$1"[redacted]"`);
    text = text.replace(new RegExp(`([?&]${escapeRegex(secret)}=)[^&"]+`, "gi"), "$1[redacted]");
  }
  if (text.length > 300000) return `${text.slice(0, 300000)}...[truncated ${text.length - 300000} chars]`;
  return text;
}

function isSecretKey(key) {
  const lower = String(key || "").toLowerCase();
  return SECRET_KEYS.some((secret) => lower.includes(secret.toLowerCase()));
}

function extractJsonKeys(text) {
  if (!text || typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    const keys = new Set();
    collectKeys(parsed, keys, 0);
    return [...keys].slice(0, 200);
  } catch {
    return [];
  }
}

function extractJsonKeyPaths(text) {
  if (!text || typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    const paths = new Set();
    collectKeyPaths(parsed, paths, "$", 0);
    return [...paths].slice(0, 300);
  } catch {
    return [];
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

function mergeKeys(existing, incoming) {
  return [...new Set([...(existing || []), ...(incoming || [])])].slice(0, 300);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return fallback;
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1000000) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  response.end(JSON.stringify(value));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
