import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "chrome-extension");
const profileDir = path.join(rootDir, "chrome-profile-gmvmax-live");
const targetUrl = process.env.GMVMAX_MONITOR_URL || "https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=7529709300881686546&is_refresh_page=true&oec_seller_id=7494989238589884894&bc_id=7362608187637366800&activated_tab_id=2&type=live&live_campaign_page=1&live_campaign_page_size=10&list_start_date=1780623169560&list_end_date=1780623169560";

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1470, height: 956 },
  locale: "zh-CN",
  timezoneId: "Asia/Kuala_Lumpur",
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ]
});

const page = context.pages()[0] || await context.newPage();
await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120000 }).catch((error) => {
  console.warn(`[GMVMAX] Initial navigation warning: ${error.message}`);
});

console.log(`[GMVMAX] Chrome extension monitor launched.`);
console.log(`[GMVMAX] Extension: ${extensionDir}`);
console.log(`[GMVMAX] Profile: ${profileDir}`);
console.log(`[GMVMAX] URL: ${targetUrl}`);
console.log(`[GMVMAX] If TikTok shows login, complete login in the opened Chrome window. The extension will start uploading after the GMV Max page loads.`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await context.close().catch(() => {});
    process.exit(0);
  });
}

await new Promise(() => {});
