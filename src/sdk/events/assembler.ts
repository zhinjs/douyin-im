import type { ImNotice, PrivateMessage } from '../../services/im/types.js';
import { GroupJoinRequestStatus } from '../../services/im/types.js';
import { isDesktopMessageDisplayable, isDesktopMessageVisible } from '../../services/im/message-display.js';
import { messageClientId } from '../../services/im/message-cache.js';
import type { Account } from '../account.js';
import type { Group } from '../contacts/group.js';
import type { RawInboundMessage } from '../../base/raw/inbound-message.js';
import {
  GroupMessageEvent,
  MessageEvent,
  PrivateMessageEvent,
  StrangerMessageEvent,
} from './message.js';
import {
  bindFriendMarkedReadNotice,
  bindGroupAdminNotices,
  bindGroupAvatarChangeNotice,
  bindGroupMarkedReadNotice,
  bindGroupMemberDecreaseNotices,
  bindGroupMemberIncreaseNotices,
  bindGroupNameChangeNotice,
  bindNoticeAccount,
  MessageUpdateNoticeEvent,
  MessageDeleteNoticeEvent,
  MessageBatchUpdateNoticeEvent,
  MessageListUpdateNoticeEvent,
  type ConversationMessageUpdate,
  type AnyNoticeEvent,
} from './notice.js';
import type { AnyRequestEvent } from './request.js';
import { getLogger } from '../../logger.js';

const logger = getLogger('Events:Assembler');

export interface EventAssemblerHooks {
  /** Merge raw state first; false suppresses event/contact construction, not the state update. */
  acceptMessage?: (inbound: RawInboundMessage) => boolean;
  onMessage: (event: MessageEvent) => void;
  onNotice?: (event: AnyNoticeEvent) => void;
  onRequest?: (event: AnyRequestEvent) => void;
}

/**
 * Raw IM DTO -> stable SDK objects.
 *
 * This is the only module allowed to combine protocol signals, Account caches,
 * contacts and concrete Event classes. Stable caches are updated before hooks run.
 */
export class EventAssembler {
  private readonly threadShortIds = new Map<string, string>();
  private readonly emittedJoinRequestIds = new Set<string>();
  private joinRequestRefreshTask?: Promise<void>;
  private generation = 0;
  private cleared = false;

  constructor(
    private readonly account: Account,
    private readonly hooks: EventAssemblerHooks,
    private readonly platformUid: string,
  ) {}

  rememberConversation(threadId: string, conversationShortId: string): void {
    if (threadId && conversationShortId) this.threadShortIds.set(threadId, conversationShortId);
  }

  resolveShortId(threadId: string, hint?: string): string | undefined {
    return hint || this.threadShortIds.get(threadId) || (/^\d+$/.test(threadId) ? threadId : undefined);
  }

  receiveMessage(inbound: RawInboundMessage): void {
    if (this.cleared) return;
    if (inbound.conversationType !== 1 && inbound.conversationType !== 2) {
      logger.warn('忽略未支持的会话类型: %s', inbound.conversationType);
      return;
    }
    this.rememberConversation(inbound.threadId, inbound.conversationShortId);
    if (this.hooks.acceptMessage?.(inbound) === false) return;
    const event = MessageEvent.fromInbound(inbound, this.account);
    if (event instanceof PrivateMessageEvent) this.account.rememberFriend(event.friend);
    else if (event instanceof StrangerMessageEvent) this.account.rememberStranger(event.stranger);
    else if (event instanceof GroupMessageEvent) this.account.rememberGroup(event.group);
    this.hooks.onMessage(event);
  }

  receiveNotice(notice: ImNotice): void {
    if (this.cleared) return;
    if (notice.type === 'im.command') {
      if (!this.account.applyConversationCommand(notice.messageType, notice.content, notice.conversationId, notice.raw)) {
        this.account.applySettingCommand(notice.messageType, notice.content, notice.raw);
      }
    }
    if (notice.type === 'message.delete') {
      this.account.applyMessageDeletionCommand(notice.conversationId, notice.serverMessageId, notice.raw);
      return;
    }
    if (notice.type === 'message.recall') {
      const target = this.account.markCachedMessageRecalled(notice.conversationId, notice);
      if (target) notice = { ...notice, serverMessageId: target.msgId,
        ...(target.clientMessageId ? { clientMessageId: target.clientMessageId } : {}) };
    }
    if (notice.type === 'friend.add-request') {
      const applicantUid = this.isSelfUid(notice.applicantUid)
        ? [notice.fromUid, notice.toUid].find(
            (uid): uid is string => Boolean(uid && !this.isSelfUid(uid)),
          )
        : notice.applicantUid;
      if (applicantUid) this.hooks.onNotice?.(bindNoticeAccount({ ...notice, applicantUid }, this.account));
      return;
    }
    if (notice.type === 'group.join-request') {
      this.scheduleJoinRequestRefresh(notice);
      return;
    }
    if (notice.type === 'group.member-increase') {
      const group = this.bindNoticeGroup(notice.conversationId, notice.conversationShortId);
      for (const event of bindGroupMemberIncreaseNotices(notice, this.account, group)) {
        this.hooks.onNotice?.(event);
      }
      return;
    }
    if (notice.type === 'group.member-decrease') {
      const group = this.bindNoticeGroup(notice.conversationId, notice.conversationShortId);
      for (const event of bindGroupMemberDecreaseNotices(notice, this.account, group)) {
        // A system-message member hint is not Desktop's explicit conversation deletion command.
        this.hooks.onNotice?.(event);
      }
      return;
    }
    if (notice.type === 'group.admin') {
      const group = this.bindNoticeGroup(notice.conversationId, notice.conversationShortId);
      for (const event of bindGroupAdminNotices(notice, this.account, group)) {
        this.hooks.onNotice?.(event);
      }
      return;
    }
    if (notice.type === 'group.name-change') {
      const group = this.bindNoticeGroup(notice.conversationId, notice.conversationShortId);
      this.hooks.onNotice?.(bindGroupNameChangeNotice(notice, this.account, group));
      return;
    }
    if (notice.type === 'group.avatar-change') {
      const group = this.bindNoticeGroup(notice.conversationId, notice.conversationShortId);
      this.hooks.onNotice?.(bindGroupAvatarChangeNotice(notice, this.account, group));
      return;
    }
    if (notice.type === 'conversation.read') {
      if (notice.readerUid && !this.account.applyParticipantReadIndex(notice.conversationId, notice.readerUid, notice.readMessageIndex)) return;
      this.receiveMarkedReadNotice(notice);
      return;
    }
    if (
      (notice.type === 'friend.increase' || notice.type === 'friend.decrease') &&
      this.isSelfUid(notice.peerUid)
    ) {
      const peerUid = [notice.fromUid, notice.toUid].find(
        (uid): uid is string => Boolean(uid && !this.isSelfUid(uid)),
      );
      if (peerUid) notice = { ...notice, peerUid };
    }
    const event = bindNoticeAccount(notice, this.account);
    if (event.type === 'friend.decrease') this.account.forgetFriend(event.peerUid);
    this.hooks.onNotice?.(event);
  }

  /** @internal Ordinary upserts carry merged snapshots even when no new-message event follows. */
  receiveMessageUpdate(inbound: Pick<RawInboundMessage, 'conversationType' | 'raw'>, message: PrivateMessage): void {
    if (this.cleared || !isDesktopMessageDisplayable(message)) return;
    this.hooks.onNotice?.(new MessageUpdateNoticeEvent(this.account, inbound.conversationType, message, inbound.raw));
  }

  /** Native event18 filters before main's nonempty-list gate, then main filters empty content. */
  receiveMessageListUpdate(messages: readonly PrivateMessage[]): void {
    if (this.cleared) return;
    const visible = messages.filter(message => isDesktopMessageVisible(message));
    if (!visible.length) return;
    this.hooks.onNotice?.(new MessageListUpdateNoticeEvent(this.account, visible.filter(message => !!message.content)));
  }

  /** @internal Native delete skips messageIsVisible; only main's client/content mapper gate applies. */
  receiveMessageDelete(message: PrivateMessage, raw: Record<string, unknown>): void {
    if (this.cleared || !messageClientId(message) || !message.content) return;
    const conversationType = message.conversationType ?? this.account.cachedConversation(message.threadId)?.conversationType ?? 0;
    this.hooks.onNotice?.(new MessageDeleteNoticeEvent(this.account, conversationType, message, raw));
  }

  /** @internal Project an already-persisted native-style batch, without inventing absent conversations. */
  receiveMessageBatch(messages: readonly PrivateMessage[], deletedClientMessageIds: readonly string[] = [], raw: Record<string, unknown> = {}, updatedConversationIds: readonly string[] = []): void {
    if (this.cleared || (!messages.length && !deletedClientMessageIds.length && !updatedConversationIds.length)) return;
    const grouped = new Map<string, Map<string, PrivateMessage>>();
    for (const id of updatedConversationIds) grouped.set(id, new Map());
    for (const message of messages) {
      let conversation = grouped.get(message.threadId);
      if (!conversation) grouped.set(message.threadId, conversation = new Map());
      conversation.set(messageClientId(message), message);
    }
    const updates: ConversationMessageUpdate[] = [];
    for (const [id, messagesByClient] of grouped) {
      const conversation = this.account.cachedConversation(id);
      if (!conversation) continue;
      updates.push({ conversation, messages: [...messagesByClient.values()].filter(message => isDesktopMessageDisplayable(message)) });
    }
    // Native checks emptiness before filtering; nonempty input can project an empty batch.
    this.hooks.onNotice?.(new MessageBatchUpdateNoticeEvent(this.account, updates, deletedClientMessageIds, raw));
  }

  clear(): void {
    this.cleared = true;
    this.generation += 1;
    this.threadShortIds.clear();
    this.emittedJoinRequestIds.clear();
    delete this.joinRequestRefreshTask;
  }

  private bindNoticeGroup(conversationId: string, conversationShortId: string): Group {
    const group = this.account.bindGroup(conversationId || conversationShortId, conversationShortId);
    this.account.rememberGroup(group);
    return group;
  }

  private isSelfUid(uid: string): boolean {
    return uid === this.platformUid || uid === this.account.uid || uid === this.account.imUid;
  }

  private receiveMarkedReadNotice(
    notice: Extract<ImNotice, { type: 'conversation.read' }>,
  ): void {
    if (notice.conversationType === 2) {
      const group = this.bindNoticeGroup(
        notice.conversationId,
        this.resolveShortId(notice.conversationId) ?? notice.conversationId,
      );
      this.hooks.onNotice?.(bindGroupMarkedReadNotice(notice, this.account, group));
      return;
    }
    if (notice.conversationType !== 1) {
      this.hooks.onNotice?.(bindNoticeAccount({
        type: 'im.command',
        conversationId: notice.conversationId,
        conversationType: notice.conversationType,
        messageType: 0,
        content: 'unsupported mark-read conversation type',
        raw: notice.raw,
      }, this.account));
      return;
    }
    const cached = this.account.cachedFriendByThreadId(notice.conversationId);
    const peerUid = cached?.uid ?? this.privatePeerUid(notice.conversationId);
    if (!peerUid) {
      this.hooks.onNotice?.(bindNoticeAccount({
        type: 'im.command',
        conversationId: notice.conversationId,
        conversationType: notice.conversationType,
        messageType: 0,
        content: 'unable to resolve mark-read private peer',
        raw: notice.raw,
      }, this.account));
      return;
    }
    const friend = cached ?? this.account.bindFriend(
      peerUid,
      notice.conversationId,
      this.resolveShortId(notice.conversationId) ?? '',
    );
    this.account.rememberFriend(friend);
    this.hooks.onNotice?.(bindFriendMarkedReadNotice(notice, this.account, friend));
  }

  private privatePeerUid(threadId: string): string | undefined {
    const participants = threadId.split(':').slice(2).filter(Boolean);
    if (participants.length === 0) return undefined;
    const ownIds = new Set([
      this.account.imUid,
      this.account.uid,
      this.platformUid,
    ].filter((value): value is string => Boolean(value)));
    return participants.find((uid) => !ownIds.has(uid)) ?? participants.at(-1);
  }

  private scheduleJoinRequestRefresh(
    signal: Extract<ImNotice, { type: 'group.join-request' }>,
  ): void {
    const previous = this.joinRequestRefreshTask ?? Promise.resolve();
    const generation = this.generation;
    const task = previous.catch(() => undefined).then(() => this.refreshJoinRequests(signal, generation));
    this.joinRequestRefreshTask = task;
    void task.catch((error) => {
      logger.warn('刷新入群申请失败: %s', error instanceof Error ? error.message : error);
    }).finally(() => {
      if (this.joinRequestRefreshTask === task) delete this.joinRequestRefreshTask;
    });
  }

  private async refreshJoinRequests(
    signal: Extract<ImNotice, { type: 'group.join-request' }>,
    generation: number,
  ): Promise<void> {
    const response = await this.account.getGroupJoinRequestData();
    if (generation !== this.generation) return;
    if (response.statusCode !== 0) {
      throw new Error(`status=${response.statusCode}${response.statusMsg ? ` ${response.statusMsg}` : ''}`);
    }
    for (const data of response.requests) {
      if (data.status !== GroupJoinRequestStatus.PENDING) continue;
      if (signal.requestId && data.requestId !== signal.requestId) continue;
      if (this.emittedJoinRequestIds.has(data.requestId)) continue;
      const signalMatchesGroup =
        signal.conversationShortId === data.groupShortId && /^\d+$/.test(signal.conversationId);
      const group = this.account.bindGroup(
        signalMatchesGroup ? signal.conversationId : data.groupShortId,
        data.groupShortId,
      );
      this.account.rememberGroup(group);
      const request = group.ensureJoinRequest(data);
      this.emittedJoinRequestIds.add(data.requestId);
      this.hooks.onRequest?.(request);
    }
  }
}
