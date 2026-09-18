# ADR 0005: jumpbyte-bot 协议能力迁移

## 状态

Implemented（2026-09-08 以抖音聊天桌面端协议描述符补齐会话动作与通知入口）

## 背景

`jumpbyte-bot` 提供了首个可验证的收发基线；随后以抖音聊天 1.2.1 的 preload、
主进程 wrapper、renderer 调用点和 native 描述符继续收敛为 Desktop 协议。

## 决策

迁移协议行为和算法，但保持 TypeScript SDK 的 oicq 风格外部 interface：

| 深模块 | Interface | 隐藏的 implementation |
|---|---|---|
| `FrontierImWs` | `connect` / `close` / message event | Desktop 设备参数、Cookie 握手、心跳、QoS ACK 与 protobuf 解包 |
| `wire` | `decodeWireTree(bytes)` | varint、wire type、递归深度、JSON/标识符文本判定 |
| `content` | build / parse 富消息 | aweType、resource/poster/refmsg JSON 形状 |
| `ImMediaUploader` | `uploadImage` / `uploadVideo` | STS、SigV4、TOS、CRC32、5 MiB 分片、commit |
| `media` | `decryptImage` / `decryptCencSample` | AES-GCM 容器、CENC 连续 CTR 子样本流 |
| `ChatContact` / `Friend` / `Group` / `Stranger` | 共同聊天动作及各类联系人专属操作 | 会话地址、成员和请求实例、缓存同步 |
| `OutboundSender` | 消息发送、转发、撤回 | 上传、内容构造与 Desktop HTTP 发送 |
| `ImConversationActions` | 已读、删除、会话设置、群成员操作 | Desktop Cookie 外壳、动作状态与 check code 合并 |
| `notifications` | `request.*` / `notice.*` | cmd 501/502、入群申请、成员系统消息、未知命令保底 |

接收固定直连 Desktop native 使用的 `frontier100-normal.zijieapi.com/ws/v2`，发送固定使用
Desktop Cookie HTTP protobuf，不做传输降级或模式切换。列表和历史的标准入口是 cmd203/cmd301 Desktop 实现。

QR Login 采用 Desktop Passport 画像：先生成稳定 `deviceId`，
以 `imdesktop.douyin.com`、AID `339757` 和 Electron UA 完成 `ttwid/check`、拉码及轮询，
再把同一份 `deviceId`、`awemeim_guid`、屏幕尺寸和 UA 随 Promote 持久化。恢复 Session 时继续
使用原设备画像，不再为好友列表、上传或作品卡片请求临时生成 GUID。旧 Session 会在首次读取时
补齐缺少的设备字段，并把 UA 升级到当前 Desktop 协议版本；是否重新登录只由 Session 健康检查
和远端自资料探针决定。

`Friend.sendMsg` 接受 `SendableMessage`，`segment.image/video/emoji/reply` 提供类似 oicq
segment 的小接口。`MessageEvent` 暴露已解析的 `content`，并增加 `quote()` 与 `recall()`。
引用 hint 沿用 jumpbyte `b252442` 的 `refmsg_*` 字段；发送外壳按当前 Douyin PC 客户端：
field 4 保持正常 `aweType=700` 文本，field 11 编码 `referenced_message_id` 与 hint。
field 11 的第 3/4 字段是可选的根消息 ID/会话索引，不是消息类型/状态；把类型写入第 3 字段
会被服务端当成错误的根消息 ID，并可能以 `check=2` 拒绝。

群聊接收先按 jumpbyte-bot `b252442` 建立基线，再以 Desktop native 描述符校正：纯数字 `conversationId` 识别为群；SDK 暴露
`Group`、`Member`、`message.group` 与 `account.pickGroup()`。Desktop 的
`getUserAllConversationList()` 实际读取 native SQLite 中已同步的全部会话；本项目没有该数据库，
因此 `getGroupList()` 用 Cookie cmd203 `/v2/message/get_by_user_init` 翻完同步游标，再按会话类型
筛群，并保留每个会话自己的 inboxType。cmd2006 仍作为底层会话列表协议保留，但不冒充 Desktop
本地全量快照。发送结果只按 Desktop 响应中的 envelope/status/check code 判断，不做本地限速或隐式重试。
好友列表取自 Desktop 联系人页实际使用的 `/aweme/v1/web/familiar/list/`，不再与聊天会话混合。
native `getFriendsWithLimits` 只读取 Desktop 自身 SQLite 联系人缓存，不能替代为 cmd2050。尚无会话的好友仍进入
`fl`，第一次聊天动作才通过
`ONE_TO_ONE_CHAT` 创建并补全地址；列表读取本身不产生外部写操作。cmd 203 成员中的
`secUid` 会作为资料补全兜底，在账号会话内缓存。资料补全失败时仍返回 UID；陌生人使用
独立的原生命令与缓存。

WS 回执同时解析直接 cmd100 响应（`.8.6.100`）和 jumpbyte 已实现的消息回流
（`.8.6.500.5`）。直接拒绝中的 `check_message.status_code` 会提升为 `checkCode`，避免把
服务端明确返回的 8611 等风控结果误报为 ACK 超时。

2026-09-08 起，协议字段以本机抖音聊天桌面端内嵌描述符为准；2026-09-11 又以
preload、主进程 wrapper 和 renderer 实际调用点重新收口稳定能力。描述符存在不再单独构成
公共 API 依据。稳定会话动作包括已读、删除、撤回、表态、刷新、免打扰、置顶、进入会话和
删除会话；群能力包括创建、完整成员读取、邀请、移除、退群和入群申请审核。

`account.refreshContacts()` 和 `account.markMessagesRead()` 仍保留批量便利接口，但底层分别逐个
复用 Desktop 的 cmd608 与 cmd2002，而不再调用 Desktop bridge 未开放的 cmd610/cmd613。
`Member.refresh()` 同样强制刷新 cmd605 的整群完整快照。会话设置先读 cmd920，再写 cmd921，
只允许调用方改变 Desktop 开放的 mute/stick 位，并保留只读 favorite 位。

jumpbyte-bot `b252442` 的提交说明和实现只保证群消息接收，未实现成员列表、加人或设管；这些群管
操作不能假称来自 jumpbyte。主动邀请按抖音聊天桌面端实际调用补齐 `biz_ext.invitation`：普通邀请
使用 `source_type=6`、`source_app_id=339757`、当前账号 `im_user_id` 以及空 `ticket`。动作响应优先
解析 `check_message.status_code/status_msg`，避免把外层 `OK` 当成失败原因，也避免把表示 JSON 类型的
原始 `check_code=2` 误判为业务失败。
邀请使用 cmd 650 `/v1/conversation/add_participants`；审核列表使用 cmd 2027
`/v1/conversation/get_audit_list`，同意或拒绝再以 `apply_id` 调用 cmd 2025
`/v1/conversation/ack_apply`（2=同意，3=拒绝）。邀请成功不等于对方已经进群，因此不乐观更新成员缓存。
创建群聊按抖音聊天 1.2.1 native `rawCreateConversation` 的实际网络调用实现为 cmd 609
`/v2/conversation/create`，请求体为 `CreateConversationV2RequestBody`。请求包含
`conversation_type=2`、完整参与者 uid，以及桌面端同款 `biz_ext.create` 和
`group_create_type=0`；SDK 自动补当前账号 uid。成功响应中的 `ConversationInfoV2` 立即投影并写入 `account.gl`。
创建参数可以同时带 `name`、`avatar_url` 与 `description`；这是 Desktop 唯一公开的群资料写入
时机。创建后的 cmd902 群资料编辑未进入 Desktop bridge，因此不进入稳定 SDK。

messageType 90001（`CONVERSATION_APPLY_NOTIFY`）只作为审核列表变化信号；收到后按 Desktop
行为拉取全局 audit list，再按 `apply_id` 去重并生成 `request.group.join`。申请 payload 是绑定当前
账号和群的 `GroupJoinRequest`，可直接 `approve()` / `reject()`。审核通过并不复用 request 事件表示
成员已加入；群系统消息 `aweType=100100/100101/100102/100107/100109/100111-100114` 才投影为
`notice.group.member-increase`，`active_users` 对应 operator，`passive_users` 对应 member。
群系统消息 `aweType=100104/100105` 分别投影为 `notice.group.member-decrease` 的 `kick/leave`；
kick 使用 `active_users` 作为 operator、`passive_users` 作为 member，leave 使用 `active_users`
作为离群 member，并在 SDK 语义层令 operator 指向 member 自身。事件投递前先删除该成员缓存；
本人离群的系统提示不再删除群会话、其他成员或聊天历史。它不是native的DeleteConv或主动652流程。
50001/7成员集合命令与提示消息的对应关系及重复通知仍待迁移，不能据系统文案推断原生全部状态链。
同一套桌面端枚举还确认 `aweType=100110/100106/100115` 分别代表设为管理员、修改群名和修改
群头像；SDK 投影为 `notice.group.admin`、`notice.group.name-change`、`notice.group.avatar-change`，
并在 handler 前更新稳定对象缓存。当前源码没有对应的取消管理员系统消息枚举，因此不推断该事件。

Desktop Frontier 收包不再只识别带 JSON 正文的消息：cmd 501 的 `conversation.read` 只保留在
协议层，SDK 按 `conversation_type` 投影为带稳定对象的 `notice.friend.marked-read` 或
`notice.group.marked-read`；它表示当前账号读取游标的多端同步，不表示对端回执。cmd 502 会话更新通知、
撤回命令和其他 IM command 会进入带当前 `account` 的 `notice` / `notice.*` 事件。无法稳定解释的
命令保留为 `notice.im.command`，原始帧仍可通过 `message.raw` 观察，不把猜测伪装成业务事件。
2026-09-13 的native控制消息复核纠正了枚举名推断：
`MESSAGE_TYPE_CONVERSATION_DESTROY=50005`只设置`isParticipant=false`并通知会话更新，
不删除会话/消息/成员；真实被动删除是50001正文command_type=3/620/1010，使用
last_message_index边界，独立派发min-index或delete。`50010`是`MESSAGE_TYPE_MODE_CHANGE`，
继续按未知命令保留。
桌面 native `MarkReadManager::mark` 使用不对称的已读路由：外层 command 是 `2002`，但
`RequestBody` 的 oneof 字段仍是 `604`，并固定使用 `inbox_type=1`，随消息位置传入
`read_badge_count`。旧实现把外层 command 也设为 `604`，只会命中返回空 JSON 壳的网关路由，
不会产生真实已读回执。事件便捷方法默认清除当前这一条产生的角标，主动调用可显式覆盖该数值。
`ResponseBody` 在同一描述符中没有定义，但 HTTP 2xx 本身不能证明对端已经收到阅读回执：只接受能够
解码且状态成功的响应；不透明 payload 会作为协议错误返回，不能再合成 `status=0`。

消息表态保留为 `MessageEvent.react()` / `ChatContact.reactMsg()`。2026-09-11 的
native 复核修正旧判断：当前
`enterConversation()` 仅发 cmd410，不能据 JS 桥接同名认作 Desktop 的完整进入生命周期，仍待替换。
cmd614 解散、cmd411 输入状态、cmd653/656 设管、cmd655 群名片、
cmd902 群资料写入和 cmd2000/2038 主动成员已读详情均已从稳定 SDK 与协议门面删除。
cmd508 好友申请信号只投影为 `notice.friend.add-request`。cmd20481/2049 好友申请列表/审核和
cmd2051 删除好友没有 Desktop 实际调用证据，已从稳定 SDK 删除。陌生人箱使用独立 `Stranger`、`sl` 与
`message.stranger`，不会进入 `fl`。陌生人列表、消息、已读、未读和删除使用原生 1001–1008
命令，实时新消息使用 cmd 1099 与 ResponseBody field 503 `StrangerNewMessageNotify`。桌面端
`combinedSearch/searchMsgInConv` 实际建立在本地 SQLite
FTS 上，SDK 因此只提供对已同步对象的 `searchConversations()`，不构造描述符中未被桌面 UI 使用的
远端搜索请求。以上协议形状和编码已有测试，真实账号/UI 效果仍需通过 demo 逐项验收。

## 兼容性

- 字符串 `sendMsg('text')` 完全兼容。
- `reply('text')` 完全兼容；精确引用使用 `quote('text')`。
- 最低 Node.js 版本为 22.5；WebSocket 仍使用显式 `ws` 依赖，本地状态默认使用内置 `node:sqlite`。
- 已知 protobuf 使用从 Desktop 描述符生成的完整 schema；请求中的未知字段会在编码前直接报错，
  不再被 protobufjs 静默丢弃。真正未知的新版 payload 仍保留 WS 帧与十六进制诊断信息供后续更新 schema。
- 音视频通话依赖实时媒体栈，不进入当前公共 SDK；其余已暴露动作若尚未真实账号验收，
  会在公开文档中明确标记，不以协议单测冒充线上可用。

## 验证面

测试只跨深模块 interface，覆盖：大整数 varint、截断 protobuf、Desktop 消息与通知提取、
动作请求字段、设置字段 presence、动作拒绝判定、富消息构造解析、AES-GCM、跨子样本连续 AES-CTR、
CRC32、SigV4 确定性。

## 来源与许可证

登录与已验证发信流程参考
[jumpbyte-bot](https://github.com/sisi0318/jumpbyte-bot)（GPL-3.0）；协议命令、字段和桌面功能面
来自本机已安装抖音聊天应用的公开运行时资源与内嵌 protobuf 描述符；外部对象与事件形态参考
[oicq](https://github.com/takayama-lily/oicq)（MPL-2.0）。本实现重新组织为本项目的深模块，并使用
Node 标准密码学/WebSocket 原语；未复制上游源文件。
