export { Account } from './account.js';
export type { StrangerSyncResult } from '../services/im/stranger-sync.js';
export type {
  AccountOptions,
  AccountState,
  ChatContact,
  BatchMessageReadResult,
  LoginOptions,
  LoginMethod,
} from './account.js';
export type { ChatHistory, ChatHistoryOptions, ChatMessage, ChatMessageIdentifier, ConversationReadReceipt } from './contacts/chat-contact.js';
export { Client, createClient } from './client.js';
export type {
  ClientOptions,
  ClientEventMap,
} from './client.js';
export type {
  ImStateStoreBackend,
  LocalImStateOptions,
  MessageLocalExtUpdate,
} from '../services/im/state-store.js';
export type {
  AccountEventMap,
  LoginAccountOption,
  LoginAccountSelectionPayload,
  SessionStatusPayload,
  SmsLoginPayload,
} from './account-events.js';
export { LoginVerification } from './auth/login-verification.js';
export { ActionVerification } from './auth/action-verification.js';
export type { ActionVerificationResult, ActionVerificationTarget } from './auth/action-verification.js';
export type {
  LoginVerificationDescriptor,
  LoginVerificationMethod,
  LoginVerificationOperation,
  LoginVerificationResult,
  LoginVerificationSource,
  OpenLoginVerificationOptions,
} from './auth/login-verification.js';
export { SendMessageError } from './errors.js';
export { DouyinResponseError } from '../http/response.js';
export type { ResponseFailureKind } from '../http/response.js';
export {
  MessageEvent,
  PrivateMessageEvent,
  StrangerMessageEvent,
  GroupMessageEvent,
} from './events/message.js';
export {
  NoticeEvent,
  ConversationNoticeEvent,
  ConversationUpdateNoticeEvent,
  ConversationMinIndexNoticeEvent,
  ConversationMembersRemovedNoticeEvent,
  ConversationDeleteNoticeEvent,
  MessageNoticeEvent,
  MessageRecallNoticeEvent,
  MessageDeleteNoticeEvent,
  MessageUpdateNoticeEvent,
  MessageBatchUpdateNoticeEvent,
  MessageListUpdateNoticeEvent,
  ConversationReadSummaryNoticeEvent,
  ImCommandNoticeEvent,
  GroupNoticeEvent,
  GroupMemberChangeNoticeEvent,
  GroupInviteNoticeEvent,
  GroupMetadataChangeNoticeEvent,
  MarkedReadNoticeEvent,
  FriendMarkedReadNoticeEvent,
  FriendAddRequestNoticeEvent,
  FriendIncreaseNoticeEvent,
  FriendDecreaseNoticeEvent,
  FriendRelationshipNoticeEvent,
  GroupMarkedReadNoticeEvent,
  GroupMemberIncreaseNoticeEvent,
  GroupMemberDecreaseNoticeEvent,
  GroupAdminNoticeEvent,
  GroupNameChangeNoticeEvent,
  GroupAvatarChangeNoticeEvent,
} from './events/notice.js';
export type { AnyNoticeEvent, FriendNoticeEvent, ConversationMessageUpdate } from './events/notice.js';
export {
  RequestEvent,
  GroupRequestEvent,
  GroupJoinRequestEvent,
} from './events/request.js';
export type { AnyRequestEvent } from './events/request.js';
export { segment } from './messaging/message.js';
export type { WorkCard, LinkCard, UserCard, FileAsset, GroupInvitationCard } from '../services/im/cards.js';
export type {
  AtMessageSegment,
  PreparedTextMessage,
  RichMessage,
  SendableMessage,
  SendableText,
  TextMessageSegment,
  ImageInput,
  ImageSource,
} from './messaging/message.js';
export { Friend } from './contacts/friend.js';
export { Stranger } from './contacts/stranger.js';
export { Group } from './contacts/group.js';
export { Member, MemberRole } from './contacts/member.js';
export { GroupJoinRequest } from './contacts/group-join-request.js';
export { GroupJoinRequestStatus } from '../services/im/types.js';
export { SharedComment, SharedWork } from './content/shared-content.js';
export type { EmojiResourcesResponse, CollectEmojiOptions, CollectEmojiResponse, CollectedEmojiPage,
  CollectedEmojisResponse, CollectedEmojiListOptions, CollectedEmojiSnapshot, CollectedStickerEnabledStatus } from '../services/im/emoji.js';
export type {
  SendMessageResponse,
  CreateGroupOptions,
  RecallMessageResponse,
  ImActionResponse,
  ParticipantReadCursor,
  ParticipantMinCursor,
  StoredReadCursor,
  ConversationReadStateResponse,
  GroupJoinRequestUnreadResponse,
  UserFollowStatus,
  UserFollowerStatus,
  UserFollowResponse,
  NewFollowerCountResponse,
  RecommendedContact,
  RecommendedContactsResponse,
  FollowerNotice,
  FollowerNoticesResponse,
  ImUserProfile,
  UserSearchEntry,
  UserSearchResponse,
  UserActiveStatus,
  ConversationActiveStatus,
  ActiveStatusResponse,
  BatchMarkReadResponse,
  ConversationInfoListResponse,
  ParticipantActionResponse,
  ParticipantActionDetails,
  ParticipantIdentity,
  ImageAsset,
  ImageResource,
  VideoResource,
  ParsedMessageContent,
  SharedCommentStatus,
  SharedWorkAccess,
  SharedWorkDetail,
  SharedWorkMediaSource,
  StrangerMessagesResponse,
  StrangerUnreadCountResponse,
} from '../services/im/index.js';
export type { UserSettingsResponse, ReadReceiptPrivacyResponse, MessageReadPrivacyQuery, MessageReadPrivacy, MessageReadPrivacyResponse } from '../services/im/user-settings.js';
export type { ConversationReadSummary } from '../services/im/read-state.js';
