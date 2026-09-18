# 文档导航

按需要阅读，不必先了解协议层才能使用 SDK。

| 目的 | 入口 |
|---|---|
| 跑通登录和消息 handler | [README](../README.md)、[demo.ts](../demo.ts) |
| 查配置、联系人、群管、事件和错误 | [使用指南](guide.md) |
| 修改继承关系或确定代码放在哪里 | [ADR 0008：实例职责](adr/0008-base-and-sdk-instance-layers.md) |
| 统一业务用词 | [CONTEXT.md](../CONTEXT.md) |

## 设计决策

- [0001：不依赖浏览器自动化](adr/0001-pure-http-no-browser-automation.md)
- [0002：账号的规范身份](adr/0002-platform-uid-as-account-identity.md)
- [0003：SDK 模块职责](adr/0003-sdk-messaging-module.md)
- [0004：IM 协议模块](adr/0004-im-protocol-modules.md)
- [0005：Jumpbyte 与桌面 IM 协议依据](adr/0005-jumpbyte-protocol-capabilities.md)
- [0006：多账号生命周期](adr/0006-multi-account-client.md)
- [0007：卡片与只读内容边界](adr/0007-im-cards-read-only-content.md)
- [0008：公共能力与继承差异](adr/0008-base-and-sdk-instance-layers.md)
- [0009：账号级本地 IM 状态库](adr/0009-local-im-state.md)

## 如何判断一项能力是否可用

公开方法与返回类型以当前生成声明为准；源码入口是 [sdk/index.ts](../src/sdk/index.ts)、
[base/index.ts](../src/base/index.ts) 和 [protocol.ts](../src/protocol.ts)。
使用指南描述调用语义，ADR 解释设计取舍。

协议描述符里存在命令、导出事件类型、通过模拟测试、真实平台返回成功、接收端正确展示，
是不同层次的证据。协议描述符中的端点或待办不等于 SDK 已支持，旧日志也不是当前发布验收结果。
