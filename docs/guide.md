# 使用指南

先按 [README](../README.md) 完成登录。本文示例使用公开入口；带参数的函数由调用方在选定账号、联系人后执行，
不会在初始化时自动发消息、审批申请或修改群。

## 账号与登录

`createClient()` 与 `new Client()` 等价。账号通过 `client.createAccount()` 注册，业务方不直接构造 Account。

| 配置 | 含义 |
|---|---|
| `dataDir` | 凭据存储目录，默认 `./data` |
| `autoLoad` | Client 是否自动注册磁盘账号，默认 `true` |
| `skipVerify` | 默认 `false`；仅在明确接受未验证 Session 时开启，不绕过平台安全验证 |
| `localState` | 默认账号级 `node:sqlite`；可传 `{ backend: 'json', maxMessagesPerConversation }`，或传 `false` 关闭 |

账号上线前会读取 Desktop 应用配置，失败沿用匹配设备的旧缓存；请求默认最多等待30秒。
配置独立保存在账号目录的 `desktop-settings.json`，不修改 Session，也不受仅控制IM状态库的 `localState` 开关影响。
运行期间每两小时刷新配置缓存，下一次登录采用新值；退出会取消在途请求和定时器。

`accountId` 只选择已保存账号，不再猜测它是手机号。首次登录必须用判别联合 `login` 明确指定
`qr / sms / password`；不传 `login` 时是扫码登录，不支持导入浏览器 Cookie。

`mobile` 不带国家码时默认 `+86`；其他国家码请显式写成 `+国家码 号码`，
例如 `+63 9000000000`（仅格式示例）。国家码后的空格会保留到协议编码，
号码内部空白、连字符、括号会清理；无分隔符的非默认国家码号码不自动猜测拆分位置。

```typescript
import { createClient } from 'douyin-im';

export function configureAccounts(savedAccountId: string, mobile: string, password: string) {
  const client = createClient({
    dataDir: './data',
    autoLoad: false,
  });
  client.createAccount({ accountId: savedAccountId });
  client.createAccount({ login: { method: 'sms', mobile } });
  client.createAccount({ login: { method: 'password', mobile, password } });
  client.createAccount({ login: { method: 'qr' } });
  // 在 client.login() 前绑定 README 中的登录与验证事件。
  return client;
}
```

| 收到的登录事件 | 调用方需要执行 |
|---|---|
| `system.login.qrcode` | 展示 `qrcodeBase64`，调用 `account.continueLogin()` 开始等待扫码确认 |
| `system.login.qrcode.status` | 展示扫码进度或诊断信息 |
| `system.login.sms` | 获取验证码，调用 `continueLoginWithSms(code)` |
| `system.login.voice` | 语音验证码已发送，接听后调用 `continueLoginWithSms(code)` |
| `system.login.sms-required` | 密码登录被要求改用验证码；调用 `requestLoginSmsCode()` |
| `system.login.accounts` | 同手机号多账号；选择 `secUid` 后调用 `continueLoginWithSubAccount()` |
| `system.login.verification` | 调用 `verification.open()` 完成平台下发的滑块、短信、辅助手机短信、手机扫码或 Push 验证 |

`Client` 的生命周期载荷带 `account`；`Account` 自己的生命周期载荷不额外包装账号。
例如 `client.on('system.login.error', ({ account, error }) => ...)`，而
`account.on('system.login.error', (error) => ...)`。消息、通知、申请本身都持有 `account`。

`client.login()` 按注册顺序登录，单个账号失败后仍尝试其余账号，最终以 AggregateError 汇总失败。
同一个实例上的并发生命周期调用会复用任务。`logout()` 会取消待完成登录并停止连接；
`removeAccount(id)` 先退出再从 Client 注销，不删除落盘凭据。
这里的`logout()`不是已实现的远程Session撤销，也不会删除BDTicket私钥/证书。
恢复Session时，身份探针返回的Cookie/票据先暂存，UID与目标账号一致后才一起保存。
取消、身份不匹配或验证失败不覆盖原凭据；旧一轮登录的迟到结果/错误不会创建账号或取消新一轮登录。
恢复连接会在探针前读取匹配设备的应用配置缓存，用作BDTicket固定启动快照。
没有匹配缓存使用Desktop默认策略；后台刷新只更新缓存，不热切换当前连接的签名开关/路径。

`account.state` 为 `idle / logging-in / online / reconnecting / stopping / offline / error`。
上线后自动发一次 Desktop Passport `boot` 续期。随后以10分钟为周期：期间有活动才发
`polling`，无活动就暂停；暂停后首次活动发 `active`。调用 `account.markActive()` 报告
真实使用活动（例如用户操作你的 UI 或终端），10秒内重复调用合并为一次；不要用定时器
调用它来冒充用户，也不要默认把收到消息当活动。Demo 的终端主动操作已接入，被动回复没有接入。
离线时调用会抛错。`skipVerify` 只跳过恢复探针，不禁用上线后的续期；续期成功不会将
未验证恢复自动标为已验证，也不能证明绑定票据已签发。

续期遇到平台挑战仍触发 `system.login.verification`，此时 `verification.operation` 为
`token-beat`，应保留验证监听器而不是上线后移除。验证取消/超时不伪造成功，不自动重新登录。
只有失败响应的业务 `data.error_code` 为数字401才自动退出该账号并派发 `system.offline`；
普通网络失败、HTTP401、字符串401不混同处理。退出停止续期和在途验证，保留 Session 文件。
该调度/续接已通过原码对照及离线测试，真实平台续期安全链和新票据签发仍待验收。

重连期间 `account.online` 仍为 `true`，可继续尝试 HTTP 操作，但不表示 WebSocket 已连接；
恢复后会再次触发 `system.online`，不要在该事件里无条件重复群发。
恢复连接后 SDK 会用桌面 cmd203/cmd301 路径检查最近 50 个会话，对最新索引推进的会话补拉最近 50 条。
返回页中的普通消息全部参与缓存合并（包括旧索引记录），通过 `notice.message.batch-update` 通知更新，
不会逐条重放 `message` 回复 handler 或 `notice.message.update`；后来到达的实时重复消息也不会当作新消息。
退出、换连接或再次重连后，晚到的补拉结果会丢弃。这仍不是 Desktop 完整拉取调度器：
更长离线窗口需显式调用 `contact.getHistory()` 分页，同索引变化和其他历史特殊命令仍待对齐。
已接入50001/command_type=2删除：实时/历史均执行软删除和引用单条更新，补拉额外携带批次删除clientId；
显式历史不派发额外批次。命令状态处理保持服务端顺序，返回列表的排序不改变状态处理顺序。

`account.uid` 对应已确认的规范平台身份，`account.imUid` 是 IM 身份；登录前可能不可用。
手机号、Passport Cookie 别名、`secUid`、IM UID 不是可任意互换的标识。所有协议大整数 ID 使用字符串。

## 联系人与缓存

| 对象 | 网络查询/刷新 | 同步选择与缓存 |
|---|---|---|
| Friend | `account.getFriendList()` | `pickFriend(uid)`、`fl` |
| Group | `account.getGroupList(true)` 强制联网 | `getGroupList()` 优先本地、`pickGroup(groupId)`、`gl` |
| Stranger | `account.getStrangerList()` | `pickStranger(uid)`、`sl` |
| Member | `group.getMemberList(true)`、`member.refresh()` | `getMemberList()` 优先本地、`pickMember(uid)`、`memberList` |
| GroupJoinRequest | `group.getJoinRequests()` | `pickJoinRequest(requestId)`、`joinRequestList` |

群和成员的完整网络列表成功后更新账号级本地状态库，并复用匹配的稳定实例；查询失败不应作为空列表处理。
好友列表和群列表都会在内部翻完服务端分页，再一次性替换缓存；调用方拿到的是完整快照，
而不是某一页。群成员列表也会翻完 cmd605，随后用可用的用户资料补全昵称和头像；资料补全
是可选步骤，不会令已经成功返回的成员页整体失败。
联系人 `pick*` 找不到时返回 `undefined`；未上线时账号的联系人操作会拒绝执行。
`account.refreshContacts()` 批量补全已加载会话，`contact.refresh()` 刷新当前会话。
`searchConversations(query)` 只搜索当前已加载联系人和群成员，不是远端全站搜索。

陌生人 Desktop 同步可显式调用 `account.refreshStrangerConversations()` 或
`account.loadMoreStrangerConversations()`：前者刷新最近页，后者只取一页更早消息。
它们写入当前账号状态并派发 `notice.message.batch-update`，不会对历史消息触发被动回复；
会话详情另行异步补查，成功后派发 `notice.conversation.update`。
返回的 `pages/conversations` 仅是本轮消费数量，不表示完整列表或已经没有更多。
该链路目前仅离线验证。`getStrangerList()` 无参数，只从当前本地会话生成私聊联系人视图，
不请求网络或补查用户资料；昵称、头像可能因本地资料缺失而为空。同一用户有多个会话时，
联系人视图使用排序最靠前的一条。`getStrangerConversations()` 同步返回所有命中的本地会话行，
保留群会话及重复用户，不等同于 `Stranger[]`。
本地查询按箱标志、会话未删除且排序非零筛选；SQLite/JSON 在读取时可能修复本地摘要，
但不会因此拉取远端消息。空列表不证明服务端没有陌生人，自动同步触发与本地裁剪仍未接通。
陌生人全箱删除、全量已读仍是待进一步核对的旧命令路径；目前全量删除成功只清内存 `sl`，
未删除持久会话行，再读本地列表可能重现旧记录，不能当成完整的 Desktop 删除流程。

Friend 与 Stranger 分属不同收件箱；即使对方 UID 相同，也不要互换这两种句柄。
Member 的群角色和群名片是当前 Group 中的只读资料，不是全局用户状态。
Friend/Stranger/Member 的 `followStatus` 表示当前账号关注对方的状态，`followerStatus` 表示对方是否关注当前账号。
调用 `getProfile()` 后，明确的 `followerStatus=0/1` 更新同账号、同UID的全部视图，并存入启用的本地库；未知为 `undefined`。
缺失/未知值不清空已确认状态，迟到资料不能覆盖较新关系或旧登录。关注响应只更新自己的方向，
不隐式追加资料查询、不由互关或通知计数推断对方的方向，也不改变群角色或好友名册。

好友列表来自 Desktop 联系人页的 `/aweme/v1/web/familiar/list/`，而不是私聊历史，也不是
native SQLite 的 `getFriendsWithLimits`；`getFriendList()` 按每页 100 条自动翻页后再原子替换缓存。
没有既有会话的 Friend 会保存可推导的 P2P ID，
直到首次聊天动作才用 `ONE_TO_ONE_CHAT` 创建并补全 shortId；单纯列好友不会新建会话。
`setBlocked()` 返回拉黑接口结果，并按Desktop流程异步刷新资料；返回不等于关系缓存已刷新。
`blocked`、`followStatus` 由资料回读确认，刷新失败保留旧值、不重发拉黑操作；退出后不继续发布旧结果。
`setBlocked()`、`setRemark()` 和 `deleteConversation()` 是三个不同动作；SDK 不提供 Desktop
bridge 未开放的“删除好友”写操作。Stranger 支持拉黑、备注和会话删除，但不会因此被 SDK
提前挪入好友缓存；关系变化以服务端通知或下次好友列表刷新为准。

陌生人网络同步的迟到响应在退出或重新登录后会拒绝，不再回填 `sl`；本地列表查询不跨网络等待。
`deleteAllStrangerConversations()` 已发出的操作仍返回实际响应，但旧登录的成功回包不会清除新登录缓存；
这不代表远端删除被取消，也不会触发自动重试。陌生人箱的进入/退出与已读不同：Desktop的进入状态
用于本地缓存裁剪保护，当前SDK尚未实现对应同步/裁剪生命周期，不以“全部已读”替代。

`friend/group/stranger.deleteConversation()` 现在共用 Desktop cmd603：只删除已有本地会话，
不会为了删除而创建好友会话；发送实际 inbox 与请求前从本地消息库取得的 indexV1 最大值。
成功后根据请求边界、当前 minIndex 和 lastMessageIndex 执行软删除；在保留较新消息的分支中，
只标记边界以内的消息，而非清空整个会话。仅协议 status=0 才处理本地状态并派发
`notice.conversation.delete`，该通知不代表必然物理移除所有记录，也不是退群或取消好友关系。
退出/重登后的旧回包不修改新登录；本地写入失败会报错，不自动重试远端删除。
此动作需要启用 SQLite/JSON 本地库；`localState:false` 会在发请求前拒绝，不能用猜测索引代替。
被动50001的command_type=3/620/1010使用正文的删除边界；存在较新消息时发
`notice.conversation.min-index`（`minIndex`是该命令的边界），否则发delete。
这两个事件的分支以删除前lastMessageIndex判定，不直接等同本地是否保留了会话。
50005仅更新已有会话的`isParticipant=false`并通知update，不删历史、不推断某个成员退群。
目前仅离线验证；旧历史重放/复活和原生完整未读/历史状态旁路仍待接通。
全箱删除 cmd1005 尚未找到 Desktop 实际业务调用，不以 proto 描述存在或离线 mock 成功证明其可用。

## 消息与图片来源

`sendMsg()` 接受字符串、单个富媒体 `segment`，或由文本与 `segment.at()` 组成的数组。
Friend、Group、Stranger 继承相同聊天动作；群聊 @ 应绑定 `Member`，由 SDK 同时生成正文中的
`richTextInfos` 与协议 `mentioned_users`。
`event.reply()` 发送普通回复，`event.quote()` 引用当前消息；不需要手工拼接引用协议字段。

```typescript
import { segment, type Friend, type ImageInput } from 'douyin-im';

export async function sendImage(friend: Friend, source: ImageInput) {
  return friend.sendMsg(segment.image(source));
}
```

```typescript
import { segment, type Group } from 'douyin-im';

export async function mention(group: Group, uid: string) {
  const members = await group.getMemberList();
  const member = members.get(uid);
  if (!member) throw new Error('群成员不存在');
  return group.sendMsg([segment.at(member), segment.text(' 请看一下')]);
}
```

`source` 可以是 Buffer/Uint8Array、原始 base64、`data:image/...;base64,...`、本地文件路径、HTTPS URL，
或者已上传的 ImageAsset。文件先读取，字符串不是有效文件路径时才尝试 base64；远程 HTTP 图片会被拒绝。
读取的字节需能识别为 JPEG、PNG、GIF、WebP 或 HEIC。网络资源会下载到内存后上传；
业务方应自行限制来源域名、文件大小和用户可访问的本地路径，不要把任意输入直接变成文件读取/内网请求。

| 内容 | 构造入口 |
|---|---|
| 文本 | `contact.sendMsg('文本')` |
| 群聊 @ | `group.sendMsg([segment.at(member), ' 文本'])` |
| 图片 | `segment.image(source)` |
| 视频 | `segment.video(videoBytes, coverBytes, { width, height })`，两份字节都需提供 |
| 表情 | `segment.emoji({ url })` |
| 收藏表情 | `segment.sticker(item)`，item来自收藏页或确认成功的收藏记录 |
| 作品/图集卡片 | `segment.share({ itemId, title })` / `segment.photos({ itemId, imageCount })` |
| 链接/用户卡片 | `segment.link({ url, title })` / `segment.user({ uid, name })` |
| 文件 | `segment.file(bytes, name)` 或 `segment.file(asset)`；字节上传最多 10 MiB |

视频与文件字节输入并不自动支持图片的所有字符串来源形式。

文本、引用回复和大表情会在发送前检查当前账号已加载的会话 `settingExt` 风险提示；
命中时抛出“当前会话存在风险，请前往抖音手机端查看”，不会发请求或自动重试。
规则保留 Desktop 的列表首项及空值判断，不是简单判断字段存在；畸形JSON也会中止发送。
设置由启动同步、新建会话、群列表和会话刷新更新；不在每次发送时额外联网查询。
`localState: false` 仍保留本次登录已加载的会话快照与设置版本，退出清除；与持久化模式共用设置拒旧、
默认值和高水位规则，不只是保存风险字段。群列表直接传递协议会话，不丢弃 ticket 或版本后再拼装。
该内存快照不会开启消息历史库；未加载设置也不代表服务端已判定安全。
command4 已接逐键增量、条件补拉和会话通知；完整补拉后的原生未读/排序/本地提示等副作用仍在对齐中。
文件选择按钮的检查属于 Desktop UI，这里不泛化为媒体、转发或其他卡片的统一传输限制。

### 表情资源与收藏

`account.getEmojiResources()` 查询 Desktop 小表情资源描述符，返回 `androidResource: { url, md5 }`；
`androidResourceStatus === 1` 表示平台要求跳过刷新，此时没有新描述符。这里的 `android` 是
Desktop 使用的服务端字段名，不是安卓收发路径。此调用不下载 ZIP、不返回表情数组，也不读取收藏列表。

```typescript
import type { Account } from 'douyin-im';

// imageId 必须来自平台已有表情项目，保留为字符串，不能先转 Number。
export async function collectExistingSticker(account: Account, imageId: string) {
  return account.collectEmoji({
    imageId, stickerUri: '', stickerUrl: '', resourceId: '0', stickerType: 0,
  });
}
```

这是 Desktop 的按 ID 收藏方式。消息收藏使用 `stickerType: 1`，参数取消息 content 的
`image_id`、`url.uri`、`url.url_list[0]`、`package_id`；搜索结果使用它自己的 `sticker_type`，
不能统一写成 1。`undefined` 字段不发送，显式空串保留；没有 imageId 的 URI 表情可省略 imageId。
本方法不上传文件，也不会自动把任意图片或每条消息转换成可收藏表情。

成功需要平台 `status_code=0/200` 且首个 `success_items` 非空，SDK 统一返回 `statusCode: 0`。
`successItems` 保留服务端字段及大整数 ID，不是可直接发送的消息 content。
7279/7280/7281 等拒绝码原样保留；空响应、超时、安全验证不自动重试，不乐观修改收藏。
退出账号后读取到的旧资源查询会被拒绝；已发出的收藏仍返回其实际结果，不把退出当成撤销。

这两项目前通过源码与离线契约验证，未做真实账号收藏验收。资源包解压、
取消收藏仍需后续实现；取消目前只有枚举证据，不据此暴露一个假定可用的操作。

收藏列表使用独立接口 `account.getCollectedEmojis()`，每次最多查询50项，不自动拉完全部页。
首次不传 cursor 会刷新列表；后页显式传 `{ cursor: previous.page.nextCursor }` 默认追加。
也可显式指定 `firstPage: true | false`，不能仅由游标值是否为0判断首页。

```typescript
const first = await account.getCollectedEmojis();
if (first.statusCode === 0 && first.page?.hasMore) {
  await account.getCollectedEmojis({ cursor: first.page.nextCursor });
}
const cached = account.getCachedCollectedEmojis(); // 只读内存副本，不再发请求
```

`page` 缺失表示服务端没有提供状态更新；`page.stickers` 缺失表示仅更新游标等元数据。
它们都不等于空收藏列表。真正的空 stickers 首页才清空缓存。
SDK按 Desktop 的 `video_id` 禁用过滤、倒序、首页/后页不同去重规则更新内存，保留原字段与大整数ID。
分页读取和收藏写的判据不同：Desktop不检查读取结果根status再消费page；因此SDK保留原 `statusCode`，
同时仍应用经过结构校验的有效 `page`，不能把收藏写的成功判据套到这里。

`collectEmoji()` 只有收到实际成功项后才更新缓存；已有ID不覆盖、不挪到顶部。
缓存不写入磁盘、不跨账号共享；退出后清除，迟到的读取不会回填。已发收藏返回实际结果但不会回填离线账号。
快照仅表示已读页与已确认收藏项，不代表完整在线列表；demo `/emojis` 刷新首页、`/emojis <cursor>` 追加下一页。

发送收藏项应使用独立消息段，而不是把记录交给 `segment.emoji({ url })` 或直接序列化为消息：

```typescript
const item = account.getCachedCollectedEmojis()?.stickers[0];
if (item) await contact.sendMsg(segment.sticker(item));
```

该段按 Desktop 收藏页生成 `aweType=501`、外层消息类型5，通过现有HTTP发送链发送；
保留平台ID的原number/string类型，动态/静态URL按字段分别回退，不上传或自行制造表情ID。
私聊和群聊共用内容，但群聊还检查当前账号的 `stickerEnabledStatus`：按 Desktop 标量 `== 0`
语义判断，未知或不允许时在发送前拒绝。群开关允许后仍检查上述会话风险；不会自动改成507重试。
可先查询收藏页更新账号开关，`contact.refresh()` 则刷新会话设置，两者不是同一状态。
`segment.emoji({ url })` 是独立的507路径，不是收藏记录的等价转换器。
demo `/sticker <friend|group|stranger> <id> <表情ID>` 只查当前账号已加载的收藏项，再显式发送。
源码字符串差分和SDK路由已离线验证；接收方实际展示仍需真实账号验收。

### 转发与消息操作

```typescript
import type { MessageEvent, Friend } from 'douyin-im';

export async function forwardReceivedMessage(event: MessageEvent, target: Friend) {
  if (event.account !== target.account) throw new Error('转发目标必须属于来源账号');
  return event.forwardTo(target);
}
```

转发保留服务端消息类型、内容和来源链；不是将内容重新变成一条文本。
只支持实现中明确允许的消息类型。发送成功返回服务端/客户端消息 ID；它不是阅读回执。

## 共同会话动作

| 方法 | 语义 |
|---|---|
| `getHistory({ cursor, count, direction, includeCurrent })` | Desktop 风格历史查询；默认 `direction: 'older'`、`count: 50`、`includeCurrent: false`，结果按会话索引升序排列；游标用十进制字符串保存 |
| `getCachedHistory(count)` | 只读取本地状态库，不发网络请求；默认返回最近 50 条 |
| `getCachedMessage(serverMessageId)` | 同步查询当前会话的单条缓存消息，包括 `deleted: true` 行；不受默认 50 条历史页限制；返回副本或 `undefined` |
| `getCachedMessageByClientId(clientMessageId)` | 按正规化 clientId 查询当前会话缓存；未命中不联网、不创建会话 |
| `modifyMessageLocalExt(clientMessageId, ext)` | 同步合并本地字符串键值；需要在线、本地库及已有会话/消息。空字符串保留，空补丁仍保存并按展示条件通知；不联网、不触发新消息或已读 |
| `recallMsg(serverMessageId)` | 撤回消息，受平台权限与时间限制 |
| `deleteMsg(id)` | `id` 为 serverId 字符串或 `{ clientMessageId }`；要求本地会话与client消息，serverId非0走cmd701，inbox取会话缓存，外层status0后更新目标/直接引用并发单事件；serverId0仅本地处理 |
| `deleteLocalMsg(id)` | 同上两种身份输入；只做本地软删除，返回是否隐藏目标，发单删除事件但不更新已发送引用。缺本地会话/消息返回false，不发网络；不是永久tombstone |
| `markRead(marker)` | 上报当前账号的阅读位置 |
| `getReadState()` | 查询并缓存原始成员读游标与最小索引，不标记已读 |
| `getCachedReadState()` | 只读账号本地游标，不代表完整成员名单 |
| `getCachedReadSummary()` | 同步计算最后自发消息的原始读者摘要；无消息/未登录/关闭本地库时 undefined，不联网或标记已读，尚未过滤展示隐私 |
| `getReadReceipt(refreshPrivacy = false)` | 将本地摘要与隐私策略合成，返回raw/privacy/readUsers/isAllRead；true仅刷新策略，不刷新原始游标。无本地摘要返回undefined，未登录/网络错误/期间摘要改变报错 |
| `reactMsg(serverMessageId, emoji, enabled)` | 添加或取消消息表态 |
| `deleteConversation()` | 调用会话删除接口，不等于退群或解散 |
| `enterConversation()` | 现实现仅发送 cmd410/actionType=1，**尚不等价于 Desktop 进入会话**；不能依赖它自动完成表态已读、消息补齐或成员读游标轮询，也不等于群成员加入 |
| `setMute()` / `setPinned()` | 免打扰、置顶；传 `false` 取消。返回请求结果，不以请求值覆盖本地资料；可 `refresh()` 读回。通知触发的完整即时重排仍待接入 |

被动事件有 `recall()`、`delete()`、`deleteLocal()`、`markRead()` 和 `react(emoji, enabled)`，自动携带当前消息位置。
`delete()` / `deleteLocal()` 优先使用事件clientId；仅有serverId时从本地库解析client身份。
`deleteLocal()` 同步返回是否隐藏了本地记录，不发网络请求。主动删除与仅本地删除都不另发batch，
前者更新直接引用status4，后者不改已发送引用。Friend/Group/Stranger共享该删除链；关闭本地状态时不可用。
本地缺会话/消息时可显式调用 `contact.refresh()` / `contact.getHistory()` 同步；删除本身不会发起补查或创建会话。
历史查询及普通会话撤回/删除在账号退出或重新登录后拒绝旧响应，不回填或清理新登录的缓存。
已发送的动作不会因此在远端撤销；遇到连接变化错误请先核对远端结果，勿直接重试。
收到撤回通知或主动撤回成功且命中本地原消息时，保留其正文并写入 `ext['s:is_recalled']='true'`；
同会话未删除的直接引用在整个保留缓存内更新 `referenceInfo.refMessageStatus=3`，不清正文或 hint。
该联动先于撤回通知派发；不递归更新 root 引用，不承诺补全未缓存目标或未来才到达的引用。
文本事件还暴露 `mentions` 与 `isMentionMe`，不会用昵称模糊判断是否 @ 当前账号。
`Friend/Stranger/Member.setFollowed(true | false)` 已恢复，消息命令 `/follow` 使用当前账号关注发送者。
该请求要求已绑定当前登录会话的 BDTicket 票据；缺失时明确报错，不降级为未签名请求。
服务端匹配 Session 的空签名会替换旧值并保存，恢复后仍不放行关注；非2xx响应不会触发业务验证续接。
证书、签名和业务验证续接已接入，但关注/取关尚未完成真实账号验收，不能视为已确认可用。

`account.getRecommendedContacts()` 单次读取Desktop聊天页顶部推荐联系人，返回
`RecommendedContactsResponse`（`statusCode/statusMsg/contacts`）。没有参数或分页能力；
业务请求仅`source=im_desktop`，其余使用所属账号的Desktop公共连接配置。
每项`RecommendedContact`只提供源码消费的可选`name/avatar/secUid/conversationId/lastActiveTime`；
没有数字UID、推荐理由或好友关系保证，`conversationId`也不代表群类型。
服务端顺序和重复项原样保留，缺失/null字段不补值；不插入UI随机ID、收起项或在线排序。
原始活动时间不计算在线布尔值，读取不更新关系、好友、会话或活动缓存，也不触发资料补全。
Desktop缺失/falsy的friends按空列表返回；显式业务错误保留状态，非法数组或字段返回-3且无部分列表。
后两项是SDK的明确错误/类型边界，比Desktop原包装仅检查friends真值更严格。
HTTP/正文失败直接抛出，不复制原包装脱离调用者的递归重试，不添加UI定时刷新。
未上线不可调用，退出/重新登录后的迟到响应拒绝返回。demo的`/recommendations`只打印结果。
原始函数与构建SDK对照和三后端账号隔离测试属于离线证据，真实接口可用性尚待验收。

`account.getNewFollowerCount()` 查询 Desktop“新朋友”的通知组401，返回
`NewFollowerCountResponse`（`statusCode/statusMsg/count?`），不是粉丝总数、好友列表或申请审核。
只有服务端明确返回该组时才有非负安全整数 `count`；组缺失时保留 `undefined`，不应清除调用方旧计数。
HTTP / 空正文 / 非法JSON错误会抛出；显式业务错误保留状态且不返回计数，畸形结构返回 `statusCode=-3`。
未上线不能查询；退出或重新登录前发起的迟到查询不会作为当前账号结果返回。
这是一次性查询，不增加后台任务、不改变关系缓存、不派发好友增减事件。
Desktop通知列表会携带 `is_mark_read=1`，该计数接口不会附带列表请求。
请求和有效响应已与原始Renderer消费者离线对照，真实账号尚未验收。

`account.readFollowerNotices()` 是独立的**读取并请求标记已读**动作，对应展开新朋友列表，
返回 `FollowerNoticesResponse`（`statusCode/statusMsg/notices/truncated`）。不能作为无副作用的后台计数查询。
请求固定每页20条，后续页沿用响应的 `max_time/min_time`，按原始条数累计超过120时停止；
恰好120条且仍有更多时会继续一页。`truncated=true` 表示因该阈值停止且服务端仍有更多，
不是读取了完整通知历史。最后按UID去重并保留首次出现的资料和顺序。
每项 `FollowerNotice` 的UID/secUid与nickname/remark/avatar区分；createTime保留原始秒时间，
hasRead保留服务端布尔或整数值，不因发送了is_mark_read就强行置true。通知资料不是Friend实例，
本方法不修改关系缓存、本地未读计数或派发好友增减事件，也不会关注列表里的用户。
重复游标、继续分页但空页或缺失游标返回-3；任一页失败都不返回部分列表冒充成功。
网络/正文错误抛出，业务错误保留状态；这些失败及账号退出都不回滚已经发出的已读请求。
不自动重试失败页，退出/重新登录后不再继续旧分页，也不把迟到结果交给新会话。
原始请求函数、头像选择和UI去重消费者与构建SDK已完成离线对照；未完成真实账号验收。

`account.searchUsers(keyword, cursor = 0)` 是添加朋友页的远端搜索；`searchConversations()` 仍只查本地已加载会话。
返回 `UserSearchResponse`：`statusCode/statusMsg/keyword/cursor/hasMore/nextCursor?/users`。
`users` 是独立资料数组，不是Friend/Stranger实例；昵称、头像、展示用抖音号 `uniqueId` 与协议用UID/secUid分开。
搜索不填充关系或资料缓存，点击/选择结果后的资料刷新和关注属于另外的显式操作。
每次只查一页，固定30条，偏移为0、30、60……；`nextCursor`由请求偏移加30得到，不使用响应cursor。
keyword不被SDK裁剪或改写（包括空串/空白）；返回 `input_keyword` 不匹配时返回-3，不能当作有效空页。
并发搜索各自校验自己的关键词；SDK不维护全局搜索框状态，UI调用方仍应自行丢弃已被新输入替代的查询。
非字符串关键词、非30倍数或超出安全范围的cursor在发请求前拒绝；畸形页/用户资料返回-3且不发布部分结果。
显式业务错误不返回用户或下一页；HTTP/空正文/非法JSON错误会抛出，不自动重试。退出/重新登录的迟到结果拒绝返回。
搜索使用Desktop原代码明确指定的 `https://www.douyin.com` 和 `version_code=21.6.0`，不等价主站写操作；
独立原码对照、错误分支和生命周期已有离线回归，真实平台鉴权与风控仍待验收。

`account.getActiveStatus(secUids, conversationIds = [])` 查询业务活动状态，使用Desktop实际的
`source=session_list`，一次POST携带FormData中的JSON数组。不自动挑选联系人、不分批、不排序或去重输入，
不要求会话ID是纯数字（P2P会话ID也可传），不执行 `active/update`。
返回 `ActiveStatusResponse`，`users?` 为 `UserActiveStatus[]`，`conversations?` 为 `ConversationActiveStatus[]`。
用户时间为服务端秒级 `lastActiveTime`，0、负值和未来值均原样保留，不由SDK转换成“在线/离线”。
会话保留服务端 `online` 数字/布尔标记和 `toast` 多语言提示；不要解释为在线人数。
缺类别/字段或null归为未提供，空数组也不会补齐未返回目标；本方法不覆盖任何本地状态。
原Desktop用户在线圆点另按5分钟窗口计算、群圆点还检查中文提示，这些展示条件不是本查询的返回契约。
非法目标数组在发请求前拒绝；畸形返回为-3，业务错误保留状态且不返回活动数据，HTTP/正文错误抛出且不重试。
只能上线后显式调用，退出/换登录代次的迟到结果拒绝返回；不启动5分钟查询循环或3分钟前台活跃上报。
两类自动调度及活跃上报仍未接入，不能把一次查询接口称作完整Desktop在线状态管理器。

## 群与成员管理

| 操作 | 方法 |
|---|---|
| 创建群 | `account.createGroup(otherMemberUids, { name, avatarUrl, description })`，自动补入当前账号并去重 |
| 邀请 | `group.inviteMembers(uids)`，返回邀请结果 |
| 移除 | `group.removeMembers(uids)`，返回请求级 `ImActionResponse` |
| 成员资料 | `member.refresh()`，按 Desktop 行为强制刷新整群成员快照后复用当前实例 |
| 退出 | `group.leave()` |

`group.inviteMembers()`发送cmd650，使用Group绑定的会话地址、固定inbox=1；
与移除不同，不要求本地库已保存群会话。外层0/200进入body解析，缺body明确报错。
`succeededUids / failedUids`只投影响应明确列出的UID，保留顺序和重复；
没有列出的目标是未报告，不再以“请求名单减失败名单”推测成功。
`details`保留Desktop的八个独立字段：普通成功/失败数组、两个secUid成员数组、
原始status、extraInfo、字符串checkCode和checkMessage。顶层状态是SDK解析后的操作摘要，
不是原始body.status；需要处理审批/频控提示时应检查详情，不能仅凭0或名单填本地成员。
它不自动邀请卡片降级、创建私聊、重试或刷新成员；调用后以通知/列表确认成员状态。
未上线或换连接后拒绝返回旧结果，不代表撤销远端邀请。原Desktop为WS-first，项目仍按用户要求仅HTTP发送。

`group.removeMembers()`使用已有本地群会话的shortId/type/inbox发送cmd651。
返回值只表示Desktop实际检查的外层响应状态，0不证明每个目标都已离群，200也不是成功别名。
它不返回推算的`succeededUids / failedUids`，不直接删成员或读游标，不自动刷新605/608，
也不伪造成员通知。成员结果以实际通知或显式`getMemberList(true)`为准。
缺本地群会话或未上线时请求前拒绝；退出/换连接后的迟到响应拒绝返回，不影响新登录缓存。
网络失败不自动重试，也不能据此认定远端尚未执行；此路径尚未实际踢人验收。

`group.leave()`遵循Desktop的两步业务链：从已有本地会话捕获indexV1边界 → 652退群 →
603清理远端会话 → 按原边界本地软删除。地址使用已保存的shortId/type/inbox；
缺本地会话或关闭SQLite/JSON时，在任何请求前拒绝。652失败不继续；652成功而603失败时
记录“已退群、清理失败/未确认”，仍按边界处理本地数据，不自动重试任何一步。
该动作成功仅排会话update，已删除的会话不会被伪造为一个空update；不会发delete事件或
强制写isParticipant=false。退出/重登后的旧回包不能继续请求或修改新登录。
未知本地编程错误与本地落库失败会抛出，不冒充平台拒绝；远端已执行的退群不会因此撤销。
目前为源码核对及离线测试，真实退群/两端显示尚未验收。

系统提示型`notice.group.member-decrease`仍提供已解析的成员及操作者投影，
但本人离群提示不再清空群会话、其他成员和历史。它与原生50001/7的UID集合通知不同，
后者已有608刷新与UID集合移除回调`notice.conversation.members-remove`；
受配置控制的2001读索引旁路仍未接通，不以在线或WS就绪替代pull-ready条件。

```typescript
import type { Group } from 'douyin-im';

export async function createNamedGroup(account: Group['account'], uid: string) {
  return account.createGroup([uid], {
    name: '测试群',
    avatarUrl: 'https://example.com/group.webp',
    description: '由机器人创建',
  });
}
```

成员包含 `displayName`、`nickname`、`alias`、`secUid`、`role`、`roleName` 等字段。
`getMemberList()` 优先完整本地快照；`getMemberList(true)` 拉取完整分页。
创建群成功后会立即缓存到 `gl`；名称、头像与描述必须随创建请求一次提交。
Desktop 1.2.1 没有桥接设管、群名片写入、解散或创建后的群资料编辑，因此稳定 SDK 不公开这些动作。

## 邀请与审核

`group.inviteMembers()` 是主动邀请；成功只代表邀请动作成功，不会提前把目标人写入成员缓存。
`group.getJoinRequests()` 返回已有入群申请，实时变化对应 `request.group.join`。
cmd508 好友申请信号对应只读的 `notice.friend.add-request`。Desktop 1.2.1 没有好友申请列表和审核的
实际调用入口，因此它不是可 `approve/reject` 的 `RequestEvent`。

```typescript
import type { GroupJoinRequest } from 'douyin-im';

export async function reviewJoinRequest(request: GroupJoinRequest, approved: boolean) {
  if (!request.isPending) throw new Error('申请已处理');
  const result = approved ? await request.approve() : await request.reject();
  if (result.statusCode !== 0) throw new Error('审核未成功');
  return result;
}
```

同一申请的相同并发决策共用一个 Promise，相反决策会被拒绝；成功处理后不能再次审核。
错误响应不自动标记成功，网络异常也不自动重试；异常可能意味着结果未知，重试写操作前先查询确认。
这只是进程内保护，不提供跨进程幂等保证。审核成功会更新申请状态，群审核通过还会补入该申请人的成员资料。
后续实际成员变动通知仍是独立事件，审核调用不会伪造一条成员增加通知。

## 消息、通知与已读

私聊事件按当前会话的 `isInStrangerBox` 状态分类，状态缺失时参考所属账号的联系人缓存。
`inboxType=1` 是 Desktop 普通聊天也使用的协议收件箱，不能据此判定陌生人。
收发日志使用 `名称(ID)`：用户优先备注、其次昵称，群使用群名。

| 频道 | 内容与边界 |
|---|---|
| `message.private / message.group / message.stranger` | 对应具体 MessageEvent，包含 friend / group、member / stranger |
| `request.group.join` | 可审核的入群申请实例 |
| `notice.friend.add-request` | 好友申请信号；只读，不提供审核动作 |
| `notice.friend.increase / notice.friend.decrease` | 好友关系变化 |
| `notice.group.member-increase / notice.group.member-decrease` | 成员加入、离开或移除；含 member、operator、source |
| `notice.group.invite` | 邀请导致成员已经加入的通知，不是待确认邀请请求 |
| `notice.group.admin / name-change / avatar-change` | 完整频道都有 `notice.group.` 前缀；handler 前更新角色或群资料 |
| `notice.friend.marked-read / notice.group.marked-read` | 会话读游标同步；带 `readerUid` 的50013事件是该用户普通读游标更新，不是隐私过滤后的逐消息已读摘要 |
| `notice.conversation.read-summary` | 原始摘要变更批次，`summaries` 包含变化的会话摘要；Account/Client共用事件实例，仅走notice总频道和本频道，不走单会话父频道 |
| `notice.conversation.update / notice.conversation.delete` | 已接入的本地会话更新和删除通知；update 的 `conversation` 是派发时本地快照，可能缺失，不隐式联网刷新；不是所有设置增量均已处理 |
| `notice.conversation.min-index` | 被动DeleteConv的独立索引通知，`minIndex`为无损十进制字符串；不是已读游标，不保证会话仍存在，也不触发物理清库 |
| `notice.conversation.members-remove` | 原生command7/event28的UID列表通知，`memberUids`为只读字符串数组；先移除对应成员缓存和读游标，不提供operator/reason，不等同于系统提示型member-decrease |
| `notice.message.recall` | 消息撤回 |
| `notice.message.update` | 普通入站消息合并后的快照更新，对应 Desktop 的独立 upsert；包含 `message`，不等于新消息、没有 reply 动作 |
| `notice.message.delete` | Desktop 删除命令命中本地目标后的原消息快照；含 `message`、`clientMessageId`，不是撤回，也不是未知目标占位通知 |
| `notice.message.batch-update` | 当前接入主动/被动撤回及断线补拉普通消息、消息/会话删除命令、command4设置命令和50005参与状态；`updates` 每组含 `conversation`、`messages` 快照，仅会话更新时 `messages` 可为空；`deletedClientMessageIds` 是客户端消息 ID 列表，不属于单会话事件 |
| `notice.message.list-update` | Desktop enum18 的平铺消息更新；当前由 `account.batchModifyMessageLocalExt([{ conversationId, clientMessageId, ext }])` 触发。`messages` 保留顺序和重复目标，读取全部补丁后的最终状态，不要求会话存在；不是会话分组事件，不进入 `notice.conversation`。native 可见性全部过滤时不派发，正文 mapper 全部过滤时可派发空数组 |
| `notice.im.command` | 未形成稳定业务模型的协议命令 |

桌面端邀请成员是主动加人，完成后收到 `notice.group.invite`，不是一条等待当前账号批准的
`request.group.invite`。当前协议没有已验证的消息表态推送，也没有独立的取消管理员系统消息；
SDK 因而只提供主动 `reactMsg()` 和设管通知，不发布无法产生的事件频道。

`message`、`notice`、`request` 为汇总频道；部分通知还有 `notice.group`、`notice.message` 等父频道。
它们和叶子频道得到同一个对象，监听多个相关频道时避免重复回复或审核。
成员离群时先从 memberList 移除再触发 handler，当前账号离群也会从 gl 移除群；
事件仍保留离群前的实例供识别上下文。

对当前收到的消息调用 `event.markRead()`；多条消息使用 `account.markMessagesRead(events)`，
要求事件属于同一账号，底层逐条复用 Desktop 的 markRead 调用，并返回原事件对象组成的
`succeeded` / `failed`。`contact.getReadState()` 通过2000/2001读取两种原始索引，成功后更新账号本地库；
50013推送同样先更新库再派发marked-read通知，其中 `readMessageIndexV2` 保持缺失，不能与普通索引混用。
`contact.getCachedReadSummary()` 已结合本地实际成员、读游标、最小索引和消息可见性生成原始摘要；
选择按普通 order_index/create_time，而不是 v2 索引。摘要受缓存窗口和同步完整性限制，不用群人数补出读者。
原始摘要的 `readUsers/isAllRead` 未过滤隐私；另用 `await contact.getReadReceipt()` 获取隐私合成结果及完整策略状态。
此方法不修改原始摘要或派发原始摘要事件，不隐式补拉成员/历史/读游标，也不判断所有UI位置条件。
显式游标查询成功和50013推进已触发 `notice.conversation.read-summary`，自动刷新仍待接入；
该同步 getter 不更新事件去重缓存，消息 createTime 非安全整数时明确报错。
单纯收到 marked-read 通知或上报已读返回成功，不能推导出对端可展示的已读状态。

## IM 卡片与共享内容

作品/图集分享对应 `event.work`，评论分享还可带 `event.comment`。实例保留来源会话，
与主站作品管理无关。

```typescript
import { getLogger, type MessageEvent } from 'douyin-im';

const logger = getLogger('SharedContent');

export async function inspectSharedContent(event: MessageEvent) {
  if (event.work) {
    const access = await event.work.getAccess();
    logger.info('share=%s download=%s media=%o', access.canShare, access.canDownload, access.media);
  }
  if (event.comment) logger.info('comment=%o', await event.comment.getStatus());
}
```

还有 `work.getDetail()`、`contact.getSharedWorkDetails(ids)`、`getSharedCommentStatuses(ids)`，
批量查询按 50 条拆分。SDK 不替调用方自动下载、决定文件名或落盘目录。

这些入口只读取聊天卡片携带或 Desktop IM 补全接口返回的信息，不提供账号级作品、粉丝、用户或主站查询门面。

## 错误与排查

- `sendMsg/reply/quote/forwardTo` 在服务端未确认投递时抛出 SendMessageError；检查 `statusCode`、`checkCode` 和 `response`，不要只看 `statusMsg="OK"`。
- 会话、群管和审核动作通常返回状态响应，业务失败不一定抛错；邀请另有 `succeededUids / failedUids`，移除只返回请求状态，不提供逐个成员确认。
- SDK 不额外施加本地发送频率限制。发送超时可能代表结果未知，避免直接自动重发。
- JSON 解析、验证页或 HTTP 错误可能抛出 DouyinResponseError；字段包含 `kind/status/endpoint/logId`。正常 JSON 仍需检查业务状态。
- 异步 handler 的 rejection 进入 `system.handler.error`；同步异常遵循 EventEmitter 行为，业务代码应自己处理。

二维码无后续时，确认 handler 调用了 continueLogin 并处理 MFA/短信事件；联系人找不到时先调用对应 get*List；
发送失败时保留状态码和脱敏回执。不要仅根据客户端接口返回成功判断接收端效果。

## Demo 配置与验证

运行 [demo.ts](../demo.ts) 可设置 `DATA_DIR`、`PLATFORM_UID`、`MOBILE`、`PASSWORD`；
`LOG_LEVEL` 接受 `debug / info / warn / error / silent`；
`DEBUG_RAW=1` 输出原始消息摘要并自动将 demo 日志级别提升到 debug，日志分享前仍应检查脱敏结果。

SDK 固定使用 Desktop Frontier WebSocket 接收事件、Desktop Cookie HTTP 发送命令，不提供传输模式开关。

离线测试、协议源码核对、真实发送和目标端渲染分别验收；不因某个类已导出就宣称协议能力可用。
