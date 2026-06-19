import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const logsDir = path.join(projectRoot, "logs");
const reportDir = path.join(logsDir, "data-analytics-report-2026-06-04");
const assetsDir = path.join(reportDir, "assets");
const startUtc = Date.UTC(2026, 5, 3, 16, 0, 0);
const endUtc = Date.now();
const dayLabel = "2026-06-04 MYT";
const maxContinuousGapMs = 30 * 60 * 1000;
const minWindowGapMs = 45 * 1000;

const colors = {
  blue: "#5477C4",
  gold: "#B8A037",
  orange: "#CC6F47",
  olive: "#71B436",
  pink: "#BD569B",
  ink: "#1F2430",
  muted: "#6F768A",
  grid: "#E6E8F0",
  panel: "#FFFFFF",
  surface: "#FCFCFD"
};

const campaignPalette = {
  "YOUMILIER KLASIK": colors.blue,
  "YOUMILIER FASHION": colors.orange,
  "YOUMILIER": colors.olive
};

await main();

async function main() {
  await fsp.mkdir(assetsDir, { recursive: true });

  const decisions = (await readJsonl(path.join(logsDir, "gmvmax-decision-snapshots.jsonl")))
    .filter((row) => inRange(row.timestamp))
    .map(normalizeDecisionSnapshot)
    .filter((row) => row.campaigns.length)
    .sort((a, b) => a.ms - b.ms);

  const pageSnapshots = (await readJsonl(path.join(logsDir, "gmvmax-page-snapshots.jsonl")))
    .filter((row) => inRange(row.timestamp || row.collectorTimestamp))
    .map(normalizePageSnapshot)
    .filter((row) => row.rows.length)
    .sort((a, b) => a.ms - b.ms);

  const networkEvidence = await summarizeNetwork(path.join(logsDir, "gmvmax-network-exchanges.jsonl"));
  const transitions = buildTransitions(decisions, pageSnapshots);
  const activeTransitions = transitions.filter((row) => row.windowSpend > 0 && row.spendDelta > 0);
  const windows = buildWindows(transitions).filter((row) => row.totalSpendDelta > 0);
  const campaignSummary = summarizeCampaigns(activeTransitions, decisions.at(-1), pageSnapshots.at(-1));
  const coverage = summarizeCoverage(decisions, pageSnapshots, networkEvidence, windows, activeTransitions);
  const correlations = summarizeCorrelations(activeTransitions);
  const logic = inferLogic({ campaignSummary, windows, correlations, networkEvidence, coverage });

  const chartData = buildChartData({ campaignSummary, windows, activeTransitions, correlations, networkEvidence });
  await writeChartPages(chartData);

  const report = {
    generatedAt: new Date().toISOString(),
    dayLabel,
    startUtc: new Date(startUtc).toISOString(),
    endUtc: new Date(endUtc).toISOString(),
    coverage,
    campaignSummary,
    correlations,
    latestWindow: windows.at(-1) || null,
    networkEvidence,
    logic,
    chartData
  };

  await fsp.writeFile(path.join(reportDir, "report-data.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(reportDir, "report.html"), renderReportHtml(report), "utf8");
  await fsp.writeFile(path.join(reportDir, "report.md"), renderReportMarkdown(report), "utf8");

  console.log(`Report: ${path.join(reportDir, "report.html")}`);
  console.log(`Data: ${path.join(reportDir, "report-data.json")}`);
}

async function readJsonl(filePath) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    return text
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function summarizeNetwork(filePath) {
  const endpointCounts = new Map();
  const endpointKeys = new Map();
  const laneHits = {
    bid: 0,
    rank: 0,
    impression: 0,
    candidate: 0,
    creative: 0,
    material: 0,
    recommendation: 0,
    targetRoi: 0,
    delivery: 0
  };
  let total = 0;
  let inWindow = 0;
  let firstMs = null;
  let lastMs = null;

  if (!fs.existsSync(filePath)) {
    return { total: 0, inWindow: 0, endpointCounts: [], endpointKeys: [], laneHits, first: null, last: null };
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    total += 1;
    const ms = toMs(row.timestampFinished || row.collectorTimestamp || row.timestamp);
    if (!Number.isFinite(ms) || ms < startUtc || ms > endUtc) continue;
    inWindow += 1;
    firstMs = firstMs == null ? ms : Math.min(firstMs, ms);
    lastMs = lastMs == null ? ms : Math.max(lastMs, ms);
    const family = row.endpointFamily || "unknown";
    const endpointKey = row.endpointKey || family;
    endpointCounts.set(family, (endpointCounts.get(family) || 0) + 1);
    endpointKeys.set(endpointKey, {
      endpointKey,
      endpointFamily: family,
      count: (endpointKeys.get(endpointKey)?.count || 0) + 1
    });

    const keyText = [
      endpointKey,
      family,
      ...(row.requestBodyKeyPaths || []),
      ...(row.responseBodyKeyPaths || [])
    ].join(" ").toLowerCase();
    for (const lane of Object.keys(laneHits)) {
      const pattern = lane === "targetRoi" ? /target.?roi|roi.?target|target_roas|roas_target/ : new RegExp(lane);
      if (pattern.test(keyText)) laneHits[lane] += 1;
    }
  }

  return {
    total,
    inWindow,
    first: firstMs == null ? null : new Date(firstMs).toISOString(),
    last: lastMs == null ? null : new Date(lastMs).toISOString(),
    endpointCounts: [...endpointCounts.entries()]
      .map(([endpointFamily, count]) => ({ endpointFamily, count }))
      .sort((a, b) => b.count - a.count),
    endpointKeys: [...endpointKeys.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    laneHits
  };
}

function normalizeDecisionSnapshot(snapshot) {
  return {
    timestamp: snapshot.timestamp,
    ms: toMs(snapshot.timestamp),
    totals: {
      spend: num(snapshot.totals?.spend),
      revenue: num(snapshot.totals?.revenue),
      roi: num(snapshot.totals?.roi)
    },
    campaigns: (snapshot.campaigns || []).map((campaign) => {
      const spend = num(campaign.totalSpend ?? campaign.netCost ?? campaign.cost ?? campaign.spend ?? campaign.netSpend);
      const revenue = num(campaign.totalOrderAmount ?? campaign.revenue);
      const account = campaign.account || inferAccount(campaign.name);
      const normalizedName = normalizeCampaignName(campaign.name || account);
      return {
        key: `${normalizedName}|${account}`,
        name: normalizedName,
        account,
        spend,
        revenue,
        budget: num(campaign.totalBudget ?? campaign.budget),
        roi: spend > 0 ? revenue / spend : null
      };
    })
  };
}

function normalizePageSnapshot(snapshot) {
  const rows = [];
  for (const row of snapshot.tableState?.rows || []) {
    const cells = row.cells || [];
    if (!cells.length || cells[0] === "开/关" || cells[0] === "广告计划名称") continue;
    const accountCell = cells[7] || "";
    const account = accountCell.replace(/\s+ID:.*/, "").trim() || inferAccount(cells[0]);
    rows.push({
      key: `${cells[0]}|${account}`,
      name: cells[0],
      status: cells[1] || null,
      budget: num(cells[2]),
      spend: num(cells[3]),
      revenue: num(cells[4]),
      targetRoi: num(cells[5]),
      roi: num(cells[6]),
      account,
      benefit: cells[8] || null,
      optimizationMode: cells[10] || null
    });
  }
  return {
    timestamp: snapshot.timestamp || snapshot.collectorTimestamp,
    ms: toMs(snapshot.timestamp || snapshot.collectorTimestamp),
    visibilityState: snapshot.visibilityState,
    bodyTextHash: snapshot.bodyTextHash,
    rows
  };
}

function buildTransitions(decisions, pageSnapshots) {
  const rows = [];
  for (let index = 1; index < decisions.length; index += 1) {
    const previous = decisions[index - 1];
    const current = decisions[index];
    const gapMs = current.ms - previous.ms;
    if (gapMs < minWindowGapMs || gapMs > maxContinuousGapMs) continue;
    const previousByKey = new Map(previous.campaigns.map((campaign) => [campaign.key, campaign]));
    const windowRows = [];
    for (const campaign of current.campaigns) {
      const before = previousByKey.get(campaign.key);
      if (!before) continue;
      const spendDelta = Math.max(0, campaign.spend - before.spend);
      const revenueDelta = Math.max(0, campaign.revenue - before.revenue);
      const page = nearestPageRow(pageSnapshots, previous.ms, campaign.key, campaign.name, campaign.account);
      windowRows.push({
        from: previous.timestamp,
        to: current.timestamp,
        fromLocal: fmtTime(previous.ms),
        toLocal: fmtTime(current.ms),
        gapMinutes: round(gapMs / 60000, 2),
        key: campaign.key,
        name: campaign.name,
        account: campaign.account,
        spendDelta,
        revenueDelta,
        deltaRoi: spendDelta > 0 ? revenueDelta / spendDelta : null,
        previousSpend: before.spend,
        currentSpend: campaign.spend,
        previousRevenue: before.revenue,
        currentRevenue: campaign.revenue,
        budget: page?.budget ?? campaign.budget,
        visibleRoi: page?.roi ?? campaign.roi,
        targetRoi: page?.targetRoi ?? null,
        roiGap: page?.targetRoi > 0 && page?.roi != null ? page.roi - page.targetRoi : null,
        status: page?.status ?? null,
        benefit: page?.benefit ?? null,
        optimizationMode: page?.optimizationMode ?? null
      });
    }
    const totalSpend = windowRows.reduce((sum, row) => sum + row.spendDelta, 0);
    const totalRevenue = windowRows.reduce((sum, row) => sum + row.revenueDelta, 0);
    for (const row of windowRows) {
      rows.push({
        ...row,
        windowSpend: totalSpend,
        windowRevenue: totalRevenue,
        spendShare: totalSpend > 0 ? row.spendDelta / totalSpend : 0
      });
    }
  }
  return rows;
}

function buildWindows(transitions) {
  const byWindow = groupBy(transitions, (row) => `${row.from}->${row.to}`);
  return [...byWindow.values()].map((rows) => {
    const totalSpendDelta = rows.reduce((sum, row) => sum + row.spendDelta, 0);
    const totalRevenueDelta = rows.reduce((sum, row) => sum + row.revenueDelta, 0);
    const ranked = [...rows].sort((a, b) => b.spendDelta - a.spendDelta);
    return {
      from: rows[0].from,
      to: rows[0].to,
      fromLocal: rows[0].fromLocal,
      toLocal: rows[0].toLocal,
      totalSpendDelta,
      totalRevenueDelta,
      deltaRoi: totalSpendDelta > 0 ? totalRevenueDelta / totalSpendDelta : null,
      topAccount: ranked[0]?.account || null,
      rows: ranked
    };
  });
}

function summarizeCampaigns(activeTransitions, latestDecision, latestPage) {
  const latestPages = new Map((latestPage?.rows || []).map((row) => [row.key, row]));
  const byCampaign = groupBy(activeTransitions, (row) => row.key);
  return [...byCampaign.entries()].map(([key, rows]) => {
    const spendDelta = sum(rows, "spendDelta");
    const revenueDelta = sum(rows, "revenueDelta");
    const latest = latestPages.get(key) || {};
    const latestDecisionRow = latestDecision?.campaigns.find((row) => row.key === key) || {};
    return {
      key,
      account: rows[0].account,
      name: rows[0].name,
      spendDelta,
      spendShare: spendDelta / Math.max(1e-9, sum(activeTransitions, "spendDelta")),
      revenueDelta,
      deltaRoi: spendDelta > 0 ? revenueDelta / spendDelta : null,
      avgSpendShare: avg(rows.map((row) => row.spendShare)),
      maxSpendShare: Math.max(...rows.map((row) => row.spendShare)),
      topWins: rows.filter((row) => row.spendShare === Math.max(...rows.filter((peer) => peer.from === row.from).map((peer) => peer.spendShare))).length,
      avgVisibleRoi: avg(rows.map((row) => row.visibleRoi).filter(isFiniteNumber)),
      avgTargetRoi: avg(rows.map((row) => row.targetRoi).filter(isFiniteNumber)),
      avgRoiGap: avg(rows.map((row) => row.roiGap).filter(isFiniteNumber)),
      latestSpend: latest.spend ?? latestDecisionRow.spend ?? null,
      latestRevenue: latest.revenue ?? latestDecisionRow.revenue ?? null,
      latestBudget: latest.budget ?? latestDecisionRow.budget ?? null,
      latestVisibleRoi: latest.roi ?? latestDecisionRow.roi ?? null,
      latestTargetRoi: latest.targetRoi ?? null,
      latestRoiGap: latest.targetRoi > 0 && latest.roi != null ? latest.roi - latest.targetRoi : null,
      latestStatus: latest.status ?? null
    };
  }).sort((a, b) => b.spendDelta - a.spendDelta);
}

function summarizeCoverage(decisions, pageSnapshots, networkEvidence, windows, activeTransitions) {
  const gaps = [];
  for (let index = 1; index < decisions.length; index += 1) {
    const gapMinutes = (decisions[index].ms - decisions[index - 1].ms) / 60000;
    gaps.push(gapMinutes);
  }
  return {
    decisionSnapshots: decisions.length,
    pageSnapshots: pageSnapshots.length,
    activeWindows: windows.length,
    campaignWindowRows: activeTransitions.length,
    firstDecision: decisions[0]?.timestamp || null,
    latestDecision: decisions.at(-1)?.timestamp || null,
    firstDecisionLocal: decisions[0] ? fmtDateTime(decisions[0].ms) : null,
    latestDecisionLocal: decisions.at(-1) ? fmtDateTime(decisions.at(-1).ms) : null,
    networkExchanges: networkEvidence.inWindow,
    maxGapMinutes: gaps.length ? Math.max(...gaps) : null,
    gapsOver30Minutes: gaps.filter((gap) => gap > 30).length,
    totalSpendDelta: sum(activeTransitions, "spendDelta"),
    totalRevenueDelta: sum(activeTransitions, "revenueDelta"),
    overallDeltaRoi: sum(activeTransitions, "spendDelta") > 0 ? sum(activeTransitions, "revenueDelta") / sum(activeTransitions, "spendDelta") : null
  };
}

function summarizeCorrelations(rows) {
  return {
    roiGapToNextSpendShare: corr(rows, "roiGap", "spendShare"),
    visibleRoiToNextSpendShare: corr(rows, "visibleRoi", "spendShare"),
    targetRoiToNextSpendShare: corr(rows, "targetRoi", "spendShare"),
    budgetToNextSpendShare: corr(rows, "budget", "spendShare"),
    previousSpendToNextSpendShare: corr(rows, "previousSpend", "spendShare")
  };
}

function inferLogic({ campaignSummary, windows, correlations, networkEvidence, coverage }) {
  const enoughWindowCoverage = coverage.activeWindows >= 24 && coverage.gapsOver30Minutes === 0;
  const hasDirectBidRank = networkEvidence.laneHits.bid > 0 || networkEvidence.laneHits.rank > 0 || networkEvidence.laneHits.candidate > 0;
  const confidence = enoughWindowCoverage && hasDirectBidRank ? "medium" : enoughWindowCoverage ? "low_to_medium" : "low_to_medium";
  const top = campaignSummary[0];
  const strictTarget = campaignSummary.reduce((best, row) => (row.latestTargetRoi > (best?.latestTargetRoi || 0) ? row : best), null);
  const looseTarget = campaignSummary.reduce((best, row) => (row.latestTargetRoi < (best?.latestTargetRoi ?? Infinity) ? row : best), null);
  return {
    confidence,
    externallyVerified: [
      "next-window spend delta share is the strongest observable allocation proxy",
      "active/effective status and ROI-protection eligibility are visible gates",
      "target ROI behaves like a pacing/effective-bid constraint rather than a simple rank order by visible ROI",
      "allocation remains multi-campaign and exploratory, not winner-take-all"
    ],
    notVerifiedInternally: [
      "private auction bid value",
      "impression-level rank position",
      "candidate generation set",
      "creative/material model score"
    ],
    currentModel: "allocation_score_ext = eligibility_gate x pacing_budget x predicted_GMV_feedback x bid_headroom(1 / target_ROI) x exploration_floor x material_health_proxy",
    topAccount: top?.account || null,
    strictTargetAccount: strictTarget?.account || null,
    looseTargetAccount: looseTarget?.account || null,
    notes: [
      `Current leading allocation receiver is ${top?.account || "-"} with ${pct(top?.spendShare)} of observed incremental spend.`,
      `${strictTarget?.account || "-"} has the strictest latest target ROI (${fmt(strictTarget?.latestTargetRoi)}), which limits bid headroom unless predicted GMV quality offsets it.`,
      `${looseTarget?.account || "-"} has the loosest latest target ROI (${fmt(looseTarget?.latestTargetRoi)}), which should make delivery easier when inventory and predicted conversion are sufficient.`,
      `Observed bid/rank/candidate endpoint evidence: ${hasDirectBidRank ? "present in key paths, still needs field-level validation" : "not present in captured summarized key paths"}.`
    ],
    correlations
  };
}

function buildChartData({ campaignSummary, windows, activeTransitions, correlations, networkEvidence }) {
  const latest = windows.slice(-12);
  return {
    spendShareBars: campaignSummary.map((row) => ({
      label: row.account,
      value: row.spendShare,
      color: campaignPalette[row.account] || colors.blue,
      detail: `${fmtMoney(row.spendDelta)} MYR`
    })),
    windowShareTrend: latest.map((window) => ({
      label: window.toLocal,
      values: window.rows.map((row) => ({
        label: row.account,
        value: row.spendShare,
        color: campaignPalette[row.account] || colors.blue
      }))
    })),
    roiGapScatter: activeTransitions
      .filter((row) => isFiniteNumber(row.roiGap) && isFiniteNumber(row.spendShare))
      .map((row) => ({
        x: row.roiGap,
        y: row.spendShare,
        label: row.account,
        color: campaignPalette[row.account] || colors.blue
      })),
    endpointBars: networkEvidence.endpointCounts.slice(0, 10).map((row) => ({
      label: row.endpointFamily,
      value: row.count,
      color: colors.gold
    })),
    correlations
  };
}

async function writeChartPages(chartData) {
  const chartPages = {
    "allocation-share.html": renderChartShell("Observed spend allocation share", barSvg(chartData.spendShareBars, { valueFormat: pct, width: 920, height: 480 })),
    "window-share-trend.html": renderChartShell("Latest 10-minute allocation share", stackedBarsSvg(chartData.windowShareTrend, { width: 1040, height: 520 })),
    "roi-gap-scatter.html": renderChartShell("ROI gap vs next-window spend share", scatterSvg(chartData.roiGapScatter, { width: 920, height: 520 })),
    "endpoint-family.html": renderChartShell("Captured endpoint family count", barSvg(chartData.endpointBars, { valueFormat: fmtInt, width: 920, height: 520 }))
  };
  for (const [file, html] of Object.entries(chartPages)) {
    await fsp.writeFile(path.join(assetsDir, file), html, "utf8");
  }
}

function renderReportHtml(report) {
  const latest = report.latestWindow;
  const generated = fmtDateTime(toMs(report.generatedAt));
  const asset = (name) => `assets/${name}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TikTok GMV Max 外显决策逻辑监测报告</title>
  <style>
    :root { color-scheme: light; --ink: ${colors.ink}; --muted: ${colors.muted}; --grid: ${colors.grid}; --panel: #fff; --surface: ${colors.surface}; }
    body { margin: 0; font-family: Inter, "PingFang SC", "Microsoft YaHei", Arial, sans-serif; background: var(--surface); color: var(--ink); line-height: 1.58; }
    main { max-width: 1080px; margin: 0 auto; padding: 44px 28px 72px; }
    h1 { font-size: 34px; line-height: 1.15; margin: 0 0 12px; letter-spacing: 0; }
    h2 { font-size: 23px; margin: 38px 0 12px; letter-spacing: 0; }
    h3 { font-size: 17px; margin: 24px 0 8px; letter-spacing: 0; }
    p, li { font-size: 15px; }
    .meta { color: var(--muted); margin-bottom: 28px; }
    .summary { background: #fff; border: 1px solid var(--grid); border-radius: 8px; padding: 18px 20px; }
    .summary li { margin: 10px 0; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 22px 0; }
    .kpi { background: #fff; border: 1px solid var(--grid); border-radius: 8px; padding: 14px; }
    .kpi strong { display: block; font-size: 22px; line-height: 1.1; margin-bottom: 6px; }
    .kpi span { color: var(--muted); font-size: 13px; }
    figure { margin: 20px 0 28px; background: #fff; border: 1px solid var(--grid); border-radius: 8px; padding: 12px; }
    figure img { width: 100%; display: block; border-radius: 4px; }
    figcaption { color: var(--muted); font-size: 13px; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--grid); border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--grid); font-size: 14px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .note { color: var(--muted); font-size: 13px; }
    code { background: #F4F5F7; padding: 1px 4px; border-radius: 4px; }
    @media (max-width: 760px) { main { padding: 28px 16px 48px; } .kpis { grid-template-columns: 1fr 1fr; } h1 { font-size: 28px; } }
  </style>
</head>
<body>
<main>
  <h1>TikTok GMV Max 外显决策逻辑监测报告</h1>
  <div class="meta">生成时间：${escapeHtml(generated)}；范围：${report.coverage.firstDecisionLocal || "-"} 到 ${report.coverage.latestDecisionLocal || "-"}；时区：Asia/Kuala_Lumpur。</div>

  <h2>Executive Summary</h2>
  <ul class="summary">
    <li><strong>当前可验证结论是“外显分发逻辑”，不是 TikTok 内部源码级模型。</strong> 今天样本显示 GMV Max 的下一窗口花费分配更接近“资格门槛 + 目标 ROI 约束 + 近期 GMV/转化反馈 + 探索保底”的组合，而不是按当前可见 ROI 或 ROI gap 单一排序。</li>
    <li><strong>${escapeHtml(report.logic.topAccount || "-")} 是目前增量花费第一接收方。</strong> 今日连续窗口累计增量花费 ${fmtMoney(report.coverage.totalSpendDelta)} MYR，增量收入 ${fmtMoney(report.coverage.totalRevenueDelta)} MYR，窗口 ROI ${fmt(report.coverage.overallDeltaRoi)}。</li>
    <li><strong>目标 ROI 更像出价/节奏约束。</strong> 低目标 ROI 计划有更宽出价空间，但实际分配仍受账户/素材/近期反馈影响；高目标 ROI 计划即使可见 ROI 较高，也不会自然拿到最高流量份额。</li>
    <li><strong>证据强度：${escapeHtml(report.logic.confidence)}。</strong> 目前网络日志捕获了 campaign、recommendation、creative/material 和 analytics/browser monitoring 族数据，但还没有足够字段证明私有 bid、rank、candidate 权重。</li>
  </ul>

  <div class="kpis">
    <div class="kpi"><strong>${report.coverage.activeWindows}</strong><span>连续有效分配窗口</span></div>
    <div class="kpi"><strong>${fmtMoney(report.coverage.totalSpendDelta)}</strong><span>今日增量花费 MYR</span></div>
    <div class="kpi"><strong>${fmt(report.coverage.overallDeltaRoi)}</strong><span>窗口增量 ROI</span></div>
    <div class="kpi"><strong>${fmtInt(report.coverage.networkExchanges)}</strong><span>今日网络交换记录</span></div>
  </div>

  <h2>分发不是单一 ROI 排序</h2>
  <p><strong>下一窗口花费份额显示平台在三条计划之间持续分配，而不是 winner-take-all。</strong> 这支持 GMV Max 存在探索与节奏层：即使某个计划短期 ROI 更高，系统也会把一部分流量保留给其他仍满足资格和目标约束的计划。</p>
  <figure><img src="${asset("allocation-share.png")}" alt="Observed spend allocation share"><figcaption>图表口径：按连续快照之间的花费增量计算份额；这是流量分发代理指标，不是曝光量或拍卖排名。</figcaption></figure>

  <p><strong>最近 10 分钟窗口仍在动态调节。</strong> 最新窗口 ${latest ? `${escapeHtml(latest.fromLocal)} 到 ${escapeHtml(latest.toLocal)}` : "-"} 的增量花费为 ${latest ? fmtMoney(latest.totalSpendDelta) : "-"} MYR，窗口 ROI 为 ${latest ? fmt(latest.deltaRoi) : "-"}。</p>
  <figure><img src="${asset("window-share-trend.png")}" alt="Latest allocation share by window"><figcaption>每根柱代表一个有效采集窗口，颜色为不同账户/计划的下一窗口花费份额。</figcaption></figure>

  <h2>目标 ROI 更像有效出价约束</h2>
  <p><strong>ROI gap 与下一窗口花费份额没有表现出稳定正相关。</strong> 今天样本里，ROI gap 与 spend share 的相关系数为 ${fmtCorr(report.correlations.roiGapToNextSpendShare)}，说明“超过目标越多就越多流量”的简单规则无法解释分发。</p>
  <figure><img src="${asset("roi-gap-scatter.png")}" alt="ROI gap vs spend share"><figcaption>每个点是一条计划在一个连续窗口中的 ROI gap 与下一窗口花费份额；点云分散代表单一 ROI gap 不是足够排序特征。</figcaption></figure>

  <h2>当前模型预估</h2>
  <p><strong>建议把 GMV Max 的外显决策模型写成约束乘法，而不是线性排行榜。</strong> 目前最稳妥的估计为：<code>${escapeHtml(report.logic.currentModel)}</code>。</p>
  <table>
    <thead><tr><th>计划/账户</th><th>增量花费</th><th>花费份额</th><th>窗口 ROI</th><th>最新目标 ROI</th><th>最新可见 ROI</th><th>解释</th></tr></thead>
    <tbody>
      ${report.campaignSummary.map((row) => `<tr><td>${escapeHtml(row.account)}</td><td>${fmtMoney(row.spendDelta)} MYR</td><td>${pct(row.spendShare)}</td><td>${fmt(row.deltaRoi)}</td><td>${fmt(row.latestTargetRoi)}</td><td>${fmt(row.latestVisibleRoi)}</td><td>${escapeHtml(explainCampaign(row))}</td></tr>`).join("\n")}
    </tbody>
  </table>

  <h2>网络证据支持“可观察字段不足”这个结论</h2>
  <p><strong>捕获到的数据流能证明页面在读写 campaign、recommendation、creative/material 等数据族，但不能直接还原私有排序权重。</strong> analytics 和 browser monitoring 记录数量很大，但它们主要证明页面/会话事件，不应被当作排名模型证据。</p>
  <figure><img src="${asset("endpoint-family.png")}" alt="Captured endpoint family counts"><figcaption>仅展示 endpoint family 计数，不展开敏感 payload；bid/rank/candidate 字段仍需继续专项捕获验证。</figcaption></figure>

  <h2>Recommended Next Steps</h2>
  <ol>
    <li>继续保持 10 分钟刷新，累计完整 24 小时连续窗口后重估相关性和分配权重。</li>
    <li>插件下一版重点标记含 <code>bid</code>、<code>rank</code>、<code>candidate</code>、<code>impression</code>、<code>creative/material score</code> 的响应字段，只存 key path 和脱敏摘要。</li>
    <li>不要主动改预算或目标 ROI；只用自然变化验证目标 ROI 约束和探索分配。</li>
  </ol>

  <h2>Further Questions</h2>
  <ul>
    <li>是否存在某个 campaign/material endpoint 在特定操作后才返回候选、出价或素材分字段？</li>
    <li>推荐数量或素材诊断是否在控制 ROI gap 和账户身份后预测下一窗口花费份额？</li>
    <li>预算变化是否来自平台自动调整、人工操作，还是 UI 解析口径变化？</li>
  </ul>

  <h2>Caveats and Assumptions</h2>
  <p>本报告只验证外显 dashboard/API 行为；没有访问 TikTok 内部排序模型、拍卖代码或真实出价权重。花费增量份额是流量分配代理，不等于曝光份额。收入存在归因延迟，10 分钟窗口 ROI 会波动。由于本地环境没有 matplotlib/seaborn，本报告图表由静态 HTML 图形通过 Chrome 截图生成 PNG，不声明 Seaborn 模板合规。</p>
</main>
</body>
</html>`;
}

function renderReportMarkdown(report) {
  const lines = [
    "# TikTok GMV Max 外显决策逻辑监测报告",
    "",
    `生成时间：${fmtDateTime(toMs(report.generatedAt))}`,
    "",
    "## Executive Summary",
    "",
    `- 当前可验证结论是外显分发逻辑，不是 TikTok 内部源码级模型。证据强度：${report.logic.confidence}。`,
    `- 今日连续窗口累计增量花费 ${fmtMoney(report.coverage.totalSpendDelta)} MYR，增量收入 ${fmtMoney(report.coverage.totalRevenueDelta)} MYR，窗口 ROI ${fmt(report.coverage.overallDeltaRoi)}。`,
    `- 当前领先接收方：${report.logic.topAccount || "-"}。模型估计：${report.logic.currentModel}。`,
    "",
    "## Campaign Summary",
    "",
    "| 计划/账户 | 增量花费 | 花费份额 | 窗口 ROI | 最新目标 ROI | 最新可见 ROI |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.campaignSummary.map((row) => `| ${row.account} | ${fmtMoney(row.spendDelta)} | ${pct(row.spendShare)} | ${fmt(row.deltaRoi)} | ${fmt(row.latestTargetRoi)} | ${fmt(row.latestVisibleRoi)} |`),
    "",
    "## Caveat",
    "",
    "本报告只验证外显 dashboard/API 行为；不能声称还原 TikTok 私有排序、拍卖、出价或模型权重。"
  ];
  return `${lines.join("\n")}\n`;
}

function renderChartShell(title, svg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:${colors.surface};font-family:Inter,Arial,sans-serif}.wrap{width:max-content;padding:20px;background:${colors.surface}}</style></head><body><div class="wrap">${svg}</div></body></html>`;
}

function barSvg(rows, { valueFormat, width, height }) {
  const margin = { top: 70, right: 110, bottom: 54, left: 210 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const max = Math.max(...rows.map((row) => row.value), 1);
  const barH = Math.min(54, plotH / Math.max(rows.length, 1) - 18);
  const gap = rows.length > 1 ? (plotH - barH * rows.length) / (rows.length - 1) : 0;
  const bars = rows.map((row, i) => {
    const y = margin.top + i * (barH + gap);
    const w = (row.value / max) * plotW;
    return `<text x="${margin.left - 12}" y="${y + barH / 2 + 5}" text-anchor="end" font-size="18" fill="${colors.ink}">${escapeHtml(row.label)}</text>
      <rect x="${margin.left}" y="${y}" width="${w}" height="${barH}" rx="4" fill="${row.color}" />
      <text x="${margin.left + w + 10}" y="${y + barH / 2 + 5}" font-size="16" fill="${colors.ink}">${escapeHtml(valueFormat(row.value))}</text>
      ${row.detail ? `<text x="${margin.left + w + 10}" y="${y + barH / 2 + 25}" font-size="12" fill="${colors.muted}">${escapeHtml(row.detail)}</text>` : ""}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="${colors.panel}"/>
    <text x="26" y="36" font-size="24" font-weight="700" fill="${colors.ink}">Observed spend allocation share</text>
    <text x="26" y="60" font-size="15" fill="${colors.muted}">Next-window spend delta share, ${dayLabel}</text>
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right + 20}" y2="${height - margin.bottom}" stroke="${colors.grid}"/>
    ${bars}
  </svg>`;
}

function stackedBarsSvg(windows, { width, height }) {
  const margin = { top: 78, right: 40, bottom: 88, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const barW = Math.max(18, plotW / Math.max(windows.length, 1) - 12);
  const gap = windows.length > 1 ? (plotW - barW * windows.length) / (windows.length - 1) : 0;
  const bars = windows.map((window, i) => {
    const x = margin.left + i * (barW + gap);
    let yTop = margin.top + plotH;
    const rects = window.values.map((part) => {
      const h = part.value * plotH;
      yTop -= h;
      return `<rect x="${x}" y="${yTop}" width="${barW}" height="${h}" fill="${part.color}"/>`;
    }).join("");
    return `${rects}<text transform="translate(${x + barW / 2},${height - margin.bottom + 18}) rotate(45)" text-anchor="start" font-size="11" fill="${colors.muted}">${escapeHtml(window.label)}</text>`;
  }).join("");
  const legendItems = [...new Map(windows.flatMap((w) => w.values).map((v) => [v.label, v])).values()];
  const legend = legendItems.map((item, i) => `<rect x="${margin.left + i * 190}" y="52" width="12" height="12" fill="${item.color}"/><text x="${margin.left + i * 190 + 18}" y="63" font-size="13" fill="${colors.muted}">${escapeHtml(item.label)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="${colors.panel}"/>
    <text x="26" y="34" font-size="24" font-weight="700" fill="${colors.ink}">Latest 10-minute allocation share</text>
    ${legend}
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="${colors.grid}"/>
    <line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="${colors.grid}"/>
    <text x="18" y="${margin.top + 8}" font-size="12" fill="${colors.muted}">100%</text>
    <text x="26" y="${margin.top + plotH}" font-size="12" fill="${colors.muted}">0%</text>
    ${bars}
  </svg>`;
}

function scatterSvg(points, { width, height }) {
  const margin = { top: 74, right: 36, bottom: 70, left: 78 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const xs = points.map((p) => p.x);
  const minX = Math.min(...xs, -0.2);
  const maxX = Math.max(...xs, 1.5);
  const xScale = (x) => margin.left + ((x - minX) / Math.max(0.001, maxX - minX)) * plotW;
  const yScale = (y) => margin.top + plotH - y * plotH;
  const dots = points.map((p) => `<circle cx="${xScale(p.x)}" cy="${yScale(p.y)}" r="5" fill="${p.color}" fill-opacity="0.72"><title>${escapeHtml(p.label)} ROI gap ${fmt(p.x)}, share ${pct(p.y)}</title></circle>`).join("");
  const legendItems = [...new Map(points.map((p) => [p.label, p])).values()];
  const legend = legendItems.map((item, i) => `<circle cx="${margin.left + i * 190}" cy="54" r="6" fill="${item.color}"/><text x="${margin.left + i * 190 + 12}" y="59" font-size="13" fill="${colors.muted}">${escapeHtml(item.label)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="${colors.panel}"/>
    <text x="26" y="34" font-size="24" font-weight="700" fill="${colors.ink}">ROI gap vs next-window spend share</text>
    ${legend}
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="${colors.grid}"/>
    <line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="${colors.grid}"/>
    <text x="${margin.left}" y="${height - 24}" font-size="14" fill="${colors.muted}">ROI gap</text>
    <text x="16" y="${margin.top + 12}" font-size="14" fill="${colors.muted}">Share</text>
    ${dots}
  </svg>`;
}

function nearestPageRow(pageSnapshots, ms, key, name, account) {
  let best = null;
  let bestGap = Infinity;
  for (const snapshot of pageSnapshots) {
    const gap = Math.abs(snapshot.ms - ms);
    if (gap > 2 * 60 * 1000 || gap > bestGap) continue;
    const row = snapshot.rows.find((candidate) => candidate.key === key || (candidate.name === name && candidate.account === account));
    if (!row) continue;
    best = row;
    bestGap = gap;
  }
  return best;
}

function explainCampaign(row) {
  if (row.latestTargetRoi === 6.5) return "目标 ROI 最宽松，具备更高出价空间；但份额仍受预算和近期反馈约束。";
  if (row.latestTargetRoi === 7) return "目标 ROI 居中，分配更像稳定扩量与效率平衡。";
  if (row.latestTargetRoi === 7.8) return "目标 ROI 最严格；即使可见 ROI 较高，也可能因出价头寸更紧而受限。";
  return "目标约束和近期反馈共同影响分配。";
}

function num(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function toMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function inRange(timestamp) {
  const ms = toMs(timestamp);
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

function normalizeCampaignName(name = "") {
  if (name === "live-plan-1") return "LIVE GMV Max_Gross revenue_YOUMILIER_20260529215644";
  if (name === "live-plan-2") return "LIVE GMV Max_Gross revenue_YOUMILIER_20260521173451";
  if (name === "live-plan-3") return "LIVE GMV Max_Gross revenue_YOUMILIER_20260519101516";
  return name;
}

function groupBy(rows, fn) {
  const map = new Map();
  for (const row of rows) {
    const key = fn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function avg(values) {
  const nums = values.filter(isFiniteNumber);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function corr(rows, xKey, yKey) {
  const pairs = rows.map((row) => [row[xKey], row[yKey]]).filter(([x, y]) => isFiniteNumber(x) && isFiniteNumber(y));
  if (pairs.length < 4) return { n: pairs.length, r: null };
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const mx = avg(xs);
  const my = avg(ys);
  const numerator = pairs.reduce((total, [x, y]) => total + (x - mx) * (y - my), 0);
  const dx = Math.sqrt(xs.reduce((total, x) => total + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((total, y) => total + (y - my) ** 2, 0));
  return { n: pairs.length, r: dx && dy ? numerator / (dx * dy) : null };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value, digits = 2) {
  return isFiniteNumber(value) ? Number(value.toFixed(digits)) : null;
}

function fmt(value) {
  return isFiniteNumber(value) ? value.toFixed(2) : "-";
}

function fmtMoney(value) {
  return isFiniteNumber(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-";
}

function fmtInt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function pct(value) {
  return isFiniteNumber(value) ? `${(value * 100).toFixed(1)}%` : "-";
}

function fmtCorr(correlation) {
  return correlation?.r == null ? `样本 n=${correlation?.n || 0}，暂不足` : `${correlation.r.toFixed(2)}（n=${correlation.n}）`;
}

function fmtTime(ms) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
