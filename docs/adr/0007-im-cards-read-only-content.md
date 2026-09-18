# ADR 0007：IM 卡片与共享内容

## 状态

已实现并通过离线协议测试；真实账号验收仍需按消息类型逐项完成。

## 决策

所有聊天消息固定通过联系人 `sendMsg` 和 Desktop Cookie HTTP 发送，不建立第二套发送器。
`cards` 模块只负责类型到 JSON/协议编号的映射；文件和媒体上传复用 IM 的 STS/VOD/TOS 模块。
作品、图集、链接、用户卡片与文件分别使用消息类型 8/77/26/25/6，入站保留完整字段，协议 ID 使用字符串。

收到的作品、图集与评论分享会绑定为 `MessageEvent.work` / `MessageEvent.comment`。这些实例只提供
聊天语境内由 Desktop IM 暴露的详情、分享/下载权限、媒体地址和评论可见状态；批量查询位于来源
`ChatContact`，每 50 条拆批并自动携带会话 shortId。

IM 原样转发通过 `MessageEvent.forwardTo(contact)` 完成。它保留原 messageType/content，按 Desktop
行为补充 `prev_id` / `root_id`，并要求来源事件和目标联系人属于同一账号。

本包不提供账号级作品、粉丝、用户或主站服务。`segment.share()` 是聊天卡片，
`MessageEvent.forwardTo()` 是 IM 消息转发，两者都只属于 Desktop IM。

## 来源与验证

卡片补全、评论状态、转发来源链和下载字段以本机抖音聊天 1.2.1 renderer 的实际调用链为准。
测试覆盖卡片构造/接收、作品与评论每 50 条拆批、下载字段提取、原消息类型与来源链转发、
Desktop HTTP 发送、文件上传字段。
