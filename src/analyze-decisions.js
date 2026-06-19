import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const outputDir = path.resolve(process.env.GMVMAX_OUTPUT_DIR || "./logs");
const recordsPath = path.join(outputDir, "gmvmax-records.jsonl");
const decisionSnapshotPath = path.join(outputDir, "gmvmax-decision-snapshots.jsonl");
const networkPath = path.join(outputDir, "gmvmax-network-exchanges.jsonl");
const pageSnapshotPath = path.join(outputDir, "gmvmax-page-snapshots.jsonl");
const reportJsonPath = path.join(outputDir, "gmvmax-decision-report.json");
const reportMdPath = path.join(outputDir, "gmvmax-decision-report.md");

const MAX_CONTINUOUS_GAP_MS = Number(process.env.GMVMAX_MAX_CONTINUOUS_GAP_MINUTES || 30) * 60 * 1000;
const MIN_WINDOW_GAP_MS = Number(process.env.GMVMAX_MIN_WINDOW_GAP_SECONDS || 45) * 1000;
const STRICT_WINDOW_MIN_COUNT = Number(process.env.GMVMAX_STRICT_WINDOW_MIN_COUNT || 6);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const records = await readJsonl(recordsPath);
  const decisionSnapshots = await readJsonl(decisionSnapshotPath);
  const exchanges = await readJsonl(networkPath);
  const pageSnapshots = await readJsonl(pageSnapshotPath);
  const evidenceSnapshots = buildEvidenceSnapshots({ records, decisionSnapshots });
  const report = buildReport({ records, decisionSnapshots, exchanges, pageSnapshots, evidenceSnapshots });
  await fs.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(reportMdPath, renderMarkdown(report), "utf8");
  console.log(`[GMVMAX] Decision report: ${reportMdPath}`);
}

function buildReport({ records, decisionSnapshots, exchanges, pageSnapshots, evidenceSnapshots }) {
  const recordRange = rangeOf(records);
  const strictRange = rangeOf(decisionSnapshots);
  const networkRange = rangeOf(exchanges);
  const pageRange = rangeOf(pageSnapshots);
  const latestTime = latestTimestamp([...evidenceSnapshots, ...exchanges, ...pageSnapshots]);
  const oneHourCutoff = latestTime ? latestTime - 60 * 60 * 1000 : 0;
  const lastHourSnapshots = evidenceSnapshots.filter((snapshot) => toMs(snapshot.timestamp) >= oneHourCutoff);
  const lastHourExchanges = exchanges.filter((exchange) => toMs(exchange.timestampFinished || exchange.collectorTimestamp || exchange.timestamp) >= oneHourCutoff);
  const lastHourPageSnapshots = pageSnapshots.filter((snapshot) => toMs(snapshot.timestamp || snapshot.collectorTimestamp) >= oneHourCutoff);
  const transitions = buildContinuousTransitions(lastHourSnapshots);
  const allocationWindows = buildAllocationWindows(transitions);
  const endpointCounts = countBy(lastHourExchanges, (exchange) => exchange.endpointFamily || exchange.endpointKey || "unknown");
  const endpointStructures = summarizeEndpointStructures(lastHourExchanges);
  const pageEvidence = summarizePageEvidence(lastHourPageSnapshots);
  const metricValidation = validateSnapshotMetrics(lastHourSnapshots);
  const verdict = buildVerdict({
    recordRange,
    strictRange,
    transitions,
    allocationWindows,
    endpointCounts,
    pageEvidence
  });

  return {
    generatedAt: new Date().toISOString(),
    observationWindow: {
      legacyRecords: recordRange,
      strictDecisionSnapshots: strictRange,
      network: networkRange,
      pageSnapshots: pageRange,
      lastHour: {
        snapshotCount: lastHourSnapshots.length,
        exchangeCount: lastHourExchanges.length,
        pageSnapshotCount: lastHourPageSnapshots.length,
        continuousTransitionCount: transitions.length,
        allocationWindowCount: allocationWindows.length
      }
    },
    networkEvidence: {
      endpointCounts,
      endpointStructures
    },
    pageEvidence,
    metricValidation,
    allocationEvidence: summarizeAllocation(allocationWindows),
    verificationVerdict: verdict,
    currentBestHypothesis: inferHypothesis({ transitions, allocationWindows, endpointCounts, pageEvidence, verdict })
  };
}

function buildEvidenceSnapshots({ records, decisionSnapshots }) {
  const byTimestamp = new Map();
  for (const record of records) {
    const snapshot = normalizeRecordSnapshot(record, "legacy_record");
    if (snapshot.campaigns.length > 0) byTimestamp.set(snapshot.timestamp, snapshot);
  }
  for (const snapshot of decisionSnapshots) {
    const normalized = normalizeDecisionSnapshot(snapshot);
    if (normalized.campaigns.length > 0) byTimestamp.set(normalized.timestamp, normalized);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function normalizeRecordSnapshot(record, source) {
  const campaigns = (record.campaigns || record.plans || []).map((campaign) => normalizeCampaign(campaign));
  return {
    source,
    timestamp: record.timestamp,
    url: record.url,
    campaigns
  };
}

function normalizeDecisionSnapshot(snapshot) {
  return {
    source: "decision_snapshot",
    timestamp: snapshot.timestamp,
    url: snapshot.url,
    totals: snapshot.totals || null,
    campaigns: (snapshot.campaigns || []).map((campaign) => normalizeCampaign(campaign))
  };
}

function normalizeCampaign(campaign) {
  const name = campaign.name || campaign.campaign || campaign.account || "unknown";
  const spend = numberFrom(campaign.totalSpend ?? campaign.netCost ?? campaign.cost ?? campaign.spend ?? campaign.netSpend);
  const revenue = numberFrom(campaign.revenue ?? campaign.totalOrderAmount);
  const orders = numberFrom(campaign.orders ?? campaign.skuOrders);
  const roi = numberFrom(campaign.roi) || (spend > 0 ? revenue / spend : 0);
  const targetRoi = numberFrom(campaign.targetRoi);
  return {
    key: `${name}|${campaign.account || campaign.schedule || ""}`,
    name,
    account: campaign.account || null,
    status: campaign.status || null,
    budget: numberFrom(campaign.budget ?? campaign.totalBudget),
    spend,
    revenue,
    orders,
    roi,
    targetRoi,
    roiGap: targetRoi > 0 ? roi - targetRoi : null,
    suggestionCount: Number(campaign.suggestionCount || 0),
    benefit: campaign.benefit || "-",
    allocationScoreProxy: numberOrNull(campaign.allocationScoreProxy)
  };
}

function buildContinuousTransitions(snapshots) {
  const transitions = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    const gapMs = toMs(current.timestamp) - toMs(previous.timestamp);
    if (gapMs < MIN_WINDOW_GAP_MS || gapMs > MAX_CONTINUOUS_GAP_MS) continue;

    const previousByKey = new Map(previous.campaigns.map((campaign) => [campaign.key, campaign]));
    for (const campaign of current.campaigns) {
      const before = previousByKey.get(campaign.key);
      if (!before) continue;
      transitions.push({
        from: previous.timestamp,
        to: current.timestamp,
        gapMinutes: round(gapMs / 60000),
        campaignKey: campaign.key,
        name: campaign.name,
        account: campaign.account,
        spendDelta: round(Math.max(0, campaign.spend - before.spend)),
        revenueDelta: round(Math.max(0, campaign.revenue - before.revenue)),
        orderDelta: round(Math.max(0, campaign.orders - before.orders)),
        previousSpend: before.spend,
        currentSpend: campaign.spend,
        previousRevenue: before.revenue,
        currentRevenue: campaign.revenue,
        roi: campaign.roi,
        targetRoi: campaign.targetRoi,
        roiGap: campaign.roiGap,
        suggestionCount: campaign.suggestionCount,
        benefit: campaign.benefit,
        allocationScoreProxy: campaign.allocationScoreProxy
      });
    }
  }
  return transitions;
}

function buildAllocationWindows(transitions) {
  const byWindow = groupBy(transitions, (row) => `${row.from}->${row.to}`);
  return [...byWindow.entries()].map(([windowKey, rows]) => {
    const totalSpendDelta = rows.reduce((sum, row) => sum + row.spendDelta, 0);
    const totalRevenueDelta = rows.reduce((sum, row) => sum + row.revenueDelta, 0);
    const ranked = rows
      .map((row) => ({
        ...row,
        spendDeltaShare: totalSpendDelta > 0 ? round(row.spendDelta / totalSpendDelta) : 0
      }))
      .sort((a, b) => b.spendDelta - a.spendDelta);
    return {
      windowKey,
      from: rows[0]?.from,
      to: rows[0]?.to,
      gapMinutes: rows[0]?.gapMinutes || 0,
      totalSpendDelta: round(totalSpendDelta),
      totalRevenueDelta: round(totalRevenueDelta),
      roiDelta: totalSpendDelta > 0 ? round(totalRevenueDelta / totalSpendDelta) : null,
      campaignCount: rows.length,
      ranked
    };
  });
}

function summarizeAllocation(windows) {
  const active = windows.filter((window) => window.totalSpendDelta > 0);
  return {
    activeWindowCount: active.length,
    zeroSpendWindowCount: windows.length - active.length,
    latestWindows: active.slice(-6).map((window) => ({
      from: window.from,
      to: window.to,
      totalSpendDelta: window.totalSpendDelta,
      totalRevenueDelta: window.totalRevenueDelta,
      roiDelta: window.roiDelta,
      topReceivers: window.ranked.slice(0, 5).map((row) => ({
        name: row.name,
        account: row.account,
        spendDelta: row.spendDelta,
        spendDeltaShare: row.spendDeltaShare,
        revenueDelta: row.revenueDelta,
        roi: round(row.roi),
        targetRoi: row.targetRoi || null,
        roiGap: row.roiGap == null ? null : round(row.roiGap),
        suggestionCount: row.suggestionCount,
        allocationScoreProxy: row.allocationScoreProxy
      }))
    }))
  };
}

function summarizeEndpointStructures(exchanges) {
  const byEndpoint = groupBy(exchanges, (exchange) => exchange.endpointKey || "unknown");
  return [...byEndpoint.entries()]
    .map(([endpointKey, rows]) => ({
      endpointKey,
      endpointFamily: rows.at(-1)?.endpointFamily || "unknown",
      count: rows.length,
      statuses: countBy(rows, (row) => String(row.status || "unknown")),
      requestBodyKeyPaths: mergeMany(rows.map((row) => row.requestBodyKeyPaths || extractJsonKeyPaths(row.requestPostData))).slice(0, 80),
      responseBodyKeyPaths: mergeMany(rows.map((row) => row.responseBodyKeyPaths || extractJsonKeyPaths(row.responseBody))).slice(0, 120)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
}

function summarizePageEvidence(pageSnapshots) {
  const latest = pageSnapshots.at(-1) || null;
  return {
    count: pageSnapshots.length,
    latest: latest
      ? {
          timestamp: latest.timestamp || latest.collectorTimestamp,
          reason: latest.reason,
          visibleSignals: latest.visibleSignals || [],
          routeState: latest.routeState || {},
          tableRowCount: latest.tableState?.rowCount || 0,
          sortState: latest.sortState || [],
          actionState: latest.actionState || []
        }
      : null,
    bodyHashChanges: unique(pageSnapshots.map((snapshot) => snapshot.bodyTextHash).filter(Boolean)).length
  };
}

function validateSnapshotMetrics(snapshots) {
  const rows = snapshots.flatMap((snapshot) => snapshot.campaigns || []);
  const checked = rows.filter((row) => row.spend > 0 && row.revenue >= 0 && row.roi > 0);
  const errors = checked.map((row) => Math.abs(row.revenue / row.spend - row.roi));
  return {
    checked: checked.length,
    avgRoiFormulaError: mean(errors),
    maxRoiFormulaError: Math.max(0, ...errors)
  };
}

function buildVerdict({ recordRange, strictRange, transitions, allocationWindows, endpointCounts, pageEvidence }) {
  const reasons = [];
  const corrections = [];
  const hasCampaignList = (endpointCounts.campaign_list || 0) > 0;
  const activeWindows = allocationWindows.filter((window) => window.totalSpendDelta > 0).length;

  if ((recordRange.hours || 0) > 2 && (strictRange.count || 0) < STRICT_WINDOW_MIN_COUNT) {
    reasons.push("Legacy records span multiple days, so they cannot be treated as one continuous one-hour experiment.");
    corrections.push("Use strict decision snapshots and gap-limited transitions for causal validation.");
  }
  if (transitions.length < STRICT_WINDOW_MIN_COUNT) {
    reasons.push(`Strict continuous transitions are insufficient: ${transitions.length}/${STRICT_WINDOW_MIN_COUNT}.`);
    corrections.push("Keep the monitor running for at least six 10-minute windows before upgrading confidence.");
  }
  if (!hasCampaignList) {
    reasons.push("No campaign list API response was captured in the strict window.");
    corrections.push("Keep broad ads.tiktok.com API capture enabled and verify campaign_list responses contain plan rows.");
  }
  if (!pageEvidence.latest) {
    reasons.push("No page snapshot evidence was available for visible sort, filter, table, or recommendation state.");
    corrections.push("Collect page snapshots from the content script once per minute.");
  }

  return {
    status: reasons.length === 0 && activeWindows >= STRICT_WINDOW_MIN_COUNT ? "validated_external_logic" : "needs_more_evidence",
    isPreviousBreakdownCorrect: reasons.length === 0 ? "partially" : "incomplete",
    confidence:
      reasons.length === 0 && activeWindows >= STRICT_WINDOW_MIN_COUNT
        ? "medium"
        : hasCampaignList && transitions.length >= 3
          ? "low_to_medium"
          : "low",
    reasons,
    corrections
  };
}

function inferHypothesis({ transitions, allocationWindows, endpointCounts, pageEvidence, verdict }) {
  const activeTransitions = transitions.filter((row) => row.spendDelta > 0);
  const roiGapKnown = activeTransitions.filter((row) => row.roiGap != null);
  const positiveSpendAboveTarget = roiGapKnown.filter((row) => row.roiGap >= 0).length;
  return {
    confidence: verdict.confidence,
    evidenceLimit:
      "This validates only external dashboard/API behavior. It cannot expose TikTok's private ranking, bidding, auction, or model weights.",
    rules: [
      "Traffic allocation should be measured by next-window spend delta share, not by cumulative spend share.",
      "Ranking or bidding logic is not directly observable unless the page or API exposes impression, bid, candidate, creative, or rank features.",
      "Target ROI can only be tested as a pacing constraint when target ROI is visible for the same campaign window.",
      "Creative/material scoring can only be tested when material, recommendation, or diagnostic endpoint fields are captured and joined to later spend deltas.",
      "Analytics and monitoring endpoints prove user/page events were sent, but they are not by themselves ranking-model evidence."
    ],
    observed: {
      activeSpendTransitions: activeTransitions.length,
      activeAllocationWindows: allocationWindows.filter((window) => window.totalSpendDelta > 0).length,
      campaignListResponses: endpointCounts.campaign_list || 0,
      pageSnapshots: pageEvidence.count,
      positiveSpendAboveTargetRate:
        roiGapKnown.length > 0 ? round(positiveSpendAboveTarget / roiGapKnown.length) : null
    }
  };
}

function rangeOf(rows) {
  const times = rows
    .map((row) => toMs(row.timestamp || row.timestampFinished || row.collectorTimestamp || row.generatedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    count: rows.length,
    first: times.length ? new Date(times[0]).toISOString() : null,
    last: times.length ? new Date(times.at(-1)).toISOString() : null,
    hours: times.length > 1 ? round((times.at(-1) - times[0]) / 3600000) : 0
  };
}

function latestTimestamp(rows) {
  const times = rows.map((row) => toMs(row.timestamp || row.timestampFinished || row.collectorTimestamp)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

function renderMarkdown(report) {
  const latestWindows = report.allocationEvidence.latestWindows || [];
  return [
    "# GMV Max Decision Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verification Verdict",
    "",
    `- Status: ${report.verificationVerdict.status}`,
    `- Previous breakdown: ${report.verificationVerdict.isPreviousBreakdownCorrect}`,
    `- Confidence: ${report.verificationVerdict.confidence}`,
    ...report.verificationVerdict.reasons.map((reason) => `- Reason: ${reason}`),
    ...report.verificationVerdict.corrections.map((correction) => `- Correction: ${correction}`),
    "",
    "## Observation Window",
    "",
    `- Legacy records: ${report.observationWindow.legacyRecords.count} over ${report.observationWindow.legacyRecords.hours}h`,
    `- Strict decision snapshots: ${report.observationWindow.strictDecisionSnapshots.count} over ${report.observationWindow.strictDecisionSnapshots.hours}h`,
    `- Last-hour snapshots: ${report.observationWindow.lastHour.snapshotCount}`,
    `- Last-hour network exchanges: ${report.observationWindow.lastHour.exchangeCount}`,
    `- Last-hour page snapshots: ${report.observationWindow.lastHour.pageSnapshotCount}`,
    `- Continuous transitions: ${report.observationWindow.lastHour.continuousTransitionCount}`,
    "",
    "## Network Evidence",
    "",
    ...Object.entries(report.networkEvidence.endpointCounts).map(([key, count]) => `- ${key}: ${count}`),
    "",
    "## Page Evidence",
    "",
    `- Page snapshots: ${report.pageEvidence.count}`,
    `- Body hash changes: ${report.pageEvidence.bodyHashChanges}`,
    `- Latest visible signals: ${(report.pageEvidence.latest?.visibleSignals || []).join(", ") || "-"}`,
    `- Latest table rows: ${report.pageEvidence.latest?.tableRowCount ?? 0}`,
    "",
    "## Allocation Evidence",
    "",
    `- Active allocation windows: ${report.allocationEvidence.activeWindowCount}`,
    ...latestWindows.flatMap((window) => [
      `- Window ${window.from} -> ${window.to}: spend +${window.totalSpendDelta}, revenue +${window.totalRevenueDelta}, ROI ${window.roiDelta ?? "-"}`,
      ...window.topReceivers.slice(0, 3).map((row) => `  - ${row.name}: +${row.spendDelta} (${row.spendDeltaShare})`)
    ]),
    "",
    "## Current Hypothesis",
    "",
    `Confidence: ${report.currentBestHypothesis.confidence}`,
    "",
    ...report.currentBestHypothesis.rules.map((rule) => `- ${rule}`),
    "",
    `Limit: ${report.currentBestHypothesis.evidenceLimit}`,
    ""
  ].join("\n");
}

async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}

function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
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

function mergeMany(groups) {
  return unique(groups.flat().filter(Boolean));
}

function unique(values) {
  return [...new Set(values)];
}

function numberFrom(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function numberOrNull(value) {
  const number = numberFrom(value);
  return Number.isFinite(number) && value != null && value !== "" ? number : null;
}

function toMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function mean(values) {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function round(value) {
  return Number(Number(value || 0).toFixed(4));
}
