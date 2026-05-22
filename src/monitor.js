import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { extractGmvMaxRecord } from "./extract-gmvmax.js";

const DEFAULT_CONFIG = {
  url: "",
  mode: "attach",
  cdpEndpoint: "http://127.0.0.1:9222",
  intervalMinutes: 10,
  headless: false,
  profileDir: "./chrome-profile",
  outputDir: "./logs",
  locale: "zh-CN",
  timezoneId: "Asia/Kuala_Lumpur",
  accountOrder: ["YOUMILIER KLASIK", "YOUMILIER FASHION", "YOUMILIER"],
  tabMatch: {
    urlIncludes: ["ads.tiktok.com", "gmv-max/dashboard", "type=live"],
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
  const config = await loadConfig();
  const once = args.has("--once");
  const listTabs = args.has("--list-tabs");
  const intervalMs = Math.max(1, Number(config.intervalMinutes || 10)) * 60 * 1000;
  const outputDir = path.resolve(config.outputDir);

  await fs.mkdir(outputDir, { recursive: true });

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
    selectors: {
      ...base.selectors,
      ...(override.selectors || {})
    }
  };
}

async function getBrowserSession(config) {
  if (config.mode === "launch") {
    await fs.mkdir(path.resolve(config.profileDir), { recursive: true });
    const context = await chromium.launchPersistentContext(path.resolve(config.profileDir), {
      channel: "chrome",
      headless: Boolean(config.headless),
      locale: config.locale,
      timezoneId: config.timezoneId,
      viewport: { width: 1440, height: 980 }
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
    return page;
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
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

  command(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

async function collectOnce(page, config, outputDir) {
  const timestamp = new Date().toISOString();
  console.log(`[GMVMAX] ${timestamp} refreshing dashboard...`);

  const targetUrl = refreshDashboardUrl(page.url(), config.url);
  if (targetUrl) {
    console.log("[GMVMAX] Navigating to current LIVE GMV Max window...");
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 120_000 }).catch(async () => {
      await page.goto(targetUrl);
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
    plans: record.plans,
    pageState: record.pageState
  };

  if (!Array.isArray(result.plans) || result.plans.length === 0) {
    const safeStamp = timestamp.replace(/[:.]/g, "-");
    await fs.writeFile(path.join(outputDir, `debug-${safeStamp}.txt`), record.bodyText, "utf8");
    await page.screenshot({ path: path.join(outputDir, `debug-${safeStamp}.png`), fullPage: true });
    console.warn(
      `[GMVMAX] No LIVE GMV Max plans found; skipped writing stale data. Page state: ${JSON.stringify(result.pageState)}`
    );
    return;
  }

  await enrichPlanIncrements(path.join(outputDir, "gmvmax-records.jsonl"), result, config.accountOrder);
  await appendJsonl(path.join(outputDir, "gmvmax-records.jsonl"), result);
  await appendCsv(path.join(outputDir, "gmvmax-records.csv"), result);
  await appendPlanCsv(path.join(outputDir, "gmvmax-plan-records.csv"), result);

  const missing = Object.entries(result.liveGmvMax).filter(([, value]) => !value);
  if (missing.length > 0) {
    const safeStamp = timestamp.replace(/[:.]/g, "-");
    await fs.writeFile(path.join(outputDir, `debug-${safeStamp}.txt`), record.bodyText, "utf8");
    await page.screenshot({ path: path.join(outputDir, `debug-${safeStamp}.png`), fullPage: true });
    console.warn(`[GMVMAX] Some metrics were not found: ${missing.map(([key]) => key).join(", ")}`);
    console.warn("[GMVMAX] Saved debug text and screenshot in logs/. Add CSS selectors in config.json if needed.");
  }

  console.log(`[GMVMAX] Saved: ${JSON.stringify(result.liveGmvMax)}`);
}

async function waitForLivePlans(page, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await page
      .evaluate(() => {
        const bodyText = (document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
        return {
          hasPlan: bodyText.includes("LIVE GMV Max_") && bodyText.includes("MYR") && bodyText.includes(" ID:"),
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

async function enrichPlanIncrements(historyPath, result, accountOrder = []) {
  const previous = await readLatestRecordWithPlans(historyPath);
  const previousByAccount = new Map(
    (previous?.plans || [])
      .filter((plan) => plan.account)
      .map((plan) => [plan.account, plan])
  );
  const currentAccounts = new Set((result.plans || []).map((plan) => plan.account).filter(Boolean));

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

function accountRank(account, accountOrder = []) {
  const index = accountOrder.indexOf(account);
  return index === -1 ? accountOrder.length : index;
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
