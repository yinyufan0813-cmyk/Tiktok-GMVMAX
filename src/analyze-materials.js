import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const outputDir = path.resolve(process.env.GMVMAX_OUTPUT_DIR || "./logs");
const prefix = process.env.MATERIAL_OUTPUT_PREFIX || "material";
const recordsPath = path.join(outputDir, `${prefix}-records.jsonl`);
const networkPath = path.join(outputDir, `${prefix}-network-exchanges.jsonl`);
const pageSnapshotPath = path.join(outputDir, `${prefix}-page-snapshots.jsonl`);
const reportJsonPath = path.join(outputDir, `${prefix}-ranking-bid-report.json`);
const reportMdPath = path.join(outputDir, `${prefix}-ranking-bid-report.md`);

const MAX_CONTINUOUS_GAP_MS = Number(process.env.MATERIAL_MAX_CONTINUOUS_GAP_MINUTES || 30) * 60 * 1000;
const MIN_WINDOW_GAP_MS = Number(process.env.MATERIAL_MIN_WINDOW_GAP_SECONDS || 45) * 1000;
const MIN_VALID_WINDOWS = Number(process.env.MATERIAL_STRICT_WINDOW_MIN_COUNT || 6);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const records = await readJsonl(recordsPath);
  const exchanges = await readJsonl(networkPath);
  const pageSnapshots = await readJsonl(pageSnapshotPath);
  const report = buildReport({ records, exchanges, pageSnapshots });
  await fs.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(reportMdPath, renderMarkdown(report), "utf8");
  console.log(`[MATERIAL] Ranking/bid report: ${reportMdPath}`);
}

function buildReport({ records, exchanges, pageSnapshots }) {
  const latestTime = latestTimestamp([...records, ...exchanges, ...pageSnapshots]);
  const cutoff24h = latestTime ? latestTime - 24 * 60 * 60 * 1000 : 0;
  const recentRecords = records.filter((row) => toMs(row.timestamp) >= cutoff24h);
  const recentExchanges = exchanges.filter((row) => toMs(row.timestampFinished || row.collectorTimestamp || row.timestamp) >= cutoff24h);
  const recentSnapshots = pageSnapshots.filter((row) => toMs(row.timestamp || row.collectorTimestamp) >= cutoff24h);
  const transitions = buildTransitions(recentRecords);
  const activeWindows = summarizeWindows(transitions).filter((window) => window.activeMaterialCount > 0);
  const endpointStructures = summarizeEndpointStructures(recentExchanges);
  const correlations = buildCorrelationSummary(transitions);
  const verdict = buildVerdict({
    recentRecords,
    recentExchanges,
    recentSnapshots,
    transitions,
    activeWindows,
    endpointStructures,
    correlations
  });

  return {
    generatedAt: new Date().toISOString(),
    observationWindow: {
      records: rangeOf(records),
      network: rangeOf(exchanges),
      pageSnapshots: rangeOf(pageSnapshots),
      last24h: {
        recordCount: recentRecords.length,
        materialRowCount: recentRecords.reduce((sum, record) => sum + (record.materials || []).length, 0),
        exchangeCount: recentExchanges.length,
        pageSnapshotCount: recentSnapshots.length,
        continuousTransitionCount: transitions.length,
        activeWindowCount: activeWindows.length
      }
    },
    pageEvidence: summarizePageEvidence(recentSnapshots),
    networkEvidence: {
      endpointCounts: countBy(recentExchanges, (row) => row.endpointFamily || row.endpointKey || "unknown"),
      endpointStructures
    },
    transitionEvidence: {
      activeWindows: activeWindows.slice(-12),
      topMovers: topMaterialMovers(transitions)
    },
    modelEstimate: inferModelEstimate({ transitions, activeWindows, endpointStructures, correlations, verdict }),
    verificationVerdict: verdict
  };
}

function buildTransitions(records) {
  const snapshots = records
    .map((record) => ({
      timestamp: record.timestamp,
      url: record.url,
      materials: (record.materials || []).map(normalizeMaterial).filter((material) => material.key)
    }))
    .filter((snapshot) => snapshot.materials.length > 0)
    .sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));

  const transitions = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    const gapMs = toMs(current.timestamp) - toMs(previous.timestamp);
    if (gapMs < MIN_WINDOW_GAP_MS || gapMs > MAX_CONTINUOUS_GAP_MS) continue;

    const previousByKey = new Map(previous.materials.map((material) => [material.key, material]));
    for (const material of current.materials) {
      const before = previousByKey.get(material.key);
      if (!before) continue;
      transitions.push({
        from: previous.timestamp,
        to: current.timestamp,
        gapMinutes: round(gapMs / 60000),
        key: material.key,
        materialId: material.materialId,
        name: material.name,
        status: material.status,
        indexBefore: before.index,
        indexAfter: material.index,
        rankMove: before.index - material.index,
        spendDelta: positiveDelta(material.spend, before.spend),
        revenueDelta: positiveDelta(material.revenue, before.revenue),
        ordersDelta: positiveDelta(material.orders, before.orders),
        impressionsDelta: positiveDelta(material.impressions, before.impressions),
        clicksDelta: positiveDelta(material.clicks, before.clicks),
        roi: material.roi,
        ctr: material.ctr,
        cvr: material.cvr,
        cpc: material.cpc,
        cpm: material.cpm,
        cpa: material.cpa,
        bid: material.bid,
        rankScore: material.rankScore,
        rank: material.rank
      });
    }
  }
  return transitions;
}

function normalizeMaterial(material) {
  const metrics = material.metrics || {};
  const spend = numberOrNull(metrics.spend);
  const revenue = numberOrNull(metrics.revenue);
  const impressions = numberOrNull(metrics.impressions);
  const clicks = numberOrNull(metrics.clicks);
  const orders = numberOrNull(metrics.orders);
  return {
    key: material.key || material.materialId || material.name,
    materialId: material.materialId || null,
    name: material.name || material.key || "unknown",
    status: material.status || null,
    index: numberOrNull(material.index),
    spend,
    revenue,
    impressions,
    clicks,
    orders,
    roi: numberOrNull(metrics.roi) ?? (spend > 0 && revenue != null ? revenue / spend : null),
    ctr: numberOrNull(metrics.ctr) ?? (impressions > 0 && clicks != null ? (clicks / impressions) * 100 : null),
    cvr: numberOrNull(metrics.cvr) ?? (clicks > 0 && orders != null ? (orders / clicks) * 100 : null),
    cpc: numberOrNull(metrics.cpc) ?? (clicks > 0 && spend != null ? spend / clicks : null),
    cpm: numberOrNull(metrics.cpm) ?? (impressions > 0 && spend != null ? (spend / impressions) * 1000 : null),
    cpa: numberOrNull(metrics.cpa) ?? (orders > 0 && spend != null ? spend / orders : null),
    bid: numberOrNull(metrics.bid),
    rankScore: numberOrNull(metrics.rankScore),
    rank: numberOrNull(metrics.rank)
  };
}

function summarizeWindows(transitions) {
  const byWindow = groupBy(transitions, (row) => `${row.from}->${row.to}`);
  return [...byWindow.entries()].map(([windowKey, rows]) => {
    const totalSpendDelta = rows.reduce((sum, row) => sum + row.spendDelta, 0);
    const totalImpressionsDelta = rows.reduce((sum, row) => sum + row.impressionsDelta, 0);
    const ranked = rows
      .map((row) => ({
        key: row.key,
        name: row.name,
        spendDelta: round(row.spendDelta),
        spendShare: totalSpendDelta > 0 ? round(row.spendDelta / totalSpendDelta) : 0,
        impressionsDelta: round(row.impressionsDelta),
        impressionShare: totalImpressionsDelta > 0 ? round(row.impressionsDelta / totalImpressionsDelta) : 0,
        revenueDelta: round(row.revenueDelta),
        ordersDelta: round(row.ordersDelta),
        rankMove: row.rankMove,
        roi: round(row.roi),
        ctr: round(row.ctr),
        cvr: round(row.cvr),
        bid: row.bid,
        rankScore: row.rankScore
      }))
      .sort((a, b) => (b.spendDelta + b.impressionsDelta) - (a.spendDelta + a.impressionsDelta));
    return {
      windowKey,
      from: rows[0]?.from,
      to: rows[0]?.to,
      gapMinutes: rows[0]?.gapMinutes || 0,
      totalSpendDelta: round(totalSpendDelta),
      totalImpressionsDelta: round(totalImpressionsDelta),
      activeMaterialCount: rows.filter((row) => row.spendDelta > 0 || row.impressionsDelta > 0).length,
      ranked: ranked.slice(0, 10)
    };
  });
}

function topMaterialMovers(transitions) {
  const byMaterial = groupBy(transitions, (row) => row.key);
  return [...byMaterial.entries()]
    .map(([key, rows]) => ({
      key,
      name: rows.at(-1)?.name || key,
      windows: rows.length,
      spendDelta: round(rows.reduce((sum, row) => sum + row.spendDelta, 0)),
      impressionsDelta: round(rows.reduce((sum, row) => sum + row.impressionsDelta, 0)),
      revenueDelta: round(rows.reduce((sum, row) => sum + row.revenueDelta, 0)),
      ordersDelta: round(rows.reduce((sum, row) => sum + row.ordersDelta, 0)),
      avgRankMove: mean(rows.map((row) => row.rankMove).filter(Number.isFinite)),
      latestRoi: round(rows.at(-1)?.roi),
      latestCtr: round(rows.at(-1)?.ctr),
      latestCvr: round(rows.at(-1)?.cvr),
      latestBid: rows.at(-1)?.bid ?? null,
      latestRankScore: rows.at(-1)?.rankScore ?? null
    }))
    .sort((a, b) => (b.spendDelta + b.impressionsDelta) - (a.spendDelta + a.impressionsDelta))
    .slice(0, 20);
}

function buildCorrelationSummary(transitions) {
  const active = transitions.filter((row) => row.spendDelta > 0 || row.impressionsDelta > 0);
  const target = active.map((row) => row.spendDelta || row.impressionsDelta);
  const fields = ["roi", "ctr", "cvr", "cpc", "cpm", "cpa", "bid", "rankScore", "rankMove"];
  return Object.fromEntries(
    fields.map((field) => [field, correlation(active.map((row) => row[field]), target)])
  );
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

function summarizePageEvidence(snapshots) {
  const latest = snapshots.at(-1) || null;
  return {
    count: snapshots.length,
    latest: latest
      ? {
          timestamp: latest.timestamp || latest.collectorTimestamp,
          url: latest.url || latest.pageUrl,
          visibleSignals: latest.summary?.visibleSignals || latest.visibleSignals || [],
          materialCount: latest.materialCount || latest.summary?.materialCount || 0,
          sortState: latest.rankingState?.sortState || latest.sortState || [],
          actionState: latest.rankingState?.actionState || latest.actionState || []
        }
      : null,
    bodyHashChanges: unique(snapshots.map((snapshot) => snapshot.summary?.bodyTextHash || snapshot.bodyTextHash).filter(Boolean)).length
  };
}

function buildVerdict({ recentRecords, recentExchanges, recentSnapshots, transitions, activeWindows, endpointStructures, correlations }) {
  const reasons = [];
  const corrections = [];
  const families = new Set([
    ...endpointStructures.map((row) => row.endpointFamily),
    ...recentExchanges.map((row) => row.endpointFamily)
  ]);
  const hasMaterialEndpoint = families.has("creative_material");
  const hasDeliveryEndpoint = families.has("delivery_signal");
  const hasReportEndpoint = families.has("performance_report") || families.has("campaign_control");
  const hasBidField = transitions.some((row) => row.bid != null);
  const hasRankScoreField = transitions.some((row) => row.rankScore != null || row.rank != null);
  const hasOutcomeDelta = transitions.some((row) => row.spendDelta > 0 || row.impressionsDelta > 0);

  if (recentRecords.length < 2) {
    reasons.push("Material snapshots are insufficient for time-window validation.");
    corrections.push("Run `npm run material` for at least two intervals; six continuous windows are preferred.");
  }
  if (activeWindows.length < MIN_VALID_WINDOWS) {
    reasons.push(`Active material windows are insufficient: ${activeWindows.length}/${MIN_VALID_WINDOWS}.`);
    corrections.push("Keep the material monitor running through multiple 10-minute refresh windows.");
  }
  if (!hasMaterialEndpoint) {
    reasons.push("No creative/material API response was captured in the 24h window.");
    corrections.push("Open the material/creative/detail tab in the monitored Chrome and keep network capture enabled.");
  }
  if (!hasDeliveryEndpoint && !hasBidField) {
    reasons.push("No bid/rank/delivery estimate endpoint or explicit bid field was captured.");
    corrections.push("Capture recommendation, estimate, delivery, bid, rank, or auction-related responses before upgrading bid-model confidence.");
  }
  if (!hasReportEndpoint || !hasOutcomeDelta) {
    reasons.push("No reliable outcome deltas are available to compare against material ranking signals.");
    corrections.push("Join material rows to spend, impression, click, order, or GMV deltas in the next windows.");
  }
  if (recentSnapshots.length === 0) {
    reasons.push("No material page snapshots were available for visible sort/filter/page state.");
    corrections.push("Keep CDP material monitor running; tune selectors if the table is custom-rendered.");
  }

  const strongestCorrelation = Math.max(0, ...Object.values(correlations).map((value) => Math.abs(value || 0)));
  return {
    status:
      reasons.length === 0 && strongestCorrelation >= 0.5
        ? "validated_external_material_logic"
        : "needs_more_evidence",
    confidence:
      reasons.length === 0
        ? "medium"
        : hasMaterialEndpoint && activeWindows.length >= 3
          ? "low_to_medium"
          : "low",
    observedCapabilities: {
      materialEndpoint: hasMaterialEndpoint,
      deliveryOrBidEndpoint: hasDeliveryEndpoint || hasBidField,
      rankScoreField: hasRankScoreField,
      outcomeDeltas: hasOutcomeDelta,
      strongestCorrelation: round(strongestCorrelation)
    },
    reasons,
    corrections
  };
}

function inferModelEstimate({ transitions, activeWindows, endpointStructures, correlations, verdict }) {
  const endpointFamilies = countBy(endpointStructures, (row) => row.endpointFamily || "unknown");
  const positiveHints = Object.entries(correlations)
    .filter(([, value]) => Number.isFinite(value))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 6)
    .map(([field, value]) => ({ field, correlationToNextSpendOrImpressions: round(value) }));

  return {
    confidence: verdict.confidence,
    evidenceLimit:
      "This estimates only externally visible material ranking, pacing, and bid proxies. It cannot expose TikTok private model weights or auction internals.",
    estimatedSignals: [
      "Next-window spend or impression delta is the safest observable proxy for material rank/traffic allocation.",
      "If explicit bid, estimate, delivery, or rank fields appear in API responses, treat them as stronger evidence than analytics events.",
      "CTR/CVR/ROI/order deltas can be tested as material quality signals only after they are joined to continuous outcome windows.",
      "Recommendation or diagnosis responses are candidate model features, but they are not ranking evidence until later traffic shifts match them."
    ],
    observed: {
      activeWindowCount: activeWindows.length,
      transitionCount: transitions.length,
      endpointFamilies,
      strongestObservedCorrelations: positiveHints
    }
  };
}

function renderMarkdown(report) {
  const latestWindows = report.transitionEvidence.activeWindows || [];
  const endpointCounts = report.networkEvidence.endpointCounts || {};
  return [
    "# Material Ranking And Bid Estimate Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verification Verdict",
    "",
    `- Status: ${report.verificationVerdict.status}`,
    `- Confidence: ${report.verificationVerdict.confidence}`,
    ...report.verificationVerdict.reasons.map((reason) => `- Reason: ${reason}`),
    ...report.verificationVerdict.corrections.map((correction) => `- Correction: ${correction}`),
    "",
    "## 24h Coverage",
    "",
    `- Material snapshots: ${report.observationWindow.last24h.recordCount}`,
    `- Material rows: ${report.observationWindow.last24h.materialRowCount}`,
    `- Network exchanges: ${report.observationWindow.last24h.exchangeCount}`,
    `- Page snapshots: ${report.observationWindow.last24h.pageSnapshotCount}`,
    `- Continuous transitions: ${report.observationWindow.last24h.continuousTransitionCount}`,
    `- Active windows: ${report.observationWindow.last24h.activeWindowCount}`,
    "",
    "## Network Evidence",
    "",
    ...Object.entries(endpointCounts).map(([family, count]) => `- ${family}: ${count}`),
    "",
    "## Page Evidence",
    "",
    `- Page snapshots: ${report.pageEvidence.count}`,
    `- Body hash changes: ${report.pageEvidence.bodyHashChanges}`,
    `- Latest material rows: ${report.pageEvidence.latest?.materialCount ?? 0}`,
    `- Latest visible signals: ${(report.pageEvidence.latest?.visibleSignals || []).join(", ") || "-"}`,
    "",
    "## Latest Active Windows",
    "",
    ...latestWindows.slice(-6).flatMap((window) => [
      `- Window ${window.from} -> ${window.to}: spend +${window.totalSpendDelta}, impressions +${window.totalImpressionsDelta}, active materials ${window.activeMaterialCount}`,
      ...window.ranked.slice(0, 3).map((row) => `  - ${row.name}: spend +${row.spendDelta}, impressions +${row.impressionsDelta}, ROI ${row.roi ?? "-"}, CTR ${row.ctr ?? "-"}, bid ${row.bid ?? "-"}`)
    ]),
    "",
    "## Current Model Estimate",
    "",
    `Confidence: ${report.modelEstimate.confidence}`,
    "",
    ...report.modelEstimate.estimatedSignals.map((rule) => `- ${rule}`),
    "",
    `Limit: ${report.modelEstimate.evidenceLimit}`,
    ""
  ].join("\n");
}

async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}

function rangeOf(rows) {
  const times = rows.map((row) => toMs(row.timestamp || row.timestampFinished || row.collectorTimestamp || row.generatedAt)).filter(Number.isFinite).sort((a, b) => a - b);
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

function positiveDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  return round(Math.max(0, current - previous));
}

function correlation(xs, ys) {
  const pairs = xs.map((x, index) => [numberOrNull(x), numberOrNull(ys[index])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 4) return null;
  const meanX = mean(pairs.map(([x]) => x));
  const meanY = mean(pairs.map(([, y]) => y));
  const numerator = pairs.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const denomX = Math.sqrt(pairs.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0));
  const denomY = Math.sqrt(pairs.reduce((sum, [, y]) => sum + (y - meanY) ** 2, 0));
  return denomX > 0 && denomY > 0 ? round(numerator / (denomX * denomY)) : null;
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

function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function toMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function mean(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length ? round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length) : 0;
}

function round(value, digits = 4) {
  return value == null || Number.isNaN(Number(value)) ? null : Number(Number(value || 0).toFixed(digits));
}
