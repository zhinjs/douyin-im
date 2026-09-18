import { ImInboxApi } from './inbox.js';
import { ImSendApi } from './send.js';
import { ImProtoTransport } from './transport.js';
import { ImMediaUploader } from './upload.js';
import type { ImageAsset } from './content.js';
import type { VideoAsset } from './upload.js';
import { randomUUID } from 'crypto';
import {
  desktopFingerprintParams,
  type DesktopScreenSize,
} from './desktop.js';
import { ImUserDirectory, type ImUserProfile, type UserSearchResponse, type ActiveStatusResponse } from './user-directory.js';
import { ImConversationActions } from './actions.js';
import { ImReadStateApi } from './read-state.js';
import type { ConversationReadStateResponse, ReadCursorsResponse, MinCursorsResponse, BatchReadCursorsResponse } from './read-state.js';
import { ImStrangerApi } from './stranger.js';
import { ImFriendApi } from './friends.js';
import { ImEmojiApi, type EmojiResourcesResponse, type CollectEmojiOptions, type CollectEmojiResponse, type CollectedEmojisResponse } from './emoji.js';
import { ImUserSettingsApi, type UserSettingsResponse, type ReadReceiptPrivacyResponse, type MessageReadPrivacyQuery, type MessageReadPrivacyResponse } from './user-settings.js';
import {
  ImSharedContent,
  type SharedCommentStatus,
  type SharedWorkDetail,
} from './shared-content.js';
import type {
  BatchMarkReadResponse,
  ConversationActionOptions,
  DeleteConversationOptions,
  CreateConversationResponse,
  CreateGroupOptions,
  MessageListOptions,
  MessageListResponse,
  RecallMessageOptions,
  RecallMessageResponse,
  SendMessageOptions,
  SendMessageResponse,
  ThreadListOptions,
  ThreadListResponse,
  ConversationListOptions,
  ConversationListResponse,
  ConversationInfoListResponse,
  DeleteMessageOptions,
  GroupParticipantActionOptions,
  GroupJoinRequestActionResponse,
  GroupJoinRequestListOptions,
  GroupJoinRequestListResponse,
  GroupJoinRequestUnreadResponse,
  GroupMemberListResponse,
  ImActionResponse,
  EnterConversationOptions,
  MarkConversationReadOptions,
  ModifyMessageReactionOptions,
  ParticipantActionResponse,
  SetConversationSettingsOptions,
  ReviewGroupJoinRequestOptions,
  StrangerMessagesResponse,
  RecentStrangerMessagesOptions,
  RecentStrangerMessagesResponse,
  StrangerUnreadCountResponse,
  UserBlockOptions,
  FriendRosterOptions,
  FriendRosterResponse,
  RecommendedContactsResponse,
  NewFollowerCountResponse,
  FollowerNoticePage,
  SetUserRemarkOptions,
  SetUserFollowedOptions,
  UserFollowResponse,
  UserRelationResponse,
} from './types.js';

export {
  buildEmojiContent,
  buildCollectedStickerContent,
  buildImageContent,
  buildReplyPayload,
  buildVideoContent,
  buildDesktopTextContent,
  isMessageDelivered,
  normalizeDesktopTextMessageContent,
  parseMessageContent,
} from './content.js';
export { decodeWire, decodeWireTree } from './wire.js';
export { decryptCencSample, decryptImage, pickImageUrl, sniffImageFormat } from './media.js';
export { canonicalUploadQuery, crc32Hex, signVodRequest } from './upload.js';

import { parseJsonResponse } from '../../http/response.js';

/** ImService 所需的 HTTP 客户端最小接口 */
export interface ImHttpClient {
  getUserAgent(): string;
  getCookies(): string;
  getGuid?(): string;
  /** Current renderer identity; native IM options retain their own initialization snapshot. */
  getDeviceId?(): string;
  getInstallId?(): string;
  /** 当前 Session 是否已由登录响应绑定到此账号的 BDTicket 密钥。 */
  hasBoundTicket?(): boolean;
  requiresTicket?(url: string): boolean;
  getScreenSize?(): DesktopScreenSize;
  requestRaw(url: string, init: RequestInit, passportHeaders?: boolean): Promise<{
    ok: boolean;
    status: number;
    headers: Headers;
    data: string;
    rawText: string;
  }>;
}

export interface ImServiceOptions {
  platformUid?: string;
  /** Desktop IM HTTP 请求使用的稳定设备 ID。 */
  deviceId?: string;
  /** 通常由 ApiConnection 提供，仅供自定义 transport 覆盖。 */
  guid?: string;
  screenSize?: DesktopScreenSize;
}

export interface EncryptedVideoUrl {
  mainUrl: string;
  backupUrl: string;
  expireTime: number;
}

/**
 * Desktop IM 协议门面 — 编排 Cookie transport / inbox / send。
 *
 * 协议细节见 content / token / transport / inbox / send / mappers。
 */
export class ImService {
  private readonly transport: ImProtoTransport;
  private readonly inboxApi: ImInboxApi;
  private readonly sendApi: ImSendApi;
  private readonly uploader: ImMediaUploader;
  private readonly userDirectory: ImUserDirectory;
  private readonly conversationActions: ImConversationActions;
  private readonly readStateApi: ImReadStateApi;
  private readonly strangerApi: ImStrangerApi;
  private readonly friendApi: ImFriendApi;
  private readonly emojiApi: ImEmojiApi;
  private readonly sharedContent: ImSharedContent;
  private readonly configuredPlatformUid: string;
  private readonly configuredDeviceId: string;
  private readonly userSettingsApi: ImUserSettingsApi;
  private readonly configuredGuid: string;
  private readonly configuredScreenSize: DesktopScreenSize;

  constructor(
    private readonly client: ImHttpClient,
    serviceOpts: ImServiceOptions = {},
  ) {
    this.configuredPlatformUid = serviceOpts.platformUid ?? '';
    this.configuredDeviceId = serviceOpts.deviceId ?? '';
    this.configuredGuid = serviceOpts.guid ?? client.getGuid?.() ?? randomUUID().replaceAll('-', '');
    this.configuredScreenSize = serviceOpts.screenSize ?? client.getScreenSize?.() ?? {
      width: 1728,
      height: 1117,
    };
    this.transport = new ImProtoTransport(client);
    this.inboxApi = new ImInboxApi(
      this.transport,
      this.configuredPlatformUid,
      this.configuredDeviceId,
    );
    this.sendApi = new ImSendApi(
      this.transport,
      serviceOpts.deviceId ?? serviceOpts.platformUid ?? '',
    );
    this.uploader = new ImMediaUploader(
      client,
      () => this.resolveUserId(),
      globalThis.fetch,
      () => this.resolveDesktopDeviceId(),
      this.configuredGuid,
      this.configuredScreenSize,
    );
    this.userDirectory = new ImUserDirectory(client, this.configuredDeviceId);
    this.userSettingsApi = new ImUserSettingsApi(client, this.configuredDeviceId);
    this.readStateApi = new ImReadStateApi(this.transport, this.configuredDeviceId);
    this.conversationActions = new ImConversationActions(
      this.transport,
      serviceOpts.deviceId ?? serviceOpts.platformUid ?? '',
      () => this.configuredPlatformUid,
    );
    this.strangerApi = new ImStrangerApi(
      this.transport,
      this.configuredDeviceId,
    );
    this.friendApi = new ImFriendApi(
      client,
      this.configuredDeviceId,
      this.configuredGuid,
      this.configuredScreenSize,
    );
    this.emojiApi = new ImEmojiApi(client, this.configuredDeviceId, this.configuredGuid, this.configuredScreenSize);
    this.sharedContent = new ImSharedContent(
      client,
      () => this.resolveDesktopDeviceId(),
      this.configuredGuid,
      this.configuredScreenSize,
    );
  }

  get myUid(): string {
    return this.configuredPlatformUid;
  }

  listThreads(options?: ThreadListOptions): Promise<ThreadListResponse> {
    return this.inboxApi.listThreads(options);
  }

  listConversations(options?: ConversationListOptions): Promise<ConversationListResponse> {
    return this.inboxApi.listConversations(options);
  }

  resolveUsers(secUids: string[]): Promise<ImUserProfile[]> {
    return this.userDirectory.resolve(secUids);
  }

  getUserProfile(secUid: string): Promise<ImUserProfile | undefined> {
    return this.userDirectory.getProfile(secUid);
  }

  searchUsers(keyword: string, cursor = 0): Promise<UserSearchResponse> {
    return this.userDirectory.searchUsers(keyword, cursor);
  }

  getActiveStatus(secUids: readonly string[], conversationIds: readonly string[] = []): Promise<ActiveStatusResponse> {
    return this.userDirectory.getActiveStatus(secUids, conversationIds);
  }

  getUserSettings(): Promise<UserSettingsResponse> {
    return this.userSettingsApi.getSettings();
  }

  getEmojiResources(): Promise<EmojiResourcesResponse> {
    return this.emojiApi.getResources();
  }

  collectEmoji(options: CollectEmojiOptions): Promise<CollectEmojiResponse> {
    return this.emojiApi.collect(options);
  }

  getCollectedEmojis(cursor = '0'): Promise<CollectedEmojisResponse> {
    return this.emojiApi.getCollected(cursor);
  }

  getReadReceiptPrivacy(): Promise<ReadReceiptPrivacyResponse> {
    return this.userSettingsApi.getReadReceiptPrivacy();
  }

  getMessageReadPrivacy(queries: readonly MessageReadPrivacyQuery[]): Promise<MessageReadPrivacyResponse> {
    return this.userSettingsApi.getMessageReadPrivacy(queries);
  }

  getStrangerMessages(conversationShortId: string, resetUnreadCount = false): Promise<StrangerMessagesResponse> {
    return this.strangerApi.getMessages(conversationShortId, resetUnreadCount);
  }

  /** Desktop cmd2047 single page; does not mark read, commit cursors or replace the SDK stranger list. */
  getRecentStrangerMessages(options: RecentStrangerMessagesOptions): Promise<RecentStrangerMessagesResponse> {
    return this.strangerApi.getRecentMessages(options);
  }

  deleteStrangerMessage(conversationShortId: string, serverMessageId: string): Promise<ImActionResponse> {
    return this.strangerApi.deleteMessage(conversationShortId, serverMessageId);
  }

  deleteAllStrangerConversations(): Promise<ImActionResponse> {
    return this.strangerApi.deleteAllConversations();
  }

  markStrangerConversationRead(conversationShortId: string): Promise<ImActionResponse> {
    return this.strangerApi.markRead(conversationShortId);
  }

  markAllStrangerConversationsRead(): Promise<ImActionResponse> {
    return this.strangerApi.markAllRead();
  }

  getStrangerUnreadCount(resetUnreadCount = false): Promise<StrangerUnreadCountResponse> {
    return this.strangerApi.getUnreadCount(resetUnreadCount);
  }

  setUserBlocked(options: UserBlockOptions): Promise<ImActionResponse> {
    return this.userDirectory.setBlocked(options);
  }

  listFriends(options?: FriendRosterOptions): Promise<FriendRosterResponse> {
    return this.friendApi.list(options);
  }

  getRecommendedContacts(): Promise<RecommendedContactsResponse> {
    return this.friendApi.getRecommendedContacts();
  }

  getNewFollowerCount(): Promise<NewFollowerCountResponse> {
    return this.friendApi.getNewFollowerCount();
  }

  readFollowerNoticePage(maxTime = '0', minTime = '1'): Promise<FollowerNoticePage> {
    return this.friendApi.readFollowerNoticePage(maxTime, minTime);
  }

  setUserRemark(options: SetUserRemarkOptions): Promise<UserRelationResponse> {
    return this.friendApi.setRemark(options);
  }

  setUserFollowed(options: SetUserFollowedOptions): Promise<UserFollowResponse> {
    return this.friendApi.setFollowed(options);
  }

  getMessages(options: MessageListOptions): Promise<MessageListResponse> {
    return this.inboxApi.getMessages(options);
  }

  send(options: SendMessageOptions): Promise<SendMessageResponse> {
    return this.sendApi.send(options);
  }

  recall(options: RecallMessageOptions): Promise<RecallMessageResponse> {
    return this.sendApi.recall(options);
  }


  createGroupConversation(
    participantUids: string[],
    options: CreateGroupOptions = {},
  ): Promise<CreateConversationResponse> {
    return this.conversationActions.createConversation(participantUids, 2, options);
  }

  createPrivateConversation(participantUids: string[]): Promise<CreateConversationResponse> {
    return this.conversationActions.createConversation(participantUids, 1);
  }

  markConversationRead(options: MarkConversationReadOptions): Promise<ImActionResponse> {
    return this.conversationActions.markRead(options);
  }

  getConversationReadState(options: ConversationActionOptions): Promise<ConversationReadStateResponse> {
    return this.readStateApi.getState(options);
  }

  getConversationReadIndexes(options: ConversationActionOptions): Promise<ReadCursorsResponse> {
    return this.readStateApi.getReadIndexes(options);
  }

  getConversationMinIndexes(options: ConversationActionOptions): Promise<MinCursorsResponse> {
    return this.readStateApi.getMinIndexes(options);
  }

  getBatchConversationReadIndexes(options: readonly ConversationActionOptions[]): Promise<BatchReadCursorsResponse> {
    return this.readStateApi.getBatchReadIndexes(options);
  }

  markConversationsRead(options: MarkConversationReadOptions[]): Promise<BatchMarkReadResponse> {
    return this.conversationActions.markReadBatch(options);
  }

  getConversationInfos(options: ConversationActionOptions[]): Promise<ConversationInfoListResponse> {
    return this.conversationActions.getConversationInfos(options);
  }

  deleteMessage(options: DeleteMessageOptions): Promise<ImActionResponse> {
    return this.conversationActions.deleteMessage(options);
  }

  deleteConversation(options: DeleteConversationOptions): Promise<ImActionResponse> {
    return this.conversationActions.deleteConversation(options);
  }

  enterConversation(options: EnterConversationOptions): Promise<ImActionResponse> {
    return this.conversationActions.enterConversation(options);
  }

  modifyMessageReaction(options: ModifyMessageReactionOptions): Promise<ImActionResponse> {
    return this.conversationActions.modifyReaction(options);
  }

  setConversationSettings(options: SetConversationSettingsOptions): Promise<ImActionResponse> {
    return this.conversationActions.setSettings(options);
  }

  inviteConversationParticipants(options: GroupParticipantActionOptions): Promise<ParticipantActionResponse> {
    return this.conversationActions.inviteParticipants(options);
  }

  listConversationParticipants(options: ConversationActionOptions): Promise<GroupMemberListResponse> {
    return this.conversationActions.listParticipants(options);
  }

  listGroupJoinRequests(options?: GroupJoinRequestListOptions): Promise<GroupJoinRequestListResponse> {
    return this.conversationActions.listJoinRequests(options);
  }

  getGroupJoinRequestUnread(): Promise<GroupJoinRequestUnreadResponse> {
    return this.conversationActions.getJoinRequestUnread();
  }

  clearGroupJoinRequestUnread(): Promise<ImActionResponse> {
    return this.conversationActions.clearJoinRequestUnread();
  }

  reviewGroupJoinRequest(options: ReviewGroupJoinRequestOptions): Promise<GroupJoinRequestActionResponse> {
    return this.conversationActions.reviewJoinRequest(options);
  }

  removeConversationParticipants(options: GroupParticipantActionOptions): Promise<ImActionResponse> {
    return this.conversationActions.removeParticipants(options);
  }

  leaveConversation(options: ConversationActionOptions): Promise<ImActionResponse> {
    return this.conversationActions.leave(options);
  }

  /** 批量补全聊天作品卡片；请求形状与抖音聊天桌面端一致。 */
  getSharedWorkDetails(
    conversationShortId: string,
    workIds: readonly string[],
  ): Promise<SharedWorkDetail[]> {
    return this.sharedContent.getWorkDetails(conversationShortId, workIds);
  }

  /** 批量读取聊天评论卡片当前是否可展示。 */
  getSharedCommentStatuses(
    conversationShortId: string,
    commentIds: readonly string[],
  ): Promise<SharedCommentStatus[]> {
    return this.sharedContent.getCommentStatuses(conversationShortId, commentIds);
  }

  uploadImage(data: Uint8Array): Promise<ImageAsset> {
    return this.uploader.uploadImage(data);
  }

  uploadFile(data: Uint8Array, name: string): Promise<import('./cards.js').FileAsset> {
    return this.uploader.uploadFile(data, name);
  }

  uploadVideo(data: Uint8Array): Promise<VideoAsset> {
    return this.uploader.uploadVideo(data);
  }

  /** 用消息中的 tkey 换取 CENC 加密视频 CDN 地址。 */
  async resolveVideoUrl(tkey: string): Promise<EncryptedVideoUrl> {
    if (!tkey.trim()) throw new Error('video tkey is required');
    const deviceId = await this.resolveDesktopDeviceId();
    const params = desktopFingerprintParams(
      deviceId,
      this.configuredGuid,
      this.configuredScreenSize,
      this.client.getUserAgent(),
    );
    params.set('iid', this.client.getInstallId?.() ?? '0');
    const url = `https://imdesktop.douyin.com/maya/story/batch_play_info/v1/?${params}`;
    const response = await this.client.requestRaw(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.client.getUserAgent(),
          Referer: 'https://imdesktop.douyin.com',
        },
        body: JSON.stringify({ req_infos: [{ tos_key: tkey, type: 2 }], with_caption: true }),
      },
    );
    const json = parseJsonResponse(response, url) as {
      data?: { play_infos?: Array<{ encrypted_url?: { main_url?: string; backup_url?: string; expire_time?: number } }> };
    };
    const encrypted = json.data?.play_infos?.[0]?.encrypted_url;
    if (!response.ok || !encrypted?.main_url) {
      throw new Error(`video play URL unavailable (HTTP ${response.status})`);
    }
    return {
      mainUrl: encrypted.main_url,
      backupUrl: encrypted.backup_url ?? '',
      expireTime: encrypted.expire_time ?? 0,
    };
  }

  private async resolveUserId(): Promise<string> {
    if (this.configuredPlatformUid) return this.configuredPlatformUid;
    throw new Error('Desktop IM requires platformUid');
  }

  private async resolveDesktopDeviceId(): Promise<string> {
    const current = this.client.getDeviceId?.();
    if (current !== undefined) return current;
    if (this.configuredDeviceId) return this.configuredDeviceId;
    throw new Error('Desktop IM requires deviceId');
  }

}
