/**
 * 完整 Bot 示例：登录 → 上线 → 接收事件 → handler 分发 → 优雅退出。
 *
 * 直接运行 `pnpm demo`。程序会优先恢复 DATA_DIR 中的 Session；没有可用 Session 时，
 * 会在当前进程内展示二维码或询问短信验证码，不需要切换到其他脚本。
 *
 * 可选环境变量：
 * - DATA_DIR=./data
 * - PLATFORM_UID=<已保存账号 UID>
 * - MOBILE=<手机号>                         使用短信登录
 * - MOBILE=<手机号> PASSWORD=<密码>         使用密码登录
 * - DEBUG_RAW=1                             打印原始 protobuf 摘要
 * - LOG_LEVEL=debug | info | warn | error | silent
 */
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { readFile, stat } from 'fs/promises';
import { basename } from 'path';
import {
  createClient,
  segment,
  GroupMessageEvent,
  PrivateMessageEvent,
  StrangerMessageEvent,
  type Client,
  type Account,
  type ImActionResponse,
  type MessageEvent,
  type AnyNoticeEvent,
  type SendMessageResponse,
  configureLogger,
  getLogger,
} from 'douyin-im';
import { presentQrCode, type PresentQrResult } from './demo/qr-display.js';

const logger = getLogger('Demo');

interface DemoConfig {
  dataDir: string;
  platformUid?: string;
  mobile?: string;
  password?: string;
  debugRaw: boolean;
}

function readConfig(): DemoConfig {
  const platformUid = process.env['PLATFORM_UID'];
  const mobile = process.env['MOBILE'];
  const password = process.env['PASSWORD'];
  return {
    dataDir: process.env['DATA_DIR'] ?? './data',
    debugRaw: process.env['DEBUG_RAW'] === '1',
    ...(platformUid ? { platformUid } : {}),
    ...(mobile ? { mobile } : {}),
    ...(password ? { password } : {}),
  };
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return (await terminal.question(question)).trim();
  } finally {
    terminal.close();
  }
}

function printReceipt(source: string, response: SendMessageResponse): void {
  logger.debug(
    `send receipt: [${source}] status=${response.statusCode} msg=${JSON.stringify(response.statusMsg)} ` +
    `clientMsgId=${response.clientMessageId ?? '-'} serverMsgId=${response.serverMessageId ?? '-'} ` +
    `checkCode=${response.checkCode ?? '-'}`,
  );
}

function printAction(source: string, response: ImActionResponse): void {
  if (response.statusCode === 0) {
    logger.info('succeed to %s', source);
    return;
  }
  logger.error(
    'failed to %s: %s(%s)%s',
    source,
    response.statusMsg,
    response.statusCode,
    response.checkCode == null ? '' : ` check=${response.checkCode}`,
  );
}

/** 所有业务事件集中在这里处理；真实项目可把每个 command 拆成独立 handler。 */
class MessageHandler {
  private readonly recentMessages = new WeakMap<Account, MessageEvent[]>();

  async handle(event: MessageEvent): Promise<void> {
    const account = event.account;
    const recent = this.recentMessages.get(account) ?? [];
    recent.push(event);
    if (recent.length > 20) recent.shift();
    this.recentMessages.set(account, recent);
    if (event instanceof GroupMessageEvent) {
      account.logger.info(
        'recv from: [Group: %s(%s), Member: %s(%s)] %s',
        event.group.name || '未知群',
        event.group.groupId,
        event.member.displayName,
        event.member.uid,
        this.preview(event),
      );
    } else if (event instanceof StrangerMessageEvent) {
      account.logger.info(
        'recv from: [Stranger: %s(%s)] %s',
        event.stranger.remark || event.stranger.nickname || '未知用户',
        event.senderUid,
        this.preview(event),
      );
    } else if (event instanceof PrivateMessageEvent) {
      account.logger.info(
        'recv from: [Private: %s(%s)] %s',
        event.friend.remark || event.friend.nickname || '未知用户',
        event.senderUid,
        this.preview(event),
      );
    } else {
      account.logger.info('recv from: [Private: %s] %s', event.senderUid, this.preview(event));
    }

    // 示例只响应明确命令，避免启动后给历史消息或所有来信自动群发。
    const input = event.text.trim();
    if (!input.startsWith('/')) return;

    const [command, ...args] = input.split(/\s+/);
    switch (command) {
      case '/ping':
        await this.send(event, 'pong');
        return;
      case '/echo':
        await this.send(event, args.join(' ') || '用法：/echo 文本');
        return;
      case '/quote':
        await this.quote(event, args.join(' ') || '已收到');
        return;
      case '/react':
        printAction(`${event.chatType}:react`, await event.react(args.join(' ') || '[爱心]'));
        return;
      case '/follow': {
        const user = event instanceof GroupMessageEvent ? event.member
          : event instanceof StrangerMessageEvent ? event.stranger
            : event instanceof PrivateMessageEvent ? event.friend : undefined;
        if (!user) return;
        try {
          const result = await user.setFollowed();
          printAction(`${event.chatType}:follow`, result);
          await this.send(event, result.statusCode !== 0
            ? `关注失败：${result.statusMsg || `status=${result.statusCode}`}`
            : result.followStatus === 4 ? '关注申请已发送，等待你批准'
              : result.followStatus === 1 || result.followStatus === 2 ? '已关注你'
                : '服务端返回未关注状态');
        } catch (error) {
          account.logger.error('关注未完成：%s', error instanceof Error ? error.message : String(error));
          await this.send(event, '关注未完成，请查看机器人终端的登录票据或安全验证提示');
        }
        return;
      }
      case '/help':
        await this.send(event, '可用命令：/ping、/echo <文本>、/quote <文本>、/follow、/react [表情键]、/read、/read-batch、/card-info、/forward-last <friend|group|stranger> <id>、/delete、/help');
        return;
      case '/read':
        printAction(`${event.chatType}:read`, await event.markRead());
        return;
      case '/read-batch': {
        const messages = recent.filter((item) => item.serverMessageId);
        const result = await account.markMessagesRead(messages);
        account.logger.info(
          '批量已读完成：成功 %s 条，失败 %s 条',
          result.succeeded.length,
          result.failed.length,
        );
        return;
      }
      case '/card-info': {
        const source = [...recent].reverse().find((item) => item !== event && item.work);
        if (!source?.work) {
          await this.send(event, '最近没有作品、图集或评论卡片');
          return;
        }
        const detail = await source.work.getDetail(true);
        const access = await source.work.getAccess();
        const comment = source.comment ? await source.comment.getStatus(true) : undefined;
        logger.info('[card-info]', { detail, access, comment });
        await this.send(
          event,
          `作品 ${source.work.id}：filtered=${detail.filtered} share=${access.canShare} ` +
          `download=${access.canDownload} media=${access.media.length}` +
          (comment ? ` comment=${comment.commentId} shown=${comment.isShown ?? 'unknown'}` : ''),
        );
        return;
      }
      case '/forward-last': {
        if (args.length !== 2) {
          await this.send(event, '用法：/forward-last <friend|group|stranger> <id>');
          return;
        }
        const [kind, id] = args;
        const target = kind === 'friend' ? account.pickFriend(id!)
          : kind === 'group' ? account.pickGroup(id!)
            : kind === 'stranger' ? account.pickStranger(id!) : undefined;
        if (!target) {
          await this.send(event, `未找到 ${kind}:${id}，请先在终端刷新相应会话列表`);
          return;
        }
        const source = [...recent].reverse().find((item) => (
          item !== event && item.serverMessageId && [5, 6, 7, 8, 16, 25, 26, 27, 30, 75, 77, 105].includes(item.messageType)
        ));
        if (!source) {
          await this.send(event, '最近没有可转发消息');
          return;
        }
        printReceipt('forward', await source.forwardTo(target));
        return;
      }
      case '/delete':
        printAction(`${event.chatType}:delete`, await event.delete());
        return;
      default:
        await this.send(event, `未知命令 ${command}，发送 /help 查看帮助`);
    }
  }

  private preview(event: MessageEvent): string {
    switch (event.content.kind) {
      case 'image':
        return `[图片] oid=${event.content.image.oid}`;
      case 'video':
        return `[视频] tkey=${event.content.video.tkey}`;
      case 'emoji':
        return `[表情] ${event.content.text || event.content.url}`;
      case 'audio':
        return `[语音] ${event.content.audio.urls[0] || event.content.audio.uri}`;
      case 'file': return `[文件] ${event.content.file.name}`;
      case 'link': return `[链接] ${event.content.link.title} ${event.content.link.url}`;
      case 'user': return `[名片] ${event.content.user.name} ${event.content.user.uid}`;
      case 'share':
        return `[分享作品] ${event.content.share.itemId} ${event.content.share.title}`;
      case 'comment':
        return `[评论卡片] work=${event.content.comment.workId} comment=${event.content.comment.commentId} ${event.content.text}`;
      case 'text':
        return JSON.stringify(event.content.text);
      case 'unknown':
        return `[未知消息] ${JSON.stringify(event.content.text)}`;
    }
  }

  private async send(event: MessageEvent, text: string): Promise<void> {
    printReceipt(event.chatType, await event.reply(text));
  }

  private async quote(event: MessageEvent, text: string): Promise<void> {
    printReceipt(`${event.chatType}:quote`, await event.quote(text));
  }
}

class DemoBot {
  private readonly client: Client;
  private readonly handler = new MessageHandler();
  private qrDisplay?: PresentQrResult;
  private commandLine?: ReturnType<typeof createInterface>;
  private selectedAccount?: Account;
  private stopping = false;
  private finish!: () => void;
  private readonly finished = new Promise<void>((resolve) => {
    this.finish = resolve;
  });

  constructor(private readonly config: DemoConfig) {
    this.client = createClient({
      dataDir: config.dataDir,
      autoLoad: !config.platformUid && !config.mobile,
    });
    if (config.platformUid) {
      this.client.createAccount({ accountId: config.platformUid });
    } else if (config.mobile) {
      this.client.createAccount({
        login: config.password
          ? { method: 'password', mobile: config.mobile, password: config.password }
          : { method: 'sms', mobile: config.mobile },
      });
    }
  }

  async run(): Promise<void> {
    this.bindLifecycleHandlers();
    this.bindMessageHandlers();
    this.bindProcessHandlers();

    logger.info('----------');
    logger.info('douyin-im demo 正在启动');
    logger.debug(
      'data=%s transport=desktop accounts=%s',
      this.config.dataDir,
      this.client.accounts.length,
    );
    logger.info('----------');
    await this.client.login();
    void this.runCommandLine();
    await this.finished;
  }

  /** 登录完成后的主动发送测试台。输入 /help 查看命令。 */
  private async runCommandLine(): Promise<void> {
    const terminal = createInterface({ input: stdin, output: stdout, terminal: true });
    this.commandLine = terminal;
    this.printCommandHelp();
    terminal.setPrompt('douyin-im> ');
    terminal.prompt();

    try {
      for await (const line of terminal) {
        await this.guard('command', () => this.handleCommand(line.trim()));
        if (this.stopping) return;
        terminal.prompt();
      }
      await this.shutdown('stdin closed');
    } catch (error) {
      if (!this.stopping) {
        logger.error(error instanceof Error ? error : new Error(String(error)), 'command line failed');
        await this.shutdown('command line failed');
      }
    }
  }

  private async handleCommand(input: string): Promise<void> {
    if (!input) return;
    const [command, target, ...rest] = input.split(/\s+/);
    switch (command) {
      case '/help':
        this.printCommandHelp();
        return;
      case '/accounts':
        for (const account of this.client.accounts) {
          const id = account.uid ?? 'pending';
          logger.info(
            '%s(%s) %s%s',
            account.nickname ?? 'Douyin Account',
            id,
            account.state,
            this.selectedAccount === account ? ' [selected]' : '',
          );
        }
        return;
      case '/use':
        if (!target) throw new Error('用法：/use <platformUid>');
        this.selectedAccount = this.client.pickAccount(target);
        this.selectedAccount.logger.info('已选择为主动操作账号');
        return;
      case '/friends':
        await this.listFriends(this.pickActiveAccount());
        return;
      case '/recommendations': {
        if (target || rest.length) throw new Error('用法：/recommendations');
        const account = this.pickActiveAccount();
        const result = await account.getRecommendedContacts();
        printAction('recommendations', result);
        if (result.statusCode === 0) {
          account.logger.info('推荐联系人：%s 项（不等于好友名单）', result.contacts.length);
          for (const item of result.contacts) account.logger.info('%s secUid=%s conversationId=%s activeTime=%s',
            item.name ?? '-', item.secUid ?? '-', item.conversationId ?? '-', item.lastActiveTime ?? '-');
        }
        return;
      }
      case '/strangers':
        await this.listStrangers(this.pickActiveAccount());
        return;
      case '/stranger-unread': {
        if (rest.length !== 0 || (target && target !== 'reset')) {
          throw new Error('用法：/stranger-unread [reset]');
        }
        const result = await this.pickActiveAccount().getStrangerUnreadCount(target === 'reset');
        printAction('stranger-unread', result);
        this.pickActiveAccount().logger.info('陌生人未读消息：%s 条', result.unreadCount);
        return;
      }
      case '/strangers-read':
        if (target || rest.length !== 0) throw new Error('用法：/strangers-read');
        printAction('strangers-read', await this.pickActiveAccount().markAllStrangersRead());
        return;
      case '/strangers-delete':
        if (target !== 'confirm' || rest.length !== 0) {
          throw new Error('该操作会清空陌生人会话；确认后输入 /strangers-delete confirm');
        }
        printAction(
          'strangers-delete',
          await this.pickActiveAccount().deleteAllStrangerConversations(),
        );
        return;
      case '/emojis': {
        if (rest.length) throw new Error('用法：/emojis [cursor]');
        const account = this.pickActiveAccount();
        const result = await account.getCollectedEmojis(target === undefined ? {} : { cursor: target });
        printAction('emojis', result);
        if (!result.page) {
          logger.info('本次未提供收藏页更新，已有缓存保持不变');
          return;
        }
        logger.info('收藏表情 page=%s next=%s more=%s enabled=%s cached=%s',
          result.page.stickers?.length ?? 'metadata-only', result.page.nextCursor, result.page.hasMore,
          result.page.stickerEnabledStatus ?? '-', account.getCachedCollectedEmojis()?.stickers.length ?? 0);
        for (const item of result.page.stickers ?? []) {
          logger.info('%s', JSON.stringify({ id: item['id'], width: item['width'], height: item['height'], imageType: item['animate_type'] }));
        }
        return;
      }
      case '/sticker': {
        if (!target || rest.length !== 2) throw new Error('用法：/sticker <friend|group|stranger> <id> <stickerId>');
        const account = this.pickActiveAccount();
        const sticker = account.getCachedCollectedEmojis()?.stickers.find(item => String(item['id']) === rest[1]);
        if (!sticker) throw new Error('该表情不在当前账号已加载的收藏页中，请先执行 /emojis [cursor]');
        printReceipt('active-sticker', await this.requireConversation(account, target, rest[0]!).sendMsg(segment.sticker(sticker)));
        return;
      }
      case '/groups':
        await this.listGroups(this.pickActiveAccount());
        return;
      case '/refresh': {
        if (target || rest.length !== 0) throw new Error('用法：/refresh');
        const contacts = await this.pickActiveAccount().refreshContacts();
        this.pickActiveAccount().logger.info('更新了 %s 个会话', contacts.length);
        return;
      }
      case '/group-create': {
        if (!target) throw new Error('用法：/group-create <uid...>');
        const group = await this.pickActiveAccount().createGroup([target, ...rest]);
        group.account.logger.info(
          '创建了群 %s(%s)，共 %s 名成员',
          group.name ?? group.groupId,
          group.groupId,
          group.memberList.size,
        );
        return;
      }
      case '/members':
        if (!target || rest.length !== 0) throw new Error('用法：/members <groupId>');
        await this.listMembers(this.pickActiveAccount(), target);
        return;
      case '/friend':
        if (!target || rest.length === 0) throw new Error('用法：/friend <uid> <文本>');
        await this.sendFriend(this.pickActiveAccount(), target, rest.join(' '));
        return;
      case '/stranger': {
        if (!target || rest.length === 0) throw new Error('用法：/stranger <uid> <文本>');
        const account = this.pickActiveAccount();
        const stranger = account.pickStranger(target);
        if (!stranger) throw new Error(`陌生人会话不存在: ${target}；先执行 /strangers`);
        printReceipt('active-stranger', await stranger.sendMsg(rest.join(' ')));
        return;
      }
      case '/group':
        if (!target || rest.length === 0) throw new Error('用法：/group <groupId> <文本>');
        await this.sendGroup(this.pickActiveAccount(), target, rest.join(' '));
        return;
      case '/group-at': {
        if (!target || rest.length < 2) throw new Error('用法：/group-at <groupId> <uid> <文本>');
        const [uid, ...textWords] = rest;
        const group = this.requireGroup(this.pickActiveAccount(), target);
        let member = group.pickMember(uid!);
        if (!member) {
          await group.getMemberList();
          member = group.pickMember(uid!);
        }
        if (!member) throw new Error(`群成员不存在: ${uid}`);
        printReceipt('active-group-at', await group.sendMsg([
          segment.at(member),
          segment.text(` ${textWords.join(' ')}`),
        ]));
        return;
      }
      case '/history': {
        if (!target || rest.length < 1 || rest.length > 2) {
          throw new Error('用法：/history <friend|group|stranger> <id> [count]');
        }
        const count = rest[1] === undefined ? 20 : Number(rest[1]);
        if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('count 必须是 1 到 50 的整数');
        const history = await this.requireConversation(
          this.pickActiveAccount(), target, rest[0]!,
        ).getHistory({ count });
        this.pickActiveAccount().logger.info('加载了 %s 条历史消息%s', history.messages.length, history.hasMore ? '，还有更多' : '');
        this.pickActiveAccount().logger.debug('history cursor=%s status=%s', history.cursor, history.statusCode);
        for (const message of history.messages) {
          logger.info(
            `  messageId=${message.msgId} sender=${message.senderUid} type=${message.msgType}` +
            ` index=${message.indexInConversationV2 ?? message.indexInConversation ?? '-'} text=${JSON.stringify(this.historyText(message.content))}`,
          );
        }
        return;
      }
      case '/card': {
        if (!target || rest.length < 3) throw new Error('用法：/card <friend|group> <id> <share|photos|link|user> <作品ID|URL|UID> [标题]');
        const [contactId, kind, value, ...titleWords] = rest;
        const title = titleWords.join(' ');
        const message = kind === 'share' ? segment.share({ itemId: value!, title })
          : kind === 'photos' ? segment.photos({ itemId: value!, title })
          : kind === 'link' ? segment.link({ url: value!, title })
          : kind === 'user' ? segment.user({ uid: value!, name: title }) : undefined;
        if (!message) throw new Error('卡片类型必须是 share/photos/link/user');
        printReceipt('card', await this.requireConversation(this.pickActiveAccount(), target, contactId!).sendMsg(message));
        return;
      }
      case '/file': {
        if (!target || rest.length < 2) throw new Error('用法：/file <friend|group> <id> <本地文件路径>');
        const path = rest.slice(1).join(' ');
        const conversation = this.requireConversation(this.pickActiveAccount(), target, rest[0]!);
        const fileInfo = await stat(path);
        if (!fileInfo.isFile() || fileInfo.size < 1 || fileInfo.size > 10 * 1024 * 1024) throw new Error('请选择 1 字节到 10 MiB 的文件');
        printReceipt('file', await conversation.sendMsg(segment.file(await readFile(path), basename(path))));
        return;
      }
      case '/image': {
        if (!target || rest.length < 2) {
          throw new Error('用法：/image <friend|group> <id> <base64|data URL|本地路径|HTTPS URL>');
        }
        const conversation = this.requireConversation(this.pickActiveAccount(), target, rest[0]!);
        const source = rest.slice(1).join(' ');
        printReceipt('image', await conversation.sendMsg(segment.image(source)));
        return;
      }
      case '/shared-work': {
        if (!target || rest.length !== 2) {
          throw new Error('用法：/shared-work <friend|group|stranger> <id> <作品ID>');
        }
        const conversation = this.requireConversation(this.pickActiveAccount(), target, rest[0]!);
        const [detail] = await conversation.getSharedWorkDetails([rest[1]!]);
        logger.info('[shared-work]', detail ?? '服务端未返回该作品');
        return;
      }
      case '/shared-comment': {
        if (!target || rest.length !== 2) {
          throw new Error('用法：/shared-comment <friend|group|stranger> <id> <评论ID>');
        }
        const conversation = this.requireConversation(this.pickActiveAccount(), target, rest[0]!);
        const [status] = await conversation.getSharedCommentStatuses([rest[1]!]);
        logger.info('[shared-comment]', status ?? '服务端未返回该评论');
        return;
      }
      case '/im-search': {
        if (!target) throw new Error('用法：/im-search <关键词>');
        const account = this.pickActiveAccount();
        await Promise.allSettled([
          account.getFriendList(),
          account.getGroupList(true),
          account.getStrangerList(),
        ]);
        const matches = account.searchConversations([target, ...rest].join(' '));
        account.logger.info('找到 %s 个会话', matches.length);
        for (const contact of matches) {
          const kind = 'groupId' in contact ? 'group' : contact.inboxType === 1 ? 'stranger' : 'friend';
          const id = 'groupId' in contact ? contact.groupId : contact.uid;
          const name = 'name' in contact ? contact.name : contact.nickname;
          logger.info(`  type=${kind} id=${id} name=${JSON.stringify(name ?? '')} thread=${contact.threadId}`);
        }
        return;
      }
      case '/block': {
        if (!target || rest.length !== 2) {
          throw new Error('用法：/block <friend|stranger> <uid> <on|off>');
        }
        const account = this.pickActiveAccount();
        const contact = target === 'friend'
          ? account.pickFriend(rest[0]!)
          : target === 'stranger'
            ? account.pickStranger(rest[0]!)
            : undefined;
        if (!contact) throw new Error(`未找到 ${target}:${rest[0]}，先刷新对应列表`);
        printAction(`${target}:block`, await contact.setBlocked(this.parseSwitch(rest[1]!)));
        return;
      }
      case '/remark': {
        if (!target || rest.length < 2) {
          throw new Error('用法：/remark <friend|stranger> <uid> <备注；用 - 清空>');
        }
        const account = this.pickActiveAccount();
        const contact = target === 'friend'
          ? account.pickFriend(rest[0]!)
          : target === 'stranger'
            ? account.pickStranger(rest[0]!)
            : undefined;
        if (!contact) throw new Error(`未找到 ${target}:${rest[0]}，先刷新对应列表`);
        const remark = rest.slice(1).join(' ');
        printAction(`${target}:remark`, await contact.setRemark(remark === '-' ? '' : remark));
        return;
      }
      case '/conversation-enter': {
        if (!target || rest.length !== 1) throw new Error(`用法：${command} <friend|group|stranger> <id>`);
        const conversation = this.requireConversation(this.pickActiveAccount(), target, rest[0]!);
        printAction(command.slice(1), await conversation.enterConversation());
        return;
      }
      case '/react-msg': {
        if (!target || rest.length < 3 || rest.length > 4) {
          throw new Error('用法：/react-msg <friend|group|stranger> <id> <serverMessageId> <表情键> [on|off]');
        }
        const [id, messageId, emoji, enabled] = rest;
        const conversation = this.requireConversation(this.pickActiveAccount(), target, id!);
        printAction('react-msg', await conversation.reactMsg(
          messageId!,
          emoji!,
          enabled === undefined ? true : this.parseSwitch(enabled),
        ));
        return;
      }
      case '/read': {
        if (!target || rest.length < 2 || rest.length > 4) {
          throw new Error('用法：/read <friend|group|stranger> <id> <serverMessageId> [index] [indexV2]');
        }
        const [id, messageId, index, indexV2] = rest;
        const conversation = this.requireConversation(this.pickActiveAccount(), target, id!);
        printAction('read', await conversation.markRead({
          serverMessageId: messageId!,
          ...(index ? { indexInConversation: index } : {}),
          ...(indexV2 ? { indexInConversationV2: indexV2 } : {}),
        }));
        return;
      }
      case '/read-receipt': {
        if (!target || rest.length < 1 || rest.length > 2 || (rest[1] !== undefined && rest[1] !== 'refresh')) {
          throw new Error('用法：/read-receipt <friend|group|stranger> <id> [refresh]');
        }
        const conversation = this.requireConversation(this.pickActiveAccount(), target, rest[0]!);
        const receipt = await conversation.getReadReceipt(rest[1] === 'refresh');
        if (!receipt) { logger.info('没有可用的本地最后自发消息摘要；不会自动拉取历史或创建会话'); return; }
        printAction('read-receipt:privacy', receipt.privacy);
        logger.info('已读隐私投影：message=%s readers=%s all=%s enabled=%s（基于本地缓存，不是完整在线名单）',
          receipt.raw.serverMessageId, receipt.readUsers.map(user => user.uid).join(',') || '-',
          receipt.isAllRead, receipt.privacy.enableReadState ?? 'unknown');
        return;
      }
      case '/delete': {
        if (!target || rest.length !== 2) {
          throw new Error('用法：/delete <friend|group|stranger> <id> <serverMessageId>');
        }
        const [id, messageId] = rest;
        const conversation = this.requireConversation(this.pickActiveAccount(), target, id!);
        printAction('delete', await conversation.deleteMsg(messageId!));
        return;
      }
      case '/mute':
      case '/pin':
        if (!target || rest.length !== 2) {
          throw new Error(`用法：${command} <friend|group> <id> <on|off>`);
        }
        await this.setConversationFlag(
          this.pickActiveAccount(),
          command.slice(1) as 'mute' | 'pin',
          target,
          rest[0]!,
          this.parseSwitch(rest[1]!),
        );
        return;
      case '/group-invite':
      case '/group-remove': {
        if (!target || rest.length === 0) throw new Error(`用法：${command} <groupId> <uid...>`);
        const group = this.requireGroup(this.pickActiveAccount(), target);
        if (command === '/group-remove') {
          const result = await group.removeMembers(rest);
          printAction(command.slice(1), result);
          if (result.statusCode === 0) group.account.logger.info('移除请求已获响应，成员结果以通知或刷新列表为准');
          return;
        }
        const result = await group.inviteMembers(rest);
        printAction(command.slice(1), result);
        group.account.logger.info('邀请响应：明确成功 %s 个 UID，失败 %s 个 UID；未列出的目标不推算，成员状态以通知或列表为准',
          new Set(result.succeededUids).size, new Set(result.failedUids).size);
        group.account.logger.debug('succeeded=%s failed=%s', result.succeededUids.join(',') || '-', result.failedUids.join(',') || '-');
        return;
      }
      case '/group-requests': {
        if (!target || rest.length !== 0) throw new Error('用法：/group-requests <groupId>');
        const requests = await this.requireGroup(this.pickActiveAccount(), target).getJoinRequests();
        this.pickActiveAccount().logger.info('群 %s 有 %s 条入群申请', target, requests.size);
        for (const request of requests.values()) {
          logger.info(
            `  requestId=${request.requestId} uid=${request.applicantUid}` +
            ` name=${JSON.stringify(request.displayName)} status=${request.status}` +
            ` reason=${JSON.stringify(request.reason ?? '')}`,
          );
        }
        return;
      }
      case '/group-approve':
      case '/group-reject': {
        if (!target || rest.length !== 1) throw new Error(`用法：${command} <groupId> <requestId>`);
        const group = this.requireGroup(this.pickActiveAccount(), target);
        await group.getJoinRequests();
        const request = group.pickJoinRequest(rest[0]!);
        if (!request) throw new Error(`本群不存在入群申请: ${rest[0]}`);
        const result = command === '/group-approve'
          ? await request.approve()
          : await request.reject();
        printAction(command.slice(1), result);
        return;
      }
      case '/group-leave':
        if (!target || rest.length !== 0) throw new Error('用法：/group-leave <groupId>');
        printAction('group-leave', await this.requireGroup(this.pickActiveAccount(), target).leave());
        return;
      case '/delete-conversation':
        if (!target || rest.length !== 1) {
          throw new Error('用法：/delete-conversation <friend|group|stranger> <id>');
        }
        printAction(
          'delete-conversation',
          await this.requireConversation(this.pickActiveAccount(), target, rest[0]!).deleteConversation(),
        );
        return;
      case '/quit':
      case '/exit':
        await this.shutdown('command');
        return;
      default:
        throw new Error(`未知终端命令 ${command}，输入 /help 查看帮助`);
    }
  }

  private pickActiveAccount(): Account {
    const account = this.selectedAccount ?? this.client.pickAccount();
    // This path is a human terminal command, not a passive message handler.
    if (account.online) account.markActive();
    return account;
  }

  private async listFriends(account: Account): Promise<void> {
    const friends = await account.getFriendList();
    account.logger.info('加载了 %s 个好友', friends.length);
    for (const friend of friends) {
      logger.info(
        `  uid=${friend.uid} nickname=${JSON.stringify(friend.nickname ?? '')}` +
        ` remark=${JSON.stringify(friend.remark ?? '')} secUid=${friend.secUid || '-'}` +
        ` closeFriend=${friend.closeFriend ? 'yes' : 'no'}` +
        ` signature=${JSON.stringify(friend.signature ?? '')}` +
        ` thread=${friend.threadId} shortId=${friend.conversationShortId || '(首次操作时创建)'}`,
      );
    }
  }

  private async listGroups(account: Account): Promise<void> {
    const groups = await account.getGroupList(true);
    account.logger.info('加载了 %s 个群', groups.length);
    for (const group of groups) {
      logger.info(
        `  groupId=${group.groupId} name=${JSON.stringify(group.name ?? '')} shortId=${group.conversationShortId}` +
        ` members=${group.memberCount ?? group.memberList.size}`,
      );
    }
  }

  private async listStrangers(account: Account): Promise<void> {
    const strangers = await account.getStrangerList();
    account.logger.info('当前本地有 %s 个陌生人联系人（不代表服务端完整列表）', strangers.length);
    for (const stranger of strangers) {
      logger.info(
        `  uid=${stranger.uid} nickname=${JSON.stringify(stranger.nickname ?? '')}` +
        ` thread=${stranger.threadId} shortId=${stranger.conversationShortId || '-'}`,
      );
    }
  }

  private async listMembers(account: Account, groupId: string): Promise<void> {
    const group = this.requireGroup(account, groupId);
    const members = await group.getMemberList(true);
    account.logger.info('群 %s 加载了 %s 名成员', groupId, members.size);
    for (const member of members.values()) {
      logger.info(
        `  uid=${member.uid} name=${JSON.stringify(member.displayName)} role=${member.roleName}(${member.role})` +
        ` secUid=${member.secUid || '-'}`,
      );
    }
  }

  private async sendFriend(account: Account, uid: string, text: string): Promise<void> {
    const friend = account.pickFriend(uid);
    if (!friend) throw new Error(`好友会话不存在: ${uid}；先执行 /friends 查看可用 UID`);
    account.logger.debug('send to: [Private(%s)] thread=%s shortId=%s', uid, friend.threadId, friend.conversationShortId);
    printReceipt('active-private', await friend.sendMsg(text));
  }

  private async sendGroup(account: Account, groupId: string, text: string): Promise<void> {
    const group = account.pickGroup(groupId);
    if (!group) throw new Error(`群会话不存在: ${groupId}；先执行 /groups 查看可用群号`);
    account.logger.debug('send to: [Group(%s)] shortId=%s', groupId, group.conversationShortId);
    printReceipt('active-group', await group.sendMsg(text));
  }

  private requireGroup(account: Account, groupId: string) {
    const group = account.pickGroup(groupId);
    if (!group) throw new Error(`群会话不存在: ${groupId}；先执行 /groups`);
    return group;
  }

  private requireConversation(account: Account, kind: string, id: string) {
    if (kind === 'friend') {
      const friend = account.pickFriend(id);
      if (!friend) throw new Error(`好友会话不存在: ${id}；先执行 /friends`);
      return friend;
    }
    if (kind === 'group') return this.requireGroup(account, id);
    if (kind === 'stranger') {
      const stranger = account.pickStranger(id);
      if (!stranger) throw new Error(`陌生人会话不存在: ${id}；先执行 /strangers`);
      return stranger;
    }
    throw new Error('会话类型必须是 friend、group 或 stranger');
  }

  private parseSwitch(value: string): boolean {
    if (value === 'on') return true;
    if (value === 'off') return false;
    throw new Error('开关值必须是 on 或 off');
  }

  private historyText(content: string): string {
    try {
      const parsed = JSON.parse(content) as { text?: unknown };
      return typeof parsed.text === 'string' ? parsed.text : content;
    } catch {
      return content;
    }
  }

  private async setConversationFlag(
    account: Account,
    action: 'mute' | 'pin',
    kind: string,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    const conversation = this.requireConversation(account, kind, id);
    const result = action === 'mute'
      ? await conversation.setMute(enabled)
      : await conversation.setPinned(enabled);
    printAction(`${kind}:${action}`, result);
  }

  private printCommandHelp(): void {
    logger.info([
      '主动发送测试命令：',
      '  /accounts                    查看账号；多账号时先 /use',
      '  /use <platformUid>           选择主动操作账号',
      '  /friends                     列出可发送的私聊',
      '  /recommendations             查询Desktop推荐联系人（不自动关注或建会话）',
      '  /emojis [cursor]             查询收藏表情；无参数刷新首页，带游标追加下一页',
      '  /sticker <类型> <id> <表情ID>  发送当前账号已加载的收藏表情',
      '  /strangers                   列出陌生人箱会话',
      '  /stranger-unread [reset]     查询陌生人未读数；reset 同时清零',
      '  /strangers-read              标记全部陌生人会话已读',
      '  /strangers-delete confirm    清空全部陌生人会话',
      '  /stranger <uid> <文本>        回复陌生人会话',
      '  /friend <uid> <文本>         主动发送私聊',
      '  /groups                      列出群聊',
      '  /refresh                     批量刷新已加载会话资料',
      '  /group-create <uid...>        创建群聊（当前账号自动加入）',
      '  /members <groupId>           拉取完整群成员列表',
      '  /group <groupId> <文本>      主动发送群聊',
      '  /group-at <groupId> <uid> <文本>         在群聊中发送可点击的 @消息',
      '  /history <类型> <id> [count]             拉取当前会话最近消息（最多 50）',
      '  /card <friend|group> <id> <share|photos|link|user> <值> [标题]  发送卡片',
      '  /file <friend|group> <id> <路径>          上传并发送文件（最多 10 MiB）',
      '  /image <friend|group> <id> <图片来源>     发送 base64、本地文件或 HTTPS 图片',
      '  /shared-work <类型> <id> <作品ID>         补全聊天作品卡片详情',
      '  /shared-comment <类型> <id> <评论ID>      查询聊天评论卡片状态',
      '  /im-search <关键词>                      搜索已同步的私聊、群聊和陌生人会话',
      '  /block <friend|stranger> <uid> <on|off>  拉黑或取消拉黑用户',
      '  /remark <friend|stranger> <uid> <备注|->  修改或清空用户备注',
      '  /conversation-enter <类型> <id>           上报进入会话',
      '  /react-msg <类型> <id> <消息ID> <表情键> [on|off]  添加或取消消息表态',
      '  /read <类型> <id> <消息ID> [index] [indexV2]       标记消息已读',
      '  /read-receipt <类型> <id> [refresh]      本地读者摘要+隐私过滤；refresh仅刷新策略，不标记已读',
      '  /delete <类型> <id> <消息ID>                       删除本地消息',
      '  /mute <friend|group> <id> <on|off>       设置免打扰',
      '  /pin <friend|group> <id> <on|off>        设置置顶',
      '  /group-invite <groupId> <uid...>          主动邀请用户入群',
      '  /group-requests <groupId>                 查看入群申请及处理状态',
      '  /group-approve <groupId> <requestId>      同意入群申请',
      '  /group-reject <groupId> <requestId>       拒绝入群申请',
      '  /group-remove <groupId> <uid...>          移除群成员',
      '  /group-leave <groupId>                    退出群聊',
      '  /delete-conversation <friend|group|stranger> <id>  删除本地会话',
      '  /quit                        退出',
      '另一账号可发 /ping、/echo、/quote、/read、/read-batch、/card-info、/forward-last、/help 测试被动处理。',
    ].join('\n'));
  }

  private bindLifecycleHandlers(): void {
    this.client.on('system.login.session', ({ account, status, reason }) => {
      account.logger.info('登录凭据：%s（%s）', status, reason);
    });

    this.client.on('system.login.qrcode', ({ account, ...qr }) =>
      this.guard('二维码登录', async () => {
        this.qrDisplay?.close();
        this.qrDisplay = await presentQrCode({
          qrcodeBase64: qr.qrcodeBase64,
          expireAt: new Date(qr.expireTime * 1000),
          enableTerminal: true,
          enableWeb: true,
          ...(qr.qrcodeIndexUrl ? { scanUrl: qr.qrcodeIndexUrl } : {}),
        });
        account.logger.info('二维码已就绪，请扫码并在手机端确认');
        await account.continueLogin();
        this.qrDisplay?.close();
        delete this.qrDisplay;
      }, true));

    this.client.on('system.login.qrcode.status', ({ account, ...status }) => {
      if (status.status === 'scanned' || status.status === '2') {
        account.logger.info('二维码已扫码%s，请在手机端确认', status.screenName ? `（${status.screenName}）` : '');
      } else if (status.status === 'confirmed' || status.status === '3') {
        account.logger.info('手机端已确认，正在建立会话…');
      } else if (status.status === 'verifying') {
        account.logger.info('需要安全验证，正在打开验证页…');
      } else if (status.status === 'verified') {
        account.logger.info('安全验证通过，继续登录…');
      } else if (status.status === 'pending') {
        account.logger.debug(
          '二维码状态待定：code=%s description=%j fields=%s',
          status.errorCode ?? '-',
          status.description ?? '',
          status.responseFields?.join(',') ?? '-',
        );
      } else if (status.status !== 'new' && status.status !== '1') {
        account.logger.debug('二维码状态：%s', status.status);
      }
    });

    this.client.on('system.login.sms', ({ account, mobile, maskedMobile }) =>
      this.guard('短信登录', async () => {
        const code = process.env['SMS_CODE'] ?? await ask(
          `请输入发送到 ${maskedMobile ?? mobile} 的验证码（输入 voice 改用语音验证码）：`,
        );
        if (code.toLowerCase() === 'voice') {
          await account.requestLoginVoiceCode();
          return;
        }
        if (!/^\d{4,8}$/.test(code)) throw new Error('验证码格式不正确');
        await account.continueLoginWithSms(code);
      }, true));

    this.client.on('system.login.voice', ({ account, mobile, maskedMobile }) =>
      this.guard('语音验证码登录', async () => {
        const code = process.env['VOICE_CODE'] ?? await ask(
          `请输入 ${maskedMobile ?? mobile} 接听电话获得的验证码：`,
        );
        if (!/^\d{4,8}$/.test(code)) throw new Error('验证码格式不正确');
        await account.continueLoginWithSms(code);
      }, true));

    this.client.on('system.login.sms-required', ({ account, mobile, reason }) =>
      this.guard('切换验证码登录', async () => {
        account.logger.warn('%s（手机号 %s）', reason, mobile);
        await account.requestLoginSmsCode();
      }, true));

    this.client.on('system.login.accounts', ({ account, method, accounts, canRegisterNewUser }) =>
      this.guard('选择登录账号', async () => {
        account.logger.info('手机号关联了 %s 个账号（%s）：', accounts.length, method);
        accounts.forEach((candidate, index) => {
          account.logger.info(
            `  ${index + 1}. ${candidate.nickname ?? candidate.douyinId ?? candidate.uid ?? candidate.secUid}` +
            ` secUid=${candidate.secUid}${candidate.isMainAccount ? ' main' : ''}` +
            `${candidate.isEnterprise ? candidate.isActive ? ' enterprise' : ' enterprise-inactive' : ''}`,
          );
        });
        const prompt = canRegisterNewUser
          ? '输入序号或 new 创建主账号：'
          : '输入账号序号：';
        const answer = await ask(prompt);
        if (answer === 'new' && canRegisterNewUser) {
          await account.continueLoginWithSubAccount({ registerNewUser: true });
          return;
        }
        const index = Number(answer) - 1;
        const selected = accounts[index];
        if (!selected) throw new Error('账号序号无效');
        await account.continueLoginWithSubAccount({ secUid: selected.secUid });
      }, true));

    this.client.on('system.login.verification', ({ account, verification }) =>
      this.guard('安全验证', async () => {
        account.logger.warn(
          `${verification.operation === 'token-beat' ? 'Session 续期' : '登录'}需要安全验证：%s（%s）`,
          verification.description ?? '请在浏览器中完成验证',
          verification.methods.join(', '),
        );
        await verification.open();
      }, verification.operation !== 'token-beat'));

    this.client.on('system.login.error', ({ account, error }) => {
      account.logger.error(error, '登录失败');
    });
    this.client.on('system.action.verification', ({ account, verification }) =>
      this.guard('业务安全验证', async () => {
        account.logger.warn('操作 %s 需要安全验证，请在浏览器完成；不会重新登录', verification.target.operation);
        await verification.open();
      }));
    this.client.on('system.online', ({ account, platformUid, screenName }) => {
      this.qrDisplay?.close();
      delete this.qrDisplay;
      account.logger.success(`Welcome, ${screenName ?? 'Douyin Account'}(${platformUid}) ! 正在加载资源…`);
      if (this.client.accounts.every((account) => account.online)) {
        logger.info('所有账号已上线，handler 已就绪；联系人列表正在后台加载');
      }
    });
    this.client.on('system.reconnecting', ({ account, attempt, delayMs }) => {
      account.logger.warn('连接已断开，%s 秒后进行第 %s 次重连', delayMs / 1000, attempt);
    });
    this.client.on('system.handler.error', ({ account, event, error }) => {
      account.logger.error(error, 'handler failed for %s', String(event));
    });
    this.client.on('system.offline', ({ account }) => {
      account.logger.info('账号已下线');
    });
  }

  private bindMessageHandlers(): void {
    // Client 汇总所有 Account 的消息，并保留来源账号。
    this.client.on('message', (event) => this.handler.handle(event));
    this.client.on('request.group.join', (request) => {
      request.account.logger.info(
        '用户 %s(%s) 请求加入群 %s(%s)（request: %s，理由: %s）',
        request.displayName,
        request.applicantUid,
        request.group.name ?? request.group.groupId,
        request.group.groupId,
        request.requestId,
        request.reason || '无',
      );
      request.account.logger.info('可调用 request.approve() 或 request.reject() 处理');
    });
    this.client.on('notice.friend.add-request', (notice) => {
      notice.account.logger.info(
        '收到好友申请状态信号：用户 %s（内容: %s）',
        notice.applicantUid,
        notice.content || '无',
      );
    });
    this.client.on('notice.friend.increase', (event) => {
      event.account.logger.info('更新了好友列表，新增好友 %s', event.peerUid);
    });
    this.client.on('notice.friend.decrease', (event) => {
      event.account.logger.info('更新了好友列表，删除好友 %s', event.peerUid);
    });
    this.client.on('notice.group.member-increase', (event) => {
      event.account.logger.info(
        '%s(%s) %s群 %s(%s)%s',
        event.member.displayName,
        event.member.uid,
        event.source === 'invite' ? '受邀加入了' : '加入了',
        event.group.name ?? event.group.groupId,
        event.group.groupId,
        event.operator ? `，操作人 ${event.operator.displayName}(${event.operator.uid})` : '',
      );
    });
    this.client.on('notice.group.member-decrease', (event) => {
      event.account.logger.info(
        '%s(%s) %s群 %s(%s)%s',
        event.member.displayName,
        event.member.uid,
        event.source === 'kick' ? '被移出了' : '离开了',
        event.group.name ?? event.group.groupId,
        event.group.groupId,
        event.operator ? `，操作人 ${event.operator.displayName}(${event.operator.uid})` : '',
      );
    });
    this.client.on('notice.group.admin', (event) => {
      event.account.logger.info(
        '群 %s(%s) 将 %s(%s) 设置为管理员',
        event.group.name ?? event.group.groupId,
        event.group.groupId,
        event.member.displayName,
        event.member.uid,
      );
    });
    this.client.on('notice.group.name-change', (event) => {
      event.account.logger.info(
        '群 %s 的名称更新为“%s”%s',
        event.group.groupId,
        event.name ?? event.group.name ?? '',
        event.operator ? `，操作人 ${event.operator.displayName}(${event.operator.uid})` : '',
      );
    });
    this.client.on('notice.group.avatar-change', (event) => {
      event.account.logger.info('群 %s(%s) 更新了头像', event.group.name ?? event.group.groupId, event.group.groupId);
      event.account.logger.debug('group avatar: %s', event.avatar ?? event.group.avatar ?? '-');
    });
    this.client.on('notice.friend.marked-read', (event) => {
      event.account.logger.info(
        '私聊 %s(%s) 读游标更新：reader=%s index=%s indexV2=%s',
        event.friend.nickname ?? event.friend.uid,
        event.friend.uid,
        event.readerUid ?? '-', event.readMessageIndex, event.readMessageIndexV2 ?? '-',
      );
    });
    this.client.on('notice.group.marked-read', (event) => {
      event.account.logger.info(
        '群 %s(%s) 读游标更新：reader=%s index=%s indexV2=%s',
        event.group.name ?? event.group.groupId,
        event.group.groupId,
        event.readerUid ?? '-', event.readMessageIndex, event.readMessageIndexV2 ?? '-',
      );
    });
    this.client.on('notice', (event) => {
      if (![
        'group.member-increase',
        'group.member-decrease',
        'group.admin',
        'group.name-change',
        'group.avatar-change',
        'friend.marked-read',
        'friend.increase',
        'friend.decrease',
        'group.marked-read',
      ].includes(event.type)) this.printNotice(event);
    });
    if (this.config.debugRaw) {
      this.client.on('message.raw', ({ account, cmd, response }) => {
        const transport = String(response['transport'] ?? 'desktop-frontier');
        const size = typeof response['base64'] === 'string' ? response['base64'].length : 0;
        account.logger.debug('recv raw: transport=%s cmd=%s bytes(base64)=%s', transport, cmd, size);
      });
    }
  }

  private printNotice(event: AnyNoticeEvent): void {
    const eventLogger = event.account.logger;
    if (event.type === 'conversation.read-summary') {
      eventLogger.debug('原始已读摘要更新：会话=%s（尚未过滤展示隐私）', event.summaries.length);
      return;
    }
    if (event.type === 'message.batch-update') {
      eventLogger.debug('批量消息状态更新：会话=%s 删除clientId=%s', event.updates.length, event.deletedClientMessageIds.length);
      return;
    }
    if (event.type === 'message.list-update') {
      eventLogger.debug('消息列表状态更新：消息=%s', event.messages.length);
      return;
    }
    if (event.type === 'message.update') {
      eventLogger.debug('消息状态更新 [Conversation(%s), Message(%s)]', event.conversationId, event.serverMessageId ?? '-');
      return;
    }
    if (event.type === 'message.delete') {
      eventLogger.debug('本地消息删除 [Conversation(%s), ClientMessage(%s)]', event.conversationId, event.clientMessageId ?? '-');
      return;
    }
    if (event.type === 'message.recall') {
      eventLogger.info('一条消息被撤回 [Conversation(%s), Message(%s)]', event.conversationId, event.serverMessageId ?? '-');
      return;
    }
    if (event.type === 'im.command') {
      eventLogger.debug('recv command: [Conversation(%s)] messageType=%s', event.conversationId, event.messageType);
      return;
    }
    if (event.type === 'friend.increase' || event.type === 'friend.decrease') {
      eventLogger.info('%s好友 %s', event.type === 'friend.increase' ? '新增' : '删除', event.peerUid);
      return;
    }
    if (
      event.type === 'group.member-increase' ||
      event.type === 'group.member-decrease' ||
      event.type === 'group.admin' ||
      event.type === 'group.name-change' ||
      event.type === 'group.avatar-change' ||
      event.type === 'friend.add-request' ||
      event.type === 'friend.marked-read' ||
      event.type === 'group.marked-read'
    ) return;
    eventLogger.debug('recv notice: %s [Conversation(%s)]', event.type, event.conversationId);
  }

  private bindProcessHandlers(): void {
    process.once('SIGINT', () => void this.shutdown('SIGINT'));
    process.once('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
      logger.error(reason instanceof Error ? reason : new Error(String(reason)), 'unhandled rejection');
    });
    process.on('uncaughtException', (error) => {
      logger.error(error, 'uncaught exception');
      void this.shutdown('uncaughtException');
    });
  }

  private async guard(label: string, task: () => Promise<void>, fatal = false): Promise<void> {
    try {
      await task();
    } catch (error) {
      logger.error(error instanceof Error ? error : new Error(String(error)), '%s failed', label);
      if (fatal) await this.shutdown(`${label}失败`);
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    logger.info('正在退出：%s', reason);
    this.qrDisplay?.close();
    delete this.qrDisplay;
    this.commandLine?.close();
    delete this.commandLine;
    try {
      await this.client.logout();
    } finally {
      this.finish();
    }
  }
}

configureLogger({
  level: process.env['LOG_LEVEL'] ?? (process.env['DEBUG_RAW'] === '1' ? 'debug' : 'info'),
  color: process.stdout.isTTY,
});

const bot = new DemoBot(readConfig());
bot.run().catch((error) => {
  logger.error(error instanceof Error ? error : new Error(String(error)), 'fatal');
  process.exitCode = 1;
});
