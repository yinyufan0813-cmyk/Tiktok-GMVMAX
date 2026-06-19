const DEFAULT_PLAN_SPREADSHEET_ID = "";
const DEFAULT_PLAN_SHEET_NAME = "GMV Max 采集数据档案 - plan_records";
const DEFAULT_SUMMARY_SPREADSHEET_ID = "";
const DEFAULT_SUMMARY_SHEET_NAME = "GMV Max 采集数据档案 - summary_records";
const DEFAULT_ARCHIVE_FOLDER_NAME = "GMVMAX Drive Upload Archive";
const DEFAULT_WEBHOOK_SECRET = "ec920266c4d443c162ff2dfad1ee322dbdbf5323279c3118";
const PLAN_HEADERS = [
  "timestamp",
  "account",
  "campaign",
  "interval_spend_increase",
  "interval_order_amount_increase",
  "total_spend",
  "total_order_amount",
  "net_spend",
  "url",
  "total_budget"
];
const SUMMARY_HEADERS = [
  "timestamp",
  "new_spend",
  "new_order_amount",
  "total_spend",
  "total_order_amount",
  "url",
  "total_budget"
];

function doPost(event) {
  return withJsonResponse_(function () {
    const payload = parsePayload_(event);
    verifySecret_(payload.secret || payload.token || header_(event, "x-gmvmax-token"));

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const result = {
        ok: true,
        timestamp: new Date().toISOString(),
        summaryRows: appendRows_(
          summarySheet_(),
          payload.summaryRows || []
        ),
        planRows: appendRows_(
          planSheet_(),
          payload.planRows || []
        )
      };

      if (payload.format === "jsonl" && payload.stream && payload.content) {
        result.jsonlBatch = writeJsonlBatch_(payload);
      }

      return result;
    } finally {
      lock.releaseLock();
    }
  });
}

function doGet(event) {
  return withJsonResponse_(function () {
    const params = (event && event.parameter) || {};
    verifySecret_(params.secret || params.token);

    if (params.action === "planRows") {
      const sheet = planSheet_();
      return { ok: true, values: sheet.getDataRange().getDisplayValues() };
    }

    return {
      ok: true,
      name: "GMVMAX Apps Script receiver",
      actions: ["planRows"],
      planSpreadsheetId: planSheet_().getParent().getId(),
      summarySpreadsheetId: summarySheet_().getParent().getId(),
      jsonlArchive: archiveFolder_().getName()
    };
  });
}

function appendRows_(sheet, rows) {
  if (!rows || !rows.length) return 0;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  return rows.length;
}

function planSheet_() {
  return configuredSheet_(
    "GMVMAX_PLAN_SPREADSHEET_ID",
    DEFAULT_PLAN_SPREADSHEET_ID,
    "GMVMAX_PLAN_SHEET_NAME",
    DEFAULT_PLAN_SHEET_NAME,
    "GMV Max 采集数据档案 - plan_records",
    PLAN_HEADERS
  );
}

function summarySheet_() {
  return configuredSheet_(
    "GMVMAX_SUMMARY_SPREADSHEET_ID",
    DEFAULT_SUMMARY_SPREADSHEET_ID,
    "GMVMAX_SUMMARY_SHEET_NAME",
    DEFAULT_SUMMARY_SHEET_NAME,
    "GMV Max 采集数据档案 - summary_records",
    SUMMARY_HEADERS
  );
}

function configuredSheet_(idProperty, fallbackId, nameProperty, fallbackSheetName, spreadsheetName, headers) {
  const properties = PropertiesService.getScriptProperties();
  const sheetName = property_(nameProperty, fallbackSheetName);
  let spreadsheet = null;
  const spreadsheetId = property_(idProperty, fallbackId);
  if (spreadsheetId) {
    try {
      spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    } catch (error) {
      properties.deleteProperty(idProperty);
    }
  }

  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create(spreadsheetName);
    properties.setProperty(idProperty, spreadsheet.getId());
  }

  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  ensureHeader_(sheet, headers);
  return sheet;
}

function ensureHeader_(sheet, headers) {
  if (!headers || !headers.length || sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function writeJsonlBatch_(payload) {
  const folder = dayFolder_(archiveFolder_(), new Date());
  const stream = safeName_(payload.stream || "stream");
  const source = safeName_(payload.source || "gmvmax");
  const stamp = Utilities.formatDate(new Date(), "Etc/UTC", "yyyyMMdd-HHmmss-SSS");
  const filename = stream + "-" + stamp + "-" + source + ".jsonl";
  const header = {
    receiverReceivedAt: new Date().toISOString(),
    sentAt: payload.sentAt || "",
    source: payload.source || "",
    stream: payload.stream || "",
    lineCount: Number(payload.lineCount || 0)
  };
  const file = folder.createFile(filename, JSON.stringify(header) + "\n" + payload.content, MimeType.PLAIN_TEXT);
  file.setDescription("GMVMAX remote JSONL batch. Client-side upload is expected to be redacted before transmission.");
  return {
    id: file.getId(),
    name: file.getName(),
    url: file.getUrl(),
    lineCount: Number(payload.lineCount || 0)
  };
}

function archiveFolder_() {
  const folderId = property_("GMVMAX_ARCHIVE_FOLDER_ID", "");
  if (folderId) return DriveApp.getFolderById(folderId);

  const folderName = property_("GMVMAX_ARCHIVE_FOLDER_NAME", DEFAULT_ARCHIVE_FOLDER_NAME);
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(folderName);
}

function dayFolder_(parent, date) {
  const day = Utilities.formatDate(date, "Etc/UTC", "yyyy-MM-dd");
  const folders = parent.getFoldersByName(day);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(day);
}

function verifySecret_(inputSecret) {
  const expected = property_("GMVMAX_WEBHOOK_SECRET", DEFAULT_WEBHOOK_SECRET);
  if (expected && inputSecret !== expected) {
    throw new Error("Invalid GMVMAX webhook secret");
  }
}

function parsePayload_(event) {
  return JSON.parse((event && event.postData && event.postData.contents) || "{}");
}

function header_(event, name) {
  const headers = (event && (event.headers || event.parameter)) || {};
  const target = String(name || "").toLowerCase();
  for (const key in headers) {
    if (String(key).toLowerCase() === target) return headers[key];
  }
  return "";
}

function property_(name, fallback) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  return value || fallback;
}

function safeName_(value) {
  return String(value || "stream").replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80) || "stream";
}

function withJsonResponse_(callback) {
  try {
    return ContentService
      .createTextOutput(JSON.stringify(callback()))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
