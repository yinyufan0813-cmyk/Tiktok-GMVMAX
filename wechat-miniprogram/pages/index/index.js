const app = getApp();

const refreshMs = 30000;

function formatNumber(value, digits = 2) {
  const number = Number(value || 0);
  return number.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatMoney(value) {
  return `${formatNumber(value)} MYR`;
}

function formatRoi(value) {
  return formatNumber(value);
}

function decorateMetric(metric = {}, formatter = formatMoney) {
  const value = Number(metric.value || 0);
  const diff = Number(metric.diff || 0);
  const direction = metric.direction || "flat";
  return {
    value,
    diff,
    direction,
    text: formatter(value),
    diffText: `${diff >= 0 ? "+" : ""}${formatter(diff)}`,
    arrow: direction === "up" ? "▲" : direction === "down" ? "▼" : "→"
  };
}

function formatTime(value) {
  if (!value) return "暂无数据时间";
  const date = new Date(value);
  const pad = item => String(item).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

Page({
  data: {
    statusText: "读取中...",
    statusClass: "loading",
    error: "",
    summary: {
      intervalSpend: decorateMetric(),
      intervalOrder: decorateMetric(),
      intervalRoi: decorateMetric({}, formatRoi),
      totalRoi: decorateMetric({}, formatRoi)
    },
    accounts: []
  },

  refreshTimer: null,

  onLoad() {
    this.loadData();
  },

  onShow() {
    this.loadData();
  },

  onUnload() {
    this.clearRefreshTimer();
  },

  onHide() {
    this.clearRefreshTimer();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  clearRefreshTimer() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  },

  scheduleRefresh() {
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => this.loadData(), refreshMs);
  },

  loadData() {
    this.setData({
      statusText: "读取中...",
      statusClass: "loading",
      error: ""
    });

    return new Promise((resolve) => {
      wx.request({
        url: `${app.globalData.apiBase}/api/latest?t=${Date.now()}`,
        method: "GET",
        timeout: 12000,
        success: (response) => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            this.showError(`HTTP ${response.statusCode}`);
            resolve();
            return;
          }
          this.renderPayload(response.data || {});
          resolve();
        },
        fail: (error) => {
          this.showError(error.errMsg || "网络请求失败");
          resolve();
        },
        complete: () => {
          this.scheduleRefresh();
        }
      });
    });
  },

  showError(message) {
    this.setData({
      statusText: "读取失败",
      statusClass: "error-state",
      error: message || "无法读取数据"
    });
  },

  renderPayload(payload) {
    const summary = payload.summary || {};
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    const pageTime = formatTime(new Date().toISOString());

    this.setData({
      statusText: `数据 ${formatTime(payload.updatedAt)}\n页面 ${pageTime}`,
      statusClass: "",
      error: "",
      summary: {
        intervalSpend: decorateMetric(summary.intervalSpend, formatMoney),
        intervalOrder: decorateMetric(summary.intervalOrder, formatMoney),
        intervalRoi: decorateMetric(summary.intervalRoi, formatRoi),
        totalRoi: decorateMetric(summary.totalRoi, formatRoi)
      },
      accounts: accounts.map(account => ({
        account: account.account || "未命名账号",
        campaign: account.campaign || "",
        intervalSpend: decorateMetric(account.intervalSpend, formatMoney),
        intervalOrder: decorateMetric(account.intervalOrder, formatMoney),
        intervalRoi: decorateMetric(account.intervalRoi, formatRoi),
        totalRoi: decorateMetric(account.totalRoi, formatRoi),
        totalSpend: decorateMetric(account.totalSpend, formatMoney),
        totalOrder: decorateMetric(account.totalOrder, formatMoney)
      }))
    });
  }
});
