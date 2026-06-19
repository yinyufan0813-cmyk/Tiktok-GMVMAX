# TikTok Shop GMV Max Monitor

这个脚本用于自动监测 TikTok Shop Ads 后台的 `LIVE GMV Max` 页面，每 10 分钟刷新一次，并记录：

- 计划新增消耗
- 计划新增成交金额
- 总消耗
- 总成交金额

本地模式下记录会写入：

- `logs/gmvmax-records.jsonl`
- `logs/gmvmax-records.csv`
- `logs/gmvmax-plan-records.csv`

`gmvmax-plan-records.csv` 会按 `Available TikTok accounts` 下方的不同账号分别记录 LIVE 计划，包括每次采集相对上一条记录增加的消耗金额、增加的成交金额、当前总消耗和当前总成交金额。

## 安装

```bash
npm install
npm run install:browsers
```

## 配置

复制示例配置：

```bash
cp examples/config.example.json config.json
```

把 `config.json` 里的 `url` 替换成你的 GMV Max 页面 URL。这个 URL 可能包含广告账号、卖家和业务中心标识，所以不要提交到公开仓库。

脚本默认使用 `attach` 模式，接入一个已经打开的 Chrome 标签页，并自动查找 `LIVE GMV Max` 页面。Chrome 需要先以远程调试端口启动：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.gmvmax-chrome
```

然后在这个 Chrome 窗口里打开 TikTok GMV Max 页面并完成登录。

可以先列出脚本能看到的标签页：

```bash
npm run list-tabs
```

确认能看到目标页后再运行监测。

## 运行一次

```bash
npm run once
```

## 持续监测

```bash
npm start
```

脚本默认每 10 分钟刷新一次页面。要调整间隔，编辑 `config.json` 中的 `intervalMinutes`。

如果确实想让脚本自己启动一个独立 Chrome，把 `config.json` 里的 `mode` 改成 `launch`。

## Google Drive / Apps Script 远端存储

要让采集数据直接进入 Google Drive，而不是继续写入本地 `logs/`：

1. 打开 [Google Apps Script](https://script.google.com/)，新建项目。
2. 把 `apps-script/gmvmax-receiver.gs` 的内容粘贴进去。
3. 在 Script properties 设置 `GMVMAX_WEBHOOK_SECRET`，并按 `APPS_SCRIPT_SETUP.md` 设置归档文件夹和 Sheet ID。
4. 点击 `Deploy` -> `New deployment`，类型选择 `Web app`。
5. `Execute as` 选择自己，`Who has access` 选择 `Anyone`。
6. 部署并授权后，把 Web App URL 和密钥放入 `.env.gmvmax` 或同名环境变量。

远端模式环境变量示例：

```sh
export GMVMAX_STORAGE_MODE="appsScript"
export GMVMAX_APPS_SCRIPT_URL="https://script.google.com/macros/s/AKfycbzwda-czjme7PVG1CBkUH9OiIkI7Bi_Djks2eSY2_X1ZnAEjcjfvutvgNz50PJap6hG/exec"
export GMVMAX_APPS_SCRIPT_TOKEN="<与 GMVMAX_WEBHOOK_SECRET 相同的值>"
export GMVMAX_APPS_SCRIPT_SECRET="<与 GMVMAX_WEBHOOK_SECRET 相同的值>"
export GMVMAX_LOCAL_PERSISTENCE="0"
export GMVMAX_REMOTE_STRICT="1"
```

`GMVMAX_LOCAL_PERSISTENCE=0` 会关闭业务记录、页面快照、网络证据和素材证据的本地落盘。进程锁等运行控制文件可能仍会短暂出现在本地；它们不是采集数据。未配置 Web App URL 时，脚本会自动回退本地缓存，避免丢失监测数据。

Apps Script 会在 Google Drive 中创建/复用 `GMVMAX Drive Upload Archive` 文件夹，并按日期保存 JSONL 批次文件；summary 和 plan 行继续追加到配置的 Google Sheets。完整部署步骤见 `APPS_SCRIPT_SETUP.md`。

## 素材排序/出价模型监测

同一个 Chrome 扩展和 CDP 备份抓包也可以监测素材、创意、视频或详情页的外显排序逻辑。先在专用 Chrome 里打开素材/创意/视频相关页面，或把 `config.json` 的 `materialMonitor.url` 填成目标页面。

素材监测默认使用独立 Chrome 调试端口 `9224` 和独立 profile `chrome-profile-material`，避免和 GMV Max 主监测的 `9222` 页面互相刷新。

```bash
npm run material:list-tabs
npm run material:once
npm run material
npm run material:analyze
```

素材监测会写入：

- `logs/material-records.jsonl`
- `logs/material-records.csv`
- `logs/material-page-snapshots.jsonl`
- `logs/material-network-exchanges.jsonl`
- `logs/material-ranking-bid-report.md`

报告只验证外显排序、流量分配和出价代理信号；如果没有素材接口、delivery/bid/rank 预估接口或连续窗口增量，报告会把结论保持为 `needs_more_evidence`。

## 屏幕悬浮窗

推荐运行 HTML 悬浮面板：

```bash
open start_dashboard.command
```

面板会用三行显示三个账号，包含新增消耗、新增成交、新增 ROI、总消耗、总成交和总 ROI，并在每个数字旁边标出相对上一轮 10 分钟数据的 `▲` / `▼` / `→`。页面内容背景已做透明化处理。

如果需要强制重开面板：

```bash
open reset_dashboard_window.command
```

备用 Tk 悬浮窗：

```bash
python3 scripts/gmvmax_float.py
```

悬浮窗会显示最新一轮 `gmvmax-plan-records.csv` 数据，并每 30 秒刷新一次。

## iPhone 手机 App

推荐使用 PWA 手机版，不需要 App Store 审核，也不需要越狱。先在 Mac 上启动手机端服务：

```bash
open start_mobile_app.command
```

终端会显示类似 `iPhone URL: http://192.168.x.x:8788/` 的地址。把 iPhone 和这台 Mac 连到同一个 Wi-Fi 后，用 iPhone Safari 打开这个地址，然后点分享按钮，选择“添加到主屏幕”。之后桌面上会出现 `GMV Max` 图标，打开方式和普通 App 类似。

手机端会每 30 秒读取一次 Mac 上最新的监测结果，显示三个账号的新增消耗、新增成交、新增 ROI、总消耗、总成交和总 ROI。

如果要生成可安装的原生 iOS IPA，需要 Apple Developer 账号、签名证书和设备 UDID 或 TestFlight/App Store 发布流程；代码本身无法绕过 iOS 的签名安装限制。

## 如果页面字段没有识别出来

TikTok Ads 后台页面会变动。脚本会先通过文字标签自动查找这些字段：

- `新增消耗`
- `新增成交金额`
- `总消耗`
- `总成交金额`

如果某个字段没找到，脚本会在 `logs/` 里保存调试截图和页面文本。你可以在 `config.json` 的 `selectors` 中填写实际 CSS 选择器：

```json
{
  "selectors": {
    "planRows": "tbody tr",
    "planName": "td:nth-child(1)",
    "newSpend": "td:nth-child(4)",
    "newOrderAmount": "td:nth-child(5)",
    "totalSpend": "td:nth-child(6)",
    "totalOrderAmount": "td:nth-child(7)"
  }
}
```

`planRows` 为空时，脚本只记录页面汇总字段；填写后会额外记录每个计划行的数据到 JSONL。

## macOS 后台常驻

可以用 `launchd` 让脚本开机后自动运行。先把 `examples/com.gmvmax.monitor.plist` 里的路径替换成你的项目绝对路径，然后执行：

```bash
launchctl load ~/Library/LaunchAgents/com.gmvmax.monitor.plist
```
