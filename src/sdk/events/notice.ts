import { BaseEvent } from '../../base/event.js';
import type { ConversationReadSummary } from '../../services/im/read-state.js';
import type { ImNotice, ImConversation, PrivateMessage } from '../../services/im/types.js';
import type { Account } from '../account.js';
import type { Friend } from '../contacts/friend.js';
import type { Group } from '../contacts/group.js';
import { MemberRole, type Member } from '../contacts/member.js';

type ProtocolOnlyNotice = Exclude<
  ImNotice,
  | { type: 'group.join-request' }
  | { type: 'group.member-increase' }
  | { type: 'group.member-decrease' }
  | { type: 'group.admin' }
  | { type: 'group.name-change' }
  | { type: 'group.avatar-change' }
  | { type: 'conversation.read' }
  | { type: 'message.delete' }
>;

export abstract class NoticeEvent extends BaseEvent<Account> {
  override readonly postType = 'notice' as const;
  abstract override readonly type: string;
}

/** Raw onConversationReadIndexChange batch; not a privacy-filtered receipt or a single-conversation event. */
export class ConversationReadSummaryNoticeEvent extends NoticeEvent {
  override readonly type = 'conversation.read-summary' as const;
  readonly summaries: readonly (Readonly<Omit<ConversationReadSummary, 'readUsers'>> & {
    readonly readUsers: readonly Readonly<ConversationReadSummary['readUsers'][number]>[];
  })[];

  constructor(account: Account, summaries: readonly ConversationReadSummary[]) {
    super(account, {});
    this.summaries = Object.freeze(structuredClone(summaries).map(summary => Object.freeze({
      ...summary, readUsers: Object.freeze(summary.readUsers.map(row => Object.freeze(row))),
    })));
  }
}

export interface ConversationMessageUpdate {
  readonly conversation: Readonly<ImConversation>;
  readonly messages: readonly Readonly<PrivateMessage>[];
}

/** Desktop onBatchUpdateMessages (18): flat, ordered, possibly repeated messages; not onBatchUpdateConvMsg. */
export class MessageListUpdateNoticeEvent extends NoticeEvent {
  override readonly type = 'message.list-update' as const;
  readonly messages: readonly Readonly<PrivateMessage>[];

  constructor(account: Account, messages: readonly PrivateMessage[], raw: Record<string, unknown> = {}) {
    super(account, raw, eventTime(raw));
    this.messages = Object.freeze(messages.map(message => Object.freeze(structuredClone(message))));
  }
}

/** SDK projection of onBatchUpdateConvMsg; it may span multiple conversations. */
export class MessageBatchUpdateNoticeEvent extends NoticeEvent {
  override readonly type = 'message.batch-update' as const;
  readonly updates: readonly ConversationMessageUpdate[];
  /** Desktop deletedMsgs carries client IDs, never server IDs. */
  readonly deletedClientMessageIds: readonly string[];

  constructor(account: Account, updates: readonly ConversationMessageUpdate[], deletedClientMessageIds: readonly string[], raw: Record<string, unknown>) {
    super(account, raw, eventTime(raw));
    this.updates = Object.freeze(structuredClone(updates).map(update => Object.freeze({
      conversation: Object.freeze(update.conversation), messages: Object.freeze(update.messages.map(message => Object.freeze(message))),
    })));
    this.deletedClientMessageIds = Object.freeze([...deletedClientMessageIds]);
  }
}

export abstract class ConversationNoticeEvent extends NoticeEvent {
  readonly conversationId: string;
  readonly conversationType: number;

  protected constructor(
    account: Account,
    conversationId: string,
    conversationType: number,
    raw: Record<string, unknown>,
  ) {
    super(account, raw, eventTime(raw));
    this.conversationId = conversationId;
    this.conversationType = conversationType;
  }
}

export class ConversationUpdateNoticeEvent extends ConversationNoticeEvent {
  override readonly type = 'conversation.update' as const;
  /** Account-local snapshot at dispatch; raw protocol notices do not imply a fresh HTTP query. */
  readonly conversation: Readonly<ImConversation> | undefined;

  constructor(notice: Extract<ImNotice, { type: 'conversation.update' }>, account: Account) {
    super(account, notice.conversationId, notice.conversationType, notice.raw);
    const conversation = account.cachedConversation(notice.conversationId);
    this.conversation = conversation && Object.freeze(structuredClone(conversation));
  }
}

export class ConversationMinIndexNoticeEvent extends ConversationNoticeEvent {
  override readonly type = 'conversation.min-index' as const;
  readonly minIndex: string;

  constructor(notice: Extract<ImNotice, { type: 'conversation.min-index' }>, account: Account) {
    super(account, notice.conversationId, notice.conversationType, notice.raw);
    this.minIndex = notice.minIndex;
  }
}

export class ConversationDeleteNoticeEvent extends ConversationNoticeEvent {
  override readonly type = 'conversation.delete' as const;

  constructor(notice: Extract<ImNotice, { type: 'conversation.delete' }>, account: Account) {
    super(account, notice.conversationId, notice.conversationType, notice.raw);
  }
}

/** Native event28 carries UID values only; no actor or kick/leave reason is implied. */
export class ConversationMembersRemovedNoticeEvent extends ConversationNoticeEvent {
  override readonly type = 'conversation.members-remove' as const;
  readonly memberUids: readonly string[];

  constructor(notice: Extract<ImNotice, { type: 'conversation.members-remove' }>, account: Account) {
    super(account, notice.conversationId, notice.conversationType, notice.raw);
    this.memberUids = Object.freeze([...notice.memberUids]);
  }
}

export abstract class MarkedReadNoticeEvent extends ConversationNoticeEvent {
  readonly readMessageIndex: string;
  readonly readMessageIndexV2: string | undefined;
  /** 有值表示其他用户的50013普通游标更新，不等于已通过隐私过滤的读者名单。 */
  readonly readerUid: string | undefined;

  protected constructor(
    notice: Extract<ImNotice, { type: 'conversation.read' }>,
    account: Account,
  ) {
    super(account, notice.conversationId, notice.conversationType, notice.raw);
    this.readMessageIndex = notice.readMessageIndex;
    this.readMessageIndexV2 = notice.readMessageIndexV2;
    this.readerUid = notice.readerUid;
  }
}

export class FriendMarkedReadNoticeEvent extends MarkedReadNoticeEvent {
  override readonly type = 'friend.marked-read' as const;
  readonly friend: Friend;

  constructor(
    notice: Extract<ImNotice, { type: 'conversation.read' }>,
    account: Account,
    friend: Friend,
  ) {
    super(notice, account);
    this.friend = friend;
  }
}

export class GroupMarkedReadNoticeEvent extends MarkedReadNoticeEvent {
  override readonly type = 'group.marked-read' as const;
  readonly group: Group;

  constructor(
    notice: Extract<ImNotice, { type: 'conversation.read' }>,
    account: Account,
    group: Group,
  ) {
    super(notice, account);
    this.group = group;
  }
}

export abstract class MessageNoticeEvent extends ConversationNoticeEvent {
  readonly serverMessageId: string | undefined;

  protected constructor(
    account: Account,
    conversationId: string,
    conversationType: number,
    serverMessageId: string | undefined,
    raw: Record<string, unknown>,
  ) {
    super(account, conversationId, conversationType, raw);
    this.serverMessageId = serverMessageId;
  }
}

/** A merged message snapshot, separate from new-message delivery and its reply handlers. */
export class MessageUpdateNoticeEvent extends MessageNoticeEvent {
  override readonly type = 'message.update' as const;
  readonly message: Readonly<PrivateMessage>;
  readonly clientMessageId: string | undefined;

  constructor(account: Account, conversationType: number, message: PrivateMessage, raw: Record<string, unknown>) {
    super(account, message.threadId, conversationType, message.msgId || undefined, raw);
    this.message = Object.freeze(structuredClone(message));
    this.clientMessageId = message.clientMessageId;
  }
}

/** The original target snapshot, not a synthetic message or a recall notification. */
export class MessageDeleteNoticeEvent extends MessageNoticeEvent {
  override readonly type = 'message.delete' as const;
  readonly message: Readonly<PrivateMessage>;
  readonly clientMessageId: string | undefined;

  constructor(account: Account, conversationType: number, message: PrivateMessage, raw: Record<string, unknown>) {
    super(account, message.threadId, conversationType, message.msgId || undefined, raw);
    this.message = Object.freeze(structuredClone(message));
    this.clientMessageId = message.clientMessageId;
  }
}

export class MessageRecallNoticeEvent extends MessageNoticeEvent {
  override readonly type = 'message.recall' as const;
  readonly clientMessageId: string | undefined;

  constructor(notice: Extract<ImNotice, { type: 'message.recall' }>, account: Account) {
    super(
      account,
      notice.conversationId,
      notice.conversationType,
      notice.serverMessageId,
      notice.raw,
    );
    this.clientMessageId = notice.clientMessageId;
  }
}

export class MessageReactionNoticeEvent extends MessageNoticeEvent {
  override readonly type = 'message.reaction' as const;
  readonly operatorUid: string;
  readonly emoji: string;
  readonly enabled: boolean;
  readonly clientMessageId: string | undefined;

  constructor(notice: Extract<ImNotice, { type: 'message.reaction' }>, account: Account) {
    super(
      account,
      notice.conversationId,
      notice.conversationType,
      notice.serverMessageId,
      notice.raw,
    );
    this.operatorUid = notice.operatorUid;
    this.emoji = notice.emoji;
    this.enabled = notice.enabled;
    this.clientMessageId = notice.clientMessageId;
  }
}

export abstract class GroupNoticeEvent extends ConversationNoticeEvent {
  readonly group: Group;

  protected constructor(account: Account, group: Group, raw: Record<string, unknown>) {
    super(account, group.threadId, 2, raw);
    this.group = group;
  }
}

export abstract class GroupMemberChangeNoticeEvent extends GroupNoticeEvent {
  readonly member: Member;
  readonly operator: Member | undefined;
  readonly operators: readonly Member[];

  protected constructor(
    account: Account,
    group: Group,
    member: Member,
    operators: readonly Member[],
    raw: Record<string, unknown>,
  ) {
    super(account, group, raw);
    this.member = member;
    this.operators = Object.freeze([...operators]);
    this.operator = operators[0];
  }
}

export class GroupMemberIncreaseNoticeEvent extends GroupMemberChangeNoticeEvent {
  override readonly type: 'group.member-increase' | 'group.invite' = 'group.member-increase';
  readonly source: Extract<ImNotice, { type: 'group.member-increase' }>['source'];

  constructor(
    notice: Extract<ImNotice, { type: 'group.member-increase' }>,
    account: Account,
    group: Group,
    member: Member,
    operators: readonly Member[],
  ) {
    super(account, group, member, operators, notice.raw);
    this.source = notice.source;
  }
}

/** An invite has completed and the member is already part of the group. */
export class GroupInviteNoticeEvent extends GroupMemberIncreaseNoticeEvent {
  override readonly type = 'group.invite' as const;
  declare readonly source: 'invite';

  constructor(
    notice: Extract<ImNotice, { type: 'group.member-increase' }> & { source: 'invite' },
    account: Account,
    group: Group,
    member: Member,
    operators: readonly Member[],
  ) {
    super(notice, account, group, member, operators);
  }
}

export class GroupMemberDecreaseNoticeEvent extends GroupMemberChangeNoticeEvent {
  override readonly type = 'group.member-decrease' as const;
  readonly source: Extract<ImNotice, { type: 'group.member-decrease' }>['source'];
  readonly isSelf: boolean;

  constructor(
    notice: Extract<ImNotice, { type: 'group.member-decrease' }>,
    account: Account,
    group: Group,
    member: Member,
    operators: readonly Member[],
  ) {
    super(account, group, member, operators, notice.raw);
    this.source = notice.source;
    this.isSelf = member.uid === account.imUid || member.uid === account.uid;
  }
}

export class GroupAdminNoticeEvent extends GroupMemberChangeNoticeEvent {
  override readonly type = 'group.admin' as const;
  readonly enabled = true as const;

  constructor(
    notice: Extract<ImNotice, { type: 'group.admin' }>,
    account: Account,
    group: Group,
    member: Member,
    operators: readonly Member[],
  ) {
    super(account, group, member, operators, notice.raw);
  }
}

export abstract class GroupMetadataChangeNoticeEvent extends GroupNoticeEvent {
  readonly operator: Member | undefined;
  readonly operators: readonly Member[];

  protected constructor(
    account: Account,
    group: Group,
    operators: readonly Member[],
    raw: Record<string, unknown>,
  ) {
    super(account, group, raw);
    this.operators = Object.freeze([...operators]);
    this.operator = operators[0];
  }
}

export class GroupNameChangeNoticeEvent extends GroupMetadataChangeNoticeEvent {
  override readonly type = 'group.name-change' as const;
  readonly name: string | undefined;

  constructor(
    notice: Extract<ImNotice, { type: 'group.name-change' }>,
    account: Account,
    group: Group,
    operators: readonly Member[],
  ) {
    super(account, group, operators, notice.raw);
    this.name = notice.name;
  }
}

export class GroupAvatarChangeNoticeEvent extends GroupMetadataChangeNoticeEvent {
  override readonly type = 'group.avatar-change' as const;
  readonly avatar: string | undefined;

  constructor(
    notice: Extract<ImNotice, { type: 'group.avatar-change' }>,
    account: Account,
    group: Group,
    operators: readonly Member[],
  ) {
    super(account, group, operators, notice.raw);
    this.avatar = notice.avatar;
  }
}

export abstract class FriendRelationshipNoticeEvent extends NoticeEvent {
  readonly peerUid: string;
  readonly fromUid: string | undefined;
  readonly toUid: string | undefined;
  readonly content: string | undefined;
  readonly ext: Readonly<Record<string, string>>;

  protected constructor(
    notice: Extract<ImNotice, { type: 'friend.increase' | 'friend.decrease' }>,
    account: Account,
  ) {
    super(account, notice.raw, eventTime(notice.raw));
    this.peerUid = notice.peerUid;
    this.fromUid = notice.fromUid;
    this.toUid = notice.toUid;
    this.content = notice.content;
    this.ext = notice.ext ?? {};
  }
}

/** cmd508 只表明好友申请状态发生变化；Desktop 没有桥接审核动作。 */
export class FriendAddRequestNoticeEvent extends NoticeEvent {
  override readonly type = 'friend.add-request' as const;
  readonly applicantUid: string;
  readonly fromUid: string | undefined;
  readonly toUid: string | undefined;
  readonly content: string | undefined;
  readonly ext: Readonly<Record<string, string>>;

  constructor(
    notice: Extract<ImNotice, { type: 'friend.add-request' }>,
    account: Account,
  ) {
    super(account, notice.raw, eventTime(notice.raw));
    this.applicantUid = notice.applicantUid;
    this.fromUid = notice.fromUid;
    this.toUid = notice.toUid;
    this.content = notice.content;
    this.ext = notice.ext ?? {};
  }
}

export class FriendIncreaseNoticeEvent extends FriendRelationshipNoticeEvent {
  override readonly type = 'friend.increase' as const;

  constructor(
    notice: Extract<ImNotice, { type: 'friend.increase' }>,
    account: Account,
  ) {
    super(notice, account);
  }
}

export class FriendDecreaseNoticeEvent extends FriendRelationshipNoticeEvent {
  override readonly type = 'friend.decrease' as const;

  constructor(
    notice: Extract<ImNotice, { type: 'friend.decrease' }>,
    account: Account,
  ) {
    super(notice, account);
  }
}

export type FriendNoticeEvent =
  | FriendMarkedReadNoticeEvent
  | FriendAddRequestNoticeEvent
  | FriendIncreaseNoticeEvent
  | FriendDecreaseNoticeEvent;

export class ImCommandNoticeEvent extends ConversationNoticeEvent {
  override readonly type = 'im.command' as const;
  readonly messageType: number;
  readonly content: string;

  constructor(notice: Extract<ImNotice, { type: 'im.command' }>, account: Account) {
    super(account, notice.conversationId, notice.conversationType, notice.raw);
    this.messageType = notice.messageType;
    this.content = notice.content;
  }
}

export type AnyNoticeEvent =
  | ConversationReadSummaryNoticeEvent
  | MessageDeleteNoticeEvent
  | MessageBatchUpdateNoticeEvent
  | MessageListUpdateNoticeEvent
  | ConversationUpdateNoticeEvent
  | ConversationMinIndexNoticeEvent
  | ConversationMembersRemovedNoticeEvent
  | ConversationDeleteNoticeEvent
  | FriendMarkedReadNoticeEvent
  | FriendAddRequestNoticeEvent
  | GroupMarkedReadNoticeEvent
  | MessageRecallNoticeEvent
  | MessageUpdateNoticeEvent
  | MessageReactionNoticeEvent
  | GroupMemberIncreaseNoticeEvent
  | GroupMemberDecreaseNoticeEvent
  | GroupAdminNoticeEvent
  | GroupNameChangeNoticeEvent
  | GroupAvatarChangeNoticeEvent
  | FriendIncreaseNoticeEvent
  | FriendDecreaseNoticeEvent
  | ImCommandNoticeEvent;

export function bindNoticeAccount(notice: ProtocolOnlyNotice, account: Account): AnyNoticeEvent {
  switch (notice.type) {
    case 'friend.add-request': return new FriendAddRequestNoticeEvent(notice, account);
    case 'friend.increase': return new FriendIncreaseNoticeEvent(notice, account);
    case 'friend.decrease': return new FriendDecreaseNoticeEvent(notice, account);
    case 'conversation.update': return new ConversationUpdateNoticeEvent(notice, account);
    case 'conversation.min-index': return new ConversationMinIndexNoticeEvent(notice, account);
    case 'conversation.members-remove': return new ConversationMembersRemovedNoticeEvent(notice, account);
    case 'conversation.delete': return new ConversationDeleteNoticeEvent(notice, account);
    case 'message.recall': return new MessageRecallNoticeEvent(notice, account);
    case 'message.reaction': return new MessageReactionNoticeEvent(notice, account);
    case 'im.command': return new ImCommandNoticeEvent(notice, account);
  }
}

/** @internal Group system batch -> one event per member, after updating the Member cache. */
export function bindGroupMemberIncreaseNotices(
  notice: Extract<ImNotice, { type: 'group.member-increase' }>,
  account: Account,
  group: Group,
): GroupMemberIncreaseNoticeEvent[] {
  const operators = notice.operators.map((data) => group.ensureMember({
    ...data,
    role: noticeRole(group, data.uid),
  }));
  return notice.members.map((data) => {
    const member = group.ensureMember({
      ...data,
      role: noticeRole(group, data.uid),
    });
    return notice.source === 'invite'
      ? new GroupInviteNoticeEvent({ ...notice, source: 'invite' }, account, group, member, operators)
      : new GroupMemberIncreaseNoticeEvent(notice, account, group, member, operators);
  });
}

/** @internal Group system batch -> one event per detached member. */
export function bindGroupMemberDecreaseNotices(
  notice: Extract<ImNotice, { type: 'group.member-decrease' }>,
  account: Account,
  group: Group,
): GroupMemberDecreaseNoticeEvent[] {
  const protocolOperators = notice.operators.map((data) => group.ensureMember({
    ...data,
    role: noticeRole(group, data.uid),
  }));
  return notice.members.map((data) => {
    const member = group.detachMember(data);
    const operators = notice.source === 'leave' ? [member] : protocolOperators;
    return new GroupMemberDecreaseNoticeEvent(notice, account, group, member, operators);
  });
}

function bindOperators(
  operators: Extract<ImNotice, { type: 'group.admin' | 'group.name-change' | 'group.avatar-change' }>['operators'],
  group: Group,
): Member[] {
  return operators.map((data) => group.ensureMember({
    ...data,
    role: noticeRole(group, data.uid),
  }));
}

function noticeRole(group: Group, uid: string): number {
  return group.pickMember(uid)?.role ??
    (group.ownerUid === uid ? MemberRole.OWNER : MemberRole.MEMBER);
}

export function bindGroupAdminNotices(
  notice: Extract<ImNotice, { type: 'group.admin' }>,
  account: Account,
  group: Group,
): GroupAdminNoticeEvent[] {
  const operators = bindOperators(notice.operators, group);
  return notice.members.map((data) => new GroupAdminNoticeEvent(
    notice,
    account,
    group,
    group.ensureMember({ ...data, role: MemberRole.ADMIN }),
    operators,
  ));
}

export function bindGroupNameChangeNotice(
  notice: Extract<ImNotice, { type: 'group.name-change' }>,
  account: Account,
  group: Group,
): GroupNameChangeNoticeEvent {
  if (notice.name !== undefined) group.updateMetadata({ name: notice.name });
  return new GroupNameChangeNoticeEvent(notice, account, group, bindOperators(notice.operators, group));
}

export function bindGroupAvatarChangeNotice(
  notice: Extract<ImNotice, { type: 'group.avatar-change' }>,
  account: Account,
  group: Group,
): GroupAvatarChangeNoticeEvent {
  if (notice.avatar !== undefined) group.updateMetadata({ avatar: notice.avatar });
  return new GroupAvatarChangeNoticeEvent(notice, account, group, bindOperators(notice.operators, group));
}

export function bindFriendMarkedReadNotice(
  notice: Extract<ImNotice, { type: 'conversation.read' }>,
  account: Account,
  friend: Friend,
): FriendMarkedReadNoticeEvent {
  return new FriendMarkedReadNoticeEvent(notice, account, friend);
}

export function bindGroupMarkedReadNotice(
  notice: Extract<ImNotice, { type: 'conversation.read' }>,
  account: Account,
  group: Group,
): GroupMarkedReadNoticeEvent {
  return new GroupMarkedReadNoticeEvent(notice, account, group);
}

function eventTime(raw: Readonly<Record<string, unknown>>): number | string | undefined {
  const value = raw['createTime'] ?? raw['create_time'] ?? raw['timestamp'];
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}
