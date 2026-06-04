# GMV Max 微信小程序面板

这个目录是悬浮窗/手机面板的微信小程序版本，默认读取：

```text
https://youmigmvmax2.tail8ecb21.ts.net/api/latest
```

## 开发调试

1. 打开微信开发者工具。
2. 导入项目目录：`wechat-miniprogram`。
3. `AppID` 可以先使用测试号或小程序真实 AppID。
4. 如果使用局域网或未配置合法域名，开发工具里勾选“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”。

## 正式版限制

微信小程序正式版的 `wx.request` 需要 HTTPS 合法域名，并且该域名需要在小程序后台配置到“request 合法域名”。如果 `tail8ecb21.ts.net` 在目标网络无法访问，需要换成可访问并可配置的小程序域名，再修改 `app.js` 里的 `apiBase`。

## 刷新逻辑

- 页面打开时立即读取一次。
- 页面回到前台时立即读取一次。
- 页面停留时每 30 秒读取一次。
- 下拉页面也会触发手动刷新。
