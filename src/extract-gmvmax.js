export function extractGmvMaxRecord({ labels, selectors }) {
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
      totalOrderAmount: firstText(selectors.totalOrderAmount, row),
      totalBudget: firstText(selectors.totalBudget, row)
    }));
  }

  function extractTableRows() {
    const rowNodes = Array.from(document.querySelectorAll("tr, [role='row']"));
    return rowNodes
      .map((row) => {
        const cells = Array.from(row.querySelectorAll("th,td,[role='columnheader'],[role='cell'],[role='gridcell']"))
          .map((cell) => textOf(cell))
          .filter(Boolean);
        return { rowText: textOf(row), cells };
      })
      .filter(({ rowText, cells }) => {
        if (!rowText.includes("MYR") || !rowText.includes("ID:")) return false;
        if (/广告计划名称|Campaign name/i.test(rowText)) return false;
        return cells.length >= 5;
      })
      .map(({ rowText, cells }, index) => {
        const accountCell = cells.find((cell) => cell.includes("ID:")) || rowText;
        const account = accountCell.match(/(?:recommendations?|条建议)?\s*(.*?)\s+ID:/i)?.[1]?.trim() || null;
        const name = cells[0] || `live-plan-${index + 1}`;
        const moneyCells = cells.filter((cell) => /\bMYR\b/.test(cell));
        const budget = moneyCells[0] || "";
        const spend = moneyCells[1] || "";
        const revenue = moneyCells[2] || "";
        if (!account || !spend || !revenue) return null;

        return {
          index: index + 1,
          account,
          name,
          totalSpend: moneyText(parseNumber(spend)),
          totalBudget: moneyText(parseNumber(budget)),
          netSpend: moneyText(parseNumber(spend)),
          totalOrderAmount: moneyText(parseNumber(revenue))
        };
      })
      .filter(Boolean);
  }

  function parseNumber(value) {
    if (!value) return null;
    const normalized = value.replace(/,/g, "");
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function moneyText(value) {
    return value == null ? null : `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MYR`;
  }

  function englishOverviewMetrics(bodyText) {
    const cost = bodyText.match(/\bCost\s+([\d,]+(?:\.\d+)?)\s+MYR\s+vs last/i);
    const grossRevenue = bodyText.match(/\bGross revenue \(Current shop\)\s+([\d,]+(?:\.\d+)?)\s+MYR\s+vs last/i);
    const chineseCost = bodyText.match(/(?:概览[\s\S]*?)?成本\s+([\d,]+(?:\.\d+)?)\s+MYR\s+较近/);
    const chineseGrossRevenue = bodyText.match(/总收入（当前店铺）\s+([\d,]+(?:\.\d+)?)\s+MYR\s+较近/);
    return {
      totalSpend: cost?.[1] ? `${cost[1]} MYR` : chineseCost?.[1] ? `${chineseCost[1]} MYR` : null,
      totalOrderAmount: grossRevenue?.[1] ? `${grossRevenue[1]} MYR` : chineseGrossRevenue?.[1] ? `${chineseGrossRevenue[1]} MYR` : null
    };
  }

  function englishLivePlans(bodyText) {
    const rows = [];
    const rowPattern = /(LIVE GMV Max_[\s\S]*?)(?=\sLIVE GMV Max_| u user|\s*$)/g;
    let match;
    while ((match = rowPattern.exec(bodyText)) !== null) {
      const rowText = match[1].replace(/\s+/g, " ").trim();
      const values = Array.from(rowText.matchAll(/([\d,]+(?:\.\d+)?)\s+MYR/g)).map((item) => parseNumber(item[1]));
      if (values.length < 6) continue;

      const grossRevenueIndex = values.length >= 7 ? values.length - 5 : values.length - 4;
      const planName = rowText.match(/^(.*?)\s+(?:Active|已生效)\s+/)?.[1] || `live-plan-${rows.length + 1}`;
      const account = rowText.match(/(?:recommendations?|条建议)\s+(.*?)\s+ID:/i)?.[1]?.trim() || null;
      rows.push({
        index: rows.length + 1,
        account,
        name: planName,
        netSpend: moneyText(values[grossRevenueIndex - 1]),
        totalSpend: moneyText(values[2]),
        totalBudget: moneyText(values[3]),
        totalOrderAmount: moneyText(values[grossRevenueIndex])
      });
    }
    return rows;
  }

  function extractCampaignRowsFromBody(bodyText) {
    const tableIndex = bodyText.indexOf("广告计划列表");
    const source = tableIndex >= 0 ? bodyText.slice(tableIndex) : bodyText;
    const headerIndex = source.indexOf("ROI");
    const body = headerIndex >= 0 ? source.slice(headerIndex + 3) : source;
    const blocks = body.split(/\n\s*\n\s*\n/);

    return blocks
      .map((block) => parseCampaignBlock(block))
      .filter(Boolean)
      .map((row, index) => ({ index: index + 1, ...row }));
  }

  function parseCampaignBlock(block) {
    const text = String(block || "").trim();
    if (!text || !text.includes("MYR") || !/\d{4}-\d{2}-\d{2}/.test(text)) return null;

    const parts = text
      .split(/\n\t\n/g)
      .map((part) => part.replace(/\t/g, "").trim())
      .filter(Boolean);
    if (parts.length < 14) return null;

    const tail = parts.slice(-6);
    const name = parts[0].replace(/\n数据分析\n修改/g, "").trim();
    const benefit = parts.slice(6, parts.length - 8).join(" | ").replace(/^[-\s|]+$/, "-").trim() || "-";

    return {
      name,
      status: parts[1],
      budget: moneyText(parseNumber(parts[2])),
      cost: moneyText(parseNumber(parts[3])),
      roiProtection: parts[4],
      suggestionCount: /\d+/.test(parts[5] || "") ? Number((parts[5] || "").match(/\d+/)[0]) : 0,
      benefit,
      schedule: parts[parts.length - 8],
      creativeBudget: parts[parts.length - 7],
      targetRoi: parseNumber(tail[0]),
      netCost: moneyText(parseNumber(tail[1])),
      orders: parseNumber(tail[2]),
      avgOrderCost: moneyText(parseNumber(tail[3])),
      revenue: moneyText(parseNumber(tail[4])),
      roi: parseNumber(tail[5])
    };
  }

  const bodyText = textOf(document.body).slice(0, 20000);
  const labelMetrics = Object.fromEntries(
    Object.entries(labels).map(([key, labelOptions]) => [key, valueAfterLabel(labelOptions)])
  );
  const englishMetrics = englishOverviewMetrics(bodyText);
  const plans = extractBySelectors();
  const tablePlans = extractTableRows();
  const englishPlans = englishLivePlans(bodyText);
  const campaignRows = extractCampaignRowsFromBody(bodyText);
  const parsedPlans = plans.length > 0 ? plans : tablePlans.length > 0 ? tablePlans : englishPlans;
  const metrics = {
    newSpend: labelMetrics.newSpend || null,
    newOrderAmount: labelMetrics.newOrderAmount || null,
    totalSpend: labelMetrics.totalSpend || englishMetrics.totalSpend,
    totalOrderAmount: labelMetrics.totalOrderAmount || englishMetrics.totalOrderAmount,
    totalBudget: labelMetrics.totalBudget || parsedPlans.find((plan) => plan.totalBudget)?.totalBudget || null
  };

  return {
    url: location.href,
    title: document.title,
    metrics,
    plans: parsedPlans,
    campaigns: campaignRows,
    pageState: {
      hasSystemError: /System error|No campaigns found/i.test(bodyText),
      planCount: parsedPlans.length,
      campaignCount: campaignRows.length
    },
    bodyText
  };
}
