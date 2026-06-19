import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  appendAppsScriptJsonl,
  createAppsScriptSink,
  shouldWriteLocalFiles
} from "./apps-script-storage.js";
import { extractMaterialRecord } from "./extract-materials.js";

const PREFIX = "MATERIAL";

const DEFAULT_CONFIG = {
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
  storage: {
    mode: "local",
    localPersistence: true,
    strict: false,
    appsScript: {
      webAppUrl: "",
      token: "",
      batchMaxRecords: 50,
      batchMaxBytes: 900000
    }
  },
  materialMonitor: {
    url: "",
    cdpEndpoint: "http://127.0.0.1:9224",
    profileDir: "./chrome-profile-material",
    outputPrefix: "material",
    waitSignals: ["Material", "素材", "Creative", "创意", "Video", "视频", "GMV Max", "ROI"],
    tabMatch: {
      urlIncludes: ["gmv-max/dashboard", "type=product", "material", "creative", "asset", "video", "campaign"],
      titleIncludes: ["GMV", "Material", "素材", "Creative", "创意", "Video", "视频"]
    },
    selectors: {
      rows: "",
      name: "",
      status: "",
      headers: []
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = await loadConfig();
  const materialConfig = config.materialMonitor || {};
  const once = args.has("--once");
  const listTabs = args.has("--list-tabs");
  const intervalMs = Math.max(1, Number(materialConfig.intervalMinutes || config.intervalMinutes || 10)) * 60 * 1000;
  const outputDir = path.resolve(materialConfig.outputDir || config.outputDir || "./logs");

  await fs.mkdir(outputDir, { recursive: true });
  const lock = await acquireProcessLock(path.join(outputDir, `${materialConfig.outputPrefix || "material"}-monitor.lock`));

  const browserSession = await getBrowserSession(config);
  try {
    if (listTabs) {
      await printOpenTabs(browserSession);
      return;
    }

    const page = await findTargetPage(browserSession, config);
    console.log(`[${PREFIX}] Attached tab: ${await page.title()} | ${page.url()}`);
    console.log(`[${PREFIX}] Started. Refresh interval: ${intervalMs / 60_000} minute(s).`);
    console.log(`[${PREFIX}] This monitor is read-only: it reloads/reads pages and records evidence only.`);

    do {
      await collectOnce(page, config, outputDir);
      if (once) break;
      await wait(intervalMs);
    } while (true);
  } finally {
    await browserSession.close();
    await lock.release();
  }

  if (once || listTabs) process.exit(process.exitCode || 0);
}

async function acquireProcessLock(lockPath) {
  const payload = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify(payload));
    return {
      release: async () => {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = await fs.readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => ({}));
  if (existing.pid && isPidRunning(existing.pid)) {
    throw new Error(`[${PREFIX}] Another material monitor is already running (PID ${existing.pid}). Stop it before starting a new one.`);
  }
  await fs.unlink(lockPath).catch(() => {});
  return acquireProcessLock(lockPath);
}

function isPidRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
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
  const materialOverride = override.materialMonitor || {};
  return {
    ...base,
    ...override,
    outputDir: process.env.GMVMAX_OUTPUT_DIR || override.outputDir || base.outputDir,
    storage: {
      ...base.storage,
      ...(override.storage || {}),
      appsScript: {
        ...base.storage.appsScript,
        ...((override.storage || {}).appsScript || {})
      }
    },
    extensionDir: process.env.GMVMAX_EXTENSION_DIR || override.extensionDir || base.extensionDir,
    loadExtension: process.env.GMVMAX_LOAD_EXTENSION
      ? process.env.GMVMAX_LOAD_EXTENSION !== "0"
      : override.loadExtension ?? base.loadExtension,
    materialMonitor: {
      ...base.materialMonitor,
      ...materialOverride,
      url: process.env.MATERIAL_MONITOR_URL || materialOverride.url || "",
      cdpEndpoint: process.env.MATERIAL_CDP_ENDPOINT || materialOverride.cdpEndpoint || base.materialMonitor.cdpEndpoint,
      profileDir: process.env.MATERIAL_PROFILE_DIR || materialOverride.profileDir || base.materialMonitor.profileDir,
      outputPrefix: process.env.MATERIAL_OUTPUT_PREFIX || materialOverride.outputPrefix || base.materialMonitor.outputPrefix,
      tabMatch: {
        ...base.materialMonitor.tabMatch,
        ...(materialOverride.tabMatch || {})
      },
      selectors: {
        ...base.materialMonitor.selectors,
        ...(materialOverride.selectors || {})
      }
    }
  };
}

async function getBrowserSession(config) {
  const materialConfig = config.materialMonitor || {};
  if (config.mode === "launch") {
    await fs.mkdir(path.resolve(materialConfig.profileDir || config.profileDir), { recursive: true });
    const extensionDir = path.resolve(config.extensionDir);
    const extensionArgs = config.loadExtension
      ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
      : [];
    const context = await chromium.launchPersistentContext(path.resolve(materialConfig.profileDir || config.profileDir), {
      channel: "chrome",
      headless: Boolean(config.headless),
      locale: config.locale,
      timezoneId: config.timezoneId,
      viewport: { width: 1440, height: 980 },
      args: extensionArgs
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const targetUrl = config.materialMonitor?.url || "";
    if (targetUrl) await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    return {
      pages: async () => context.pages(),
      connectPage: async (targetPage) => targetPage,
      close: () => context.close()
    };
  }

  return {
    pages: async () => {
      const endpoint = materialConfig.cdpEndpoint || config.cdpEndpoint;
      const targets = await fetchCdpTargets(endpoint);
      return targets.filter((target) => target.type === "page").map((target) => new CdpPageTarget(endpoint, target));
    },
    connectPage: async (target) => CdpPage.connect(target),
    openTarget: async (url) => openCdpTarget(materialConfig.cdpEndpoint || config.cdpEndpoint, url),
    close: async () => {}
  };
}

async function printOpenTabs(browserSession) {
  const pages = await browserSession.pages();
  if (pages.length === 0) {
    console.log(`[${PREFIX}] No open pages found.`);
    return;
  }
  for (const [index, page] of pages.entries()) {
    console.log(`[${index + 1}] ${await safeTitle(page)} | ${page.url()}`);
  }
}

async function findTargetPage(browserSession, config) {
  const materialConfig = config.materialMonitor || {};
  let pages = (await browserSession.pages()).filter(isInspectablePage);
  if (pages.length === 0 && materialConfig.url && browserSession.openTarget) {
    await browserSession.openTarget(materialConfig.url);
    await wait(5000);
    pages = (await browserSession.pages()).filter(isInspectablePage);
  }
  if (pages.length === 0) throw new Error("No inspectable Chrome tabs found.");

  let scored = await scorePages(pages, config);
  scored.sort((a, b) => b.score - a.score);
  let best = scored[0];
  if ((!best || best.score <= 0) && materialConfig.url && browserSession.openTarget) {
    console.log(`[${PREFIX}] Could not find a material/creative tab. Opening configured URL...`);
    await browserSession.openTarget(materialConfig.url);
    await wait(5000);
    pages = (await browserSession.pages()).filter(isInspectablePage);
    scored = await scorePages(pages, config);
    scored.sort((a, b) => b.score - a.score);
    best = scored[0];
  }
  if (!best || best.score <= 0) {
    const tabList = scored.map((item, index) => `[${index + 1}] ${item.title} | ${item.url}`).join("\n");
    throw new Error(`Could not find a TikTok material/creative tab. Open tabs:\n${tabList}`);
  }
  if (isTikTokLoginPage(best.url)) throw new Error("Found the TikTok Ads login tab. Complete login in Chrome first, then run the monitor again.");

  const page = await browserSession.connectPage(best.page);
  await page.bringToFront().catch(() => {});
  await page.startNetworkCapture?.(path.resolve(materialConfig.outputDir || config.outputDir || "./logs"), materialConfig.outputPrefix || "material", config);
  return page;
}

async function scorePages(pages, config) {
  const scored = [];
  for (const page of pages) {
    const title = await safeTitle(page);
    const url = page.url();
    scored.push({ page, title, url, score: scorePage({ title, url }, config) });
  }
  return scored;
}

function scorePage({ title, url }, config) {
  const targetUrl = config.materialMonitor?.url || "";
  const target = safelyParseUrl(targetUrl);
  const current = safelyParseUrl(url);
  let score = 0;
  if (!current || current.host !== "ads.tiktok.com") return 0;
  if (isTikTokLoginPage(url)) return 0;
  const materialish = /material|creative|asset|video|素材|创意|广告素材/i.test(`${title} ${url}`);
  const productGmvMax = current.pathname.includes("/gmv-max/dashboard") && current.searchParams.get("type") === "product";
  if (!targetUrl && !materialish && !productGmvMax) return 0;
  if (target && current.pathname === target.pathname) score += 12;
  if (targetUrl && url === targetUrl) score += 20;
  for (const part of config.materialMonitor?.tabMatch?.urlIncludes || []) {
    if (part && url.toLowerCase().includes(part.toLowerCase())) score += 3;
  }
  for (const part of config.materialMonitor?.tabMatch?.titleIncludes || []) {
    if (part && title.toLowerCase().includes(part.toLowerCase())) score += 2;
  }
  if (materialish) score += 12;
  if (productGmvMax) score += 16;
  if (/campaign|adgroup/i.test(url)) score += 4;
  return score;
}

function isInspectablePage(page) {
  const url = page.url();
  return url && !url.startsWith("chrome://") && !url.startsWith("devtools://");
}

async function safeTitle(page) {
  try { return await page.title(); } catch { return ""; }
}

function isTikTokLoginPage(url) {
  const parsed = safelyParseUrl(url);
  return parsed?.host === "ads.tiktok.com" && parsed.pathname.includes("/login");
}

function safelyParseUrl(value) {
  try { return value ? new URL(value) : null; } catch { return null; }
}

async function fetchCdpTargets(endpoint) {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/list`);
  if (!response.ok) throw new Error(`Chrome DevTools returned ${response.status} ${response.statusText}`);
  return response.json();
}

async function openCdpTarget(endpoint, targetUrl) {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Chrome DevTools could not open target: ${response.status} ${response.statusText}`);
  return response.json();
}

class CdpPageTarget {
  constructor(endpoint, target) {
    this.endpoint = endpoint;
    this.target = target;
  }
  url() { return this.target.url || ""; }
  async title() { return this.target.title || ""; }
}

class CdpPage {
  constructor(target, socket) {
    this.target = target;
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.networkRequests = new Map();
    this.networkOutputDir = null;
    this.outputPrefix = "material";
    this.socket.addEventListener("message", (event) => this.onMessage(event));
  }

  static async connect(pageTarget) {
    if (!pageTarget.target.webSocketDebuggerUrl) throw new Error(`Target has no webSocketDebuggerUrl: ${pageTarget.url()}`);
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
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
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

  async startNetworkCapture(outputDir, outputPrefix = "material", config = {}) {
    this.networkOutputDir = outputDir;
    this.outputPrefix = outputPrefix;
    this.writeLocalNetworkFiles = shouldWriteLocalFiles(config);
    this.remoteNetworkSink = createAppsScriptSink(config, { source: "material-monitor-cdp" });
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
      source: "material-monitor-cdp",
      ...entry
    };
    await appendRemoteNetworkJsonl(this.remoteNetworkSink, `${this.outputPrefix}-network`, enriched);
    if (this.writeLocalNetworkFiles) {
      await fs.appendFile(path.join(this.networkOutputDir, `${this.outputPrefix}-network.jsonl`), `${JSON.stringify(enriched)}\n`, "utf8");
    }
    if (entry.kind === "network_exchange") {
      await appendRemoteNetworkJsonl(this.remoteNetworkSink, `${this.outputPrefix}-network-exchanges`, enriched);
      if (this.writeLocalNetworkFiles) {
        await fs.appendFile(path.join(this.networkOutputDir, `${this.outputPrefix}-network-exchanges.jsonl`), `${JSON.stringify(enriched)}\n`, "utf8");
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
  url() { return this.target.url || ""; }
  async title() { return (await this.evaluate(() => document.title)) || this.target.title || ""; }
  async bringToFront() { await this.command("Page.bringToFront"); }
  async reload(options = {}) { await this.command("Page.reload", { ignoreCache: true }); await this.waitForTimeout(options.timeout ? Math.min(options.timeout, 8000) : 8000); }
  async goto(url, options = {}) { await this.command("Page.navigate", { url }); await this.waitForTimeout(options.timeout ? Math.min(options.timeout, 8000) : 8000); }
  async waitForTimeout(ms) { await wait(ms); }
  async evaluate(fn, arg) {
    const expression = `(${fn})(${JSON.stringify(arg)})`;
    const result = await this.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Evaluation failed");
    return result.result?.value;
  }
  async screenshot({ path: screenshotPath }) {
    const result = await this.command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
    await fs.writeFile(screenshotPath, result.data, "base64");
  }
  async close() { this.socket.close(); }
}

async function appendRemoteNetworkJsonl(sink, stream, record) {
  if (!sink) return;
  try {
    await sink.appendJsonl(stream, record);
  } catch (error) {
    console.warn(`[${PREFIX}] Network remote sync skipped for ${stream}: ${error.message}`);
  }
}

async function collectOnce(page, config, outputDir) {
  const materialConfig = config.materialMonitor || {};
  const prefix = materialConfig.outputPrefix || "material";
  const timestamp = new Date().toISOString();
  console.log(`[${PREFIX}] ${timestamp} refreshing material evidence page...`);

  await page.reload({ waitUntil: "networkidle", timeout: 120_000 }).catch(async () => page.reload());
  await acceptVisibleDialogs(page);
  await waitForMaterialSignals(page, materialConfig.waitSignals || []);

  const record = await page.evaluate(extractMaterialRecord, {
    labels: materialConfig.labels || {},
    selectors: materialConfig.selectors || {}
  });

  const result = {
    timestamp,
    url: record.url,
    title: record.title,
    routeState: record.routeState,
    summary: record.summary,
    rankingState: record.rankingState,
    materials: normalizeMaterials(record.materials || [])
  };

  const writeLocalFiles = shouldWriteLocalFiles(config);
  await appendAppsScriptJsonl(config, `${prefix}-records`, result, { source: "material-monitor" });
  const pageSnapshot = {
    kind: "page_snapshot",
    source: "material-monitor-cdp",
    timestamp,
    url: result.url,
    title: result.title,
    routeState: result.routeState,
    summary: result.summary,
    rankingState: result.rankingState,
    materialCount: result.materials.length
  };
  await appendAppsScriptJsonl(config, `${prefix}-page-snapshots`, pageSnapshot, { source: "material-monitor" });
  if (writeLocalFiles) {
    await appendJsonl(path.join(outputDir, `${prefix}-records.jsonl`), result);
    await appendJsonl(path.join(outputDir, `${prefix}-page-snapshots.jsonl`), pageSnapshot);
    await appendMaterialCsv(path.join(outputDir, `${prefix}-records.csv`), result);
  }

  if (result.materials.length === 0) {
    const safeStamp = timestamp.replace(/[:.]/g, "-");
    await appendAppsScriptJsonl(config, `${prefix}-debug`, { timestamp, bodyText: record.bodyText || "", summary: result.summary }, { source: "material-monitor" });
    if (writeLocalFiles) {
      await fs.writeFile(path.join(outputDir, `${prefix}-debug-${safeStamp}.txt`), record.bodyText || "", "utf8");
      await page.screenshot({ path: path.join(outputDir, `${prefix}-debug-${safeStamp}.png`), fullPage: true }).catch(() => {});
    }
    console.warn(`[${PREFIX}] No material rows found; saved debug text/screenshot for selector tuning.`);
    return;
  }

  console.log(`[${PREFIX}] Saved ${result.materials.length} material row(s). Signals: ${(result.summary.visibleSignals || []).join(", ") || "-"}`);
}

function normalizeMaterials(materials) {
  return materials.map((material, index) => {
    const metrics = material.metrics || {};
    const spend = numberOrNull(metrics.spend);
    const revenue = numberOrNull(metrics.revenue);
    const impressions = numberOrNull(metrics.impressions);
    const clicks = numberOrNull(metrics.clicks);
    const orders = numberOrNull(metrics.orders);
    return {
      ...material,
      index: Number(material.index || index + 1),
      key: material.key || material.materialId || `${material.name || "material"}|${index + 1}`,
      metrics: {
        ...metrics,
        spend,
        revenue,
        impressions,
        clicks,
        orders,
        roi: numberOrNull(metrics.roi) ?? (spend > 0 && revenue != null ? round(revenue / spend) : null),
        ctr: numberOrNull(metrics.ctr) ?? (impressions > 0 && clicks != null ? round((clicks / impressions) * 100) : null),
        cvr: numberOrNull(metrics.cvr) ?? (clicks > 0 && orders != null ? round((orders / clicks) * 100) : null),
        cpc: numberOrNull(metrics.cpc) ?? (clicks > 0 && spend != null ? round(spend / clicks) : null),
        cpm: numberOrNull(metrics.cpm) ?? (impressions > 0 && spend != null ? round((spend / impressions) * 1000) : null),
        cpa: numberOrNull(metrics.cpa) ?? (orders > 0 && spend != null ? round(spend / orders) : null),
        bid: numberOrNull(metrics.bid),
        rankScore: numberOrNull(metrics.rankScore),
        rank: numberOrNull(metrics.rank)
      }
    };
  });
}

async function waitForMaterialSignals(page, signals, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await page.evaluate((expectedSignals) => {
      const bodyText = (document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
      return {
        hasSignal: expectedSignals.some((signal) => bodyText.includes(signal)),
        hasRows: Array.from(document.querySelectorAll("tr, [role='row']")).some((row) => /material|素材|creative|创意|video|视频|MYR|ROI/i.test(row.innerText || row.textContent || "")),
        hasEmptyState: /No data|No results|暂无|没有数据|System error/i.test(bodyText),
        length: bodyText.length
      };
    }, signals).catch(() => null);

    if (lastState?.hasSignal || lastState?.hasRows || lastState?.hasEmptyState) return lastState;
    await page.waitForTimeout(3000);
  }
  console.warn(`[${PREFIX}] Timed out waiting for material signals. Last state: ${JSON.stringify(lastState)}`);
  return lastState;
}

async function acceptVisibleDialogs(page) {
  const buttons = ["Accept all", "Accept", "同意", "接受", "我知道了", "Got it"];
  await page.evaluate((names) => {
    const elements = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const element of elements) {
      const text = (element.innerText || element.textContent || "").trim();
      if (names.some((name) => text.includes(name))) element.click();
    }
  }, buttons).catch(() => {});
}

async function appendJsonl(filePath, value) {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function appendMaterialCsv(filePath, result) {
  const exists = await fileExists(filePath);
  if (!exists) {
    await fs.appendFile(filePath, "timestamp,index,key,material_id,name,status,spend,revenue,orders,impressions,clicks,roi,ctr,cvr,cpc,cpm,cpa,bid,rank_score,rank,url\n", "utf8");
  }
  for (const material of result.materials || []) {
    const metrics = material.metrics || {};
    const row = [
      result.timestamp,
      material.index,
      material.key,
      material.materialId,
      material.name,
      material.status,
      metrics.spend,
      metrics.revenue,
      metrics.orders,
      metrics.impressions,
      metrics.clicks,
      metrics.roi,
      metrics.ctr,
      metrics.cvr,
      metrics.cpc,
      metrics.cpm,
      metrics.cpa,
      metrics.bid,
      metrics.rankScore,
      metrics.rank,
      result.url
    ].map(csvCell);
    await fs.appendFile(filePath, `${row.join(",")}\n`, "utf8");
  }
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
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
  /ads\.tiktok\.com\/api\/.+(?:gmv|max|campaign|adgroup|material|creative|asset|video|rank|bid|recommend|diagnos|delivery|traffic|auction|stat|report|estimate|predict)/i,
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
  if (/creative|material|asset|video/.test(key)) return "creative_material";
  if (/bid|auction|rank|delivery|traffic|estimate|predict/.test(key)) return "delivery_signal";
  if (/recommend|diagnos|suggest/.test(key)) return "recommendation";
  if (/campaign|adgroup|ad_plan/.test(key)) return "campaign_control";
  if (/report|stat|analytics/.test(key)) return "performance_report";
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

function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
