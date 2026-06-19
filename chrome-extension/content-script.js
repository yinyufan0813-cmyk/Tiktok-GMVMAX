const SNAPSHOT_INTERVAL_MS = 60_000;
const MAX_TEXT = 120;
const MAX_ROWS = 20;
const MAX_CELLS = 12;

sendPageSeen();
sendPageSnapshot("load");
setInterval(() => sendPageSnapshot("interval"), SNAPSHOT_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sendPageSnapshot("visible");
});

function sendPageSeen() {
  chrome.runtime.sendMessage({
    type: "gmvmax-page-seen",
    url: location.href,
    timestamp: new Date().toISOString()
  }).catch(() => {});
}

function sendPageSnapshot(reason) {
  if (!isTargetEvidencePage()) return;
  const snapshot = buildSnapshot(reason);
  chrome.runtime.sendMessage({
    type: "gmvmax-page-snapshot",
    snapshot
  }).catch(() => {});
}

function isTargetEvidencePage() {
  return location.hostname === "ads.tiktok.com" &&
    /gmv-max|campaign|adgroup|material|creative|asset|video/i.test(`${location.pathname} ${location.search}`);
}

function buildSnapshot(reason) {
  const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || "");
  return {
    kind: "page_snapshot",
    reason,
    timestamp: new Date().toISOString(),
    url: safeUrl(location.href),
    title: document.title || "",
    visibilityState: document.visibilityState,
    bodyTextLength: bodyText.length,
    bodyTextHash: hashText(bodyText),
    routeState: routeState(),
    visibleSignals: visibleSignals(bodyText),
    sortState: sortState(),
    tableState: tableState(),
    actionState: actionState()
  };
}

function routeState() {
  const params = new URLSearchParams(location.search);
  return {
    type: params.get("type"),
    activatedTabId: params.get("activated_tab_id"),
    campaignPage: params.get("live_campaign_page") || params.get("campaign_page"),
    campaignPageSize: params.get("live_campaign_page_size") || params.get("campaign_page_size"),
    hasDateRange: params.has("list_start_date") || params.has("list_end_date")
  };
}

function visibleSignals(bodyText) {
  const labels = [
    "LIVE GMV Max",
    "GMV Max",
    "广告计划列表",
    "Target ROI",
    "目标 ROI",
    "Budget",
    "预算",
    "Cost",
    "ROI",
    "Orders",
    "Revenue",
    "Recommendation",
    "建议",
    "Material",
    "素材",
    "Creative",
    "创意",
    "Video",
    "视频",
    "Bid",
    "出价",
    "Rank",
    "排序",
    "CTR",
    "CVR",
    "Diagnosis",
    "诊断"
  ];
  return labels.filter((label) => bodyText.includes(label));
}

function sortState() {
  return Array.from(document.querySelectorAll("[aria-sort], [data-sort], th button, [role='columnheader']"))
    .map((element) => ({
      text: clippedText(element),
      ariaSort: element.getAttribute("aria-sort"),
      dataSort: element.getAttribute("data-sort"),
      pressed: element.getAttribute("aria-pressed"),
      selected: element.getAttribute("aria-selected")
    }))
    .filter((item) => item.text || item.ariaSort || item.dataSort || item.pressed || item.selected)
    .slice(0, 20);
}

function tableState() {
  const rowElements = Array.from(document.querySelectorAll("tr, [role='row']"))
    .filter((row) => clippedText(row).includes("MYR") || /GMV Max|ROI|Budget|预算|消耗|Revenue/i.test(clippedText(row)))
    .slice(0, MAX_ROWS);
  return {
    rowCount: rowElements.length,
    rows: rowElements.map((row, index) => ({
      index,
      textHash: hashText(clippedText(row, 800)),
      cells: Array.from(row.querySelectorAll("th, td, [role='cell'], [role='gridcell'], [role='columnheader']"))
        .map((cell) => clippedText(cell))
        .filter(Boolean)
        .slice(0, MAX_CELLS)
    }))
  };
}

function actionState() {
  return Array.from(document.querySelectorAll("button, [role='button'], a"))
    .map((element) => ({
      text: clippedText(element),
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
      selected: element.getAttribute("aria-selected"),
      expanded: element.getAttribute("aria-expanded")
    }))
    .filter((item) => /recommend|建议|素材|material|creative|创意|video|视频|bid|出价|rank|排序|diagnos|诊断|optimi|roi|budget|预算/i.test(item.text))
    .slice(0, 30);
}

function safeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|csrf|session|msToken|x-bogus|x-gnarly/i.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function clippedText(element, limit = MAX_TEXT) {
  return normalizeText(element?.innerText || element?.textContent || "").slice(0, limit);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hashText(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
