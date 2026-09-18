# HTTP / WebSocket 运行时，不使用浏览器自动化

本 SDK 通过逆向签名、加密与设备画像，用 Node 发起 HTTP 请求以模拟浏览器行为。运行时**不**依赖 Puppeteer、Playwright 或任何嵌入式浏览器。

浏览器开发工具仅用于开发期抓包与对照；生产路径使用 HTTP / WebSocket 与持久化 Session/DeviceProfile。
Desktop Frontier WebSocket 长连接也是该协议运行时的一部分。

浏览器自动化会增加运行环境与多账号资源管理成本，因此选择直接实现协议请求与长连接。

## 用户确认的运行时边界

用户已明确拒绝加入 Electron，包括可选的 Electron 登录宿主。不得再将安装 Electron
作为登录、动态证书、Session 绑定或 follow 的前置条件，也不以其他嵌入式浏览器绕过本 ADR。

已有普通浏览器验证页仍用于用户手动完成平台安全验证；这不等于给 SDK 增加浏览器自动化依赖。
开发期 Chrome/iframe 对照脚本不接入默认生产运行时。继续按源码迁移 Node 可执行的请求、
证书、签名、Cookie 和响应状态处理，分别验证它们的账号归属。无法证明等价的环节必须明确
标为未实现或未验收，不能将合成浏览器测试当作纯 Node 登录已经打通。
