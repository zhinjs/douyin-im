# ADR 0006：Client 管理多个 Account

## 状态

已采纳。

## 背景

单账号工厂会让 Store 选择、底层 ApiConnection 创建、事件绑定和进程退出散落在每个调用方。
多账号运行时还必须保证 Cookie、设备身份和 IM 连接不会跨账号共享。

## 决策

新增 `Client` 作为多账号模块，其公开接口集中为：

- `createAccount()`：注册或取得 `Account`；
- `pickAccount()` / `accounts`：为主动操作选择和枚举账号；
- `loadAccounts()`：注册磁盘中后来新增的账号；
- `login()` / `logout()`：管理全部账号的生命周期。

`Client` 只共享 `AccountStore`，不共享底层 `ApiConnection`。每个 `Account` 独占协议状态。
登录及底层事件以扁平的 `{ account, ...payload }` 聚合到 `Client`。错误事件使用
`{ account, error }`，下线事件使用 `{ account }`。被动消息事件直接传递 `MessageEvent`，
事件自身持有 `event.account`；它的 `reply()`、`quote()` 和 `recall()` 使用当前联系人及所属账号的共享发送器。
主动操作必须先通过 `client.pickAccount(accountId)` 选择账号。这样 handler 无需同时维护事件载荷
和账号载荷，也不会误用另一个账号回复。

多个账号按注册顺序登录，防止需要人工验证时同时显示多个二维码或验证码提示。下线采用尽力关闭：
即使一个账号失败，也继续关闭其余账号，最终用 `AggregateError` 报告失败。

`Account.login()` 只在账号真正 online 后完成，同一账号或 Client 的并发生命周期调用复用
同一个 Promise。`logout()` 会取消仍在进行的登录，并关闭已经启动的消息模块。
Client 用生命周期代次阻止 `logout()` 之后的顺序登录循环继续启动其他账号；退出期间的新
`login()` 会等待退出完成。

WebSocket 意外断开时账号进入 `reconnecting`，接收器按 1、2、4、8、16、30 秒上限退避重连，
重连成功后回到 `online`。异步事件 listener 的 rejection 统一转换为
`system.handler.error`，并保留来源账号和原事件名。

产品层 `sendMsg()` 在服务端确认投递后完成，否则抛出 `SendMessageError`，其中保留原始响应。
这不代表接收端已经展示或阅读。会话与群管理动作仍返回状态响应，调用方应检查业务状态和失败成员列表。

`Account.getFriendList()` 是好友网络刷新边界；`getGroupList(true)` 是群列表网络刷新边界，
普通 `getGroupList()` 可复用账号本地完整快照。两者都返回账号绑定的
`Friend` / `Group` 并更新 `fl` / `gl`。`pickFriend()` / `pickGroup()` 只做同步缓存选择，
避免一次主动操作同时混入查询、映射和发送三种失败模式。

不保留独立账号工厂；所有账号都从 `Client.createAccount()` 创建，主动操作从
`Client.pickAccount()` 开始，避免形成第二套账号创建规则。

包根入口以产品接口为主，并额外导出 `BaseClient`、`BaseAccount`、`Contact`、`BaseEvent`
四个稳定扩展基类；完整 Base 类型从 `douyin-im/base` 导入。登录协议、Store、签名和 IM
protobuf 实现统一从 `douyin-im/protocol` 导入，防止业务代码绕开账号选择和生命周期。

包根提供 `createClient()` 作为推荐工厂，配置直接平铺在一个 options 对象中；不再嵌套
`accountDefaults`。富消息构造器统一命名为 `segment`。
