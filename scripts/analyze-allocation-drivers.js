import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const logsDir = path.join(projectRoot, "logs");
const startUtc = Date.UTC(2026, 5, 3, 16, 0, 0);
const endUtc = Date.now();
const minGapMs = 45 * 1000;
const maxGapMs = 30 * 60 * 1000;

const decisions = (await readJsonl(path.join(logsDir, "gmvmax-decision-snapshots.jsonl")))
  .filter((row) => inRange(row.timestamp))
  .map(normalizeDecision)
  .filter((row) => row.campaigns.length)
  .sort((a, b) => a.ms - b.ms);

const pages = (await readJsonl(path.join(logsDir, "gmvmax-page-snapshots.jsonl")))
  .filter((row) => inRange(row.timestamp || row.collectorTimestamp))
  .map(normalizePage)
  .filter((row) => row.rows.length)
  .sort((a, b) => a.ms - b.ms);

const rows = buildRows(decisions, pages);
const activeRows = rows.filter((row) => row.windowSpend > 0 && row.spendDelta > 0);
const features = [
  "targetRoi",
  "bidHeadroom",
  "roiGap",
  "visibleRoi",
  "budget",
  "previousSpend",
  "previousCumulativeShare",
  "lagSpendShare",
  "lagDeltaRoi"
];

const result = {
  generatedAt: new Date().toISOString(),
  latestDecisionLocal: decisions.at(-1) ? fmtDateTime(decisions.at(-1).ms) : null,
  observationRows: activeRows.length,
  windows: new Set(activeRows.map((row) => row.windowKey)).size,
  campaignMix: summarizeCampaignMix(activeRows),
  globalCorrelation: Object.fromEntries(features.map((feature) => [feature, corr(activeRows, feature, "spendShare")])),
  withinCampaignCorrelation: Object.fromEntries(features.map((feature) => [feature, withinCorr(activeRows, feature, "spendShare")])),
  oneVariableModels: Object.fromEntries(features.map((feature) => [feature, oneVarModel(activeRows, feature, "spendShare")])),
  accountModel: accountModel(activeRows),
  accountPlusWithinModel: accountPlusWithinModel(activeRows),
  latestWindows: summarizeLatestWindows(activeRows),
  interpretation: interpret()
};

const outputPath = path.join(logsDir, "gmvmax-allocation-driver-analysis.json");
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
console.log(`Wrote ${outputPath}`);

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.split(/\n+/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function normalizeDecision(snapshot) {
  const campaigns = (snapshot.campaigns || []).map((campaign) => {
    const account = campaign.account || inferAccount(campaign.name);
    const name = normalizeName(campaign.name || account);
    const spend = num(campaign.totalSpend ?? campaign.netCost ?? campaign.cost ?? campaign.spend ?? campaign.netSpend);
    const revenue = num(campaign.totalOrderAmount ?? campaign.revenue);
    return {
      key: `${name}|${account}`,
      name,
      account,
      spend,
      revenue,
      budget: num(campaign.totalBudget ?? campaign.budget),
      roi: spend > 0 ? revenue / spend : null
    };
  });
  return {
    timestamp: snapshot.timestamp,
    ms: Date.parse(snapshot.timestamp),
    campaigns
  };
}

function normalizePage(snapshot) {
  const rows = [];
  for (const row of snapshot.tableState?.rows || []) {
    const cells = row.cells || [];
    if (!cells.length || cells[0] === "开/关" || cells[0] === "广告计划名称") continue;
    const account = (cells[7] || "").replace(/\s+ID:.*/, "").trim() || inferAccount(cells[0]);
    const name = normalizeName(cells[0]);
    rows.push({
      key: `${name}|${account}`,
      name,
      account,
      status: cells[1],
      budget: num(cells[2]),
      spend: num(cells[3]),
      revenue: num(cells[4]),
      targetRoi: num(cells[5]),
      visibleRoi: num(cells[6])
    });
  }
  return {
    ms: Date.parse(snapshot.timestamp || snapshot.collectorTimestamp),
    timestamp: snapshot.timestamp || snapshot.collectorTimestamp,
    rows
  };
}

function buildRows(snapshots, pageSnapshots) {
  const out = [];
  const priorByCampaign = new Map();
  for (let index = 1; index < snapshots.length; index += 1) {
    const prev = snapshots[index - 1];
    const cur = snapshots[index];
    const gap = cur.ms - prev.ms;
    if (gap < minGapMs || gap > maxGapMs) continue;

    const prevMap = new Map(prev.campaigns.map((campaign) => [campaign.key, campaign]));
    const currentRows = [];
    for (const campaign of cur.campaigns) {
      const before = prevMap.get(campaign.key);
      if (!before) continue;
      const page = nearestPage(pageSnapshots, prev.ms, campaign.key);
      const spendDelta = Math.max(0, campaign.spend - before.spend);
      const revenueDelta = Math.max(0, campaign.revenue - before.revenue);
      const previousTotalSpend = prev.campaigns.reduce((sum, row) => sum + (row.spend || 0), 0);
      const prior = priorByCampaign.get(campaign.key);
      currentRows.push({
        windowKey: `${prev.timestamp}->${cur.timestamp}`,
        from: prev.timestamp,
        to: cur.timestamp,
        toLocal: fmtDateTime(cur.ms),
        account: campaign.account,
        key: campaign.key,
        spendDelta,
        revenueDelta,
        deltaRoi: spendDelta > 0 ? revenueDelta / spendDelta : null,
        previousSpend: before.spend,
        previousRevenue: before.revenue,
        previousCumulativeShare: previousTotalSpend > 0 ? before.spend / previousTotalSpend : null,
        targetRoi: page?.targetRoi ?? null,
        bidHeadroom: page?.targetRoi > 0 ? 1 / page.targetRoi : null,
        visibleRoi: page?.visibleRoi ?? before.roi,
        roiGap: page?.targetRoi > 0 && page?.visibleRoi != null ? page.visibleRoi - page.targetRoi : null,
        budget: page?.budget ?? before.budget,
        lagSpendShare: prior?.spendShare ?? null,
        lagDeltaRoi: prior?.deltaRoi ?? null
      });
    }

    const windowSpend = currentRows.reduce((sum, row) => sum + row.spendDelta, 0);
    const windowRevenue = currentRows.reduce((sum, row) => sum + row.revenueDelta, 0);
    for (const row of currentRows) {
      const enriched = {
        ...row,
        windowSpend,
        windowRevenue,
        spendShare: windowSpend > 0 ? row.spendDelta / windowSpend : 0
      };
      out.push(enriched);
      priorByCampaign.set(row.key, enriched);
    }
  }
  return out;
}

function nearestPage(pageSnapshots, ms, key) {
  let best = null;
  let bestGap = Infinity;
  for (const page of pageSnapshots) {
    const gap = Math.abs(page.ms - ms);
    if (gap > 2 * 60 * 1000 || gap >= bestGap) continue;
    const row = page.rows.find((candidate) => candidate.key === key);
    if (!row) continue;
    best = row;
    bestGap = gap;
  }
  return best;
}

function summarizeCampaignMix(rows) {
  const total = rows.reduce((sum, row) => sum + row.spendDelta, 0);
  return [...groupBy(rows, (row) => row.account).entries()].map(([account, group]) => ({
    account,
    rows: group.length,
    spendDelta: round(group.reduce((sum, row) => sum + row.spendDelta, 0)),
    spendShare: round(group.reduce((sum, row) => sum + row.spendDelta, 0) / total, 4),
    avgWindowShare: round(avg(group.map((row) => row.spendShare)), 4),
    avgTargetRoi: round(avg(group.map((row) => row.targetRoi).filter(finite)), 2),
    avgVisibleRoi: round(avg(group.map((row) => row.visibleRoi).filter(finite)), 2),
    avgRoiGap: round(avg(group.map((row) => row.roiGap).filter(finite)), 2)
  })).sort((a, b) => b.spendDelta - a.spendDelta);
}

function summarizeLatestWindows(rows) {
  const windows = [...groupBy(rows, (row) => row.windowKey).values()].slice(-6);
  return windows.map((windowRows) => ({
    toLocal: windowRows[0].toLocal,
    windowSpend: round(windowRows[0].windowSpend),
    windowRoi: round(windowRows[0].windowRevenue / windowRows[0].windowSpend, 2),
    shares: windowRows
      .map((row) => ({
        account: row.account,
        spendShare: round(row.spendShare, 4),
        spendDelta: round(row.spendDelta),
        visibleRoi: round(row.visibleRoi, 2),
        targetRoi: round(row.targetRoi, 2),
        roiGap: round(row.roiGap, 2)
      }))
      .sort((a, b) => b.spendShare - a.spendShare)
  }));
}

function oneVarModel(rows, xKey, yKey) {
  const pairs = rows.map((row) => [row[xKey], row[yKey]]).filter(([x, y]) => finite(x) && finite(y));
  if (pairs.length < 4) return { n: pairs.length, r2: null, slope: null };
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const b = covariance(xs, ys) / variance(xs);
  const a = avg(ys) - b * avg(xs);
  const preds = xs.map((x) => a + b * x);
  return { n: pairs.length, r2: round(rSquared(ys, preds), 4), slope: round(b, 5) };
}

function accountModel(rows) {
  const accounts = [...new Set(rows.map((row) => row.account))];
  const y = rows.map((row) => row.spendShare);
  const yMean = avg(y);
  const pred = rows.map((row) => avg(rows.filter((peer) => peer.account === row.account).map((peer) => peer.spendShare)));
  return {
    accounts,
    n: rows.length,
    r2: round(rSquared(y, pred), 4),
    baselineMeanShare: round(yMean, 4)
  };
}

function accountPlusWithinModel(rows) {
  const y = rows.map((row) => row.spendShare);
  const accountMeanPred = rows.map((row) => avg(rows.filter((peer) => peer.account === row.account).map((peer) => peer.spendShare)));
  const residual = rows.map((row, index) => row.spendShare - accountMeanPred[index]);
  const withinFeatures = ["roiGap", "visibleRoi", "previousSpend", "previousCumulativeShare", "lagSpendShare", "lagDeltaRoi"];
  return {
    accountOnlyR2: round(rSquared(y, accountMeanPred), 4),
    residualCorrelation: Object.fromEntries(withinFeatures.map((feature) => {
      const values = rows.map((row) => row[feature]);
      const residualRows = rows.map((row, index) => ({ x: values[index], y: residual[index], account: row.account })).filter((row) => finite(row.x) && finite(row.y));
      return [feature, corr(residualRows, "x", "y")];
    }))
  };
}

function interpret() {
  return [
    "Primary association is account/plan identity plus fixed target-ROI posture.",
    "Lower target ROI maps to higher observed allocation share, consistent with effective-bid headroom.",
    "ROI gap has meaningful global association, but part of it is explained by the KLASIK plan having both low target ROI and high share.",
    "Visible ROI alone is weak globally and should not be treated as the main rank signal.",
    "Budget and cumulative spend are not positive allocation drivers in this sample; they mostly reflect campaign identity and pacing constraints.",
    "Lagged share and lagged delta ROI should be treated as secondary pacing/feedback signals until more 24-hour windows accumulate."
  ];
}

function corr(rows, xKey, yKey) {
  const pairs = rows.map((row) => [row[xKey], row[yKey]]).filter(([x, y]) => finite(x) && finite(y));
  if (pairs.length < 4) return { n: pairs.length, r: null };
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  return { n: pairs.length, r: round(covariance(xs, ys) / Math.sqrt(variance(xs) * variance(ys)), 4) };
}

function withinCorr(rows, xKey, yKey) {
  const residualized = [];
  for (const group of groupBy(rows, (row) => row.account).values()) {
    const valid = group.filter((row) => finite(row[xKey]) && finite(row[yKey]));
    if (valid.length < 3) continue;
    const meanX = avg(valid.map((row) => row[xKey]));
    const meanY = avg(valid.map((row) => row[yKey]));
    residualized.push(...valid.map((row) => ({ x: row[xKey] - meanX, y: row[yKey] - meanY })));
  }
  return corr(residualized, "x", "y");
}

function covariance(xs, ys) {
  const mx = avg(xs);
  const my = avg(ys);
  return xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0);
}

function variance(xs) {
  const mean = avg(xs);
  return xs.reduce((sum, x) => sum + (x - mean) ** 2, 0);
}

function rSquared(y, pred) {
  const mean = avg(y);
  const sst = y.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const sse = y.reduce((sum, value, index) => sum + (value - pred[index]) ** 2, 0);
  return sst > 0 ? 1 - sse / sst : 0;
}

function groupBy(rows, getKey) {
  const map = new Map();
  for (const row of rows) {
    const key = getKey(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value, digits = 2) {
  return finite(value) ? Number(value.toFixed(digits)) : null;
}

function num(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function inRange(timestamp) {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) && ms >= startUtc && ms <= endUtc;
}

function inferAccount(name = "") {
  if (name === "live-plan-1") return "YOUMILIER KLASIK";
  if (name === "live-plan-2") return "YOUMILIER FASHION";
  if (name === "live-plan-3") return "YOUMILIER";
  if (name.includes("20260529215644")) return "YOUMILIER KLASIK";
  if (name.includes("20260521173451")) return "YOUMILIER FASHION";
  if (name.includes("20260519101516")) return "YOUMILIER";
  return null;
}

function normalizeName(name = "") {
  if (name === "live-plan-1") return "LIVE GMV Max_Gross revenue_YOUMILIER_20260529215644";
  if (name === "live-plan-2") return "LIVE GMV Max_Gross revenue_YOUMILIER_20260521173451";
  if (name === "live-plan-3") return "LIVE GMV Max_Gross revenue_YOUMILIER_20260519101516";
  return name;
}

function fmtDateTime(ms) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(ms);
}
