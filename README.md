# TikTok Shop GMV Max Monitor

这个脚本用于自动监测 TikTok Shop Ads 后台的 `LIVE GMV Max` 页面，每 10 分钟刷新一次，并记录：

- 计划新增消耗
- 计划新增成交金额
- 总消耗
- 总成交金额

记录会写入：

- `logs/gmvmax-records.jsonl`
- `logs/gmvmax-records.csv`

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

默认已经填入当前 GMV Max 页面 URL。首次运行会打开一个 Chrome 窗口，如果 TikTok 要求登录，请在打开的窗口里完成登录。登录状态会保存在本项目的 `chrome-profile/` 目录里，后续运行会继续复用。

## 运行一次

```bash
npm run once
```

## 持续监测

```bash
npm start
```

脚本默认每 10 分钟刷新一次页面。要调整间隔，编辑 `config.json` 中的 `intervalMinutes`。

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
