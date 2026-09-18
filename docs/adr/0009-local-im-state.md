# ADR 0009：账号级本地 IM 状态库

## 状态

已采纳。

## 背景

抖音聊天的 `imsdk.node` 并不是每次展示群、成员或消息都重新请求网络。原生 SDK 将会话、成员和消息同步到本地数据库，renderer 再通过 `getConversationMemberList`、`getMessageList` 等接口读取本地状态。当前项目不能把 Desktop 私有二进制及其 dylib、许可证和初始化参数直接打进 MIT npm 包，但需要保留相同的“网络同步和实时事件汇入一个账号状态库”语义。

Node.js 从 22.5.0 提供内置 `node:sqlite`。项目最低运行版本因此调整为 Node.js 22.5.0，不引入额外 SQLite 原生依赖。

## 决策

- 每个账号使用独立的 `data/accounts/<platformUid>/im-state.sqlite`。
- 默认后端是同步的 `node:sqlite`；只有调用方显式配置 `localState: { backend: 'json' }` 时才使用 `im-state.json`，不会按运行环境静默切换。
- `localState: false` 完全关闭本地 IM 状态库。
- 会话 ID、消息 ID、索引等 int64 全部以 SQLite `TEXT` 和 TypeScript `string` 保存。
- 群列表和群成员列表分别记录“完整快照已同步”标记。实时消息中见到一个群或成员只属于增量，不得冒充完整列表。
- 网络历史、实时入站消息和发送接口返回成功的出站简略记录写入同一消息表，并按消息 ID 去重。发送响应成功不是对端收件证明。每个会话默认保留最近 1000 条，可通过 `maxMessagesPerConversation` 调整。
- `getGroupList()` 与 `group.getMemberList()` 优先完整本地快照；传 `true` 强制联网刷新。`contact.getCachedHistory()` 永远只读取本地库；`getHistory()` 请求网络并把成功结果并入本地库。
- SQLite/JSON 文件结构是包内实现细节。上层仍然只操作 `Account`、`Friend`、`Group`、`Member` 和事件对象。

## 一致性边界

本地状态库是缓存和同步视图，不是平台事实的替代品。只有完整网络查询成功才替换完整快照；失败时保留旧数据。邀请、移除、退群等写操作仍以服务端响应和后续通知为准，未知结果不能靠本地写入伪装成成功。

账号用户关系快照分别保存 `followStatus`（自己的关注方向）和 `followerStatus`（对方的关注方向）。
后一字段只由身份匹配的单用户资料中的明确0/1更新，复用资料读取的登录代次/较新关系保护，供Friend/Stranger/Member共享。
SQLite/JSON无需改表即可保存新增可选字段，旧记录无字段保持未知。follow响应不改反方向，401计数不构造关系变化；
列表/搜索/通知中的独立资料快照尚未宣称全部合并进此账号状态，见源码边界。

主动单会话删除单独使用 Desktop cmd603 的 indexV1 边界及本地三分支软删除，不调用物理清理缓存的
`deleteConversation` 辅助方法。边界在请求前从保留消息取得，回包成功后以当前 minIndex/lastMessageIndex
判定；SQLite事务失败回滚，JSON候选状态写失败不发布。`localState:false` 缺消息边界时拒绝此动作。
被动50001的command_type=3/620/1010使用正文last_message_index共享软删算法，
按删除前lastMessageIndex分别派发min-index或delete。50005只写isParticipant=false，
保留会话、历史和成员；事件投影不再无条件清库。主动与被动的通知条件不同；详情见
主动删除和被动控制消息。

SQLite 使用 WAL、busy timeout 和事务更新。ID 不参与 SQLite 整数运算，避免超过 JavaScript 安全整数范围。JSON 后端采用临时文件加原子 rename，主要用于调试和需要人工查看缓存的场景，不适合多个进程同时写同一账号。

两种后端对消息保留上限和读取条数使用同一个会话索引比较器：先排序，再截断，不能先按时间截断再排序。
SQLite 当前读取该会话的受限缓存窗口，在 JavaScript 中用 BigInt 比较索引，避免 TEXT 字典序或 Number 精度丢失。
这与 native 用 `order_index` 选择最后自发摘要是不同的查询语义；原始已读摘要另用下述独立选择器。
出站确认回调绑定创建发送器时的登录代次；退出或重新登录后返回的旧回包不会写入新的本地库，
但原调用仍返回其真实发送结果，不伪装撤销已经发出的请求，也不会自动重发。

发送回包没有完整 MessageBody。`send-ack` 来源仅补建不存在的缓存行，不能覆盖先到达的服务器消息，
以免丢失原始 createTime、order、索引、version、ext 和引用信息；之后到达的服务器消息仍可替换简略记录。
SQLite 事务与 JSON 更新使用同一个来源判定函数，按 serverId/clientId 检查已存在消息，不依赖到达时序或字段数量猜测来源。
这是当前简略出站缓存的边界，并非 native 本地发送状态机或全部消息合并规则的等价实现。
源码已确认 wire `status` 对应 native `net_status`，`orderInConversation` 对应 `order_index`；
独立的本地 `status` 及待发送消息 order 分配尚未迁移，详见消息状态来源。

普通服务器消息按同会话 clientId 合并：`s:client_message_id` 优先于 DTO 别名并正规化 ASCII 大小写，
旧 ext 仅补新 ext 缺失键，新键的空字符串仍有效；新 content 为空时才补旧内容。
旧有效正数 order 被保留在缓存 `orderIndex`，新 wire `orderInConversation` 独立保留，不能混为一个字段。
serverId、index/indexV2、version、wire status 使用新消息值；client-only 简略记录得到 serverId 后移除旧别名行。
无 clientId 时仍以 serverId 保留 SDK 去重能力，不把此回退描述成 native clientId getter 的行为。
旧缓存无需删除或改 Session；首次合并可从旧 wire order 读取有效 order。

传输层不再提前丢弃同 ID 更新、自身回显或空 content。Account 先写入/合并缓存，再决定是否派发新消息，
自身消息和命中已有消息的更新不会构造业务事件或联系人；回显因此不会把自己加成好友。
持久缓存可抑制重启后的重复事件；`localState: false` 仅保留本次运行的身份去重，退出后清除。
旧 EventAssembler 在停止后不再接受消息和通知，防止晚到回调污染新账号运行期。
联系人历史查询、普通会话撤回/消息删除/会话删除绑定发起时的 ImService 实例；
地址准备和响应返回后均检查账号在线状态与连接身份。退出或重新登录后旧响应明确拒绝，
不再写入或删除新运行期缓存。动作若已发送，拒绝本地结果不代表远端撤销，调用方应核对远端状态后再决定是否重试。
陌生人列表只读当前本地会话，构造联系人投影时不跨网络等待；异步陌生人同步另行校验登录代次，旧结果不回填 `sl`。账号级陌生会话全部删除返回原动作的实际响应，
但仅在原登录仍在线时清内存名册；退出/重登后的迟到成功不会清掉新名册，不重发远端操作。
普通消息更新现另行投影为 `notice.message.update`（Desktop bridge 实际名称是 `onUpsertMessage`，枚举 5）。
它提供已合并的 `message` 副本及账号/会话/消息身份，不提供猜测的变更原因或旧值，不具备自动 reply 动作。
首次消息、自身回显以及完全相同的重复快照都可触发；后两类仍不触发普通新消息 handler。
保存先于更新事件，更新事件先于 SDK 新消息派发；更新 handler 同步退出账号时不再派发该新消息。
更新通知使用 原生显示过滤：clientId 非空、wire status 不为 1、
普通显示 type 位于 0–1999，并处理 type=1 的 PC 版本条件及 type=1002/aweType 整数100200特例。
JS mapper 另要求非空 content；关闭本地库时不能依靠旧缓存补齐空正文。
该门槛不读取 s:visible/s:invisible，也不把 recalled/deleted 或 serverId=0 当作显示禁止条件。
非对象/损坏系统正文的 native 外围异常处理未闭环，SDK 暂保留空对象解析回退；
普通新消息、单消息更新和批次更新均使用该显示过滤；隐藏的普通消息仍写缓存但不构造业务消息事件。
历史/搜索入口尚未宣称共用这套展示规则。
详见 消息更新事件。
批次投影为 `notice.message.batch-update`，`updates` 中每组携带已存的会话快照及消息副本；
`deletedClientMessageIds` 对应 native deletedMsgs，不是 serverId。先按会话/clientId合并（后者覆盖），再过滤显示；
不存在本地会话时跳过该组，不合成会话。非空输入过滤成空数组仍允许通知，与原生过滤顺序一致。
批次可跨会话，所以只走 notice/notice.message 父频道，不继承单会话通知的 conversationId 字段。
目前已接主动/被动撤回及断线补拉普通消息生产者。补拉页保留返回顺序，全部普通行参与合并，
不因索引旧于 checkpoint 而舍弃其状态更新；不逐条派发 new/upsert，但登记已见身份以抑制后续实时重复新消息。
登录初始化持久化真实会话 DTO；重连先应用会话列表快照再合并消息，不合成不存在的会话。
关闭本地状态时无法恢复会话快照，非空消息批次可投影为空 updates，运行时身份去重仍保留。
连接 generation 与 recovery epoch 隔离退出、旧 receiver、重复重连及晚到 seed/history；同步 listener 停止连接后不继续拉取或推进游标。
现有恢复查询仍限最近50会话/每会话50消息，并以最新索引推进选取会话；未实现完整 native pull 调度/分页。
50001/command_type=2删除已接入；其余特殊批次生产者仍待对齐，不能将普通历史的无 new/upsert 语义推广为“历史命令无任何事件”。
会话快照沿用 SDK 的 ImConversation 已存字段，不宣称已有 native hintMessage/全部派生列；
通用消息 localExt 已接入下述独立单条/批量操作；待发送状态和完整会话维护仍未完成。

40001 撤回从 ext 读取 `s:target_client_message_id/s:target_server_message_id`；包装层要求 clientId 非空，再按 clientId 查目标，
再回退 serverId；命中后保留正文、类型、order 等字段，写 `s:is_recalled="true"`，以及 localExt 中的
`s:text_recall_timestamp`。通知时间只有在 `0 < create_time < now` 时采用，否则取当前毫秒时间。
没有目标时不伪造消息或永久 tombstone。后续同 clientId 普通消息按 native 规则补缺标记；
显式新 ext 值仍优先，不发明不可逆状态。缓存消费者可用 `message.ext?.['s:is_recalled'] === 'true'`
识别撤回，不能把保留的正文当作未撤回消息。隐私策略缓存会失效，不复用旧策略。

目标命中后，按其实际 serverId 联动本会话全部保留且未 deleted 的直接引用：
仅写 `referenceInfo.refMessageStatus = 3`，保留正文、hint、有效 order 及本地字段，
在撤回通知派发前持久化。不按 rootMessageId 扩散或递归，也不把引用消息自身标为 recalled。
查询不受历史页大小限制，但仍受 SDK 配置的缓存保留容量限制；源码见
引用撤回联动。原消息未命中时不创建联动墓碑。
后到引用自动回查及晚到旧快照保护尚未闭环，不自行补猜测逻辑。
主动撤回 cmd702 固定 inbox1，外层状态 0/200 即进入本地更新；从请求前捕获的 clientId 查找，
不以服务器 ID 回退复活已删除目标，先投影 batch 再返回 SDK 动作结果。后到40001仍可独立更新/派发。
源码见回调边界。SDK 的 serverId 动作入口仍可显式请求远端，
尚未复制 native UI 入口要求本地会话/消息先存在的全部前置条件；缺少本地clientId时不会伪造本地更新。

普通消息合并限 `type < 50000 && type !== 40001`；其他消息不进入普通缓存，WS 未识别类型仍作为
`im.command` 可观察。目前未持久化 40001 通知自身，不以它宣称完整 native 数据库对齐。

单消息删除现保留 `deleted: true` 记录，而非物理删除正文。查询遵循已核实的不对称条件：
历史及 clientId 查询排除删除行；serverId 查询仍可取到它。JSON 和 SQLite 使用同一消息 payload 字段，
其中历史排除必须在条数截断之前；原生SQL核对确认该条件位于WHERE中。
既有无该字段的记录按未删除处理，不重建用户数据库。缓存容量统计仍包含删除行，超出保留窗口后可淘汰。
普通消息重入时不与删除行合并旧 ext/order，正常保存清除 deleted；这是 native 保存语义，不是承诺服务端会重发。
撤回通过 serverId 回退找到删除行时使用独立 local-update 保存，保留有效 order、正文与本地字段，再清除 deleted。
简略发送 ack 仍不得恢复已有删除行，这是 SDK 的不完整回包保护；未找到目标不伪造永久墓碑。
`deleteLocalMsg` 只作用于本地库；`deleteMsg` 仅当目标serverId非0才请求服务端。尚未建模native message_property表的伴随删除及全缓存策略。

主动/本地删除审计要求两条入口都先验证本地会话和client消息。
SDK接受serverId字符串或显式 `{ clientMessageId }`，字符串先解析同会话client身份，不直接绕过本地门槛发请求。
主动删除inbox/shortId/type取本地Conversation，serverId取命中消息；serverId0跳过HTTP，支持client-only缓存行。
cmd701同步链仅外层status0才执行本地delete(true,true)：目标软删、引用status4逐条update、目标delete，不构造batch。
仅本地入口对应delete(true,false)：目标软删并发delete，不联动存量引用。两者共用按client删除的存储及事件能力，
Stranger不再覆盖为cmd1003；MessageEvent优先转发clientId。主动回包后重查捕获的client身份，不以旧serverId误删替代行。
保留SDK诚实失败结果与可依赖的同步本地完成结果，不复制native吞网络error和local缺common callback的问题。
本地状态关闭或尚无会话/目标时不执行删除。命中last/hint时已接先更新摘要并发会话事件，再做引用/消息回调，见下文。

Desktop 删除命令只接受50001正文的整数command_type=2，
会话ID须为字符串，message_id须为JSON整数；词法读取保留int64位模式，不能接受数字字符串/小数来冒充native整数。
缺失或非法字段安全拒绝，不复制native的未检查下标访问。先以正文会话/serverId查目标，再取clientId查询非deleted行。
命中才软删除，联动同会话全部保留的非deleted直接引用status=4、保留正文/hint，不递归root。
引用更新逐条投影upsert，目标通过notice.message.delete投影原消息副本（不合成deleted/operator/reason字段）。
删除出口不经过native messageIsVisible，但仍须clientId/content；引用upsert仍使用正常显示过滤。
实时push没有额外batch；补拉追加最初目标clientId到deletedClientMessageIds，重复软删行也可能进入该列表。
显式getHistory不发额外batch，但仍处理删除与引用单事件；处理返回页时保留服务端顺序，列表排序仅用于返回视图。
旧代次或同步listener退出后不继续派发/回填。property表和其他command仍未完整建模。

last/hint选择记录与网络Conversation资料分开，SQLite使用conversation_summaries表，JSON使用conversationSummaries；
保存两个clientId、普通lastMessageIndex及本地lastMessageTime/sortOrder/maxIndex/maxOrder，消息正文仍在消息库。运行时槽可以与已存ID暂时不同：
按native空页/unchanged分支，删除清槽后未必补DB写；不把所有cache变动都视为持久化完成。
普通服务器消息保存后维护摘要，删除按命中重算并先派发notice.conversation.update；撤回更新摘要后走原有batch。
引用local-update不当新消息触发选择，send-ack也不冒充已验证的服务器MessageBody。
getConversation/listGroups及会话事件提供隔离快照，last/hint分别经main正文门槛投影为消息或null；
网络刷新保留本地选择，整会话删除同时清理。候选基于order_index、deleted先过滤、200条/最多10页，
不是getCachedHistory默认50条或indexV2排序。完整细节和已知边界见摘要审计。
完整服务端合并会把当前本地摘要一并保存，包括此前仅在内存中清空的选择标识；
数据库列表查询与localExt-only操作仍保留各自不强制保存摘要的边界，见合并保存核对。
远程float/hint配置已在账号初始化时读取并传入独立快照，失败保留设备/版本匹配的desktop-settings.json；
每两小时更新缓存，下次登录采用新值，不擅自热更新native选项。该应用配置与IM localState开关、Session均独立。
普通服务器消息的浮动链已接入：双槽存在、非撤回、native-visible后，分别维护两个max计数、last/hint和条件浮动；
not_float过滤不阻止摘要更新，七类通知例外按当前账号判断。初次重算不顺便浮动，删除/撤回不倒退会话时间。
sortOrder按当前pinned或settingExt中的a:cell_sort_time计算，网络资料刷新不覆盖本地派生字段。
property槽已按普通MessageBody.property_list接入：self消息中选其他人的se:表态，Info独立放在localExt，正文仍在消息库；
取消表态可写回默认Info并清槽，但删除原消息只清槽保留Info，不倒退会话时间，也不凭property-only命中发会话更新。
内部表态已读仅在localExt持久化完成后发布内存标记：JSON候选写失败恢复旧状态，SQLite包含COMMIT在内成功才返回。
失败不会导致下一次调用被误判为已读，也不清空重建摘要丢失未保存的last/hint选择；这不是服务端上报成功的证明。
完整reload/repair、表态已读上报、property命令增量/独立数据库、置顶设置即时重排、列表排序及unread/contact时间联动仍待接入；
缺少可用配置时使用native默认关闭，不代表已确认线上配置关闭。

单消息读取由联系人上的 `getCachedMessage/getCachedMessageByClientId` 暴露；两者账号及会话隔离，
只返回副本，不隐式联网。serverId 查询使用现有主键，clientId 在该会话的受限缓存内匹配，
不受 `getCachedHistory` 默认 50 条页面限制。尚未新增 native 式 clientId 独立索引。

消息本地扩展通过 `contact.modifyMessageLocalExt(clientMessageId, ext)` 或账号级
`batchModifyMessageLocalExt([{ conversationId, clientMessageId, ext }])` 按键合并字符串值。
两者不联网；前者要求已有会话和消息并发普通更新，后者跳过缺失消息、逐项保存后重读最终状态，
独立派发enum18对应的 `notice.message.list-update` 平铺数组，保留顺序/重复和两阶段展示过滤。
不复用enum23分组批次，不触发新消息handler、不强制重算摘要。同步本地完成、输入预校验和写失败抛错是SDK策略；
整批不是事务，已成功前项保留。原生指针别名与SDK摘要副本并非已完全等价，详见localExt审计。

## 原始已读摘要

三种联系人共用 `getCachedReadSummary()`，Account 绑定当前身份，状态库使用同一纯函数计算。
SQLite/JSON 都扫描该会话全部保留消息，不受默认50条历史页限制，但仍受现有缓存淘汰策略约束。
只选当前账号发送、wire status（net_status）为0、未删除、`s:is_recalled` 不等于精确字符串 true、
类型不属于1/1001/1002/1010的消息，按有效 order_index、create_time 降序选择。
不额外要求正文、clientId、正 serverId/index 或可展示条件；clientId只取 `s:client_message_id`，不回退服务器ID。

成员与读游标按 UID 关联，允许部分成员缓存参与，不通过要求完整名单的 listGroupMembers 入口。
排除自身和无成员对应的游标；使用普通消息索引、signed-int64绝对最小索引及精确可见性规则。
不可见但满足最小索引的成员仍计入分母；readUsers 非空且数量等于分母才 isAllRead。
secUid 来自成员记录，结果重新构造，不泄露内部可变对象。不联网、不写摘要通知缓存、不标记已读。

这是隐私过滤前的原始摘要，不保证本地成员/游标完整；ready/timer初始化仍未实现。
createTime 仍受既有 number 消息模型限制：发现非安全整数明确报错；UID/索引保留字符串和 bigint 计算。
cmd2000/2001/2038依据 native 接受 status0或200，必须同时通过响应体校验，公开成功统一为statusCode0。
源码与地址证据见读者摘要审计；目前仅离线验收。

Account另持有不落盘的摘要通知map，显式read/min组合查询成功保存或50013其他用户游标推进后重算。
native全字段equality对副本按signed UID排序，不把输出行顺序当作变化；getter与通知map完全分离。
先写完本次各会话的变化，再发一个 `ConversationReadSummaryNoticeEvent`（`notice.conversation.read-summary`）。
事件及读者行是隔离冻结副本；没有最后自发消息则跳过且不清旧通知项；整个runtime停止时清空map。
SDK组合查询仍沿用两请求都成功才保存/通知的约定，不宣称与native独立read/min回调时机相同。
pull-finish/batch、成员后续fetch和完整调度尚未接入；普通成员/消息缓存写入不擅自触发该事件。

`ChatContact.getReadReceipt(refreshPrivacy)` 使用本地raw摘要的消息身份与原始时间调用既有账号隐私策略缓存，
返回独立的 raw/privacy/readUsers/isAllRead。开关、查询状态与逐消息on/off应用于展示结果，不改raw或通知map。
投影期间连接或完整摘要变化即报错，不把旧查询合到新状态；纯读者顺序变化按native equality不算变化。
这是显式SDK查询：不启动renderer自动任务、成员拉取或UI位置筛选；业务错误在privacy返回，网络异常抛出。
SQLite/JSON仍复用既有逐消息策略库，重启复核账号开关，强制刷新仅重查策略。结果不证明缓存完整或真实UI验收。

## 陌生人同步双游标

协议分页组件 `StrangerSync` 使用状态库的 `getStrangerSyncCursors/setStrangerSyncCursors`，
分别保存刷新版本 version（默认0）和加载更多边界 loadMoreVersion（默认-1）。
两者均为 signed-int64 十进制字符串，不复用 Frontier 游标，不写入 Session。
SQLite 使用既有 state_meta 的独立 key；JSON 使用独立字段并沿用原子替换，写入失败还原内存游标。
同一账号目录重启恢复，其他账号目录独立；无持久库时游标仅随组件实例存活。

游标提交发生在成功消费整页之后，后页失败不回滚已成功页。
这只保证游标对的保存边界，不提供 consumer 会话/消息写入与游标的跨表事务。
组件要求 owner 注入登录代次检查并在退出时 close；Account 已绑定实际代次与连接，
显式 refresh/loadMore 会保存骨架、异步608补查和发布消息批量更新；本地列表、自动调度与裁剪尚未接入。
详细源码依据、SDK 防护差异及离线覆盖见陌生人同步实施 §7。

会话 coreVersion/coreExt/mode 与 setting/local ext 独立，网络快照按 core version presence 合并并重算箱标志；
陌生骨架是显式 local 写入，不能当作缺少网络字段的完整快照重新清空。
具体合并和 Account 接入边界见实施 §8。

## 为什么不直接嵌入 imsdk.node

Desktop addon 只暴露低层 `init/call/getCtxHandle`，启动依赖应用内多个私有动态库、平台专用目录、证书/许可和完整初始化参数，且 macOS/Windows 二进制不同。直接嵌入会令 npm 包不可独立分发，也不会自动得到现有的 `Account/Group/Event` 公开语义。因此当前把 Desktop 作为行为与字段模型的依据，使用公开 Node 运行时实现本地状态 seam；未来若提供合法、完整的原生运行时，可在同一 seam 后新增适配器。
