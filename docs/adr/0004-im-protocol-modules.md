# ADR 0004: IM 协议层模块拆分

## 状态

已接受。

## 背景

`ImService` 单文件混有 token、HTTP protobuf 传输、收件箱映射、发送与内容构造，难测难改。

## 决策

协议层按实际共享复杂性拆分，`ImService` 组合账号所需的 IM 协议能力：

| 模块 | 职责 |
|------|------|
| `token` | user_token/v2 + ticket_guard keys |
| `transport` | encodeRequest + POST imapi |
| `inbox` | listThreads / strangers / getMessages |
| `send` | 桌面 Cookie send / recall |
| `content` | build*Content / isMessageDelivered / parseSendResponse |
| `mappers` | protobuf object → PrivateThread / PrivateMessage |

## 后果

- 发消息路径（HTTP/WS）共用 `ImSendApi.buildSendBody`
- SDK `OutboundSender` 继续依赖 `ImService` 类，无需感知内部拆分
- 当前还包括独立的 actions、notifications、upload 与 media 实现；产品用户通过联系人操作，协议调试从 `douyin-im/protocol` 导入

## Deletion test

- 删 `transport` → 每个 cmd 重复 auth 与 fetch
- 删 `content` → type=7 / aweType 与 投递判断（8610）不一致
