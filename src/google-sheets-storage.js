import crypto from "node:crypto";
import fs from "node:fs/promises";
import { shouldWriteLocalFiles } from "./apps-script-storage.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const tokenCache = new Map();

export function googleSheetsStorageConfig(config = {}) {
  const storage = config.storage || {};
  const sheets = storage.googleSheets || {};
  const mode = process.env.GMVMAX_STORAGE_MODE || storage.mode || "local";
  const appsScript = storage.appsScript || {};
  const strictEnv = process.env.GMVMAX_REMOTE_STRICT || process.env.GMVMAX_GOOGLE_STRICT || "";
  return {
    enabled: mode === "googleSheets" || mode === "appsScript",
    mode,
    localPersistence: process.env.GMVMAX_LOCAL_PERSISTENCE
      ? process.env.GMVMAX_LOCAL_PERSISTENCE !== "0"
      : storage.localPersistence !== false,
    strict: strictEnv
      ? strictEnv === "1"
      : Boolean(storage.strict),
    appsScriptUrl: process.env.GMVMAX_APPS_SCRIPT_URL || appsScript.webAppUrl || appsScript.url || "",
    appsScriptSecret: process.env.GMVMAX_APPS_SCRIPT_SECRET || process.env.GMVMAX_APPS_SCRIPT_TOKEN || appsScript.secret || appsScript.token || "",
    planRecordsSpreadsheetId: process.env.GMVMAX_GOOGLE_PLAN_SHEET_ID || sheets.planRecordsSpreadsheetId || "",
    planRecordsSheetName: process.env.GMVMAX_GOOGLE_PLAN_TAB || sheets.planRecordsSheetName || "plan_records",
    summaryRecordsSpreadsheetId: process.env.GMVMAX_GOOGLE_SUMMARY_SHEET_ID || sheets.summaryRecordsSpreadsheetId || "",
    summaryRecordsSheetName: process.env.GMVMAX_GOOGLE_SUMMARY_TAB || sheets.summaryRecordsSheetName || "summary_records"
  };
}

export function shouldWriteLocalBusinessFiles(config = {}) {
  return shouldWriteLocalFiles(config);
}

export async function readPlanRowsFromGoogleSheets(config = {}) {
  const storage = googleSheetsStorageConfig(config);
  if (!storage.enabled) return null;
  if (storage.appsScriptUrl) return readPlanRowsFromAppsScript(storage);
  if (storage.mode === "appsScript") return null;
  if (!storage.planRecordsSpreadsheetId) return null;
  const values = await getValues(
    storage.planRecordsSpreadsheetId,
    storage.planRecordsSheetName,
    "A:J",
    config
  );
  return valuesToObjects(values);
}

export async function readLatestRecordWithPlansFromGoogleSheets(config = {}) {
  const rows = await readPlanRowsFromGoogleSheets(config);
  if (!rows || rows.length === 0) return null;
  const latestTimestamp = [...new Set(rows.map((row) => row.timestamp).filter(Boolean))].at(-1);
  if (!latestTimestamp) return null;
  return {
    timestamp: latestTimestamp,
    plans: rows
      .filter((row) => row.timestamp === latestTimestamp)
      .map((row, index) => ({
        index: index + 1,
        account: row.account,
        name: row.campaign,
        intervalSpendIncrease: row.interval_spend_increase,
        intervalOrderAmountIncrease: row.interval_order_amount_increase,
        totalSpend: row.total_spend,
        totalOrderAmount: row.total_order_amount,
        netSpend: row.net_spend,
        totalBudget: row.total_budget
      }))
  };
}

export async function appendResultToGoogleSheets(config = {}, result = {}) {
  const storage = googleSheetsStorageConfig(config);
  if (!storage.enabled) return false;

  if (storage.appsScriptUrl) return appendResultToAppsScript(storage, result);
  if (storage.mode === "appsScript") {
    return handleStorageError(storage, new Error("Apps Script storage is enabled, but GMVMAX_APPS_SCRIPT_URL is not configured."));
  }

  if (!storage.planRecordsSpreadsheetId || !storage.summaryRecordsSpreadsheetId) {
    return handleStorageError(storage, new Error("Google Sheets storage is enabled, but spreadsheet IDs are not configured."));
  }

  try {
    await appendValues(
      storage.summaryRecordsSpreadsheetId,
      storage.summaryRecordsSheetName,
      [[
        result.timestamp,
        result.liveGmvMax?.newSpend || "",
        result.liveGmvMax?.newOrderAmount || "",
        result.liveGmvMax?.totalSpend || "",
        result.liveGmvMax?.totalOrderAmount || "",
        result.url || "",
        result.liveGmvMax?.totalBudget || ""
      ]],
      config
    );

    const planRows = (result.plans || [])
      .filter((plan) => String(plan.account || "").trim())
      .map((plan) => [
        result.timestamp,
        plan.account || "",
        plan.name || "",
        plan.intervalSpendIncrease || "",
        plan.intervalOrderAmountIncrease || "",
        plan.totalSpend || "",
        plan.totalOrderAmount || "",
        plan.netSpend || "",
        result.url || "",
        plan.totalBudget || ""
      ]);

    if (planRows.length > 0) {
      await appendValues(storage.planRecordsSpreadsheetId, storage.planRecordsSheetName, planRows, config);
    }
    return true;
  } catch (error) {
    return handleStorageError(storage, error);
  }
}

async function appendResultToAppsScript(storage, result) {
  try {
    const planRows = (result.plans || [])
      .filter((plan) => String(plan.account || "").trim())
      .map((plan) => [
        result.timestamp,
        plan.account || "",
        plan.name || "",
        plan.intervalSpendIncrease || "",
        plan.intervalOrderAmountIncrease || "",
        plan.totalSpend || "",
        plan.totalOrderAmount || "",
        plan.netSpend || "",
        result.url || "",
        plan.totalBudget || ""
      ]);

    const response = await fetch(storage.appsScriptUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        secret: storage.appsScriptSecret,
        summaryRows: [[
          result.timestamp,
          result.liveGmvMax?.newSpend || "",
          result.liveGmvMax?.newOrderAmount || "",
          result.liveGmvMax?.totalSpend || "",
          result.liveGmvMax?.totalOrderAmount || "",
          result.url || "",
          result.liveGmvMax?.totalBudget || ""
        ]],
        planRows
      })
    });
    await assertOk(response, "append through Apps Script");
    return true;
  } catch (error) {
    return handleStorageError(storage, error);
  }
}

async function readPlanRowsFromAppsScript(storage) {
  const url = new URL(storage.appsScriptUrl);
  url.searchParams.set("action", "planRows");
  if (storage.appsScriptSecret) url.searchParams.set("secret", storage.appsScriptSecret);
  const response = await fetch(url);
  await assertOk(response, "read through Apps Script");
  const body = await response.json();
  if (Array.isArray(body.rows)) return body.rows;
  return valuesToObjects(body.values || []);
}

async function handleStorageError(storage, error) {
  if (storage.strict) throw error;
  console.warn(`[GMVMAX] Google Sheets sync skipped: ${error.message}`);
  return false;
}

function valuesToObjects(values = []) {
  const [headers = [], ...rows] = values;
  return rows
    .filter((row) => row.some((cell) => String(cell || "").trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])));
}

async function getValues(spreadsheetId, sheetName, range, config) {
  const token = await getAccessToken(config);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${sheetName}!${range}`)}?valueRenderOption=FORMATTED_VALUE`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  await assertOk(response, "read Google Sheets values");
  const body = await response.json();
  return body.values || [];
}

async function appendValues(spreadsheetId, sheetName, rows, config) {
  if (!rows.length) return;
  const token = await getAccessToken(config);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${sheetName}!A:Z`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ values: rows })
    }
  );
  await assertOk(response, "append Google Sheets values");
}

async function assertOk(response, action) {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new Error(`Could not ${action}: HTTP ${response.status} ${text.slice(0, 300)}`);
}

async function getAccessToken(config = {}) {
  if (process.env.GMVMAX_GOOGLE_ACCESS_TOKEN) return process.env.GMVMAX_GOOGLE_ACCESS_TOKEN;

  const serviceAccount = await readServiceAccount(config);
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    throw new Error(
      "Missing Google credentials. Set GMVMAX_GOOGLE_ACCESS_TOKEN or GMVMAX_GOOGLE_SERVICE_ACCOUNT_JSON / GMVMAX_GOOGLE_SERVICE_ACCOUNT_FILE."
    );
  }

  const cacheKey = serviceAccount.client_email;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const assertion = [
    base64urlJson({ alg: "RS256", typ: "JWT" }),
    base64urlJson({
      iss: serviceAccount.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now
    })
  ].join(".");
  const signature = crypto.createSign("RSA-SHA256").update(assertion).sign(serviceAccount.private_key, "base64url");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${assertion}.${signature}`
    })
  });
  await assertOk(response, "create Google access token");
  const body = await response.json();
  tokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000
  });
  return body.access_token;
}

async function readServiceAccount(config = {}) {
  const sheets = config.storage?.googleSheets || {};
  const raw = process.env.GMVMAX_GOOGLE_SERVICE_ACCOUNT_JSON || sheets.serviceAccountJson;
  if (raw) return JSON.parse(raw);

  const file = process.env.GMVMAX_GOOGLE_SERVICE_ACCOUNT_FILE || sheets.serviceAccountFile;
  if (!file) return null;
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
