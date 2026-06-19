import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const assetsDir = path.join(projectRoot, "logs", "data-analytics-report-2026-06-04", "assets");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const charts = [
  ["allocation-share.html", "allocation-share.png", "980,560"],
  ["window-share-trend.html", "window-share-trend.png", "1100,600"],
  ["roi-gap-scatter.html", "roi-gap-scatter.png", "980,600"],
  ["endpoint-family.html", "endpoint-family.png", "980,600"]
];

for (const [html, png, size] of charts) {
  await screenshotChart(html, png, size);
}

async function screenshotChart(htmlName, pngName, windowSize) {
  const htmlPath = path.join(assetsDir, htmlName);
  const pngPath = path.join(assetsDir, pngName);
  const userDataDir = path.join("/private/tmp", `gmvmax-report-chrome-${pngName.replace(/\W+/g, "-")}`);
  await fsp.mkdir(userDataDir, { recursive: true });

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=1500",
    `--user-data-dir=${userDataDir}`,
    `--screenshot=${pngPath}`,
    `--window-size=${windowSize}`,
    pathToFileURL(htmlPath).href
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve();
    }, 12000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code && code !== 0 && !output.includes("bytes written to file")) {
        reject(new Error(`Chrome screenshot failed for ${htmlName}: ${output}`));
        return;
      }
      resolve();
    });
  });

  const stat = await fsp.stat(pngPath);
  console.log(`${pngName}: ${stat.size} bytes`);
}
