# GMV Max Apps Script 接收端

采集脚本支持通过 Apps Script Web App 直接上传到 Google Drive。当前实现分两路：

- `summaryRows` / `planRows` 继续追加到 Google Sheets。
- 页面、素材、网络 JSONL 流写入 Google Drive 文件夹中的按日批文件。

客户端会在上传前脱敏网络流：只保留端点路径、状态、方法、字段路径、体积等分析信号，不上传 Cookie、CSRF、Authorization、完整 query、完整请求体或完整响应体。

## 1. 创建 Apps Script

打开 https://script.google.com/home/projects/create ，新建项目后，把 `apps-script/gmvmax-receiver.gs` 的内容粘贴到 `Code.gs`。

## 2. 设置脚本属性

在 Apps Script 页面进入 `Project Settings`，添加 Script properties：

```text
GMVMAX_WEBHOOK_SECRET=ec920266c4d443c162ff2dfad1ee322dbdbf5323279c3118
GMVMAX_ARCHIVE_FOLDER_NAME=GMVMAX Drive Upload Archive
GMVMAX_PLAN_SPREADSHEET_ID=1BuKLQoUlmWXXyVBy5wttDk-XD9noFB9E_o4lXSEmcYk
GMVMAX_PLAN_SHEET_NAME=GMV Max 采集数据档案 - plan_records
GMVMAX_SUMMARY_SPREADSHEET_ID=1f51y3-KvJ2GhZPrwJyceR7BEP8JPHbqac1auY1czhSY
GMVMAX_SUMMARY_SHEET_NAME=GMV Max 采集数据档案 - summary_records
```

如果你已经在 Drive 里建好了专用文件夹，也可以用 `GMVMAX_ARCHIVE_FOLDER_ID=<folder id>` 替代 `GMVMAX_ARCHIVE_FOLDER_NAME`。

## 3. 部署 Web App

点击 `Deploy` -> `New deployment`：

- Type: `Web app`
- Execute as: `Me`
- Who has access: `Anyone`

首次部署会要求授权 Google Sheets 和 Google Drive 权限。授权后复制生成的 `/exec` URL。

## 4. 配置本地采集器

把下面内容写入项目根目录的 `.env.gmvmax`，或按同名环境变量启动采集器：

```sh
export GMVMAX_STORAGE_MODE="appsScript"
export GMVMAX_APPS_SCRIPT_URL="https://script.google.com/macros/s/AKfycbzwda-czjme7PVG1CBkUH9OiIkI7Bi_Djks2eSY2_X1ZnAEjcjfvutvgNz50PJap6hG/exec"
export GMVMAX_APPS_SCRIPT_TOKEN="ec920266c4d443c162ff2dfad1ee322dbdbf5323279c3118"
export GMVMAX_APPS_SCRIPT_SECRET="ec920266c4d443c162ff2dfad1ee322dbdbf5323279c3118"
export GMVMAX_LOCAL_PERSISTENCE="0"
export GMVMAX_REMOTE_STRICT="1"
```

`GMVMAX_LOCAL_PERSISTENCE=0` 只应在 Web App URL 和密钥验证通过后启用。未配置 URL 时，代码会回退到本地采集缓存，避免监测数据丢失。

## 5. 验证

部署完成后，可用一次采集验证：

```sh
npm run once
```

Apps Script 返回成功后，Drive 中会出现 `GMVMAX Drive Upload Archive/YYYY-MM-DD/*.jsonl` 批文件；Google Sheets 中会继续追加 summary 和 plan 行。
