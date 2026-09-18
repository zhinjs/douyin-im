# Douyin IM

抖音 TypeScript SDK，提供多账号登录、私信/群聊、媒体消息、群管理和事件处理。日常 IM 使用 Node.js HTTP/WebSocket，不依赖浏览器自动化；仅在平台要求安全验证时按需打开一次性本地验证页。

## 能力范围

- 登录与账号：二维码、短信、密码登录；滑块、主/辅助手机号短信、手机扫码与 Push 等服务端二次验证；Session 持久化，多账号隔离。
- 聊天：文本、群聊 @、会话历史、图片、视频、表情、引用、撤回、转发、已读和消息表态。
- 联系人：好友、陌生人、群及群成员实例；完整好友名册、列表查询、缓存选择和资料刷新。
- 群管理：创建（可带名称、头像与描述）、邀请、入群申请审核、成员移除与退群。
- 事件：消息、好友申请、入群申请、成员变化、会话同步等。
- 内容：聊天中的作品、图集、评论、链接、用户与文件卡片。

本包只覆盖抖音聊天 Desktop IM；聊天卡片和消息转发不等于作品管理或主站互动。

“已实现”表示存在代码与对应测试，不代表每个接口都完成了真实账号验收。平台权限、风控、登录方式和协议变更仍可能影响结果；服务端成功回执也不等于接收端已渲染或已读。
尤其是短信/密码及各类二次验证分支，需要在安全测试账号上分别验收；项目不会把离线 fixture
或官方源码中的调用点写成真实账号成功结论。

默认登录仍使用旧 Jumpbyte 签名分支和兼容 browserInfo 模板；已迁移的 Desktop BDMS/Web Secure
模块尚未接入纯 Node 默认登录链。不能将底层算法测试通过理解为完整 Desktop 登录已对齐。
动态证书、Session 绑定和 follow 还需隔离新登录及关系读回的真实验收。

## 从源码运行

需要 Node.js 22.5+，项目为 ESM，并使用 Node 内置的 `node:sqlite` 保存本地 IM 状态。以下命令在仓库目录执行，不依赖包已发布到 npm：

```bash
pnpm install
pnpm build
pnpm demo
```

[demo.ts](demo.ts) 是完整交互示例：恢复 Session → 展示二维码或输入验证信息 → 接收事件 → handler 处理 → 退出。
在终端输入 `/help` 查看主动操作；从另一个账号发送 `/ping`、`/echo 文本`、`/quote 文本` 测试被动回复。
该示例也包含邀请、移除和退群等管理命令，请在测试会话运行；对外部署前应自行限制命令执行权限。

## 最小 Bot

以下 TypeScript 示例使用当前包的公开入口。二维码保存为当前目录的 `login.png`，请打开图片后用抖音扫码。
它只响应 `/ping`，不会启动后主动群发或自动审批申请。

```typescript
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { configureLogger, createClient, getLogger } from 'douyin-im';

const terminal = createInterface({ input: stdin, output: stdout });
configureLogger({ level: process.env.LOG_LEVEL ?? 'info', color: stdout.isTTY });
const logger = getLogger('Bot');
const client = createClient({ dataDir: './data' });

client.on('system.login.qrcode', async ({ account, qrcodeBase64 }) => {
  await writeFile('login.png', Buffer.from(qrcodeBase64, 'base64'), { mode: 0o600 });
  account.logger.info('二维码已保存到 login.png，请扫码并在手机端确认');
  await account.continueLogin();
});
client.on('system.login.sms', async ({ account }) => {
  await account.continueLoginWithSms((await terminal.question('登录短信验证码：')).trim());
});
client.on('system.login.voice', async ({ account }) => {
  await account.continueLoginWithSms((await terminal.question('语音验证码：')).trim());
});
client.on('system.login.verification', async ({ account, verification }) => {
  account.logger.warn('需要登录验证：%s', verification.methods.join(', '));
  await verification.open(); // 打开本地页面并承载抖音官方验证组件
});
client.on('system.online', ({ account }) => account.logger.success('Welcome, %s !', account.nickname));
client.on('message', async (event) => {
  if (event.text.trim() === '/ping') await event.reply('pong');
});
client.on('request', (request) => {
  request.account.logger.info('收到待审核申请 %s', request.type); // 根据自己的审核规则决定是否 approve/reject
});
client.on('system.login.error', ({ account, error }) => account.logger.error(error, '登录失败'));
client.on('system.handler.error', ({ account, event, error }) => account.logger.error(error, '处理失败 %s', event));

async function stop(code: number): Promise<void> {
  try {
    await client.logout();
  } catch (error) {
    logger.error(error, '退出失败');
    code = 1;
  } finally {
    terminal.close();
    process.exitCode = code;
  }
}
process.once('SIGINT', () => { void stop(0); });
process.once('SIGTERM', () => { void stop(0); });
terminal.once('SIGINT', () => { void stop(0); });

try {
  await client.login();
} catch (error) {
  logger.error(error);
  await stop(1);
}
```

默认自动注册 `data/accounts` 下已保存的账号；没有账号时，`client.login()` 会创建一个扫码账号。
多账号按注册顺序登录，`login()` 在完成验证、真正上线后才结束。`system.login.verification`
把当前验证与触发它的原请求绑定；调用 `verification.open()` 后，SDK 会承载抖音下发的官方验证组件，
覆盖滑块、主/辅助手机号短信、手机扫码和 Push 等服务端可用方式，并在完成后恢复原请求。SDK 不绕过验证。

每次登录上线后，SDK 自动并行加载好友、群列表，并同步陌生人会话后更新 `sl`，最后打印联系人数量。
`system.online` 表示连接就绪，联系人仍可能正在加载；单项失败单独记录，不使账号掉线，也不将失败计为 0。
WS 重连不会重复全量加载。陌生人数是当前本地已同步的联系人数量，不代表服务端全部历史会话。

上线后有一次 Passport `boot` 续期；后续由显式活动驱动，空闲时暂停，不是永久定时保活。
宿主收到真实用户操作时调用 `account.markActive()`，不要把被动收消息或定时器当作用户活动。
续期也可能触发 `system.login.verification`（operation=`token-beat`），上线后请保留该监听器。
详见[活动续期与生命周期](docs/guide.md)；调度和验证续接已离线测试，真实新票据签发仍待验收。

首次登录也可以在 `client.login()` 前显式注册账号。手机号只放在 `login` 中，`accountId` 只用于恢复
已保存账号，二者不会互相猜测：

```typescript
client.createAccount({ login: { method: 'qr' } });
client.createAccount({ login: { method: 'sms', mobile: '13800138000' } });
client.createAccount({
  login: { method: 'password', mobile: '13800138000', password: process.env.DOUYIN_PASSWORD! },
});
```

密码登录收到 `system.login.sms-required` 时调用 `account.requestLoginSmsCode()`；同一手机号绑定多个
账号时，按 `system.login.accounts` 的候选项调用 `continueLoginWithSubAccount({ secUid })`。普通短信收不到时
可调用 `account.requestLoginVoiceCode()`，随后从 `system.login.voice` 取得输入时机并继续提交验证码。
SDK 登录入口固定为扫码、短信或密码，不支持导入浏览器 Cookie。

## 日志

项目使用 `@zhin.js/logger`，但日志语义沿用 oicq 的习惯：运行日志以账号为主语，
消息使用 `recv from` / `succeed to send` / `failed to send` 的单行摘要，登录和通知使用
可直接阅读的事件描述；thread、cursor、status、传输通道等协议字段只在 `debug` 中出现。
账号实例公开 `account.logger`，其类别为 `Douyin:<uid>`；与账号无关的应用日志仍使用
`DouyinIM:*` 命名空间。SDK 默认 `silent`，不会替宿主应用修改全局日志状态；应用入口可显式启用：

```typescript
import { configureLogger, getLogger, setLogLevel } from 'douyin-im';

configureLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  color: process.stdout.isTTY,
  maskSensitive: true,
});

const logger = getLogger('MyBot'); // DouyinIM:MyBot
logger.info('正在启动');
logger.success('已上线');
logger.warn('连接正在重试');
logger.error(new Error('示例错误'), '任务失败');

setLogLevel('debug'); // 同步修改已经创建的所有 douyin-im 子 Logger
```

典型输出如下；多账号运行时只看类别即可确认日志归属，不需要在正文反复输出 `account=`：

```text
[12:30:01.123][INFO] [Douyin:1150530166719210] Welcome, 归雨(1150530166719210) ! 正在加载资源…
[12:30:02.345][INFO] [Douyin:1150530166719210] 加载了 10 个好友，3 个群，0 个陌生人
[12:30:08.456][INFO] [Douyin:1150530166719210] recv from: [Group: 代理人研究(7423010390826582565), Member: 张嘻嘻(3138463854771706)] "/ping"
[12:30:08.789][INFO] [Douyin:1150530166719210] succeed to send: [Group: 代理人研究(7423010390826582565)] pong
```

`LOG_LEVEL=debug pnpm demo` 可查看协议收发摘要；默认 demo 使用 `info`。
自定义文件或流输出时，可通过 `configureLogger({ transports })` 注入
`@zhin.js/logger` 的 transport。默认控制台 transport 会对常见 token、password、key 字段脱敏。

## 调用方式

表情资源与收藏：`account.getEmojiResources()` 返回资源包地址/MD5（不是表情数组），
`account.collectEmoji(options)` 收藏已有平台表情；`account.getCollectedEmojis()` 查询首页，
传入 `{ cursor }` 继续下一页，`getCachedCollectedEmojis()` 读取当前账号的内存快照。
这些调用已按 Desktop 源码接入并做离线对照，尚未真实账号验收；
收藏项可以通过 `contact.sendMsg(segment.sticker(item))` 发送；群聊需当前账号的收藏表情开关允许。
文本、引用和大表情还检查已加载的会话风险设置；命中时发送前拒绝，不自动重试或解除风险。
资源包下载、取消收藏和上传自定义表情仍未实现。demo 可用 `/emojis [cursor]` 查询，
再显式输入 `/sticker <friend|group|stranger> <id> <表情ID>` 发送已加载的收藏项。
输入与失败处理见[表情资源与收藏](docs/guide.md#表情资源与收藏)。

被动操作使用事件所属账号；主动操作先选账号，再选联系人：

```typescript
import type { Client } from 'douyin-im';

export async function sendToFriend(client: Client, accountId: string, friendUid: string) {
  const account = client.pickAccount(accountId);
  await account.getFriendList();
  const friend = account.pickFriend(friendUid);
  if (!friend) throw new Error('好友会话未找到');
  return friend.sendMsg('你好');
}
```

`getFriendList()` 使用抖音聊天联系人页实际调用的 `/aweme/v1/web/familiar/list/`，不再把“有私聊历史的会话”误当成完整好友列表。
SDK 按 Desktop 的每页 100 条参数自动翻完好友分页，并保留昵称、备注、签名和密友标记；群列表需要网络刷新时会翻完 cmd203 同步游标，再按 Desktop 的
会话类型规则筛出群聊。两者都在完整查询成功后才原子替换账号缓存。
昵称与备注分别保存在 `nickname`、`remark`，显示名可用 `friend.remark || friend.nickname`。
刷新保留明确的空备注、空签名和 `closeFriend=false`；缺失字段不会清掉已知值。
尚未聊过的好友也会返回 `Friend`；第一次执行 `sendMsg()`、`getHistory()` 等会话动作时才创建 P2P
会话，不会在读取列表时产生写操作。用户关系和会话彼此独立：
`setBlocked()` 拉黑/解除，`setRemark()` 修改备注，`deleteConversation()` 仅删除会话。
`setBlocked()` 返回操作响应后异步刷新资料；`blocked`、`followStatus` 以资料回读为准，不保证此时已更新。
Desktop 1.2.1 没有实际调用“删除好友”的证据，稳定 SDK 不公开该动作。
`Friend/Stranger/Member.setFollowed(true|false)` 和 demo 的消息命令 `/follow` 已恢复实现，
但**尚未完成真实关注验收**：BDTicket 核心通过原生离线差分，真实证书获取已验证；
登录响应绑定、账号持久化和重启恢复通过离线测试。请求优先使用匹配绑定的 `sessionid`，否则按 Desktop 选择 `sessionid_ss`；
当前策略保护 follow 时，两者至少一个必须匹配已有票据，否则明确要求新登录，不会伪造票据。
有签名头不代表绑定有效；仅收到 `sessionid_ss` 的 Set-Cookie 也不会发行新绑定。
匹配 Session 的响应若给出空/缺失票据签名，会替换旧缓存；重启恢复后仍视为未就绪，不继续使用旧签名。
关注的非 2xx 响应直接报 HTTP 失败，即使附带验证头也不会进入验证续接或自动重发。
服务端挑战通过 `system.action.verification` 交给业务验证对象；
认证状态落盘失败会阻止后续账号请求，保存恢复后可继续；不会自动重发此前已发出的动作。
若错误发生在收到响应之后，不能据此认定动作未执行，应先读回状态，避免盲目重试。
证书响应按Desktop顺序分字段更新；畸形证书头不会遮掉业务正文，合法Cookie/票据仍需保存。
恢复时已有服务端证书和序列号会直接复用，不因客户端证书缺失再次取证；当前加载失败不自动重试登录或关注。
恢复探针先检查 Passport 账户信息，再查询自资料确认抖音 UID；账户检查成功不代表票据已绑定。
Cookie/票据更新只在 UID 匹配后提交；取消、身份不匹配或校验失败保留原凭据，迟到结果不会覆盖它。
退出或取消登录后，在途 HTTP 响应不再更新账号 Cookie/票据；已收到的业务结果仍返回原调用方，不自动重发。
退出保留身份和凭据；后台设备证书可以完成，但不会借失效回调保存离线账号或已取消的 pending。
有效响应会保存 Cookie 的轮换/删除；Cookie `msToken` 不再作为登录签名 token，历史 Session 的同名副本也不再注入签名。
底层显式 `msToken` 配置仅是当前连接的内存签名覆盖值，不写入 Cookie 或 Session；默认 BDMS `xmst` 上下文仍未接通。
迟到二维码不会替换新登录的二维码。
取证在后台进行，不阻塞首个请求；缺服务端证书时使用 REE ECDSA，证书到达并保存后切换 HMAC。
对称签名开启且尚无序列号时，get-ticket 请求发送 `server-cert-sn: 0`。调用方取消只终止自己的请求，不终止共用取证。
签名开关和路径来自匹配设备的应用配置缓存启动快照；无缓存使用Desktop默认值，运行中刷新不热切换当前连接。
Session签名与Passport取票是独立规则；配置关闭签名不会伪造票据，也不会把服务端拒绝当成功。
demo 已注册处理器打开验证页，验证码/身份验证成功后才重发原动作，取消、退出或网络异常不会重发。
该续接已通过离线回归；XHR 代理另通过真实 Chromium 的 6 项隔离测试（本地模拟后端），尚待抖音真实挑战验收。
返回 `followStatus=4` 是等待批准的关注申请，只有 1/2 表示已关注/互关。
同账号、同 UID 的 Friend/Stranger/Member 共享已确认的 `followStatus`、`followerStatus`，并随 SQLite/JSON 状态恢复；
关注成功不会自动把用户加入好友列表。`contact.getProfile()` 可通过 Desktop 用户资料接口读回关系，
它要求已有 `secUid`，不创建会话；本轮只做了协议和缓存离线验证。
`followerStatus` 是反方向：`1` 表示对方关注当前账号，`0` 表示未关注，`undefined` 表示未知。
只有资料明确返回 0/1 才更新；自己的关注、取消关注或收到新朋友计数不会推导该值。
例如 `await friend.getProfile()` 后，可读取 `friend.followerStatus`；同 UID 的群成员视图同步可见。
这些能力目前只完成了离线回归，尚未完成真实账号验收。

```ts
client.on('system.action.verification', async ({ verification }) => {
  await verification.open(); // 使用所属账号完成原操作的验证，不重新登录
});
```

入群审核未读属于账号，不属于某个群：

```ts
const unread = await account.getGroupJoinRequestUnread();
if (unread.statusCode === 0) console.log(unread.unreadCount, unread.lastRequest); // int64 计数为字符串
// 按业务需要显式清除；不会同意或拒绝申请，也不会自动重试失败动作。
await account.clearGroupJoinRequestUnread();
```

这两个入口已按 Desktop native 的 cmd2028/2029 和空请求体实现，尚待真实账号读回验收。
审核通过也不会直接把申请人写入成员缓存，以成员列表或实际入群事件为准。

聊天页顶部推荐联系人可单次查询（也可在demo中输入 `/recommendations`）：

```ts
const recommended = await account.getRecommendedContacts();
if (recommended.statusCode !== 0) throw new Error(`查询失败: ${recommended.statusCode} ${recommended.statusMsg}`);
console.log(recommended.contacts); // name?、avatar?、secUid?、conversationId?、lastActiveTime?
```

这是推荐资料快照，不是好友名单；不保证含数字UID，也不根据conversationId推断群类型。
保留返回顺序与重复项，不自动关注、创建会话、补资料或更新关系/活动缓存。
字段缺失不补造值，活动时间不直接转换成在线状态；无分页、后台刷新或自动重试。
已与Desktop原请求和映射离线对照，尚未真实账号验收。

新关注通知计数可独立查询（Desktop“新朋友”通知组401，不是粉丝总数）：

```ts
const result = await account.getNewFollowerCount();
if (result.statusCode !== 0) throw new Error(`查询失败: ${result.statusCode} ${result.statusMsg}`);
if (result.count !== undefined) console.log('新关注通知：', result.count);
```

只有服务端明确返回该组时才有 `count`，未返回不代表0。该接口不会展开通知列表、标记已读、
更新好友关系或自动轮询。已完成源码对照和离线测试，尚未真实账号验收。

需要展开新朋友列表时，显式调用读取动作（会请求服务端标记通知已读）：

```ts
const result = await account.readFollowerNotices();
if (result.statusCode !== 0) throw new Error(`读取失败: ${result.statusCode} ${result.statusMsg}`);
console.log(result.notices); // uid、secUid、nickname、remark?、avatar?、hasRead? 等
console.log(result.truncated); // 服务端仍有更多，但已达到 Desktop 本次读取阈值
```

按 Desktop 每页20条，累计原始条数超过120或没有更多时停止；不是硬截断120条。
相同UID保留第一次出现的资料，不更新好友缓存，不强行把返回的 `hasRead` 改成已读。
失败或退出登录不会自动重试，但已经发出的请求可能已产生已读效果；不会返回部分列表冒充完整成功。
此能力已完成源码对照及离线测试，尚未真实账号验收。

添加朋友页的远端用户搜索与本地 `searchConversations()` 分开：

```ts
const page = await account.searchUsers('昵称或抖音号'); // 固定每页30条，首次cursor=0
if (page.statusCode !== 0) throw new Error(`搜索失败: ${page.statusCode} ${page.statusMsg}`);
console.log(page.users); // uid、secUid、nickname、uniqueId?、avatarThumb? 等资料
if (page.nextCursor !== undefined) {
  const next = await account.searchUsers(page.keyword, page.nextCursor);
  console.log(next.users);
}
```

`uniqueId` 是展示用抖音号，不替代 UID/secUid。搜索只返回当前页资料，不自动关注、创建会话、
写入好友/资料缓存或派发通知。它按 Desktop 的实际调用使用 www 域名，不是恢复主站 creator 能力；
已完成原码与构建SDK的离线对照，尚待真实账号验收。

业务活动状态可按 secUid 和会话 ID 显式查询：

```ts
const active = await account.getActiveStatus(['用户的secUid'], ['会话ID']);
if (active.statusCode !== 0) throw new Error(`查询失败: ${active.statusCode} ${active.statusMsg}`);
console.log(active.users, active.conversations);
```

用户结果包含 `secUid/lastActiveTime?`（服务端秒级时间），会话结果包含 `conversationId/online?/toast?`。
缺失数据不代表离线，群的 `online` 不代表在线人数；接口不计算用户在线布尔值、不更新缓存、
不自动轮询或上报账号前台活动。这不是WS保活。已做离线源码对照，尚未真实账号验收。

`account.getUserSettings()` 读取 Desktop 用户设置，`account.getReadReceiptPrivacy()` 查询当前账号的已读展示开关。
两者已用机器人现有 Session 只读验收；返回 `enableReadState` 是 Desktop 对当前返回值的显示判断，
不是逐消息已读名单，也不会修改隐私、标记已读或过滤原始 `notice.*.marked-read` 事件。
`account.getMessageReadPrivacy(queries)` 优先复用账号内的消息策略缓存，缺失项自动按 50 条分批查询；
传第二个参数 `true` 可强制联网刷新。事件中可直接 `await event.getReadPrivacy()` 或
`await event.getReadPrivacy(true)`，它使用原始协议时间而不是秒级 `event.time`。
消息 ID/会话 shortId 保留字符串，`createTime` 必须传原始协议值，不能猜测换算。
这条查询已在专用测试群的一条已有消息上只读验收；on/off 是过滤规则，空列表不表示全群已读。
策略通过账号本地 SQLite/JSON 持久化，重启后使用缓存前重新查询当前账号展示开关；
删除消息/会话会清理对应策略，退出或删除期间迟到的查询不会重新写回。
`localState: false` 时仅保留本次运行的内存策略。缓存行为经过离线测试，尚未做跨真实会话的展示验收。
原始读者摘要已支持本地计算及变更通知；隐私合成已有显式API，完整展示条件和自动刷新仍在对齐中。
SDK 当前只在显式调用时查询，不自动建立轮询；消息策略查询按 Desktop 最多重试 5 次传输失败，业务拒绝不重试。

`friend/group/stranger.getReadState()` 读取会话原始 `readIndexes` 和 `minIndexes`，
对应 Desktop cmd2000/2001，索引和 UID 均为字符串，协议未提供的字段保持 `undefined`。
它只读现有会话，不会创建私聊、标记已读或修改隐私；任一查询失败时不返回混合的部分快照。
两个查询并非原子快照，也不是最终可展示的读者名单：还需要成员状态、消息可见性和隐私过滤。
专用测试群两位成员的这两个查询已真实只读通过，其他会话类型尚待实测。
协议层另有 `getBatchConversationReadIndexes`（cmd2038）；成功响应缺少的会话通过
`missingConversationIds` 明确返回，不能把缺失项当作空读者列表。本次测试群批量查询即为这种结果。

成功的 `getReadState()` 会合并到账号 SQLite/JSON 的读游标库，
`contact.getCachedReadState()` 可只读取得本地 `{ uid, readIndex, minIndex }`；`localState: false` 时仅保存在内存。
本地列按 native 使用普通 index 和独立2001最小索引，缺省列为0；协议查询结果仍保留字段缺失信息。
50013 推送会先更新游标，再派发 `notice.friend.marked-read` / `notice.group.marked-read`，
其中 `readerUid` 来自 `P2PSender`，没有 `readMessageIndexV2`。自身、重复或倒退推送不会再次派发。
此事件仍是原始读游标，不表示隐私允许展示，也不表示“全群已读”。
退出、删除、已确认的成员移除或新推送会使在途旧查询取消；成员和会话清理同时清理对应游标。
这些保护与持久化已通过离线测试，真实50013接收和最终摘要展示尚待验收。

`group.inviteMembers(uids)`按Desktop cmd650使用绑定地址、固定inbox=1；响应名单只包含明确返回的UID，
未列出的目标不推算成功。`details`保留普通/secUid名单及原始status、checkCode、checkMessage等字段，
顶层`succeededUids / failedUids`是便捷投影，不是成员缓存确认。不会自动发邀请卡、建私聊或更新成员。

`group.removeMembers(uids)`按Desktop cmd651返回请求级`ImActionResponse`，不推算成功/失败UID名单。
外层状态0不证明各成员已移除；缓存只随实际成员通知或列表更新，不随本次响应直接删除，
也不自动发起成员刷新。该动作使用本地已有群会话地址，退出/重登后的旧响应不能修改新登录状态。
当前仅源码核对与离线验证，未实际踢人验收。

`contact.getCachedReadSummary()` 同步返回当前账号在该会话最后一条符合 native 条件的自发消息的原始摘要：
消息身份、原始 `createTime` 字符串、`readUsers`（`uid/secUid/readIndex/minIndex`）和 `isAllRead`。
选择按普通 `order_index/create_time`，读者由实际成员与读游标关联，结合最小索引和消息可见性计算；
不使用群人数或 v2 索引推测读者。没有符合条件的消息、未登录或关闭本地库时返回 `undefined`。
它不联网、不标记已读、不改变事件去重缓存，也尚未应用上述展示隐私策略。
结果受本地消息保留窗口和成员/游标同步程度限制，`isAllRead` 只描述本地参与计算的记录，不能当作完整在线名单。
当前消息模型的 `createTime` 是 number；不安全整数会明确报错，不返回已丢精度的摘要。此功能尚未真实展示验收。

`await contact.getReadReceipt()` 将本地最后自发摘要与消息隐私策略合成，返回 `{ raw, privacy, readUsers, isAllRead }`；
无本地摘要时返回 `undefined`。`raw` 保留未过滤数据，`privacy` 保留查询状态、账号开关及逐消息策略。
开关关闭/未知或查询失败时隐藏读者；有效策略优先 on 白名单，再用 off 排除，策略缺失或有错误不显示读者。
返回的读者是独立副本，不会修改 `raw`。消息策略默认复用缓存，`getReadReceipt(true)` 强制刷新策略；
它不补拉历史、成员或读游标，不创建会话、不标记已读。需要刷新原始游标时应显式调用 `getReadState()`。
未登录、网络异常、查询期间连接或摘要改变会报错；隐私业务错误保留在 `privacy.statusCode`，不是“无人已读”的证明。
这不是Desktop消息气泡的完整显示判定：消息位置、发送状态、仅看一次消息等UI条件另算，也未自动触发隐私查询。
Demo 可用 `/read-receipt <friend|group|stranger> <id> [refresh]` 检查；本地记录完整性及真实展示仍需验收。

`notice.conversation.read-summary` 提供 `event.summaries` 数组，一次可以包含多个会话，仍是隐私过滤前的原始摘要。
目前显式 `getReadState()` 成功保存，以及其他用户50013游标推进后，会重新计算；字段不变不重复通知，
仅读者数组顺序不同不算变化。所有变化先写入独立的运行期通知缓存，再派发一个批次；getter 不写此缓存。
没有最后自发消息时跳过，不发空摘要，也不因此清掉旧通知记录；退出账号清空通知缓存。
Account 和 Client 均可监听；批次没有单个 conversationId，因此不走要求单会话的 `notice.conversation` 父频道，
仍走 `notice` 总频道。原生 pull-finish/batch调度、成员变化后的网络刷新和进入会话轮询尚未接入。

默认每个账号使用 `data/accounts/<uid>/im-state.sqlite`。`getGroupList()` 和
`group.getMemberList()` 优先完整本地快照，传入 `true` 可强制联网刷新；
`contact.getCachedHistory()` 只读本地消息，`getHistory()` 查询网络并把成功结果并入本地库。
`contact.getCachedMessage(serverMessageId)` 和 `getCachedMessageByClientId(clientMessageId)`
在当前账号、当前会话的整个缓存窗口内查找单条消息；同步返回副本或 `undefined`，不联网、不创建会话。
clientId 使用与入站合并相同的 ASCII 大小写正规化。关闭本地库或缓存已淘汰时未命中，不表示远端消息不存在。

`contact.modifyMessageLocalExt(clientMessageId, ext)` 按键合并本地字符串字段，支持 Friend/Group/Stranger；
同步保存后按展示条件触发 `notice.message.update`。它不发消息、不标已读、不更新远端字段，空字符串不是删除键。
需要账号在线且启用本地库；单条要求已有会话和消息，批量跳过缺失消息。批量可跨当前账号的会话：

```ts
account.batchModifyMessageLocalExt([
  { conversationId: group.threadId, clientMessageId: '本地客户端消息ID', ext: { 'app:handled': '1' } },
]);
account.on('notice.message.list-update', event => {
  // 平铺消息列表，保留输入顺序和重复目标；不是下面的会话分组 batch-update。
  console.log(event.messages);
});
```

批量先逐项保存，再读取最终消息状态并发一次列表更新通知，不触发普通 `message` handler。
不是跨行事务：后续写入失败会抛错，之前成功的行仍保留；可以读回确认，不自动重试。
仅修改消息库，不强制重选会话摘要；没有增加文件下载或转写动作。

`contact.deleteLocalMsg(id)` 只做本地软删除，返回是否隐藏了一条记录；不会请求服务端。
删除操作的 `id` 可为 serverId 字符串或 `{ clientMessageId }`，后者也支持尚无 serverId 的本地消息。
两种删除都要求本地会话和可按 clientId 找到的消息；缺失时先显式刷新会话、拉取历史，不会隐式创建会话。
`deleteMsg(id)` 对有 serverId 的目标走统一 cmd701（含 Stranger），成功后联动引用状态4并发删除通知；
serverId为0时只处理本地。`deleteLocalMsg(id)` 发删除通知但不联动已发送引用。关闭本地状态后这些删除能力不可用。
历史和 clientId 查询排除已删除记录，serverId 查询仍可返回带 `deleted: true` 的记录。
删除不是撤回，也不是永久禁止同步：若服务器消息再次进入正常保存路径，删除标记会清除。
撤回命中本地原消息时，同会话已缓存且未删除的直接引用会更新 `referenceInfo.refMessageStatus=3`；
正文和引用 hint 保留，不递归更新间接引用，也不为未缓存原消息生成墓碑。
普通入站消息的合并快照可通过 `notice.message.update` 的 `event.message` 获取，包含自身回显和重复快照；
这不是新消息事件，不会重复触发 `message` 回复 handler。
主动/被动撤回和断线补拉的普通消息产生 `notice.message.batch-update`：`event.updates` 包含已缓存会话和受影响消息副本；
补拉页中的旧索引记录也参与合并，但不会逐条触发 `message` 回复 handler 或 `notice.message.update`。
`event.deletedClientMessageIds` 明确使用 clientId（撤回不填此列表）。
Desktop 删除命令会软删除已缓存目标，通过 `notice.message.delete` 提供原消息快照，并将同会话直接引用状态更新为 `4`；
引用消息保留正文并单独派发 `notice.message.update`。实时删除命令不另发批次，补拉命令会把目标 clientId 放入批次删除列表。
显式 `getHistory()` 中的删除命令仍执行单条通知，但不额外派发批次。未知目标不会合成消息；完整补拉调度和其他特殊命令仍在对齐中。
会话设置命令 `50001/command_type=4` 已接入实时、历史和补拉：按逐键版本更新或删除设置，
不能增量处理时按会话版本判断是否用 cmd608 补拉，并合并重复请求。部分修改失败时保留内存值，不立即落库。
`notice.conversation.update` 读取当前会话快照；补拉批次还可包含仅会话更新、`messages` 为空的条目。
原生补拉后的本地提示消息及完整未读/排序等副作用尚未补齐，当前不是完整 Desktop 同步器验收。
实时入站消息和发送接口返回成功的出站简略记录也会写入同一消息表；简略记录不会覆盖完整服务器消息，发送响应成功不等于对端已收件。可用
`localState: { backend: 'json', maxMessagesPerConversation: 500 }` 显式改用 JSON，或用
`localState: false` 关闭持久化 IM 状态库；运行时不会静默切换后端。
关闭后仍保留本次登录已加载的会话快照和设置版本，供风险检查、联系人状态与会话事件使用，退出清除；
这不等于开启内存历史库，`getCachedHistory()` 仍无历史可读，也不会创建 `im-state.sqlite` / `im-state.json`。

`pick*()` 只同步查账号内的稳定实例缓存，找不到联系人时返回 `undefined`。
`pickAccount()` 只有在注册了一个账号时才能省略 ID；找不到账号或选择不明确会抛错。
用户、群和消息 ID 始终使用字符串，避免大整数精度丢失。
`group.getMemberList(true)` 会翻完 cmd605 的全部成员页；成员资料补全失败不会把协议已经返回的成员丢掉。

## 文档

- [使用指南](docs/guide.md)：登录配置、联系人、消息、群管理、申请、通知、错误与排查。
- [架构与继承职责](docs/adr/0008-base-and-sdk-instance-layers.md)：公共能力由基类实现，子类只处理差异。
- [账号级本地 IM 状态库](docs/adr/0009-local-im-state.md)：SQLite、完整快照与缓存一致性边界。
- [文档索引](docs/README.md)：术语与设计决策。

业务代码使用 `douyin-im`；扩展基类使用 `douyin-im/base`；协议研究使用 `douyin-im/protocol`。
内部 `ChatContact` 类不从根入口导出；根入口的同名导出是联系人联合类型。

## 开发验证

```bash
pnpm build
pnpm typecheck:demo
pnpm lint
pnpm test
```

保管好 `data/` 中的 Cookie、设备身份与待验证记录，以及二维码文件；不要将它们提交到仓库或公开日志。
登录前会按 Desktop 链路向抖音注册/激活设备，提交本机硬件 UUID、序列号、网卡 MAC 等信息；
硬件原文不落盘、不写日志，只保存返回的 deviceId/installId。
第三方实现参考与来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
