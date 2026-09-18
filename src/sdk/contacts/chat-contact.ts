import type {
  ConversationReadMarker,
  ImActionResponse,
  RecallMessageResponse,
  SendMessageResponse,
  PrivateMessage,
} from '../../services/im/types.js';
import { isMessageDelivered } from '../../services/im/content.js';
import type { SharedCommentStatus, SharedWorkDetail } from '../../services/im/shared-content.js';
import type { ImService } from '../../services/im/service.js';
import type { ConversationReadStateResponse, ConversationReadSummary, StoredReadCursor } from '../../services/im/read-state.js';
import { equalConversationReadSummaries } from '../../services/im/read-state.js';
import { filterReadReceipt, type MessageReadPrivacyResponse } from '../../services/im/user-settings.js';
import { Contact, type ConversationAddress } from '../../base/contact.js';
import type { Account } from '../account.js';
import { SendMessageError } from '../errors.js';
import type { MessageEvent } from '../events/message.js';
import type { SendableMessage } from '../messaging/message.js';
import { logSendResult } from '../messaging/reply-log.js';
import { messageBrief } from '../messaging/message.js';
import { messageClientId } from '../../services/im/message-cache.js';

export type ChatMessage = PrivateMessage;
/** A string denotes a server ID; an explicit client ID also addresses unsent local messages. */
export type ChatMessageIdentifier = string | { clientMessageId: string };

/** Privacy projection of a local native summary; not a complete reader census or UI eligibility verdict. */
export interface ConversationReadReceipt {
  raw: ConversationReadSummary;
  privacy: MessageReadPrivacyResponse;
  readUsers: ConversationReadSummary['readUsers'];
  isAllRead: boolean;
}

export interface ChatHistory {
  statusCode: number;
  statusMsg: string;
  hasMore: boolean;
  messages: ChatMessage[];
  cursor: string;
  direction: 'older' | 'newer';
}

export interface ChatHistoryOptions {
  cursor?: string | number;
  count?: number;
  direction?: 'older' | 'newer';
  includeCurrent?: boolean;
}

function compareHistoryMessage(left: ChatMessage, right: ChatMessage): number {
  const leftIndex = left.indexInConversationV2 || left.indexInConversation;
  const rightIndex = right.indexInConversationV2 || right.indexInConversation;
  if (leftIndex && rightIndex) {
    try {
      const delta = BigInt(leftIndex) - BigInt(rightIndex);
      if (delta !== 0n) return delta < 0n ? -1 : 1;
    } catch {
      // Malformed protocol indexes fall back to server creation time.
    }
  }
  return left.createTime - right.createTime;
}

/** Friend / Group / Stranger 共用的包内聊天能力；不从 npm 根入口导出。 */
export abstract class ChatContact extends Contact<Account> {
  protected abstract readonly logTarget: string;

  protected constructor(
    id: string,
    address: ConversationAddress,
    account: Account,
  ) {
    super(account, id, address);
  }

  async sendMsg(message: SendableMessage): Promise<SendMessageResponse> {
    const sender = this.account.outbound;
    const connection = this.account.im;
    this.assertCurrentConnection(connection);
    const address = await this.prepareAddress();
    this.assertCurrentConnection(connection);
    if (!address.conversationShortId) {
      throw new SendMessageError({ statusCode: -1, statusMsg: 'missing conversationShortId', clientMessageId: '' });
    }
    const response = logSendResult(
      await sender.sendMessage({ ...address, message }),
      this.logTarget,
      messageBrief(message),
      this.account.logger,
    );
    if (!isMessageDelivered(response)) throw new SendMessageError(response);
    return response;
  }

  /** 拉取本会话历史；会话地址由实例持有，不允许调用方手拼 threadId/type。 */
  async getHistory(options: ChatHistoryOptions = {}): Promise<ChatHistory> {
    const connection = this.account.im;
    const address = await this.prepareAddress();
    this.assertCurrentConnection(connection);
    const response = await connection.getMessages({
      threadId: address.threadId,
      conversationShortId: address.conversationShortId,
      conversationType: address.conversationType,
      inboxType: address.inboxType,
      ...(options.cursor != null ? { cursor: options.cursor } : {}),
      ...(options.count != null ? { count: options.count } : {}),
      ...(options.direction != null ? { direction: options.direction } : {}),
      ...(options.includeCurrent != null ? { includeCurrent: options.includeCurrent } : {}),
    });
    this.assertCurrentConnection(connection);
    const messages = [...response.messages].sort(compareHistoryMessage);
    // Process command/state effects in server order; ascending order is only the returned view.
    if (response.statusCode === 0) this.account.cacheMessages(response.messages);
    return {
      ...response,
      // Desktop renderer merges every page in ascending conversation-index order.
      messages,
    };
  }

  /** 只读本地消息库，不发起网络请求；结果按会话索引升序排列。 */
  getCachedHistory(count = 50): readonly ChatMessage[] {
    return this.account.cachedMessages(this.threadId, count);
  }

  /** 按服务器消息 ID 只读本地缓存（包括 deleted 行）；未命中不表示远端不存在。 */
  getCachedMessage(serverMessageId: string): ChatMessage | undefined {
    return this.account.cachedMessage(this.threadId, serverMessageId, 'server');
  }

  /** 按客户端消息 ID 只读本地缓存；与入站合并使用相同的 ASCII 大小写正规化。 */
  getCachedMessageByClientId(clientMessageId: string): ChatMessage | undefined {
    return this.account.cachedMessage(this.threadId, clientMessageId, 'client');
  }

  /** Merge local string fields by client ID; synchronous persistence, no HTTP or send/marked-read action. */
  modifyMessageLocalExt(clientMessageId: string, ext: Readonly<Record<string, string>>): void {
    this.account.modifyCachedMessageLocalExt(this.threadId, clientMessageId, ext);
  }

  /** 把一条当前账号收到的桌面端可转发消息原样转发到本会话。 */
  async forwardMsg(message: MessageEvent): Promise<SendMessageResponse> {
    if (message.account !== this.account) {
      throw new Error('不能跨账号转发消息；请使用来源事件的 account 选择联系人');
    }
    const serverMessageId = message.serverMessageId;
    if (!serverMessageId) throw new Error('MessageEvent: no server message id');
    const sender = this.account.outbound;
    const connection = this.account.im;
    this.assertCurrentConnection(connection);
    const address = await this.prepareAddress();
    this.assertCurrentConnection(connection);
    const response = logSendResult(await sender.forwardMessage({
      ...address,
      content: message.rawContent,
      messageType: message.messageType,
      serverMessageId,
    }), this.logTarget, `[转发消息] ${message.text}`, this.account.logger);
    if (!isMessageDelivered(response)) throw new SendMessageError(response);
    return response;
  }

  /** 批量补全本会话中的作品卡片，协议每批最多 50 条。 */
  async getSharedWorkDetails(workIds: readonly string[]): Promise<SharedWorkDetail[]> {
    const address = await this.prepareAddress();
    return this.account.im.getSharedWorkDetails(address.conversationShortId, workIds);
  }

  /** 批量读取本会话中的评论卡片状态，协议每批最多 50 条。 */
  async getSharedCommentStatuses(commentIds: readonly string[]): Promise<SharedCommentStatus[]> {
    const address = await this.prepareAddress();
    return this.account.im.getSharedCommentStatuses(address.conversationShortId, commentIds);
  }

  async recallMsg(serverMessageId: string): Promise<RecallMessageResponse> {
    const sender = this.account.outbound;
    const connection = sender.imService;
    const clientMessageId = this.account.cachedMessage(this.threadId, serverMessageId, 'server')?.clientMessageId;
    const address = await this.prepareAddress();
    this.assertCurrentConnection(connection);
    const result = await sender.recall({
      ...address,
      serverMessageId,
    });
    this.assertCurrentConnection(connection);
    if ((result.statusCode === 0 || result.statusCode === 200) && clientMessageId) {
      // Desktop's success callback captures clientId and uses serverId=0 for local lookup.
      this.account.markCachedMessageRecalled(this.threadId, { clientMessageId });
    }
    return result;
  }

  async deleteMsg(identifier: ChatMessageIdentifier): Promise<ImActionResponse> {
    const connection = this.account.im;
    const conversation = this.account.cachedConversation(this.threadId);
    if (!conversation) throw new Error('删除消息失败：本地会话不存在，请先同步会话');
    if (conversation.conversationType !== 1 && conversation.conversationType !== 2) throw new Error('删除消息失败：尚未支持该会话类型');
    const target = this.resolveDeleteTarget(identifier);
    if (!target) throw new Error('删除消息失败：本地消息不存在，请先同步历史');
    const clientMessageId = messageClientId(target);
    if (!target.msgId || target.msgId === '0') {
      this.account.deleteCachedMessageByClientId(this.threadId, clientMessageId, true);
      return { statusCode: 0, statusMsg: '' };
    }
    const result = await connection.deleteMessage({
      threadId: this.threadId,
      conversationShortId: conversation.conversationShortId,
      conversationType: conversation.conversationType,
      inboxType: conversation.inboxType ?? 0,
      serverMessageId: target.msgId,
    });
    this.assertCurrentConnection(connection);
    if (result.statusCode === 0) this.account.deleteCachedMessageByClientId(this.threadId, clientMessageId, true);
    return result;
  }

  /** 仅软删除本地缓存，不请求服务端；返回是否隐藏了此前未删除的记录。 */
  deleteLocalMsg(identifier: ChatMessageIdentifier): boolean {
    if (!this.account.cachedConversation(this.threadId)) return false;
    const target = this.resolveDeleteTarget(identifier);
    return target ? this.account.deleteCachedMessageByClientId(this.threadId, messageClientId(target), false) : false;
  }

  private resolveDeleteTarget(identifier: ChatMessageIdentifier): PrivateMessage | undefined {
    if (typeof identifier !== 'string') return this.account.cachedMessage(this.threadId, identifier.clientMessageId, 'client');
    const target = this.account.cachedMessage(this.threadId, identifier, 'server');
    const clientId = target && messageClientId(target);
    return clientId ? this.account.cachedMessage(this.threadId, clientId, 'client') : undefined;
  }

  async markRead(marker: ConversationReadMarker): Promise<ImActionResponse> {
    return this.account.im.markConversationRead({ ...await this.prepareAddress(), ...marker });
  }

  /** 查询本会话原始读游标与最小可见索引；不是隐私过滤后的已读名单，也不标记已读。 */
  async getReadState(): Promise<ConversationReadStateResponse> {
    if (!this.account.online) throw new Error('账号未上线，请先完成登录');
    // 只读查询不应经 Friend.prepareAddress 隐式创建会话。
    const address = this.resolveAddress();
    if (!address.conversationShortId) throw new Error('尚无可查询的会话，请先建立会话');
    return this.account.readConversationState(address);
  }

  /** 只读账号本地游标；空数组不代表完整成员快照，也不代表全员未读。 */
  getCachedReadState(): readonly StoredReadCursor[] {
    return this.account.cachedReadCursors(this.threadId);
  }

  /** 最后自发消息的本地原始摘要；尚未过滤展示隐私，不代表完整在线读者名单。不联网或标记已读。 */
  getCachedReadSummary(): ConversationReadSummary | undefined {
    return this.account.cachedReadSummary(this.threadId);
  }

  /** 以本地最后自发摘要合成展示隐私；只查询缺失策略，refreshPrivacy=true 强制刷新策略，不补拉成员或读游标。 */
  async getReadReceipt(refreshPrivacy = false): Promise<ConversationReadReceipt | undefined> {
    if (!this.account.online) throw new Error('账号未上线，请先完成登录');
    const raw = this.getCachedReadSummary();
    if (!raw) return undefined;
    const connection = this.account.im;
    if (raw.conversationType !== 1 && raw.conversationType !== 2) throw new Error('已读摘要缺少有效的会话类型');
    const privacy = await this.account.getMessageReadPrivacy([{
      serverMessageId: raw.serverMessageId, conversationId: raw.conversationId,
      conversationShortId: raw.conversationShortId, conversationType: raw.conversationType,
      createTime: Number(raw.createTime), // Keep the original protocol value; account validation rejects unsafe integers.
    }], refreshPrivacy);
    this.assertCurrentConnection(connection);
    const current = this.getCachedReadSummary();
    if (!current || !equalConversationReadSummaries(raw, current)) throw new Error('本地已读摘要已变化，请重新查询');
    return { raw, privacy, ...filterReadReceipt(raw, privacy) };
  }

  /** 从桌面 v2 会话详情刷新当前稳定对象。 */
  async refresh(): Promise<this> {
    const result = await this.account.refreshContactAddresses([await this.prepareAddress()]);
    if (result.statusCode !== 0) {
      throw new Error(`刷新会话失败: status=${result.statusCode} ${result.statusMsg}`.trim());
    }
    return this;
  }

  async deleteConversation(): Promise<ImActionResponse> {
    const connection = this.account.im;
    this.assertCurrentConnection(connection);
    // Desktop resolves an existing local conversation; deleting a Friend must not lazily create one.
    const conversation = this.account.cachedConversation(this.threadId);
    if (!conversation) throw new Error(`本地会话不存在: ${this.threadId}`);
    const conversationType = conversation.conversationType;
    if (conversationType !== 1 && conversationType !== 2) throw new Error(`不支持的会话类型: ${conversationType}`);
    const lastMessageIndex = this.account.getConversationDeletionBoundary(this.threadId);
    const result = await connection.deleteConversation({ threadId: conversation.conversationId,
      conversationShortId: conversation.conversationShortId, conversationType,
      inboxType: conversation.inboxType ?? 0, lastMessageIndex });
    this.assertCurrentConnection(connection);
    if (result.statusCode === 0) this.account.applyConversationDeletion(this.threadId, conversationType, lastMessageIndex);
    return result;
  }

  /** 给指定服务器消息添加或取消表态；emoji 使用抖音键值，如 `[爱心]`。 */
  async reactMsg(serverMessageId: string, emoji: string, enabled = true): Promise<ImActionResponse> {
    const operatorUid = this.account.im.myUid || this.account.imUid || this.account.uid;
    if (!operatorUid) throw new Error('当前账号缺少可用的 IM uid');
    return this.account.im.modifyMessageReaction({
      ...await this.prepareAddress(),
      serverMessageId,
      emoji,
      enabled,
      operatorUid,
    });
  }

  /** 当前仅发送 user_action；尚未覆盖 native 进入会话的补齐、表态已读与成员轮询。 */
  async enterConversation(): Promise<ImActionResponse> {
    return this.account.im.enterConversation(await this.prepareAddress());
  }

  async setMute(mute = true): Promise<ImActionResponse> {
    const connection = this.account.im;
    const address = await this.prepareAddress();
    this.assertCurrentConnection(connection);
    const result = await connection.setConversationSettings({ ...address, mute });
    this.assertCurrentConnection(connection);
    return result;
  }

  async setPinned(pinned = true): Promise<ImActionResponse> {
    const connection = this.account.im;
    const address = await this.prepareAddress();
    this.assertCurrentConnection(connection);
    const result = await connection.setConversationSettings({ ...address, pinned });
    this.assertCurrentConnection(connection);
    return result;
  }

  /** Friend 可在首次动作前懒创建 P2P 会话；Group/Stranger 直接返回已有地址。 */
  protected async prepareAddress(): Promise<Readonly<ConversationAddress>> {
    return this.resolveAddress();
  }

  protected assertCurrentConnection(connection: ImService): void {
    if (!this.account.online || this.account.im !== connection) {
      throw new Error('账号连接已变化，操作结果不再适用于当前登录；请先核对远端状态');
    }
  }

  protected override resolveAddress(): Readonly<ConversationAddress> {
    return {
      ...this.address,
      conversationShortId: this.account.resolveShortId(
        this.address.threadId,
        this.address.conversationShortId,
      ) ?? '',
    };
  }
}
