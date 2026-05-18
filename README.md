# TikTok Shop GMV Max Monitor

这个脚本用于自动监测 TikTok Shop Ads 后台的 `LIVE GMV Max` 页面，每 10 分钟刷新一次，并记录：

- 计划新增消耗
- 计划新增成交金额
- 总消耗
- 总成交金额

记录会写入：

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
