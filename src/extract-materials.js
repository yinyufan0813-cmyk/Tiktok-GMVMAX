export function extractMaterialRecord({ selectors = {}, labels = {} } = {}) {
  const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const numberRe = /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/;
  const hashText = (value) => {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function firstText(selector, root = document) {
    if (!selector) return null;
    const node = root.querySelector(selector);
    return node ? textOf(node) : null;
  }

  function parseNumber(value) {
    if (value == null) return null;
    const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function routeState() {
    const params = new URLSearchParams(location.search);
    return {
      pathname: location.pathname,
      type: params.get("type"),
      campaignId: params.get("campaign_id") || params.get("campaignId"),
      adgroupId: params.get("adgroup_id") || params.get("adgroupId"),
      materialId: params.get("material_id") || params.get("materialId"),
      creativeId: params.get("creative_id") || params.get("creativeId"),
      hasDateRange: params.has("start_date") || params.has("end_date") || params.has("list_start_date")
    };
  }

  function headerCells(table) {
    const headerRow =
      table.querySelector("thead tr") ||
      Array.from(table.querySelectorAll("tr, [role='row']")).find((row) =>
        /material|素材|creative|创意|video|视频|cost|消耗|gmv|roi|rank|排序|bid|出价/i.test(textOf(row))
      );
    return Array.from(headerRow?.querySelectorAll("th, [role='columnheader'], td") || [])
      .map((cell) => textOf(cell))
      .filter(Boolean);
  }

  function rowCells(row) {
    return Array.from(row.querySelectorAll("td, th, [role='cell'], [role='gridcell']"))
      .map((cell) => textOf(cell))
      .filter(Boolean);
  }

  function metricFromCells(headers, cells, aliases) {
    const lowerAliases = aliases.map((item) => item.toLowerCase());
    const index = headers.findIndex((header) => {
      const lower = header.toLowerCase();
      return lowerAliases.some((alias) => lower.includes(alias));
    });
    if (index >= 0 && index < cells.length) return cells[index];
    const joined = cells.join(" ");
    for (const alias of aliases) {
      const match = joined.match(new RegExp(`${escapeRegex(alias)}\\s*[:：]?\\s*([¥￥$A-Z]{0,4}\\s*[-\\d,.]+%?)`, "i"));
      if (match) return match[1];
    }
    return null;
  }

  function materialIdFromRow(row, rowText) {
    const href = Array.from(row.querySelectorAll("a[href]"))
      .map((link) => link.getAttribute("href") || "")
      .find((value) => /material|creative|asset|video/i.test(value));
    const idText = `${href || ""} ${rowText}`;
    const match =
      idText.match(/(?:material|creative|asset|video)[_-]?id[=:：\s]+(\d{6,})/i) ||
      idText.match(/\b(?:mid|cid|vid)[=:：\s]+(\d{6,})/i) ||
      idText.match(/\b(\d{12,})\b/);
    return match?.[1] || null;
  }

  function materialName(headers, cells, fallback) {
    return (
      metricFromCells(headers, cells, labels.name || ["Material", "素材", "Creative", "创意", "Video", "视频", "Name", "名称"]) ||
      cells.find((cell) => /material|素材|creative|创意|video|视频|GMV Max/i.test(cell)) ||
      fallback
    );
  }

  function materialFromCells({ row, cells, headers, index }) {
    if (isGmvMaxProductCells(cells)) return materialFromGmvMaxCells({ row, cells, index });
    const rowText = textOf(row);
    const name = materialName(headers, cells, `material-${index + 1}`);
    const metrics = {
      impressions: parseNumber(metricFromCells(headers, cells, labels.impressions || ["Impressions", "曝光", "展现"])),
      clicks: parseNumber(metricFromCells(headers, cells, labels.clicks || ["Clicks", "点击"])),
      orders: parseNumber(metricFromCells(headers, cells, labels.orders || ["Orders", "订单", "SKU orders"])),
      spend: parseNumber(metricFromCells(headers, cells, labels.spend || ["Cost", "Spend", "消耗", "花费", "Net cost"])),
      revenue: parseNumber(metricFromCells(headers, cells, labels.revenue || ["GMV", "Revenue", "收入", "成交", "Gross revenue"])),
      roi: parseNumber(metricFromCells(headers, cells, labels.roi || ["ROI", "ROAS"])),
      ctr: parseNumber(metricFromCells(headers, cells, labels.ctr || ["CTR", "点击率"])),
      cvr: parseNumber(metricFromCells(headers, cells, labels.cvr || ["CVR", "转化率"])),
      cpc: parseNumber(metricFromCells(headers, cells, labels.cpc || ["CPC", "点击成本"])),
      cpm: parseNumber(metricFromCells(headers, cells, labels.cpm || ["CPM", "千次"])),
      cpa: parseNumber(metricFromCells(headers, cells, labels.cpa || ["CPA", "下单成本", "Order cost"])),
      bid: parseNumber(metricFromCells(headers, cells, labels.bid || ["Bid", "出价"])),
      rankScore: parseNumber(metricFromCells(headers, cells, labels.rankScore || ["Score", "分数", "Rank score", "质量分"])),
      rank: parseNumber(metricFromCells(headers, cells, labels.rank || ["Rank", "排序", "排名"]))
    };
    return {
      index: index + 1,
      key: materialIdFromRow(row, rowText) || `${name}|${index + 1}`,
      materialId: materialIdFromRow(row, rowText),
      name,
      status: metricFromCells(headers, cells, labels.status || ["Status", "状态"]) || inferStatus(rowText),
      sourceTextHash: hashText(rowText),
      cells: cells.slice(0, 24),
      metrics
    };
  }

  function isGmvMaxProductCells(cells) {
    return /GMV Max/i.test(cells[0] || "") && cells.length >= 15 && /MYR|RM/.test(cells.join(" "));
  }

  function materialFromGmvMaxCells({ row, cells, index }) {
    const rowText = textOf(row);
    const name = cells[0] || `material-${index + 1}`;
    const materialCount = parseNumber((name.match(/(\d+)\s*条素材/) || [])[1]);
    const suggestionCount = parseNumber((cells[5]?.match(/(\d+)\s*条建议/) || [])[1]);
    const schedule = cells[7] || null;
    const key = materialIdFromRow(row, rowText) || `${name}|${schedule || index + 1}`;
    return {
      index: index + 1,
      key,
      materialId: materialIdFromRow(row, rowText),
      name,
      status: cells[1] || inferStatus(rowText),
      sourceTextHash: hashText(rowText),
      cells: cells.slice(0, 24),
      metrics: {
        materialCount,
        spend: parseNumber(cells[3]),
        suggestionCount,
        targetRoi: parseNumber(cells[9]),
        netCost: parseNumber(cells[10]),
        orders: parseNumber(cells[11]),
        avgOrderCost: parseNumber(cells[12]),
        revenue: parseNumber(cells[13]),
        roi: parseNumber(cells[14]),
        impressions: null,
        clicks: null,
        ctr: null,
        cvr: null,
        cpc: null,
        cpm: null,
        cpa: parseNumber(cells[12]),
        bid: null,
        rankScore: null,
        rank: index + 1
      }
    };
  }

  function extractBySelectors() {
    if (!selectors.rows) return [];
    return Array.from(document.querySelectorAll(selectors.rows)).map((row, index) => {
      const cells = rowCells(row);
      const headers = Array.isArray(selectors.headers) ? selectors.headers : [];
      return {
        ...materialFromCells({ row, cells, headers, index }),
        name: firstText(selectors.name, row) || materialName(headers, cells, `material-${index + 1}`),
        status: firstText(selectors.status, row) || inferStatus(textOf(row))
      };
    });
  }

  function extractTables() {
    const tables = Array.from(document.querySelectorAll("table, [role='table'], [role='grid']"));
    const rows = [];
    for (const table of tables) {
      const headers = headerCells(table);
      const rowNodes = Array.from(table.querySelectorAll("tbody tr, [role='row']"));
      for (const row of rowNodes) {
        const cells = rowCells(row);
        const rowText = textOf(row);
        if (cells.length < 2) continue;
        if (!isLikelyMaterialRow(rowText, headers, cells)) continue;
        rows.push(materialFromCells({ row, cells, headers, index: rows.length }));
      }
    }
    return rows;
  }

  function isLikelyMaterialRow(rowText, headers, cells) {
    const joinedHeaders = headers.join(" ");
    if (/material|素材|creative|创意|video|视频|asset|rank|排序|bid|出价/i.test(`${joinedHeaders} ${rowText}`)) {
      return true;
    }
    const numericCells = cells.filter((cell) => numberRe.test(cell)).length;
    return numericCells >= 3 && /cost|spend|gmv|roi|order|click|impression|消耗|成交|订单|点击|曝光/i.test(joinedHeaders);
  }

  function inferStatus(rowText) {
    const match = rowText.match(/\b(Active|Inactive|Paused|Rejected|Learning|Approved|Enabled|Disabled)\b|已生效|暂停|审核|拒绝|投放中|不可用/);
    return match?.[0] || null;
  }

  function visibleSignals(bodyText) {
    const signals = [
      "GMV Max",
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
      "ROI",
      "Recommendation",
      "建议",
      "Diagnosis",
      "诊断"
    ];
    return signals.filter((signal) => bodyText.includes(signal));
  }

  function sortState() {
    return Array.from(document.querySelectorAll("[aria-sort], [data-sort], th button, [role='columnheader']"))
      .map((element) => ({
        text: textOf(element).slice(0, 120),
        ariaSort: element.getAttribute("aria-sort"),
        dataSort: element.getAttribute("data-sort"),
        pressed: element.getAttribute("aria-pressed"),
        selected: element.getAttribute("aria-selected")
      }))
      .filter((item) => item.text || item.ariaSort || item.dataSort || item.pressed || item.selected)
      .slice(0, 30);
  }

  function actionState() {
    return Array.from(document.querySelectorAll("button, [role='button'], a"))
      .map((element) => ({
        text: textOf(element).slice(0, 120),
        disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
        selected: element.getAttribute("aria-selected"),
        expanded: element.getAttribute("aria-expanded")
      }))
      .filter((item) => /material|素材|creative|创意|video|视频|bid|出价|rank|排序|recommend|建议|diagnos|诊断|detail|详情/i.test(item.text))
      .slice(0, 40);
  }

  function safeUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      for (const key of [...parsed.searchParams.keys()]) {
        if (/token|csrf|session|msToken|x-bogus|x-gnarly/i.test(key)) parsed.searchParams.set(key, "[redacted]");
      }
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }

  const bodyText = textOf(document.body);
  const selectorMaterials = extractBySelectors();
  const tableMaterials = extractTables();
  const materials = selectorMaterials.length > 0 ? selectorMaterials : tableMaterials;

  return {
    url: safeUrl(location.href),
    title: document.title,
    routeState: routeState(),
    summary: {
      materialCount: materials.length,
      bodyTextLength: bodyText.length,
      bodyTextHash: hashText(bodyText),
      visibleSignals: visibleSignals(bodyText)
    },
    rankingState: {
      sortState: sortState(),
      actionState: actionState()
    },
    materials,
    bodyText: bodyText.slice(0, 50000)
  };
}
