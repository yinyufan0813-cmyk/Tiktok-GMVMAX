import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { extractGmvMaxRecord } from "./extract-gmvmax.js";
import {
  appendAppsScriptJsonl,
  createAppsScriptSink,
  shouldWriteLocalFiles
} from "./apps-script-storage.js";
import {
  appendResultToGoogleSheets,
  readLatestRecordWithPlansFromGoogleSheets,
  shouldWriteLocalBusinessFiles
} from "./google-sheets-storage.js";

const DEFAULT_CONFIG = {
  url: "",
  mode: "attach",
  cdpEndpoint: "http://127.0.0.1:9222",
  intervalMinutes: 10,
  headless: false,
  profileDir: "./chrome-profile",
  extensionDir: "./chrome-extension",
  loadExtension: true,
  outputDir: "./logs",
  locale: "zh-CN",
  timezoneId: "Asia/Kuala_Lumpur",
  accountOrder: ["YOUMILIER KLASIK", "YOUMILIER FASHION", "YOUMILIER", "YOUMI OOTD"],
  storage: {
    mode: "local",
    localPersistence: true,
    strict: false,
    googleSheets: {
      planRecordsSpreadsheetId: "",
      planRecordsSheetName: "plan_records",
      summaryRecordsSpreadsheetId: "",
      summaryRecordsSheetName: "summary_records"
    },
    appsScript: {
      webAppUrl: "",
      token: "",
      batchMaxRecords: 50,
      batchMaxBytes: 900000
    }
  },
  tabMatch: {
    urlIncludes: ["ads.tiktok.com", "gmv-max/dashboard"],
    titleIncludes: ["GMV"]
  },
  selectors: {
    planRows: "",
    planName: "",
    newSpend: "",
    newOrderAmount: "",
    totalSpend: "",
    totalOrderAmount: "",
    totalBudget: ""
  }
};

const LABELS = {
  newSpend: ["新增消耗", "New spend", "Additional spend"],
  newOrderAmount: ["新增成交金额", "新增成交额", "New GMV", "New revenue"],
  totalSpend: ["总消耗", "Total spend"],
  totalOrderAmount: ["总成交金额", "总成交额", "Total GMV", "Total revenue"],
  totalBudget: ["总预算", "Total budget"]
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const args = new Set(process.argv.slice(2));
  await loadRuntimeEnv(path.resolve(".env.gmvmax"));
  const config = await loadConfig();
  const once = args.has("--once");
  const listTabs = args.has("--list-tabs");
  const intervalMs = Math.max(1, Number(config.intervalMinutes || 10)) * 60 * 1000;
  const outputDir = path.resolve(config.outputDir);

  if (shouldWriteLocalFiles(config)) await fs.mkdir(outputDir, { recursive: true });

  const browserSession = await getBrowserSession(config);
  if (listTabs) {
    await printOpenTabs(browserSession);
    await browserSession.close();
    return;
  }

  const page = await findTargetPage(browserSession, config);
  console.log(`[GMVMAX] Attached tab: ${await page.title()} | ${page.url()}`);

  console.log(`[GMVMAX] Started. Refresh interval: ${config.intervalMinutes} minute(s).`);
  console.log("[GMVMAX] Monitoring the existing Chrome tab. Keep that tab open while the script runs.");

  do {
    await collectOnce(page, config, outputDir);
    if (once) break;
    await wait(intervalMs);
  } while (true);

  await page.close?.();
  await browserSession.close();
}

async function loadRuntimeEnv(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function loadConfig() {
  const configPath = process.env.GMVMAX_CONFIG || "config.json";
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return mergeConfig(DEFAULT_CONFIG, {});
  }
}

function mergeConfig(base, override) {
  const envUrl = process.env.GMVMAX_URL;
  return {
    ...base,
    ...override,
    url: envUrl || override.url || base.url,
    outputDir: process.env.GMVMAX_OUTPUT_DIR || override.outputDir || base.outputDir,
    tabMatch: {
      ...base.tabMatch,
      ...(override.tabMatch || {})
    },
    accountOrder: Array.isArray(override.accountOrder) ? override.accountOrder : base.accountOrder,
    storage: {
      ...base.storage,
      ...(override.storage || {}),
      googleSheets: {
        ...base.storage.googleSheets,
        ...((override.storage || {}).googleSheets || {})
      },
      appsScript: {
        ...(base.storage.appsScript || {}),
        ...((override.storage || {}).appsScript || {})
      }
    },
    selectors: {
      ...base.selectors,
      ...(override.selectors || {})
    },
    extensionDir: process.env.GMVMAX_EXTENSION_DIR || override.extensionDir || base.extensionDir,
    loadExtension: process.env.GMVMAX_LOAD_EXTENSION
      ? process.env.GMVMAX_LOAD_EXTENSION !== "0"
      : override.loadExtension ?? base.loadExtension
  };
}

async function getBrowserSession(config) {
  if (config.mode === "launch") {
    await fs.mkdir(path.resolve(config.profileDir), { recursive: true });
    const extensionDir = path.resolve(config.extensionDir);
    const extensionArgs = config.loadExtension
      ? [
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`
        ]
      : [];
    const context = await chromium.launchPersistentContext(path.resolve(config.profileDir), {
      channel: "chrome",
      headless: Boolean(config.headless),
      locale: config.locale,
      timezoneId: config.timezoneId,
      viewport: { width: 1440, height: 980 },
      args: extensionArgs
    });
    const page = context.pages()[0] ?? (await context.newPage());
    if (config.url) {
      await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    }
    return {
      kind: "playwright",
      pages: async () => context.pages(),
      connectPage: async (page) => page,
      close: () => context.close()
    };
  }

  try {
    return {
      kind: "cdp",
      pages: async () => {
        const targets = await fetchCdpTargets(config.cdpEndpoint);
        return targets.filter((target) => target.type === "page").map((target) => new CdpPageTarget(config.cdpEndpoint, target));
      },
      connectPage: async (target) => CdpPage.connect(target),
      openTarget: async (url) => openCdpTarget(config.cdpEndpoint, url),
      close: async () => {}
    };
  } catch (error) {
    throw new Error(
      [
        `Cannot connect to existing Chrome at ${config.cdpEndpoint}.`,
        "Start Chrome with remote debugging enabled, then open the TikTok GMV Max page in that Chrome window.",
        "macOS example:",
        "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.gmvmax-chrome",
        `Original error: ${error.message}`
      ].join("\n")
    );
  }
}

async function printOpenTabs(browserSession) {
  const pages = await browserSession.pages();
  if (pages.length === 0) {
    console.log("[GMVMAX] No open pages found.");
    return;
  }

  for (const [index, page] of pages.entries()) {
    console.log(`[${index + 1}] ${await safeTitle(page)} | ${page.url()}`);
  }
}

async function findTargetPage(browserSession, config) {
  let pages = (await browserSession.pages()).filter((page) => isInspectablePage(page));
  if (pages.length === 0 && config.url && browserSession.openTarget) {
    console.log("[GMVMAX] No inspectable tabs found. Opening configured GMV Max URL...");
    await browserSession.openTarget(refreshDashboardUrl(config.url) || config.url);
    await wait(5_000);
    pages = (await browserSession.pages()).filter((page) => isInspectablePage(page));
  }
  if (pages.length === 0) {
    throw new Error("No inspectable Chrome tabs found.");
  }

  let scored = await scorePages(pages, config);
  scored.sort((a, b) => b.score - a.score);
  let best = scored[0];
  if ((!best || best.score <= 0) && config.url && browserSession.openTarget) {
    console.log("[GMVMAX] Could not find the GMV Max live tab. Opening configured URL...");
    await browserSession.openTarget(refreshDashboardUrl(config.url) || config.url);
    await wait(5_000);
    pages = (await browserSession.pages()).filter((page) => isInspectablePage(page));
    scored = await scorePages(pages, config);
    scored.sort((a, b) => b.score - a.score);
    best = scored[0];
  }
  if (!best || best.score <= 0) {
    const tabList = scored.map((item, index) => `[${index + 1}] ${item.title} | ${item.url}`).join("\n");
    throw new Error(`Could not find the TikTok GMV Max tab. Open tabs:\n${tabList}`);
  }
  if (isTikTokLoginPage(best.url)) {
    throw new Error("Found the TikTok Ads login tab. Complete login in Chrome first, then run the monitor again.");
  }

  const page = await browserSession.connectPage(best.page);
  await page.bringToFront().catch(() => {});
  await page.startNetworkCapture?.(path.resolve(config.outputDir), config);
  return page;
}

async function scorePages(pages, config) {
  const scored = [];
  for (const page of pages) {
    const title = await safeTitle(page);
    const url = page.url();
    const score = scorePage({ title, url }, config);
    scored.push({ page, title, url, score });
  }
  return scored;
}

function isInspectablePage(page) {
  const url = page.url();
  return url && !url.startsWith("chrome://") && !url.startsWith("devtools://");
}

async function safeTitle(page) {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

function scorePage({ title, url }, config) {
  const targetUrl = config.url || "";
  const target = safelyParseUrl(targetUrl);
  const current = safelyParseUrl(url);
  let score = 0;

  if (!current || current.host !== "ads.tiktok.com") return 0;

  if (target && current && current.host === target.host) score += 4;
  if (target && current && current.pathname === target.pathname) score += 6;
  if (targetUrl && url === targetUrl) score += 20;

  for (const part of config.tabMatch.urlIncludes || []) {
    if (part && url.includes(part)) score += 3;
  }

  for (const part of config.tabMatch.titleIncludes || []) {
    if (part && title.toLowerCase().includes(part.toLowerCase())) score += 2;
  }

  return score;
}

function safelyParseUrl(value) {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

function refreshDashboardUrl(currentUrl, fallbackUrl = "") {
  const parsed = safelyParseUrl(currentUrl) || safelyParseUrl(fallbackUrl);
  if (!parsed || parsed.host !== "ads.tiktok.com" || !parsed.pathname.includes("/gmv-max/dashboard")) {
    return null;
  }

  const now = String(Date.now());
  parsed.searchParams.set("is_refresh_page", "true");
  parsed.searchParams.set("activated_tab_id", "2");
  parsed.searchParams.set("type", "live");
  parsed.searchParams.set("live_campaign_page", parsed.searchParams.get("live_campaign_page") || "1");
  parsed.searchParams.set("live_campaign_page_size", parsed.searchParams.get("live_campaign_page_size") || "10");
  parsed.searchParams.set("list_start_date", now);
  parsed.searchParams.set("list_end_date", now);
  return parsed.toString();
}

function isTikTokLoginPage(url) {
  const parsed = safelyParseUrl(url);
  return parsed?.host === "ads.tiktok.com" && parsed.pathname.includes("/login");
}

async function fetchCdpTargets(endpoint) {
  const url = `${endpoint.replace(/\/$/, "")}/json/list`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Chrome DevTools returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function openCdpTarget(endpoint, targetUrl) {
  const url = `${endpoint.replace(/\/$/, "")}/json/new?${encodeURIComponent(targetUrl)}`;
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Chrome DevTools could not open target: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

class CdpPageTarget {
  constructor(endpoint, target) {
    this.endpoint = endpoint;
    this.target = target;
  }

  url() {
    return this.target.url || "";
  }

  async title() {
    return this.target.title || "";
  }
}

class CdpPage {
  constructor(target, socket) {
    this.target = target;
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.networkRequests = new Map();
    this.networkOutputDir = null;
    this.socket.addEventListener("message", (event) => this.onMessage(event));
  }

  static async connect(pageTarget) {
    if (!pageTarget.target.webSocketDebuggerUrl) {
      throw new Error(`Target has no webSocketDebuggerUrl: ${pageTarget.url()}`);
    }

    const socket = new WebSocket(pageTarget.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    const page = new CdpPage(pageTarget.target, socket);
    await page.command("Page.enable");
    await page.command("Runtime.enable");
    await page.command("Network.enable", {
      maxTotalBufferSize: 100000000,
      maxResourceBufferSize: 50000000,
      maxPostDataSize: 300000
    }).catch(() => {});
    return page;
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.method) {
      void this.onEvent(message.method, message.params || {});
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  async onEvent(method, params) {
    if (method === "Network.requestWillBeSent") {
      const url = params.request?.url || "";
      if (!shouldCaptureNetworkUrl(url)) return;
      this.networkRequests.set(params.requestId, {
        kind: "network_exchange",
        timestamp: new Date().toISOString(),
        requestId: params.requestId,
        type: params.type,
        method: params.request?.method || "GET",
        url: sanitizeNetworkUrl(url),
        requestHeaders: sanitizeHeaders(params.request?.headers || {}),
        requestPostData: sanitizeBody(params.request?.postData || null),
        initiator: params.initiator?.type || null
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const entry = this.networkRequests.get(params.requestId);
      if (!entry) return;
      entry.status = params.response?.status;
      entry.mimeType = params.response?.mimeType;
      entry.responseHeaders = sanitizeHeaders(params.response?.headers || {});
      return;
    }

    if (method === "Network.loadingFinished") {
      const entry = this.networkRequests.get(params.requestId);
      if (!entry) return;
      this.networkRequests.delete(params.requestId);
      try {
        const body = await this.command("Network.getResponseBody", { requestId: params.requestId });
        entry.responseBody = sanitizeBody(body?.body || null);
        entry.responseBase64Encoded = Boolean(body?.base64Encoded);
      } catch (error) {
        entry.responseBodyError = String(error?.message || error);
      }
      entry.encodedDataLength = params.encodedDataLength;
      entry.timestampFinished = new Date().toISOString();
      await this.appendNetworkEntry(entry);
      return;
    }

    if (method === "Network.loadingFailed") {
      const entry = this.networkRequests.get(params.requestId);
      if (!entry) return;
      this.networkRequests.delete(params.requestId);
      entry.kind = "network_failed";
      entry.errorText = params.errorText;
      entry.timestampFinished = new Date().toISOString();
      await this.appendNetworkEntry(entry);
    }
  }

  async startNetworkCapture(outputDir, config = {}) {
    this.networkOutputDir = outputDir;
    this.writeLocalNetworkFiles = shouldWriteLocalFiles(config);
    this.remoteNetworkSink = createAppsScriptSink(config, { source: "monitor-cdp" });
    if (this.writeLocalNetworkFiles) await fs.mkdir(outputDir, { recursive: true });
  }

  async appendNetworkEntry(entry) {
    if (!this.networkOutputDir) return;
    const enriched = {
      collectorTimestamp: new Date().toISOString(),
      endpointKey: endpointKey(entry.url),
      endpointFamily: endpointFamily(entry.url),
      requestBodyKeyPaths: extractJsonKeyPaths(entry.requestPostData),
      responseBodyKeyPaths: extractJsonKeyPaths(entry.responseBody),
      source: "monitor-cdp",
      ...entry
    };
    await appendRemoteNetworkJsonl(this.remoteNetworkSink, "gmvmax-network", enriched);
    if (this.writeLocalNetworkFiles) {
      await fs.appendFile(path.join(this.networkOutputDir, "gmvmax-network.jsonl"), `${JSON.stringify(enriched)}\n`, "utf8");
    }
    if (entry.kind === "network_exchange") {
      await appendRemoteNetworkJsonl(this.remoteNetworkSink, "gmvmax-network-exchanges", enriched);
      if (this.writeLocalNetworkFiles) {
        await fs.appendFile(path.join(this.networkOutputDir, "gmvmax-network-exchanges.jsonl"), `${JSON.stringify(enriched)}\n`, "utf8");
      }
    }
  }

  command(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP command timed out: ${method}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  url() {
    return this.target.url || "";
  }

  async title() {
    const result = await this.evaluate(() => document.title);
    return result || this.target.title || "";
  }

  async bringToFront() {
    await this.command("Page.bringToFront");
  }

  async reload(options = {}) {
    await this.command("Page.reload", { ignoreCache: true });
    await this.waitForTimeout(options.timeout ? Math.min(options.timeout, 8000) : 8000);
  }

  async goto(url, options = {}) {
    await this.command("Page.navigate", { url });
    await this.waitForTimeout(options.timeout ? Math.min(options.timeout, 8000) : 8000);
  }

  async waitForTimeout(ms) {
    await wait(ms);
  }

  async evaluate(fn, arg) {
    const expression = `(${fn})(${JSON.stringify(arg)})`;
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Evaluation failed");
    }
    return result.result?.value;
  }

  async screenshot({ path: screenshotPath }) {
    const result = await this.command("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true
    });
    await fs.writeFile(screenshotPath, result.data, "base64");
  }

  async close() {
    this.socket.close();
  }
}

async function appendRemoteNetworkJsonl(sink, stream, record) {
  if (!sink) return;
  try {
    await sink.appendJsonl(stream, record);
  } catch (error) {
    console.warn(`[GMVMAX] Network remote sync skipped for ${stream}: ${error.message}`);
  }
}

async function collectOnce(page, config, outputDir) {
  const timestamp = new Date().toISOString();
  console.log(`[GMVMAX] ${timestamp} refreshing dashboard...`);

  const targetUrl = refreshDashboardUrl(page.url(), config.url);
  if (targetUrl) {
    console.log("[GMVMAX] Navigating to current LIVE GMV Max window...");
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 120_000 }).catch((error) => {
      console.warn(`[GMVMAX] Navigation timeout/skipped, reading current page state: ${error.message}`);
    });
  } else {
    await page.reload({ waitUntil: "networkidle", timeout: 120_000 });
  }

  await acceptVisibleDialogs(page);
  await waitForLivePlans(page);

  const record = await page.evaluate(extractGmvMaxRecord, {
    labels: LABELS,
    selectors: config.selectors
  });

  const result = {
    timestamp,
    url: record.url,
    title: record.title,
    liveGmvMax: record.metrics,
    plans: normalizeExtractedPlans(record.plans),
    campaigns: normalizeCampaignRows(record.campaigns),
    pageState: record.pageState
  };

  const pageSnapshot = await page.evaluate(extractPageEvidenceSnapshot, { reason: "monitor_collect", timestamp });
  const writeLocalFiles = shouldWriteLocalFiles(config);
  await appendAppsScriptJsonl(config, "gmvmax-page-snapshots", pageSnapshot, { source: "monitor" });
  if (writeLocalFiles) await appendJsonl(path.join(outputDir, "gmvmax-page-snapshots.jsonl"), pageSnapshot);

  if ((!Array.isArray(result.plans) || result.plans.length === 0) && (!Array.isArray(result.campaigns) || result.campaigns.length === 0)) {
    const safeStamp = timestamp.replace(/[:.]/g, "-");
    await appendAppsScriptJsonl(config, "gmvmax-debug", { timestamp, bodyText: record.bodyText, pageState: result.pageState }, { source: "monitor" });
    if (writeLocalFiles) {
      await fs.writeFile(path.join(outputDir, `debug-${safeStamp}.txt`), record.bodyText, "utf8");
      await page.screenshot({ path: path.join(outputDir, `debug-${safeStamp}.png`), fullPage: true });
    }
    console.warn(
      `[GMVMAX] No LIVE GMV Max plans found; skipped writing stale data. Page state: ${JSON.stringify(result.pageState)}`
    );
    return;
  }

  if (Array.isArray(result.plans) && result.plans.length > 0) {
    await enrichPlanIncrements(path.join(outputDir, "gmvmax-records.jsonl"), result, config);
  }

  await appendResultToGoogleSheets(config, result);
  await appendAppsScriptJsonl(config, "gmvmax-records", result, { source: "monitor" });

  const writeLocalBusinessFiles = shouldWriteLocalBusinessFiles(config);
  if (writeLocalBusinessFiles) {
    await appendJsonl(path.join(outputDir, "gmvmax-records.jsonl"), result);
    await appendDecisionSnapshot(path.join(outputDir, "gmvmax-decision-snapshots.jsonl"), result);
  }
  if (Array.isArray(result.plans) && result.plans.length > 0) {
    if (writeLocalBusinessFiles) {
      await appendCsv(path.join(outputDir, "gmvmax-records.csv"), result);
      await appendPlanCsv(path.join(outputDir, "gmvmax-plan-records.csv"), result);
    }
  }

  const missing = Object.entries(result.liveGmvMax).filter(([, value]) => !value);
  if (missing.length > 0) {
    const safeStamp = timestamp.replace(/[:.]/g, "-");
    await appendAppsScriptJsonl(config, "gmvmax-debug", { timestamp, bodyText: record.bodyText, missing: missing.map(([key]) => key) }, { source: "monitor" });
    if (writeLocalFiles) {
      await fs.writeFile(path.join(outputDir, `debug-${safeStamp}.txt`), record.bodyText, "utf8");
      await page.screenshot({ path: path.join(outputDir, `debug-${safeStamp}.png`), fullPage: true });
    }
    console.warn(`[GMVMAX] Some metrics were not found: ${missing.map(([key]) => key).join(", ")}`);
    console.warn("[GMVMAX] Saved debug text and screenshot in logs/. Add CSS selectors in config.json if needed.");
  }

  console.log(`[GMVMAX] Saved: ${JSON.stringify(result.liveGmvMax)}`);
}

function extractPageEvidenceSnapshot(options = {}) {
  const maxText = 120;
  const maxRows = 20;
  const maxCells = 12;
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const clippedText = (element, limit = maxText) =>
    normalizeText(element?.innerText || element?.textContent || "").slice(0, limit);
  const hashText = (value) => {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const safeUrl = (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      for (const key of [...parsed.searchParams.keys()]) {
        if (/token|csrf|session|msToken|x-bogus|x-gnarly/i.test(key)) {
          parsed.searchParams.set(key, "[redacted]");
        }
      }
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  };
  const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || "");
  const params = new URLSearchParams(location.search);
  const labels = [
    "LIVE GMV Max",
    "GMV Max",
    "广告计划列表",
    "Target ROI",
    "目标 ROI",
    "Budget",
    "预算",
    "Cost",
    "ROI",
    "Orders",
    "Revenue",
    "Recommendation",
    "建议",
    "Material",
    "素材"
  ];
  const rowElements = Array.from(document.querySelectorAll("tr, [role='row']"))
    .filter((row) => clippedText(row).includes("MYR") || /GMV Max|ROI|Budget|预算|消耗|Revenue/i.test(clippedText(row)))
    .slice(0, maxRows);

  return {
    kind: "page_snapshot",
    source: "monitor-cdp",
    reason: options.reason || "monitor_collect",
    timestamp: options.timestamp || new Date().toISOString(),
    url: safeUrl(location.href),
    title: document.title || "",
    visibilityState: document.visibilityState,
    bodyTextLength: bodyText.length,
    bodyTextHash: hashText(bodyText),
    routeState: {
      type: params.get("type"),
      activatedTabId: params.get("activated_tab_id"),
      campaignPage: params.get("live_campaign_page") || params.get("campaign_page"),
      campaignPageSize: params.get("live_campaign_page_size") || params.get("campaign_page_size"),
      hasDateRange: params.has("list_start_date") || params.has("list_end_date")
    },
    visibleSignals: labels.filter((label) => bodyText.includes(label)),
    sortState: Array.from(document.querySelectorAll("[aria-sort], [data-sort], th button, [role='columnheader']"))
      .map((element) => ({
        text: clippedText(element),
        ariaSort: element.getAttribute("aria-sort"),
        dataSort: element.getAttribute("data-sort"),
        pressed: element.getAttribute("aria-pressed"),
        selected: element.getAttribute("aria-selected")
      }))
      .filter((item) => item.text || item.ariaSort || item.dataSort || item.pressed || item.selected)
      .slice(0, 20),
    tableState: {
      rowCount: rowElements.length,
      rows: rowElements.map((row, index) => ({
        index,
        textHash: hashText(clippedText(row, 800)),
        cells: Array.from(row.querySelectorAll("th, td, [role='cell'], [role='gridcell'], [role='columnheader']"))
          .map((cell) => clippedText(cell))
          .filter(Boolean)
          .slice(0, maxCells)
      }))
    },
    actionState: Array.from(document.querySelectorAll("button, [role='button'], a"))
      .map((element) => ({
        text: clippedText(element),
        disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
        selected: element.getAttribute("aria-selected"),
        expanded: element.getAttribute("aria-expanded")
      }))
      .filter((item) => /recommend|建议|素材|material|optimi|roi|budget|预算/i.test(item.text))
      .slice(0, 30)
  };
}

async function waitForLivePlans(page, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await page
      .evaluate(() => {
        const bodyText = (document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
        return {
          hasPlan:
            (bodyText.includes("LIVE GMV Max_") && bodyText.includes("MYR") && bodyText.includes(" ID:")) ||
            (bodyText.includes("广告计划列表") && bodyText.includes("目标 ROI") && bodyText.includes("MYR")),
          hasEmptyState: /No campaigns found|暂无|没有广告计划|System error/i.test(bodyText),
          length: bodyText.length
        };
      })
      .catch(() => null);

    if (lastState?.hasPlan || lastState?.hasEmptyState) return lastState;
    await page.waitForTimeout(3000);
  }

  console.warn(`[GMVMAX] Timed out waiting for LIVE GMV Max plans. Last state: ${JSON.stringify(lastState)}`);
  return lastState;
}

async function enrichPlanIncrements(historyPath, result, config = {}) {
  const accountOrder = config.accountOrder || [];
  const allowedAccounts = allowedAccountSet(accountOrder);
  const previous =
    (await readLatestRecordWithPlansFromGoogleSheets(config).catch((error) => {
      console.warn(`[GMVMAX] Google Sheets history unavailable: ${error.message}`);
      return null;
    })) || (await readLatestRecordWithPlans(historyPath));
  fillMissingAccounts(result.plans, previous?.plans || [], accountOrder);
  result.plans = (result.plans || []).filter((plan) => isAllowedAccount(plan.account, allowedAccounts));

  const previousByAccount = new Map(
    (previous?.plans || [])
      .filter((plan) => plan.account && isAllowedAccount(plan.account, allowedAccounts))
      .map((plan) => [plan.account, plan])
  );
  const currentAccounts = new Set(
    (result.plans || [])
      .map((plan) => plan.account)
      .filter((account) => account && isAllowedAccount(account, allowedAccounts))
  );

  if (currentAccounts.size > 0) {
    for (const [account, previousPlan] of previousByAccount.entries()) {
      if (currentAccounts.has(account)) continue;
      result.plans.push({
        ...previousPlan,
        intervalSpendIncrease: "0.00 MYR",
        intervalOrderAmountIncrease: "0.00 MYR"
      });
    }
  }

  result.plans.sort((a, b) => accountRank(a.account, accountOrder) - accountRank(b.account, accountOrder));

  for (const plan of result.plans || []) {
    const previousPlan = previousByAccount.get(plan.account);
    const spendIncrease = previousPlan
      ? parseMoney(plan.totalSpend) - parseMoney(previousPlan.totalSpend)
      : 0;
    const orderAmountIncrease = previousPlan
      ? parseMoney(plan.totalOrderAmount) - parseMoney(previousPlan.totalOrderAmount)
      : 0;
    plan.intervalSpendIncrease = moneyText(Math.max(0, spendIncrease));
    plan.intervalOrderAmountIncrease = moneyText(Math.max(0, orderAmountIncrease));
  }

  const intervalSpend = (result.plans || []).reduce((sum, plan) => sum + parseMoney(plan.intervalSpendIncrease), 0);
  const intervalOrderAmount = (result.plans || []).reduce((sum, plan) => sum + parseMoney(plan.intervalOrderAmountIncrease), 0);
  result.liveGmvMax.newSpend = moneyText(intervalSpend);
  result.liveGmvMax.newOrderAmount = moneyText(intervalOrderAmount);
}

function normalizeExtractedPlans(plans = []) {
  return plans.map((plan) => {
    const normalized = { ...plan };
    const extractedRevenue = parseMoney(normalized.totalBudget);
    const extractedBudget = parseMoney(normalized.netSpend);
    const extractedNetSpend = parseMoney(normalized.totalOrderAmount);
    const totalSpend = parseMoney(normalized.totalSpend);

    if (
      extractedBudget > 0 &&
      extractedRevenue > 0 &&
      extractedNetSpend > 0 &&
      extractedBudget >= totalSpend &&
      extractedBudget >= extractedRevenue &&
      extractedRevenue > extractedNetSpend
    ) {
      normalized.totalOrderAmount = normalized.totalBudget;
      normalized.totalBudget = normalized.netSpend;
      normalized.netSpend = plan.totalOrderAmount;
    }

    return normalized;
  });
}

function normalizeCampaignRows(campaigns = []) {
  return campaigns.map((campaign) => ({
    ...campaign,
    roiGap: roundNumber(Number(campaign.roi || 0) - Number(campaign.targetRoi || 0)),
    targetMet: Number(campaign.roi || 0) >= Number(campaign.targetRoi || 0),
    spend: campaign.netCost || campaign.cost,
    spendNumber: parseMoney(campaign.netCost || campaign.cost),
    revenueNumber: parseMoney(campaign.revenue),
    allocationScoreProxy: allocationScoreProxy(campaign)
  }));
}

function allocationScoreProxy(campaign) {
  const spend = parseMoney(campaign.netCost || campaign.cost);
  const revenue = parseMoney(campaign.revenue);
  const roi = Number(campaign.roi || 0);
  const targetRoi = Number(campaign.targetRoi || 0);
  const orders = Number(campaign.orders || 0);
  const roiGap = roi - targetRoi;
  return roundNumber(
    Math.log1p(spend) * 0.35 +
      Math.log1p(revenue) * 0.25 +
      Math.log1p(orders) * 0.2 +
      Math.max(-5, Math.min(5, roiGap)) * 0.15 -
      Number(campaign.suggestionCount || 0) * 0.05
  );
}

async function appendDecisionSnapshot(filePath, result) {
  const campaigns = Array.isArray(result.campaigns) && result.campaigns.length > 0 ? result.campaigns : result.plans || [];
  const totalSpend = campaigns.reduce((sum, campaign) => sum + parseMoney(campaign.netCost || campaign.totalSpend || campaign.cost), 0);
  const totalRevenue = campaigns.reduce((sum, campaign) => sum + parseMoney(campaign.revenue || campaign.totalOrderAmount), 0);
  const snapshot = {
    timestamp: result.timestamp,
    url: result.url,
    pageState: result.pageState,
    totals: {
      spend: moneyText(totalSpend),
      revenue: moneyText(totalRevenue),
      roi: totalSpend > 0 ? roundNumber(totalRevenue / totalSpend) : 0
    },
    distribution: buildDistribution(campaigns),
    campaigns
  };
  await fs.appendFile(filePath, `${JSON.stringify(snapshot)}\n`, "utf8");
}

function buildDistribution(campaigns = []) {
  const totalSpend = campaigns.reduce((sum, campaign) => sum + parseMoney(campaign.netCost || campaign.totalSpend || campaign.cost), 0);
  return campaigns
    .map((campaign) => {
      const spend = parseMoney(campaign.netCost || campaign.totalSpend || campaign.cost);
      return {
        name: campaign.name || campaign.account,
        spendShare: totalSpend > 0 ? roundNumber(spend / totalSpend) : 0,
        spend: moneyText(spend),
        roi: campaign.roi || null,
        targetRoi: campaign.targetRoi || null,
        roiGap: campaign.roiGap ?? null,
        suggestionCount: campaign.suggestionCount || 0,
        allocationScoreProxy: campaign.allocationScoreProxy ?? null,
        benefit: campaign.benefit || "-"
      };
    })
    .sort((a, b) => b.spendShare - a.spendShare);
}

function fillMissingAccounts(plans = [], previousPlans = [], accountOrder = []) {
  const accountByCampaign = new Map(
    previousPlans
      .filter((plan) => plan.name && plan.account)
      .map((plan) => [plan.name, plan.account])
  );

  plans.forEach((plan, index) => {
    if (String(plan.account || "").trim()) return;
    plan.account = accountByCampaign.get(plan.name) || accountOrder[index] || `live-plan-${index + 1}`;
  });
}

function accountRank(account, accountOrder = []) {
  const index = accountOrder.indexOf(account);
  return index === -1 ? accountOrder.length : index;
}

function allowedAccountSet(accountOrder = []) {
  const accounts = accountOrder.map((account) => String(account || "").trim()).filter(Boolean);
  return accounts.length ? new Set(accounts) : null;
}

function isAllowedAccount(account, allowedAccounts) {
  if (!allowedAccounts) return true;
  return allowedAccounts.has(String(account || "").trim());
}

async function readLatestRecordWithPlans(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]);
      if (Array.isArray(record.plans) && record.plans.some((plan) => plan.account)) {
        return record;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

function parseMoney(value) {
  if (!value) return 0;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function moneyText(value) {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MYR`;
}

function roundNumber(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

async function acceptVisibleDialogs(page) {
  const buttons = ["Accept all", "Accept", "同意", "接受", "我知道了", "Got it"];
  await page
    .evaluate((names) => {
      const elements = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const element of elements) {
        const text = (element.innerText || element.textContent || "").trim();
        if (names.some((name) => text.includes(name))) {
          element.click();
        }
      }
    }, buttons)
    .catch(() => {});
}

async function appendJsonl(filePath, value) {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function appendCsv(filePath, result) {
  const exists = await fileExists(filePath);
  const row = [
    result.timestamp,
    result.liveGmvMax.newSpend,
    result.liveGmvMax.newOrderAmount,
    result.liveGmvMax.totalSpend,
    result.liveGmvMax.totalOrderAmount,
    result.url,
    result.liveGmvMax.totalBudget
  ].map(csvCell);

  if (!exists) {
    await fs.appendFile(
      filePath,
      "timestamp,new_spend,new_order_amount,total_spend,total_order_amount,url,total_budget\n",
      "utf8"
    );
  } else {
    await ensureSummaryCsvHasBudgetColumn(filePath);
  }
  await fs.appendFile(filePath, `${row.join(",")}\n`, "utf8");
}

async function ensureSummaryCsvHasBudgetColumn(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const lineEndIndex = content.indexOf("\n");
  const header = lineEndIndex === -1 ? content : content.slice(0, lineEndIndex);
  if (header.split(",").includes("total_budget")) return;

  const rest = lineEndIndex === -1 ? "" : content.slice(lineEndIndex);
  await fs.writeFile(filePath, `${header},total_budget${rest}`, "utf8");
}

async function appendPlanCsv(filePath, result) {
  const exists = await fileExists(filePath);
  if (!exists) {
    await fs.appendFile(
      filePath,
      "timestamp,account,campaign,interval_spend_increase,interval_order_amount_increase,total_spend,total_order_amount,net_spend,url,total_budget\n",
      "utf8"
    );
  } else {
    await ensurePlanCsvHasBudgetColumn(filePath);
  }

  for (const plan of result.plans || []) {
    if (!String(plan.account || "").trim()) continue;
    const row = [
      result.timestamp,
      plan.account,
      plan.name,
      plan.intervalSpendIncrease,
      plan.intervalOrderAmountIncrease,
      plan.totalSpend,
      plan.totalOrderAmount,
      plan.netSpend,
      result.url,
      plan.totalBudget
    ].map(csvCell);
    await fs.appendFile(filePath, `${row.join(",")}\n`, "utf8");
  }
}

async function ensurePlanCsvHasBudgetColumn(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const lineEndIndex = content.indexOf("\n");
  const header = lineEndIndex === -1 ? content : content.slice(0, lineEndIndex);
  if (header.split(",").includes("total_budget")) return;

  const rest = lineEndIndex === -1 ? "" : content.slice(lineEndIndex);
  await fs.writeFile(filePath, `${header},total_budget${rest}`, "utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const NETWORK_CAPTURE_PATTERNS = [
  /ads\.tiktok\.com\/api\/oec\//i,
  /ads\.tiktok\.com\/api\/v\d+\/oec\//i,
  /ads\.tiktok\.com\/api\/oec_shopping\/v1\//i,
  /ads\.tiktok\.com\/api\/shopping\/v1\/gmv_max/i,
  /ads\.tiktok\.com\/api\/.+(?:gmv|max|campaign|material|creative|asset|rank|bid|recommend|diagnos|delivery|traffic|auction|stat)/i,
  /ads\.tiktok\.com\/api\/v\d+\/i18n\/shark\/event/i,
  /mcs-[^/]+\.tiktokv\.com\/(?:v1\/)?list/i,
  /mon\.tiktokv\.com\/monitor/i,
  /libraweb-[^/]+\.tiktok\.com\/service\/2\/abtest_config/i
];

const SECRET_NETWORK_KEYS = [
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

function shouldCaptureNetworkUrl(url) {
  return NETWORK_CAPTURE_PATTERNS.some((pattern) => pattern.test(url));
}

function sanitizeNetworkUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretNetworkKey(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = isSecretNetworkKey(key) ? "[redacted]" : String(value);
  }
  return output;
}

function sanitizeBody(body) {
  if (body == null) return null;
  let text = String(body);
  for (const secret of SECRET_NETWORK_KEYS) {
    text = text.replace(new RegExp(`("${escapeRegex(secret)}"\\s*:\\s*)"[^"]*"`, "gi"), `$1"[redacted]"`);
    text = text.replace(new RegExp(`([?&]${escapeRegex(secret)}=)[^&"]+`, "gi"), "$1[redacted]");
  }
  if (text.length > 300000) return `${text.slice(0, 300000)}...[truncated ${text.length - 300000} chars]`;
  return text;
}

function isSecretNetworkKey(key) {
  const lower = String(key || "").toLowerCase();
  return SECRET_NETWORK_KEYS.some((secret) => lower.includes(secret.toLowerCase()));
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

function extractJsonKeyPaths(text) {
  if (!text || typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    const paths = new Set();
    collectJsonKeyPaths(parsed, paths, "$", 0);
    return [...paths].slice(0, 300);
  } catch {
    return [];
  }
}

function collectJsonKeyPaths(value, paths, prefix, depth) {
  if (depth > 5 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 0) collectJsonKeyPaths(value[0], paths, `${prefix}[]`, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const pathKey = `${prefix}.${key}`;
    paths.add(pathKey);
    collectJsonKeyPaths(child, paths, pathKey, depth + 1);
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
