import type {
  ImActionResponse,
  MessageReferenceInfo,
  RecallMessageResponse,
  SendMessageResponse,
} from '../../services/im/types.js';
import { parseMessageContent, type ParsedMessageContent, type TextMention } from '../../services/im/content.js';
import { BaseEvent } from '../../base/event.js';
import type { Account } from '../account.js';
import type { ChatContact } from '../contacts/chat-contact.js';
import type { Friend } from '../contacts/friend.js';
import type { Group } from '../contacts/group.js';
import type { Stranger } from '../contacts/stranger.js';
import type { Member } from '../contacts/member.js';
import type { SendableMessage } from '../messaging/message.js';
import type { RawInboundMessage } from '../../base/raw/inbound-message.js';
import { SharedComment, SharedWork } from '../content/shared-content.js';

export abstract class MessageEvent extends BaseEvent<Account> {
  override readonly postType = 'message' as const;
  abstract override readonly type: 'message.private' | 'message.group' | 'message.stranger';
  abstract readonly chatType: 'private' | 'group' | 'stranger';
  readonly threadId: string;
  readonly conversationShortId: string;
  readonly conversationType: 1 | 2;
  readonly inboxType: number;
  readonly senderUid: string;
  readonly senderSecUid?: string;
  readonly serverMessageId?: string;
  readonly clientMessageId?: string;
  readonly indexInConversation?: string;
  readonly indexInConversationV2?: string;
  readonly createTime?: string;
  readonly status?: number;
  readonly version?: string;
  readonly orderInConversation?: string;
  readonly ext: Readonly<Record<string, string>>;
  readonly referenceInfo?: MessageReferenceInfo;
  readonly text: string;
  readonly content: ParsedMessageContent;
  readonly rawContent: string;
  readonly messageType: number;
  readonly mentions: readonly TextMention[];
  readonly isMentionMe: boolean;
  readonly work: SharedWork | undefined;
  readonly comment: SharedComment | undefined;

  protected constructor(inbound: RawInboundMessage, account: Account, private readonly contact: ChatContact) {
    super(account, inbound.raw, eventTime(inbound));
    this.threadId = inbound.threadId;
    this.conversationShortId = inbound.conversationShortId;
    this.conversationType = inbound.conversationType === 2 ? 2 : 1;
    this.inboxType = inbound.inboxType ?? 0;
    this.senderUid = inbound.senderUid;
    if (inbound.senderSecUid) this.senderSecUid = inbound.senderSecUid;
    if (inbound.serverMessageId) this.serverMessageId = inbound.serverMessageId;
    if (inbound.clientMessageId) this.clientMessageId = inbound.clientMessageId;
    if (inbound.indexInConversation) this.indexInConversation = inbound.indexInConversation;
    if (inbound.indexInConversationV2) this.indexInConversationV2 = inbound.indexInConversationV2;
    if (inbound.createTime) this.createTime = inbound.createTime;
    if (inbound.status !== undefined) this.status = inbound.status;
    if (inbound.version) this.version = inbound.version;
    if (inbound.orderInConversation) this.orderInConversation = inbound.orderInConversation;
    this.ext = inbound.ext ?? Object.freeze({});
    if (inbound.referenceInfo) this.referenceInfo = inbound.referenceInfo;
    this.text = inbound.text;
    this.content = parseMessageContent(inbound.rawContent, inbound.messageType);
    this.rawContent = inbound.rawContent;
    this.messageType = inbound.messageType;
    this.mentions = Object.freeze(this.content.kind === 'text' ? [...(this.content.mentions ?? [])] : []);
    const ownUids = new Set([account.imUid, account.uid].filter((uid): uid is string => Boolean(uid)));
    this.isMentionMe = this.mentions.some((mention) => ownUids.has(mention.uid));
    if (this.content.kind === 'share') {
      this.work = SharedWork.bind(this.content.share.itemId, {
        title: this.content.share.title,
        authorUid: this.content.share.authorUid,
        authorSecUid: this.content.share.authorSecUid,
      }, (ids) => this.contact.getSharedWorkDetails(ids), account);
      this.comment = undefined;
    } else if (this.content.kind === 'comment') {
      this.work = SharedWork.bind(
        this.content.comment.workId,
        {},
        (ids) => this.contact.getSharedWorkDetails(ids),
        account,
      );
      this.comment = SharedComment.bind(this.content.comment.commentId, {
        text: this.content.text,
        authorName: this.content.comment.authorName,
        coverUrl: this.content.comment.coverUrl,
      }, (ids) => this.contact.getSharedCommentStatuses(ids), account);
    } else {
      this.work = undefined;
      this.comment = undefined;
    }
  }

  get isGroup(): boolean {
    return this.conversationType === 2;
  }

  static fromInbound(inbound: RawInboundMessage, account: Account): MessageEvent {
    if (inbound.conversationType === 2 || /^\d+$/.test(inbound.threadId)) {
      return GroupMessageEvent.fromInbound(inbound, account);
    }
    // Desktop uses inbox 1 for ordinary chats too. Stranger-box membership is
    // conversation state, not a transport inbox number or a follow relationship.
    const conversation = account.cachedConversation(inbound.threadId);
    const isStranger = conversation?.isInStrangerBox
      ?? (!account.cachedFriend(inbound.senderUid)
        && account.cachedStranger(inbound.senderUid)?.threadId === inbound.threadId);
    if (isStranger) return StrangerMessageEvent.fromInbound(inbound, account);
    return PrivateMessageEvent.fromInbound(inbound, account);
  }

  reply(message: SendableMessage): Promise<SendMessageResponse> {
    return this.contact.sendMsg(message);
  }

  /** 查询此消息的已读展示策略，不生成读者名单、不标记已读。 */
  getReadPrivacy(refresh = false) {
    if (!this.serverMessageId || !this.createTime || !/^\d+$/.test(this.createTime)) {
      throw new Error('消息缺少 serverMessageId 或原始 createTime');
    }
    return this.account.getMessageReadPrivacy([{
      serverMessageId: this.serverMessageId,
      conversationId: this.threadId,
      conversationShortId: this.conversationShortId,
      conversationType: this.conversationType,
      createTime: Number(this.createTime), // Keep wire time, NOT BaseEvent.time (seconds).
    }], refresh);
  }

  forwardTo(target: ChatContact): Promise<SendMessageResponse> {
    return target.forwardMsg(this);
  }

  quote(text: string): Promise<SendMessageResponse> {
    if (!this.serverMessageId) throw new Error('MessageEvent: no server message id');
    return this.reply({
      type: 'reply', text,
      referencedMessageId: this.serverMessageId,
      referencedMessageType: this.messageType,
      referencedUid: this.senderUid,
      ...(this.senderSecUid ? { referencedSecUid: this.senderSecUid } : {}),
      referencedText: this.text,
    });
  }

  recall(): Promise<RecallMessageResponse> {
    if (!this.serverMessageId) throw new Error('MessageEvent: no server message id');
    return this.contact.recallMsg(this.serverMessageId);
  }

  delete(): Promise<ImActionResponse> {
    if (this.clientMessageId) return this.contact.deleteMsg({ clientMessageId: this.clientMessageId });
    if (!this.serverMessageId) throw new Error('MessageEvent: no server message id');
    return this.contact.deleteMsg(this.serverMessageId);
  }

  /** 仅删除当前账号的本地记录，不请求服务端。 */
  deleteLocal(): boolean {
    if (this.clientMessageId) return this.contact.deleteLocalMsg({ clientMessageId: this.clientMessageId });
    if (!this.serverMessageId) throw new Error('MessageEvent: no server message id');
    return this.contact.deleteLocalMsg(this.serverMessageId);
  }

  /** 对当前消息添加或取消表态。 */
  react(emoji: string, enabled = true): Promise<ImActionResponse> {
    if (!this.serverMessageId) throw new Error('MessageEvent: no server message id');
    return this.contact.reactMsg(this.serverMessageId, emoji, enabled);
  }

  markRead(): Promise<ImActionResponse> {
    if (!this.serverMessageId) throw new Error('MessageEvent: no server message id');
    return this.contact.markRead({
      serverMessageId: this.serverMessageId,
      ...(this.indexInConversation ? { indexInConversation: this.indexInConversation } : {}),
      ...(this.indexInConversationV2 ? { indexInConversationV2: this.indexInConversationV2 } : {}),
      readBadgeCount: 1,
    });
  }

}

export class PrivateMessageEvent extends MessageEvent {
  override readonly type = 'message.private' as const;
  override readonly chatType = 'private' as const;
  readonly friend: Friend;

  private constructor(inbound: RawInboundMessage, account: Account, friend: Friend) {
    super(inbound, account, friend);
    this.friend = friend;
  }

  static override fromInbound(inbound: RawInboundMessage, account: Account): PrivateMessageEvent {
    const friend = account.bindFriend(
      inbound.senderUid,
      inbound.threadId,
      inbound.conversationShortId,
      inbound.senderSecUid ? { secUid: inbound.senderSecUid } : {},
    );
    return new PrivateMessageEvent(inbound, account, friend);
  }
}

export class GroupMessageEvent extends MessageEvent {
  override readonly type = 'message.group' as const;
  override readonly chatType = 'group' as const;
  readonly group: Group;
  readonly member: Member;

  private constructor(inbound: RawInboundMessage, account: Account, group: Group) {
    super(inbound, account, group);
    this.group = group;
    this.member = group.ensureMember({
      uid: inbound.senderUid,
      role: group.pickMember(inbound.senderUid)?.role ?? 0,
      ...(inbound.senderSecUid ? { secUid: inbound.senderSecUid } : {}),
    });
  }

  static override fromInbound(inbound: RawInboundMessage, account: Account): GroupMessageEvent {
    const group = account.bindGroup(inbound.threadId, inbound.conversationShortId || inbound.threadId, {
      inboxType: inbound.inboxType ?? 0,
    });
    return new GroupMessageEvent(inbound, account, group);
  }

}

export class StrangerMessageEvent extends MessageEvent {
  override readonly type = 'message.stranger' as const;
  override readonly chatType = 'stranger' as const;
  readonly stranger: Stranger;

  private constructor(inbound: RawInboundMessage, account: Account, stranger: Stranger) {
    super(inbound, account, stranger);
    this.stranger = stranger;
  }

  static override fromInbound(
    inbound: RawInboundMessage,
    account: Account,
  ): StrangerMessageEvent {
    const stranger = account.bindStranger(
      inbound.senderUid,
      inbound.threadId,
      inbound.conversationShortId,
      inbound.senderSecUid ? { secUid: inbound.senderSecUid } : {},
    );
    return new StrangerMessageEvent(inbound, account, stranger);
  }
}

function eventTime(inbound: RawInboundMessage): number | string | undefined {
  const value = inbound.createTime ??
    inbound.raw['createTime'] ?? inbound.raw['create_time'] ?? inbound.raw['timestamp'];
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}
