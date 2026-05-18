import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

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
    totalOrderAmount: ""
  }
};

const LABELS = {
  newSpend: ["新增消耗", "New spend", "Additional spend"],
  newOrderAmount: ["新增成交金额", "新增成交额", "New GMV", "New revenue"],
  totalSpend: ["总消耗", "Total spend"],
  totalOrderAmount: ["总成交金额", "总成交额", "Total GMV", "Total revenue"]
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
    await printOpenTabs(browserSession.browser);
    await browserSession.close();
    return;
  }

  const page = await findTargetPage(browserSession.browser, config);
  console.log(`[GMVMAX] Attached tab: ${await page.title()} | ${page.url()}`);

  console.log(`[GMVMAX] Started. Refresh interval: ${config.intervalMinutes} minute(s).`);
  console.log("[GMVMAX] Monitoring the existing Chrome tab. Keep that tab open while the script runs.");

  do {
    await collectOnce(page, config, outputDir);
    if (once) break;
    await wait(intervalMs);
  } while (true);

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
    tabMatch: {
      ...base.tabMatch,
      ...(override.tabMatch || {})
    },
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
      browser: { contexts: () => [context] },
      close: () => context.close()
    };
  }

  try {
    const browser = await chromium.connectOverCDP(config.cdpEndpoint);
    return {
      browser,
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

async function printOpenTabs(browser) {
  const pages = allPages(browser);
  if (pages.length === 0) {
    console.log("[GMVMAX] No open pages found.");
    return;
  }

  for (const [index, page] of pages.entries()) {
    console.log(`[${index + 1}] ${await safeTitle(page)} | ${page.url()}`);
  }
}

async function findTargetPage(browser, config) {
  const pages = allPages(browser).filter((page) => isInspectablePage(page));
  if (pages.length === 0) {
    throw new Error("No inspectable Chrome tabs found.");
  }

  const scored = [];
  for (const page of pages) {
    const title = await safeTitle(page);
    const url = page.url();
    const score = scorePage({ title, url }, config);
    scored.push({ page, title, url, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) {
    const tabList = scored.map((item, index) => `[${index + 1}] ${item.title} | ${item.url}`).join("\n");
    throw new Error(`Could not find the TikTok GMV Max tab. Open tabs:\n${tabList}`);
  }

  await best.page.bringToFront().catch(() => {});
  return best.page;
}

function allPages(browser) {
  return browser.contexts().flatMap((context) => context.pages());
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

async function collectOnce(page, config, outputDir) {
  const timestamp = new Date().toISOString();
  console.log(`[GMVMAX] ${timestamp} refreshing dashboard...`);

  await page.reload({ waitUntil: "networkidle", timeout: 120_000 });

  await acceptVisibleDialogs(page);
  await page.waitForTimeout(5000);

  const record = await page.evaluate(
    ({ labels, selectors }) => {
      const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
      const moneyRe = /(?:[$￥¥]|MYR|RM|USD|CNY|RMB)?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/;

      function firstText(selector, root = document) {
        if (!selector) return null;
        const node = root.querySelector(selector);
        return node ? textOf(node) : null;
      }

      function valueAfterLabel(labelOptions) {
        const all = Array.from(document.querySelectorAll("body *"));
        for (const node of all) {
          const ownText = textOf(node);
          if (!ownText || ownText.length > 500) continue;
          if (!labelOptions.some((label) => ownText.includes(label))) continue;

          const localMatch = ownText.replace(labelOptions.find((label) => ownText.includes(label)), "").match(moneyRe);
          if (localMatch) return localMatch[0].trim();

          const parent = node.parentElement;
          if (!parent) continue;
          const siblings = Array.from(parent.children);
          const index = siblings.indexOf(node);
          const candidates = siblings.slice(index + 1).concat(Array.from(parent.querySelectorAll("*")));
          for (const candidate of candidates) {
            const match = textOf(candidate).match(moneyRe);
            if (match) return match[0].trim();
          }
        }
        return null;
      }

      function extractBySelectors() {
        if (!selectors.planRows) return [];
        return Array.from(document.querySelectorAll(selectors.planRows)).map((row, index) => ({
          index: index + 1,
          name: firstText(selectors.planName, row) || `plan-${index + 1}`,
          newSpend: firstText(selectors.newSpend, row),
          newOrderAmount: firstText(selectors.newOrderAmount, row),
          totalSpend: firstText(selectors.totalSpend, row),
          totalOrderAmount: firstText(selectors.totalOrderAmount, row)
        }));
      }

      const metrics = Object.fromEntries(
        Object.entries(labels).map(([key, labelOptions]) => [key, valueAfterLabel(labelOptions)])
      );

      return {
        url: location.href,
        title: document.title,
        metrics,
        plans: extractBySelectors(),
        bodyText: textOf(document.body).slice(0, 20000)
      };
    },
    { labels: LABELS, selectors: config.selectors }
  );

  const result = {
    timestamp,
    url: record.url,
    title: record.title,
    liveGmvMax: record.metrics,
    plans: record.plans
  };

  await appendJsonl(path.join(outputDir, "gmvmax-records.jsonl"), result);
  await appendCsv(path.join(outputDir, "gmvmax-records.csv"), result);

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

async function acceptVisibleDialogs(page) {
  const buttons = ["Accept all", "Accept", "同意", "接受", "我知道了", "Got it"];
  for (const name of buttons) {
    const button = page.getByRole("button", { name, exact: false }).first();
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      await button.click().catch(() => {});
    }
  }
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
    result.url
  ].map(csvCell);

  if (!exists) {
    await fs.appendFile(
      filePath,
      "timestamp,new_spend,new_order_amount,total_spend,total_order_amount,url\n",
      "utf8"
    );
  }
  await fs.appendFile(filePath, `${row.join(",")}\n`, "utf8");
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
