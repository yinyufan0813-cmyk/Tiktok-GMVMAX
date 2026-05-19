import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.GMVMAX_MOBILE_PORT || 8788);
const host = process.env.GMVMAX_MOBILE_HOST || "0.0.0.0";
const csvPath = path.join(rootDir, "logs", "gmvmax-plan-records.csv");

const staticFiles = {
  "/": { file: "mobile.html", type: "text/html; charset=utf-8" },
  "/mobile.html": { file: "mobile.html", type: "text/html; charset=utf-8" },
  "/mobile.webmanifest": { file: "mobile.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/mobile-sw.js": { file: "mobile-sw.js", type: "text/javascript; charset=utf-8" }
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows.map(values => Object.fromEntries(headers.map((key, index) => [key, values[index] || ""])));
}

function numberFromMoney(value) {
  const match = String(value || "").replaceAll(",", "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function roi(orderAmount, spend) {
  return spend ? orderAmount / spend : null;
}

function metric(value, previousValue) {
  const diff = value - previousValue;
  const direction = diff > 0.004 ? "up" : diff < -0.004 ? "down" : "flat";
  return { value, diff, direction };
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + numberFromMoney(row[field]), 0);
}

function buildPayload(rows) {
  const timestamps = [...new Set(rows.map(row => row.timestamp).filter(Boolean))];
  const currentTs = timestamps.at(-1) || null;
  const previousTs = timestamps.at(-2) || null;
  const currentRows = rows.filter(row => row.timestamp === currentTs);
  const previousRows = rows.filter(row => row.timestamp === previousTs);
  const previousByAccount = new Map(previousRows.map(row => [row.account || row.campaign, row]));

  const accounts = currentRows.map((row, index) => {
    const key = row.account || row.campaign || `账号 ${index + 1}`;
    const previous = previousByAccount.get(key) || {};
    const intervalSpend = numberFromMoney(row.interval_spend_increase);
    const intervalOrder = numberFromMoney(row.interval_order_amount_increase);
    const totalSpend = numberFromMoney(row.total_spend);
    const totalOrder = numberFromMoney(row.total_order_amount);
    const previousIntervalSpend = numberFromMoney(previous.interval_spend_increase);
    const previousIntervalOrder = numberFromMoney(previous.interval_order_amount_increase);
    const previousTotalSpend = numberFromMoney(previous.total_spend);
    const previousTotalOrder = numberFromMoney(previous.total_order_amount);
    const intervalRoi = roi(intervalOrder, intervalSpend);
    const totalRoi = roi(totalOrder, totalSpend);
    const previousIntervalRoi = roi(previousIntervalOrder, previousIntervalSpend);
    const previousTotalRoi = roi(previousTotalOrder, previousTotalSpend);

    return {
      account: key,
      campaign: row.campaign || "",
      intervalSpend: metric(intervalSpend, previousIntervalSpend),
      intervalOrder: metric(intervalOrder, previousIntervalOrder),
      intervalRoi: metric(intervalRoi ?? 0, previousIntervalRoi ?? 0),
      totalSpend: metric(totalSpend, previousTotalSpend),
      totalOrder: metric(totalOrder, previousTotalOrder),
      totalRoi: metric(totalRoi ?? 0, previousTotalRoi ?? 0)
    };
  });

  const intervalSpend = sum(currentRows, "interval_spend_increase");
  const intervalOrder = sum(currentRows, "interval_order_amount_increase");
  const totalSpend = sum(currentRows, "total_spend");
  const totalOrder = sum(currentRows, "total_order_amount");
  const previousIntervalSpend = sum(previousRows, "interval_spend_increase");
  const previousIntervalOrder = sum(previousRows, "interval_order_amount_increase");
  const previousTotalSpend = sum(previousRows, "total_spend");
  const previousTotalOrder = sum(previousRows, "total_order_amount");

  return {
    updatedAt: currentTs,
    previousAt: previousTs,
    accountCount: accounts.length,
    summary: {
      intervalSpend: metric(intervalSpend, previousIntervalSpend),
      intervalOrder: metric(intervalOrder, previousIntervalOrder),
      intervalRoi: metric(roi(intervalOrder, intervalSpend) ?? 0, roi(previousIntervalOrder, previousIntervalSpend) ?? 0),
      totalSpend: metric(totalSpend, previousTotalSpend),
      totalOrder: metric(totalOrder, previousTotalOrder),
      totalRoi: metric(roi(totalOrder, totalSpend) ?? 0, roi(previousTotalOrder, previousTotalSpend) ?? 0)
    },
    accounts
  };
}

async function latestData() {
  const text = await fs.readFile(csvPath, "utf8");
  return buildPayload(parseCsv(text));
}

function localUrls() {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${port}/`);
      }
    }
  }
  return urls;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  try {
    if (url.pathname === "/api/latest") {
      const payload = await latestData();
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*"
      });
      response.end(JSON.stringify(payload));
      return;
    }

    const staticFile = staticFiles[url.pathname];
    if (staticFile) {
      const content = await fs.readFile(path.join(rootDir, staticFile.file), "utf8");
      response.writeHead(200, {
        "content-type": staticFile.type,
        "cache-control": "no-store"
      });
      response.end(content);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`GMV Max mobile app server running on http://127.0.0.1:${port}/`);
  for (const url of localUrls()) console.log(`iPhone URL: ${url}`);
});
