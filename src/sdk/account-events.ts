import type { PassportSubAccount, QrCodeInfo, QrConnectStatus } from '../desktop/types.js';
import type {
  GroupMessageEvent,
  MessageEvent,
  PrivateMessageEvent,
  StrangerMessageEvent,
} from './events/message.js';
import type {
  ConversationReadSummaryNoticeEvent,
  ConversationNoticeEvent,
  ConversationDeleteNoticeEvent,
  ConversationUpdateNoticeEvent,
  ConversationMinIndexNoticeEvent,
  ConversationMembersRemovedNoticeEvent,
  FriendMarkedReadNoticeEvent,
  FriendAddRequestNoticeEvent,
  FriendIncreaseNoticeEvent,
  FriendDecreaseNoticeEvent,
  FriendNoticeEvent,
  ImCommandNoticeEvent,
  GroupMarkedReadNoticeEvent,
  GroupAdminNoticeEvent,
  GroupAvatarChangeNoticeEvent,
  GroupMemberDecreaseNoticeEvent,
  GroupMemberIncreaseNoticeEvent,
  GroupMemberChangeNoticeEvent,
  GroupInviteNoticeEvent,
  GroupMetadataChangeNoticeEvent,
  GroupNameChangeNoticeEvent,
  GroupNoticeEvent,
  MessageRecallNoticeEvent,
  MessageDeleteNoticeEvent,
  MessageUpdateNoticeEvent,
  MessageBatchUpdateNoticeEvent,
  MessageListUpdateNoticeEvent,
  MessageReactionNoticeEvent,
  MessageNoticeEvent,
  MarkedReadNoticeEvent,
  AnyNoticeEvent,
} from './events/notice.js';
import type { GroupRequestEvent, AnyRequestEvent } from './events/request.js';
import type { GroupJoinRequest } from './contacts/group-join-request.js';
import type { LoginVerification } from './auth/login-verification.js';
import type { ActionVerification } from './auth/action-verification.js';

export interface SmsLoginPayload {
  mobile: string;
  maskedMobile?: string;
}

export interface LoginAccountOption {
  secUid: string;
  uid?: string;
  nickname?: string;
  avatar?: string;
  douyinId?: string;
  isMainAccount: boolean;
  isEnterprise: boolean;
  isActive: boolean;
  raw: PassportSubAccount;
}

export interface LoginAccountSelectionPayload {
  method: 'sms' | 'password';
  accounts: readonly LoginAccountOption[];
  /** true 时可调用 continueLoginWithSubAccount({ registerNewUser: true })。 */
  canRegisterNewUser: boolean;
}

export interface QrLoginStatusPayload {
  status: QrConnectStatus;
  screenName?: string;
  errorCode?: number;
  description?: string;
  responseFields?: string[];
}

export interface HandlerErrorPayload {
  event: string | symbol;
  error: Error;
}

export interface ReconnectingPayload {
  attempt: number;
  delayMs: number;
  code?: number;
  reason?: string;
}

export interface SessionStatusPayload {
  /** valid: 远端已确认；unverified: 暂时无法验证或显式跳过；expired: 已确认失效。 */
  status: 'valid' | 'unverified' | 'expired';
  reason: string;
}

export interface AccountEventMap {
  'system.login.session': SessionStatusPayload;
  'system.login.qrcode': QrCodeInfo;
  'system.login.qrcode.status': QrLoginStatusPayload;
  'system.login.sms': SmsLoginPayload;
  'system.login.voice': SmsLoginPayload;
  'system.login.accounts': LoginAccountSelectionPayload;
  'system.login.sms-required': { mobile: string; reason: string };
  'system.login.verification': { verification: LoginVerification };
  'system.action.verification': { verification: ActionVerification };
  'system.login.error': Error;
  'system.handler.error': HandlerErrorPayload;
  'system.online': { platformUid: string; screenName?: string };
  'system.reconnecting': ReconnectingPayload;
  'system.offline': void;
  'message.private': PrivateMessageEvent;
  'message.stranger': StrangerMessageEvent;
  'message.group': GroupMessageEvent;
  'message': MessageEvent;
  'message.raw': { cmd: number; response: Record<string, unknown> };
  'request': AnyRequestEvent;
  'request.group': GroupRequestEvent;
  'request.group.join': GroupJoinRequest;
  'notice': AnyNoticeEvent;
  'notice.conversation': ConversationNoticeEvent;
  'notice.conversation.marked-read': MarkedReadNoticeEvent;
  'notice.conversation.read-summary': ConversationReadSummaryNoticeEvent;
  'notice.friend': FriendNoticeEvent;
  'notice.friend.add-request': FriendAddRequestNoticeEvent;
  'notice.friend.marked-read': FriendMarkedReadNoticeEvent;
  'notice.friend.increase': FriendIncreaseNoticeEvent;
  'notice.friend.decrease': FriendDecreaseNoticeEvent;
  'notice.group': GroupNoticeEvent;
  'notice.group.member-change': GroupMemberChangeNoticeEvent;
  'notice.group.member-increase': GroupMemberIncreaseNoticeEvent;
  'notice.group.invite': GroupInviteNoticeEvent;
  'notice.group.member-decrease': GroupMemberDecreaseNoticeEvent;
  'notice.group.admin': GroupAdminNoticeEvent;
  'notice.group.name-change': GroupNameChangeNoticeEvent;
  'notice.group.avatar-change': GroupAvatarChangeNoticeEvent;
  'notice.group.metadata-change': GroupMetadataChangeNoticeEvent;
  'notice.group.marked-read': GroupMarkedReadNoticeEvent;
  'notice.conversation.update': ConversationUpdateNoticeEvent;
  'notice.conversation.min-index': ConversationMinIndexNoticeEvent;
  'notice.conversation.members-remove': ConversationMembersRemovedNoticeEvent;
  'notice.conversation.delete': ConversationDeleteNoticeEvent;
  'notice.message.recall': MessageRecallNoticeEvent;
  'notice.message.delete': MessageDeleteNoticeEvent;
  'notice.message.update': MessageUpdateNoticeEvent;
  'notice.message.batch-update': MessageBatchUpdateNoticeEvent;
  'notice.message.list-update': MessageListUpdateNoticeEvent;
  'notice.message.reaction': MessageReactionNoticeEvent;
  'notice.message': MessageNoticeEvent | MessageBatchUpdateNoticeEvent | MessageListUpdateNoticeEvent;
  'notice.im.command': ImCommandNoticeEvent;
}
