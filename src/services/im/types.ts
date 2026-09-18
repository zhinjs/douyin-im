export interface PrivateThread {
  threadId: string;
  /** protobuf int64，必须用字符串避免精度丢失 */
  conversationShortId?: string;
  conversationType?: number;
  inboxType?: number;
  peer: ThreadPeer;
  lastMessage?: PrivateMessage;
  unreadCount: number;
  updateTime: number;
  [key: string]: unknown;
}

export interface ConversationMember {
  uid: string;
  secUid?: string;
  role: number;
}

/** cmd 2006 返回的会话；纯数字 ID 且 type=2 的条目为群聊。 */
export interface ImConversation {
  conversationId: string;
  conversationShortId: string;
  conversationType: number;
  isGroup: boolean;
  name: string;
  description?: string;
  notice?: string;
  avatar?: string;
  ownerUid?: string;
  ownerSecUid?: string;
  ticket?: string;
  isParticipant?: boolean;
  inboxType?: number;
  badgeCount?: number;
  /** Server core state, separate from settingExt and localExt. */
  coreVersion?: string;
  coreExt?: Readonly<Record<string, string>>;
  mode?: number;
  /** Local box membership derived from core mode/ext after a server snapshot merge. */
  isInStrangerBox?: boolean;
  /** Local conversation deletion state; independent of each cached message's deleted flag. */
  deleted?: boolean;
  /** Outer cmd2047 conversation version, not coreVersion or a message version. */
  strangerVersion?: string;
  participantsCount?: number;
  sortOrder?: string;
  /** Native local derived state; not a wire/IPC setting field or an ext getter. */
  isFolded?: boolean;
  settingExt?: Readonly<Record<string, string>>;
  /** Network setting_version (field 10), independent of core/version or individual ext keys. */
  settingVersion?: string;
  /** Network ext_version (field 32), used by Desktop's per-key setting updates. */
  settingExtVersions?: Readonly<Record<string, string>>;
  /** Local monotonic counters; not aliases for last/read/indexV2. */
  maxIndex?: string;
  maxOrder?: string;
  muted?: boolean;
  pinned?: boolean;
  favorite?: boolean;
  /** Network setting timestamps (int64, not local sort order). */
  setTopTime?: string;
  setFavoriteTime?: string;
  /** Native setting read badge high-water mark; distinct from conversation badgeCount. */
  readBadgeCount?: number;
  readIndex?: string;
  readIndexV2?: string;
  minIndex?: string;
  minIndexV2?: string;
  lastMessageTime: number;
  /** Local native-style summary projection; absent before local summary initialization. */
  lastMessageIndex?: string;
  lastMessage?: PrivateMessage | null;
  hintMessage?: PrivateMessage | null;
  localExt?: Readonly<Record<string, string>>;
  propertyInfo?: ConversationPropertyInfo;
  propertyMessage?: PrivateMessage | null;
  members: GroupMemberData[];
}

export interface ConversationListOptions {
  /** protobuf int64，必须用字符串避免精度丢失。 */
  cursor?: string | number;
  count?: number;
}

export interface ConversationListResponse {
  statusCode: number;
  statusMsg: string;
  conversations: ImConversation[];
}

export interface CreateConversationResponse extends ImActionResponse {
  conversation?: ImConversation;
}

export interface CreateGroupOptions {
  name?: string;
  avatarUrl?: string;
  description?: string;
}

export interface ThreadPeer {
  uid: string;
  secUid?: string;
  nickname: string;
  avatarThumb?: string;
  [key: string]: unknown;
}

/** 抖音聊天原生 Message.refInfo；所有 int64 均保留为十进制字符串。 */
export interface MessageReferenceInfo {
  refMessageId: string;
  hint: string;
  refMessageType: number;
  refMessageStatus: number;
  rootMessageId?: string;
  rootMessageConvIndex?: string;
}

/** MessageBody.property_list entry. UID and create_time remain lossless int64 text. */
export interface MessagePropertyItem {
  uid: string;
  secUid: string;
  createTime: string;
  idempotentId: string;
  value: string;
}

export interface ConversationPropertyInfo {
  clientId: string;
  emoji: string;
  sender: string;
  /** Native seconds, lossless int64 text at the JS boundary. */
  createdAt: string;
  markRead: boolean;
}

export interface PrivateMessage {
  msgId: string;
  threadId: string;
  conversationShortId?: string;
  conversationType?: number;
  inboxType?: number;
  senderUid: string;
  senderSecUid?: string;
  clientMessageId?: string;
  content: string;
  msgType: number;
  createTime: number;
  /** Wire MessageBody.status (Desktop DB net_status), not its separate local send-stage status. */
  status: number;
  version?: string;
  /** Wire field 13; Desktop DB order_index. Distinct from both conversation indexes. */
  orderInConversation?: string;
  /** Local cache effective order after Desktop merge; wire orderInConversation remains unchanged. */
  orderIndex?: string;
  indexInConversation?: string;
  indexInConversationV2?: string;
  ext?: Readonly<Record<string, string>>;
  /** Local-only metadata; never serialized into outbound wire ext. */
  localExt?: Readonly<Record<string, string>>;
  /** Local soft-delete flag. Server-ID lookup can return this row; history/client-ID lookup exclude it. */
  deleted?: boolean;
  referenceInfo?: MessageReferenceInfo;
  propertyList?: Readonly<Record<string, readonly MessagePropertyItem[]>>;
  [key: string]: unknown;
}

export interface ThreadListOptions {
  /** 同步游标是 int64；字符串可避免 JS number 丢精度。 */
  cursor?: string | number;
  count?: number;
  /** 不设置时同时请求 0 和 1；0=好友 P2P，1=其他收件箱。 */
  inboxType?: number;
}

export interface ThreadListResponse {
  statusCode: number;
  statusMsg: string;
  hasMore: boolean;
  threads: PrivateThread[];
  cursor: string;
  /** cmd203 同步返回的原始会话资料，供 Desktop 风格完整会话列表使用。 */
  conversations: ImConversation[];
  unreadCount?: number;
}

export interface StrangerMessagesResponse extends ImActionResponse {
  messages: PrivateMessage[];
}

/** One native cmd2047 page. These are version bounds, not a list offset/count. */
export interface RecentStrangerMessagesOptions {
  latestStrangerVersion: string;
  earliestStrangerVersion: string;
  inboxType?: number;
}

/** Fields consumed by Desktop StrangerChainPuller; not a complete ConversationInfoV2. */
export interface RecentStrangerConversation {
  conversationId: string;
  conversationShortId: string;
  version: string;
  badgeCount: number;
  messages: PrivateMessage[];
}

export interface RecentStrangerMessagesResponse extends ImActionResponse {
  nextStrangerVersion: string;
  hasMore: boolean;
  /** One entry per outer row, including rows without messages. Never flattened or deduplicated. */
  messages: RecentStrangerConversation[];
  logId: string;
}

/** Account-scoped native stranger sync high-water mark and load-more boundary. */
export interface StrangerSyncCursors {
  version: string;
  loadMoreVersion: string;
}

export interface StrangerUnreadCountResponse extends ImActionResponse {
  unreadCount: string;
}

export interface UserBlockOptions {
  uid: string;
  secUid: string;
  blocked: boolean;
  /** 0=普通拉黑，1=不让他看我，2=不看他；桌面聊天 UI 使用 0。 */
  source?: 0 | 1 | 2;
}

export interface FriendRosterOptions {
  cursor?: string | number;
  count?: number;
}

export interface FriendRosterEntry {
  uid: string;
  nickname: string;
  avatar?: string;
  secUid?: string;
  remark?: string;
  signature?: string;
  appliedAt?: string;
  ext?: Readonly<Record<string, string>>;
}

export interface FriendRosterResponse extends ImActionResponse {
  hasMore: boolean;
  cursor: string;
  total: string;
  /** Page-local profiles; membership lists may refer to profiles on other pages. */
  userList: FriendRosterEntry[];
  friendUids: string[];
  closeFriendUids?: string[];
}

/** Desktop聊天页顶部推荐项；不是Friend实例，也不证明好友关系或群类型。 */
export interface RecommendedContact {
  name?: string;
  avatar?: string;
  secUid?: string;
  /** 原始推荐项的备用标识；存在此字段不代表这是群推荐。 */
  conversationId?: string;
  /** 服务端active_time原值；不从0、负值或缺失推断在线状态。 */
  lastActiveTime?: number;
}

export interface RecommendedContactsResponse extends ImActionResponse {
  /** 服务端顺序与重复项均保留；不混入本地资料、在线排序或UI占位项。 */
  contacts: RecommendedContact[];
}

/** Desktop “新朋友”通知组401的计数，不是粉丝总数或好友申请数。 */
export interface NewFollowerCountResponse extends ImActionResponse {
  /** 仅服务端明确返回401组时存在；未返回该组不等于0，不应清除调用方旧计数。 */
  count?: number;
}

/** 新朋友通知中的资料快照，不表示本地好友关系已更新。 */
export interface FollowerNotice {
  uid: string;
  secUid: string;
  nickname: string;
  remark?: string;
  avatar?: string;
  avatarUri?: string;
  createTime?: number;
  hasRead?: boolean | number;
  followStatus?: number;
  followerStatus?: number;
  content?: string;
}

export interface FollowerNoticePage extends ImActionResponse {
  notices: FollowerNotice[];
  hasMore: boolean;
  maxTime?: string;
  minTime?: string;
}

export interface FollowerNoticesResponse extends ImActionResponse {
  /** 按通知顺序保留每个UID的第一项，与Desktop新朋友列表一致。 */
  notices: FollowerNotice[];
  /** 累计原始通知超过120且服务端仍有更多时停止，不代表严格截断120个用户。 */
  truncated: boolean;
}

export interface SetUserRemarkOptions {
  uid: string;
  secUid: string;
  remark: string;
}

export interface UserRelationResponse extends ImActionResponse {
  remark?: string;
}

/** Desktop follow_status；4 表示申请待对方批准，而不是已经关注。 */
export type UserFollowStatus = 0 | 1 | 2 | 4;

/** Desktop follower_status：对方是否关注当前账号，与自己的 follow_status 独立。 */
export type UserFollowerStatus = 0 | 1;

export interface SetUserFollowedOptions {
  uid: string;
  secUid: string;
  followed: boolean;
}

export interface UserFollowResponse extends ImActionResponse {
  followStatus?: UserFollowStatus;
}

export interface MessageListOptions {
  threadId: string;
  conversationShortId?: string;
  conversationType?: number;
  inboxType?: number;
  /** 消息索引是 int64；字符串可避免 JS number 丢精度。 */
  cursor?: string | number;
  count?: number;
  /** Desktop getMessageList 的 older；默认向更早消息翻页。 */
  direction?: 'older' | 'newer';
  /** 是否保留索引恰好等于 cursor 的消息；Desktop 默认 false。 */
  includeCurrent?: boolean;
}

export interface MessageListResponse {
  statusCode: number;
  statusMsg: string;
  hasMore: boolean;
  messages: PrivateMessage[];
  cursor: string;
  direction: 'older' | 'newer';
}

export interface SendMessageOptions {
  threadId: string;
  content: string;
  msgType?: number;
  conversationShortId: string;
  conversationType?: number;
  inboxType?: number;
  /** Desktop sendMessage 的 mentionUsers；同时编码为 cmd100 field 9。 */
  mentionedUsers?: string[];
  /** 引用消息元数据；在 cmd100 field 11 编码，正文仍使用普通文本 content。 */
  reference?: SendMessageReference;
}

export interface SendMessageReference {
  referencedMessageId: string;
  hint: string;
  rootMessageId?: string;
  rootMessageConvIndex?: string;
}

export interface SendMessageResponse {
  statusCode: number;
  statusMsg: string;
  serverMessageId?: string;
  clientMessageId?: string;
  /** 内容安全审核状态码（0=通过，非0=被拦截/需审核） */
  checkCode?: number;
}

export interface RecallMessageOptions {
  threadId: string;
  conversationShortId: string;
  serverMessageId: string;
  conversationType?: number;
  inboxType?: number;
}

export interface RecallMessageResponse {
  statusCode: number;
  statusMsg: string;
  recalled: boolean;
}

export interface ImActionResponse {
  statusCode: number;
  statusMsg: string;
  checkCode?: number;
}

/** cmd650 邀请结果；cmd651 移除仅返回请求级 ImActionResponse。 */
export interface ParticipantActionResponse extends ImActionResponse {
  /** 显式普通及 sec 名单的 UID 投影，不包含推算成功项。 */
  succeededUids: string[];
  failedUids: string[];
  /** Desktop 的独立响应字段；外层拒绝或缺少 body 时不存在。 */
  details?: ParticipantActionDetails;
}

export interface ParticipantActionDetails {
  successParticipants: string[];
  failedParticipants: string[];
  status?: number;
  extraInfo?: string;
  checkCode?: string;
  checkMessage?: string;
  secSuccessParticipants: ParticipantIdentity[];
  secFailedParticipants: ParticipantIdentity[];
}

export interface ParticipantIdentity {
  uid?: string;
  secUid?: string;
}

export interface GroupMemberData {
  uid: string;
  secUid?: string;
  nickname?: string;
  avatar?: string;
  role: number;
  alias?: string;
  sortOrder?: string;
  blocked?: number;
  leftBlockTime?: string;
  ext?: Readonly<Record<string, string>>;
}

export interface GroupMemberListResponse extends ImActionResponse {
  members: GroupMemberData[];
}

export interface ConversationInfoListResponse extends ImActionResponse {
  conversations: ImConversation[];
}

export interface BatchMarkReadResponse extends ImActionResponse {
  failed: MarkConversationReadOptions[];
}

export enum GroupJoinRequestStatus {
  PENDING = 1,
  APPROVED = 2,
  REJECTED = 3,
  INVALID = 4,
}

export interface GroupJoinRequestData {
  requestId: string;
  applicantUid: string;
  applicantSecUid?: string;
  applicantNickname?: string;
  applicantAvatar?: string;
  groupShortId: string;
  conversationType: number;
  status: GroupJoinRequestStatus;
  reason?: string;
  inviterUid?: string;
  inviterSecUid?: string;
  createdAt?: string;
  modifiedAt?: string;
  moderatorUid?: string;
  ext?: Readonly<Record<string, string>>;
}

export interface GroupJoinRequestListResponse extends ImActionResponse {
  requests: GroupJoinRequestData[];
}

export interface GroupJoinRequestActionResponse extends ImActionResponse {
  request?: GroupJoinRequestData;
}

/** Account-wide audit unread state. Decimal string preserves the native int64. */
export interface GroupJoinRequestUnreadResponse extends ImActionResponse {
  unreadCount?: string;
  lastRequest?: GroupJoinRequestData;
}

export type GroupMemberIncreaseSource =
  | 'invite'
  | 'command'
  | 'qrcode'
  | 'duoshan'
  | 'apply'
  | 'search'
  | 'activity'
  | 'face-to-face'
  | 'circle';

export type GroupMemberDecreaseSource = 'kick' | 'leave';

export interface ImGroupNoticeUser {
  uid: string;
  secUid?: string;
  nickname?: string;
}

export interface ConversationReadMarker {
  serverMessageId: string;
  indexInConversation?: string;
  indexInConversationV2?: string;
  /** 本次被清除的会话角标数；桌面端 native SDK 会把它随已读位置一起上报。 */
  readBadgeCount?: number;
}

export interface ConversationActionOptions extends ConversationAddressOptions {}

export interface DeleteConversationOptions extends ConversationAddressOptions {
  /** Captured local message indexV1 maximum, not indexV2 or a server message ID. */
  lastMessageIndex: string;
}

export interface ConversationAddressOptions {
  threadId: string;
  conversationShortId: string;
  conversationType: 1 | 2;
  inboxType?: number;
}

export interface MarkConversationReadOptions extends ConversationAddressOptions, ConversationReadMarker {}

export interface DeleteMessageOptions extends ConversationAddressOptions {
  serverMessageId: string;
}

export interface ModifyMessageReactionOptions extends ConversationAddressOptions {
  serverMessageId: string;
  emoji: string;
  enabled: boolean;
  /** 当前账号的数字 IM uid，用作桌面协议的幂等标识。 */
  operatorUid: string;
}

export interface EnterConversationOptions extends ConversationAddressOptions {}

export interface SetConversationSettingsOptions extends ConversationAddressOptions {
  mute?: boolean;
  pinned?: boolean;
}

export interface GroupParticipantActionOptions extends ConversationAddressOptions {
  uids: string[];
}

export interface GroupJoinRequestListOptions {
  conversationShortId?: string;
}

export interface ReviewGroupJoinRequestOptions {
  requestId: string;
  status: GroupJoinRequestStatus.APPROVED | GroupJoinRequestStatus.REJECTED;
}

export type ImNotice =
  | {
      /** cmd508 的 SendApply 信号；SDK 收到后刷新可处理的好友申请列表。 */
      type: 'friend.add-request';
      applicantUid: string;
      fromUid?: string;
      toUid?: string;
      content?: string;
      ext?: Readonly<Record<string, string>>;
      raw: Record<string, unknown>;
    }
  | {
      /** cmd508 的好友关系建立事实。 */
      type: 'friend.increase';
      peerUid: string;
      fromUid?: string;
      toUid?: string;
      content?: string;
      ext?: Readonly<Record<string, string>>;
      raw: Record<string, unknown>;
    }
  | {
      /** cmd508 的好友关系解除事实。 */
      type: 'friend.decrease';
      peerUid: string;
      fromUid?: string;
      toUid?: string;
      content?: string;
      ext?: Readonly<Record<string, string>>;
      raw: Record<string, unknown>;
    }
  | {
      type: 'conversation.read';
      conversationId: string;
      conversationType: number;
      readMessageIndex: string;
      readMessageIndexV2?: string;
      /** cmd504/type50013 的 content.P2PSender；普通会话已读通知不提供读者身份。 */
      readerUid?: string;
      raw: Record<string, unknown>;
    }
  | {
      type: 'conversation.update';
      conversationId: string;
      conversationType: number;
      raw: Record<string, unknown>;
    }
  | {
      type: 'conversation.min-index';
      conversationId: string;
      conversationType: number;
      /** Native onUpdateConversationMinIndex carries the command boundary, not necessarily stored minIndex. */
      minIndex: string;
      raw: Record<string, unknown>;
    }
  | {
      type: 'conversation.members-remove';
      conversationId: string;
      conversationType: number;
      memberUids: readonly string[];
      raw: Record<string, unknown>;
    }
  | {
      type: 'conversation.delete';
      conversationId: string;
      conversationType: number;
      raw: Record<string, unknown>;
    }
  | {
      type: 'message.delete';
      /** Target identity from command JSON; resolve the local message before projecting an event. */
      conversationId: string;
      serverMessageId: string;
      raw: Record<string, unknown>;
    }
  | {
      type: 'message.recall';
      conversationId: string;
      conversationType: number;
      serverMessageId?: string;
      clientMessageId?: string;
      /** Raw create_time of the recall notification, not the target message. */
      createTime?: string;
      raw: Record<string, unknown>;
    }
  | {
      type: 'message.reaction';
      conversationId: string;
      conversationType: number;
      operatorUid: string;
      emoji: string;
      enabled: boolean;
      serverMessageId?: string;
      clientMessageId?: string;
      raw: Record<string, unknown>;
    }
  | {
      /** cmd500 messageType=90001；SDK 收到后拉取审核列表再生成可操作 request。 */
      type: 'group.join-request';
      conversationId: string;
      conversationShortId: string;
      conversationType: number;
      requestId?: string;
      content: string;
      raw: Record<string, unknown>;
    }
  | {
      /** 群系统消息中的成员加入事实；一条消息可以包含多个成员。 */
      type: 'group.member-increase';
      conversationId: string;
      conversationShortId: string;
      conversationType: 2;
      source: GroupMemberIncreaseSource;
      members: ImGroupNoticeUser[];
      operators: ImGroupNoticeUser[];
      raw: Record<string, unknown>;
    }
  | {
      /** 群系统消息中的成员离开事实；kick 的 passive_users 为离群成员，leave 的 active_users 为离群成员。 */
      type: 'group.member-decrease';
      conversationId: string;
      conversationShortId: string;
      conversationType: 2;
      source: GroupMemberDecreaseSource;
      members: ImGroupNoticeUser[];
      operators: ImGroupNoticeUser[];
      raw: Record<string, unknown>;
    }
  | {
      /** messageType=7, aweType=100110；当前桌面端只定义“设为管理员”。 */
      type: 'group.admin';
      conversationId: string;
      conversationShortId: string;
      conversationType: 2;
      members: ImGroupNoticeUser[];
      operators: ImGroupNoticeUser[];
      enabled: true;
      raw: Record<string, unknown>;
    }
  | {
      /** messageType=7, aweType=100106；name 取不到时仍保留通知和 raw。 */
      type: 'group.name-change';
      conversationId: string;
      conversationShortId: string;
      conversationType: 2;
      name?: string;
      operators: ImGroupNoticeUser[];
      raw: Record<string, unknown>;
    }
  | {
      /** messageType=7, aweType=100115；avatar 取不到时仍保留通知和 raw。 */
      type: 'group.avatar-change';
      conversationId: string;
      conversationShortId: string;
      conversationType: 2;
      avatar?: string;
      operators: ImGroupNoticeUser[];
      raw: Record<string, unknown>;
    }
  | {
      type: 'im.command';
      conversationId: string;
      conversationType: number;
      messageType: number;
      content: string;
      raw: Record<string, unknown>;
    };
