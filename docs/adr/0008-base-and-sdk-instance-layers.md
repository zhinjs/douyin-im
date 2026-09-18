# ADR 0008：继承承载公共能力，子类实现差异

已接受并按当前代码落地。本文描述现状，不保留未实现的接口草图或目录迁移计划。

## 决策与取舍

基类应实现子类实际共用的状态和行为；子类只添加差异。一个规则只有一个实现位置，
定位业务动作不应穿越多份同名接口、纯转发方法和包装对象。
继承用于同类对象的差异，编解码、上传、认证等独立职责仍通过组合复用。

删除没有业务调用的抽象，而非为它补一个测试制造用途。保留中间模块的依据是它确实管理了
共享状态、生命周期、协议差异或复杂算法，而不是名字看起来符合某种架构模式。

## 现有继承与职责

```text
BaseClient → Client
BaseAccount → Account
Contact → ChatContact → Friend / Group / Stranger
BaseEvent → MessageEvent / NoticeEvent / RequestEvent → 具体事件
```

这里的箭头表示继承；Account 属于 Client，联系人和事件属于 Account，这些关系不是继承。

| 实例 | 实际职责 | 子类增加的差异 |
|---|---|---|
| BaseClient | 注册、别名解析、账号选择、顺序登录、并发退出与生命周期任务合并 | Client 创建具体 Account 并转发业务事件 |
| BaseAccount | 单账号生命周期、并发登录/退出、持有协议运行时和连接管理 | Account 接入认证流程、联系人缓存、账号级动作及事件装配 |
| Contact | 所属账号、稳定 ID、只读会话地址、地址补全入口 | ChatContact 实现共同聊天动作 |
| ChatContact | 发送、转发、撤回、已读、表态、会话设置等共同动作 | Friend 提供用户关系能力；Group 管理群和成员；Stranger 使用独立收件箱 |
| BaseEvent | 所属账号、原始载荷、统一时间解析 | 三类业务事件提供各自公共状态和行为 |
| MessageEvent | 内容、消息标识及 reply/quote/recall/markRead 等动作 | 私聊持有 friend，群聊持有 group/member，陌生人持有 stranger |
| NoticeEvent 及共享分类 | 会话、消息、群成员等通知上下文 | 具体通知承载对应变化字段 |
| RequestEvent | approve/reject、待处理检查和并发决策保护 | 具体申请通过 executeDecision 实现协议动作和成功状态更新 |

RequestEvent 对同一实例的相同并发决策复用任务，相反决策拒绝执行；已处理申请拒绝再次提交。
失败不自动标记成功，也不自动重试。这个保护是进程内并发保护，不是跨进程的服务端幂等保证。
入群申请的日期字段由 BaseEvent 统一解析。

运行时存在 RequestEvent → GroupRequestEvent → GroupJoinRequestEvent → GroupJoinRequest。
具体入群申请本身就是事件实例，不再额外包装成另一份事件。桌面端成员邀请是直接加群，
不建模为等待当前账号批准的 Request。cmd508 好友申请信号只进入
`FriendAddRequestNoticeEvent`，因为 Desktop 1.2.1 没有实际调用好友申请列表或审核接口。
没有可验证接收来源的事件类、频道和动作不进入公开 API。

## 状态归属与调用路径

联系人动作使用其所属 Account 的当前协议连接或共享发送器，不保存第二份 Cookie、连接或 sender。
群特有规则在 Group，群成员实例通过所属 Group 执行操作。

- 普通会话动作：联系人方法 → Account 的内部 ImService → 协议请求。
- 消息发送：继承的 ChatContact.sendMsg → 账号共享 OutboundSender → 内容构建、上传与发送。
- 入站消息：ConnectionManager → EventAssembler → 具体 MessageEvent → 路由 → Account / Client handler。

Account 统一处理好友、群、陌生人实例的绑定和缓存复用，列表与消息事件共用该规则。
EventAssembler 在调用用户 handler 前更新相关缓存，再把同一个事件实例派发到注册频道。
已持有的联系人对象使用账号当前连接；登录、退出和缓存清理仍由账号生命周期统一控制。

普通发送和转发均在准备会话地址前捕获发送器及连接，准备后核对账号仍在线且连接未变。
退出或重登后尚未发出的旧操作必须拒绝，不能等待结束后借用新账号发送器继续发送。
已经派发的请求则保留实际返回结果，不将迟到成功改写为失败或自动重试；账号发送回调按
原登录代次隔离缓存写入。这是 SDK 多账号生命周期约束，不声称 Desktop 原生存在相同检查。

关注/取关的人工验证续接由 Account 持有原登录代次。退出或重新登录后到达的挑战不再派发，
也不重发动作；已经发出的操作若迟到成功，仍返回实际响应，但不更新已退休或新登录的关系缓存。
Friend、Stranger、Member 的结果更新回调在这个共同生命周期边界内执行；本地更新错误不进入
网络挑战重试分支。这是多账号 SDK 的状态隔离约束，不代表能够撤销已经发送的远端关注操作。

好友和陌生人的备注仅将已确认回显发布到原发送连接仍属于的在线账号。
拉黑则按Desktop实际调用链，在请求resolve后独立启动一次getProfile，不从请求或拉黑响应
推断blocked/followStatus，也不等待资料刷新才返回操作结果。资料失败不重发拉黑，
资料读取复用Account.readUserProfile的身份、登录代次与较新关系快照保护。
每次初始化会创建新的OutboundSender/ImService，因此退出或重登后的旧拉黑响应不会
启动新账号的资料请求。它们不借用follow挑战续接，不新增统一端口或公开API。

协议运行时中，AccountRuntime 持有已绑定记录、设备和 ApiConnection；
ConnectionManager 负责接收器选择、去重、启动、停止及迟到连接的清理。
WebSocket 保活与重连仍在对应 adapter / WebSocket 实现中。Passport 活动续期由
BaseAccount 持有内部 `PassportTokenBeat`，以 `markActive()` 接收显式宿主活动，
上线启动、退出停止；它不是 WS 心跳，也不把收到消息自动当作活动。
该模块集中管理10分钟活动窗口、10秒前沿节流、空闲暂停/恢复及严格业务401处理，
AccountAuth 负责原请求的人工验证续接，ApiConnection 仍是唯一凭据/签名拥有者。
不暴露定时器配置或追加 Feature/Port 透传层。

OutboundSender 只保留消息构建、上传、发送通道与撤回分支，不重复转发所有群和好友操作。
AccountAuth 保留多步认证流程，ImInboxQueries 保留列表查询与资料映射，EventAssembler 保留通知和申请装配。
不再使用集中声明并透传所有业务动作的 Feature / Port，也不保留 Contact.invoke。

## 事件规则

MessageEvent、NoticeEvent、RequestEvent 是运行时类。Notice 描述事实，Request 才能审核。
未知、无法稳定识别的命令通过 notice.im.command 保留，不编造业务事件。

路由由 [router.ts](../../src/sdk/events/router.ts) 显式登记，不按字符串前缀猜测。
例如邀请导致的成员增加通知依次进入：

```text
notice → notice.conversation → notice.group → notice.group.member-change
       → notice.group.member-increase → notice.group.invite
```

各频道得到同一个对象。注册父频道和叶子频道时，业务方应避免重复执行相同副作用。
事件字段和当前接收能力见 [使用指南](../guide.md)，而不是根据抽象类名推断。

新增事件时一并检查协议识别、具体对象、路由、AccountEventMap / ClientEventMap 和行为测试。
消息事件的 type 为 message.private 等完整消息名；通知和申请的 type 为 group.invite、group.join
等分类内名称，其完整频道还包含 notice 或 request 前缀。

## 当前目录与公开入口

```text
src/
├── base/                 Base 类、raw DTO 与 Desktop runtime
├── desktop/              ApiConnection 与 Desktop 登录协议
├── http/ passport/ store/ 签名请求、认证与存储
├── services/im/          IM 编解码、传输、动作、通知、上传和媒体
├── sdk/
│   ├── account.ts client.ts
│   ├── auth/
│   ├── contacts/
│   ├── events/           assembler.ts / router.ts / message.ts / notice.ts / request.ts
│   ├── messaging/        outbound.ts / inbox-queries.ts / 消息构造与图片输入
│   └── content/          IM 共享卡片实例
├── index.ts
└── protocol.ts
```

`douyin-im` 导出上层实例和四个 Base 类；`douyin-im/base` 提供 Base 类及相关类型；
`douyin-im/protocol` 提供底层研究入口。源码没有 `src/protocol/` 目录，后者是包的子路径导出。
内部 ChatContact 类与协议运行时不从根入口导出；根入口的 ChatContact 是联系人联合类型。
标注 @internal 的成员不属于生成声明中的公共接口，产品示例不通过这些成员发起操作。

依赖方向：sdk → base / 协议实现；base → 协议实现 / store；
协议实现不依赖 sdk 或 base。已有 [依赖检查](../../src/base/dependency.test.ts)。

验证以行为为准：生命周期幂等、账号隔离、列表与事件复用实例、缓存先更新、请求并发保护、
相同事件对象进入父子频道。不要用编译通过或模拟传输成功替代真实平台验收。
