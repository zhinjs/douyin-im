import { captureRejectionSymbol } from 'events';
import { ApiConnection } from '../desktop/api-connection.js';
import { DesktopSettings, desktopFloatHintConfig } from '../desktop/settings.js';
import { AccountStore } from '../store/account-store.js';
import { tryRestoreSession } from '../store/wake.js';
import type { AccountEventMap } from './account-events.js';
import { AccountAuth } from './auth/account-auth.js';
import { ActionVerification, type ActionVerificationTarget } from './auth/action-verification.js';
import { ActionChallengeError } from '../http/action-challenge.js';
import { openBrowserVerification } from './auth/browser-verification.js';
import type { LoginMethod } from './auth/account-auth.js';
import { OutboundSender } from './messaging/outbound.js';
import { EventAssembler } from './events/assembler.js';
import type { ImService } from '../services/im/service.js';
import type { ImUserProfile, UserSearchResponse, ActiveStatusResponse } from '../services/im/user-directory.js';
import { mapProfile } from '../services/im/user-directory.js';
import { addCollectedEmoji, mergeCollectedEmojiPage, type EmojiResourcesResponse, type CollectEmojiOptions, type CollectEmojiResponse,
  type CollectedEmojisResponse, type CollectedEmojiListOptions, type CollectedEmojiSnapshot } from '../services/im/emoji.js';
import type { UserSettingsResponse, ReadReceiptPrivacyResponse, MessageReadPrivacyQuery, MessageReadPrivacyResponse } from '../services/im/user-settings.js';
import { normalizeMessageReadPrivacyQueries } from '../services/im/user-settings.js';
import { equalConversationReadSummaries, mergeReadCursorState, validateStoredReadCursors, type StoredReadCursor, type ConversationReadStateResponse, type ConversationReadSummary } from '../services/im/read-state.js';
import { ConversationDeleteNoticeEvent, ConversationReadSummaryNoticeEvent } from './events/notice.js';
import { isOrdinaryMessageType, messageClientId, prepareMessageCacheWrite } from '../services/im/message-cache.js';
import { messageDeletionCommand } from '../services/im/notifications.js';
import { conversationDeletionCommand, conversationDeletionPlan, signedMessageIndex } from '../services/im/conversation-delete.js';
import { participantCommand, participantDecimalId, type ParticipantCommand } from '../services/im/participant-command.js';
import { mergeConversationSnapshot, buildStrangerConversation } from '../services/im/conversation-state.js';
import { StrangerSync, type StrangerSyncResult } from '../services/im/stranger-sync.js';
import { selectStrangerConversations } from '../services/im/stranger-list.js';
import { settingCommand, applySettingExt, conversationIsFolded, type SettingCommand, type SettingExtState } from '../services/im/setting-command.js';
import { isDesktopMessageDisplayable } from '../services/im/message-display.js';
import { inboundFromMessage, type RawInboundMessage } from '../base/raw/inbound-message.js';
import type { ConversationAddress } from '../base/contact.js';
import { parsePeerFromConversationId } from '../services/im/mappers.js';
import type {
  BatchMarkReadResponse,
  ConversationReadMarker,
  ConversationInfoListResponse,
  CreateGroupOptions,
  ImConversation,
  GroupJoinRequestListResponse,
  GroupJoinRequestUnreadResponse,
  NewFollowerCountResponse,
  RecommendedContactsResponse,
  FollowerNoticesResponse,
  UserFollowStatus,
  RecentStrangerMessagesResponse,
} from '../services/im/types.js';
import { ImInboxQueries } from './messaging/inbox-queries.js';
import { Friend, type FriendMetadata } from './contacts/friend.js';
import { Stranger, type StrangerMetadata } from './contacts/stranger.js';
import { Group, type GroupMetadata } from './contacts/group.js';
import {
  type MessageEvent,
} from './events/message.js';
import type { StoredAccount } from '../store/types.js';
import type {
  GroupMemberData,
  ImActionResponse,
} from '../services/im/types.js';
import { toError } from './errors.js';
import { BaseAccount } from '../base/account.js';
import { emitEventRoutes } from './events/router.js';
import {
  createImStateStore,
  validateMessageLocalExt,
  type MessageLocalExtUpdate,
  type ImStateStoreBackend,
  type ImStateStore,
  type LocalImStateOptions,
  type UserRelationState,
  type CachedMessageReadPrivacy,
} from '../services/im/state-store.js';
import type { PrivateMessage } from '../services/im/types.js';

function groupByInbox<T extends { inboxType?: number }>(items: readonly T[]): Map<number, T[]> {
  const batches = new Map<number, T[]>();
  for (const item of items) {
    const inboxType = item.inboxType ?? 0;
    const batch = batches.get(inboxType) ?? [];
    batch.push(item);
    batches.set(inboxType, batch);
  }
  return batches;
}

export type { LoginMethod };

export type { AccountState } from '../base/account.js';

export type LoginOptions =
  | { method: 'qr' }
  | { method: 'sms'; mobile: string }
  | { method: 'password'; mobile: string; password: string };

export interface AccountOptions {
  /** 已落盘账号的稳定 ID 或别名；只用于恢复，不再猜测为手机号。 */
  accountId?: string;
  /** 首次登录方式；不传时使用二维码。 */
  login?: LoginOptions;
  skipVerify?: boolean;
  /** 本地 IM 状态库；默认 sqlite，false 可完全关闭。 */
  localState?: false | LocalImStateOptions;
}

export type ChatContact = Friend | Group | Stranger;

export interface BatchMessageReadResult extends ImActionResponse {
  succeeded: readonly MessageEvent[];
  failed: readonly MessageEvent[];
}

/**
 * 单账号门面（对齐 oicq Client）。
 *
 * 主路径：
 * - `login()` / `logout()`
 * - `getFriendList` / `getGroupList` → `fl` / `gl` → `pick*` → `sendMsg`
 * - 事件：`system.online` | `message` | `message.private` | `message.group`
 */
export class Account extends BaseAccount {
  private readonly store: AccountStore;

  private readonly auth: AccountAuth;
  private readonly skipVerify: boolean;
  private readonly preferredUid?: string;
  private readonly localStateOptions: false | LocalImStateOptions;
  private onlinePayload?: { platformUid: string; screenName?: string };
  private accountNickname: string | undefined;
  private accountProfile?: Readonly<ImUserProfile>;
  private readonly friends = new Map<string, Friend>();
  private readonly strangers = new Map<string, Stranger>();
  private readonly groups = new Map<string, Group>();
  private sender?: OutboundSender;
  private assembler?: EventAssembler;
  private inboxFeature?: ImInboxQueries;
  private stateStore?: ImStateStore;
  private strangerSync?: StrangerSync;
  private readonly strangerDetailRefreshes = new Map<string, Promise<void>>();
  private applicationSettings?: DesktopSettings;
  private readonly readPrivacyCache = new Map<string, CachedMessageReadPrivacy>();
  private readReceiptSwitch: number | undefined;
  private collectedEmojiState: CollectedEmojiSnapshot | undefined;
  /** Keep live protocol settings even when the caller disables persistence. */
  private readonly transientConversations = new Map<string, ImConversation>();
  /** Native ext changes can remain live even when the batch exits before saveConversation. */
  private readonly pendingSettingExt = new Map<string, SettingExtState & Pick<ImConversation, 'isFolded'>>();
  private readonly settingRefreshes = new Map<string, Promise<void>>();
  private readPrivacyEpoch = 0;
  private readonly readCursors = new Map<string, StoredReadCursor[]>();
  private readonly readSummaryNotifications = new Map<string, ConversationReadSummary>();
  private readonly receivedMessageKeys = new Set<string>();
  private readCursorEpoch = 0;
  private qrContinuation?: Promise<void>;
  private restoreController?: AbortController;
  private readonly actionVerifications = new Set<ActionVerification>();
  private readonly userRelations = new Map<string, Readonly<UserRelationState>>();

  private constructor(
    client: ApiConnection,
    store: AccountStore,
    options: AccountOptions = {},
  ) {
    super({ captureRejections: true });
    this.installAccountRuntime(store, client);
    this.store = store;
    this.skipVerify = options.skipVerify ?? false;
    this.localStateOptions = options.localState ?? {};

    const preferredUid = options.accountId
      ? store.resolvePlatformUid(options.accountId)
      : undefined;
    if (preferredUid) {
      this.preferredUid = preferredUid;
      this.accountNickname = store.load(preferredUid)?.meta.screenName;
      this.refreshLoggerIdentity();
    }
    const login = options.login ?? { method: 'qr' };

    this.auth = new AccountAuth(
      {
        client,
        store,
        loginMethod: login.method,
        ...('mobile' in login ? { mobile: login.mobile } : {}),
        ...('password' in login ? { password: login.password } : {}),
      },
      {
        onQrcode: (info) => this.emit('system.login.qrcode', info),
        onQrStatus: (payload) => this.emit('system.login.qrcode.status', payload),
        onSms: (payload) => this.emit('system.login.sms', payload),
        onVoice: (payload) => this.emit('system.login.voice', payload),
        onAccountSelection: (payload) => this.emit('system.login.accounts', payload),
        onSmsRequired: (payload) => this.emit('system.login.sms-required', payload),
        onVerification: (payload) => this.emit('system.login.verification', payload),
        onLoggedIn: (account) => this.onLoggedInAccount(account),
      },
    );
  }

  /** @internal 账号只能由 Client 注册和创建。 */
  static create(
    client: ApiConnection,
    store: AccountStore,
    options: AccountOptions = {},
  ): Account {
    return new Account(client, store, options);
  }

  /** 当前账号的稳定平台标识；登录前可能尚不可用。 */
  get uid(): string | undefined {
    return this.runtime.platformUid ?? this.preferredUid;
  }

  get nickname(): string | undefined {
    return this.accountNickname;
  }

  /** 当前登录最近一次主动读取的自身资料；退出后清空，不包含认证凭据。 */
  get profile(): Readonly<ImUserProfile> | undefined { return this.accountProfile; }

  /** 显式读取 Desktop 当前账号资料；不修改 Session 或好友关系。 */
  async getProfile(): Promise<Readonly<ImUserProfile>> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const connection = this.runtime.connection;
    const response = await connection.getSelfProfile();
    if (!this.online || generation !== this.loginGeneration || connection !== this.runtime.connection) {
      throw new Error('账号状态已变化，自身资料读取已取消');
    }
    const status = response['status_code'];
    if (status !== undefined && status !== 0) throw new Error(`查询自身资料失败: status=${String(status)}`);
    const profile = mapProfile(response['user']);
    if (!profile || profile.uid !== this.uid) throw new Error('自身资料响应缺失或身份不匹配');
    this.accountProfile = Object.freeze(profile);
    return this.accountProfile;
  }

  get imUid(): string | undefined {
    return this.sender?.imService.myUid || undefined;
  }

  /** 当前账号实际启用的本地 IM 状态后端；登录前或关闭缓存时为 undefined。 */
  get localStateBackend(): ImStateStoreBackend | undefined {
    return this.stateStore?.backend;
  }

  /** 上线后自动加载的好友对象缓存；可调用 getFriendList() 手动刷新。 */
  get fl(): ReadonlyMap<string, Friend> {
    return this.friends;
  }

  /** 上线后自动加载的群对象缓存；可调用 getGroupList(true) 手动刷新。 */
  get gl(): ReadonlyMap<string, Group> {
    return this.groups;
  }

  /** 上线时同步的陌生人视图；getStrangerList 读本地，后续同步用 refresh/loadMore。 */
  get sl(): ReadonlyMap<string, Stranger> {
    return this.strangers;
  }

  /** @internal 完整群列表替换时清理旧缓存项；协议退群/删除走各自的边界处理。 */
  forgetGroup(groupId: string, expected: Group): void {
    if (this.groups.get(groupId) !== expected) return;
    this.groups.delete(groupId);
    this.transientConversations.delete(groupId);
    this.pendingSettingExt.delete(groupId);
    this.invalidateReadPrivacy(groupId);
    this.readCursors.delete(groupId); this.readCursorEpoch++;
    this.stateStore?.deleteConversation(groupId);
  }

  /** @internal 被动事件先写入 gl，再交给用户 handler。 */
  rememberGroup(group: Group): void {
    if (!this.groups.has(group.groupId)) this.groups.set(group.groupId, group);
  }

  /** @internal 被动事件先写入 fl，再交给用户 handler。 */
  rememberFriend(friend: Friend): void {
    if (!this.friends.has(friend.uid)) this.friends.set(friend.uid, friend);
  }

  /** @internal 被动事件和批量会话刷新先写入 sl，再交给用户 handler。 */
  rememberStranger(stranger: Stranger): void {
    if (!this.strangers.has(stranger.uid)) this.strangers.set(stranger.uid, stranger);
  }

  /** @internal 好友删除通知只移除仍以该 uid 缓存的好友。 */
  forgetFriend(uid: string): void {
    this.friends.delete(uid);
  }

  /** @internal 入站事件复用账号缓存中的对象及完整资料。 */
  cachedFriend(uid: string): Friend | undefined {
    return this.friends.get(uid);
  }

  /** @internal 已读通知只有 conversationId 时仍可复用已加载的 Friend。 */
  cachedFriendByThreadId(threadId: string): Friend | undefined {
    for (const friend of this.friends.values()) {
      if (friend.threadId === threadId) return friend;
    }
    return undefined;
  }

  /** @internal 陌生人列表绑定时复用稳定实例。 */
  cachedStranger(uid: string): Stranger | undefined {
    return this.strangers.get(uid);
  }

  /** @internal 入站事件复用账号缓存中的对象及成员列表。 */
  cachedGroup(groupId: string): Group | undefined {
    return this.groups.get(groupId);
  }

  /** @internal 完整成员快照不存在时返回 undefined，不能把事件增量误作全量。 */
  cachedGroupMembers(groupId: string): readonly GroupMemberData[] | undefined {
    return this.stateStore?.listGroupMembers(groupId);
  }

  /** @internal cmd605 成功后替换完整成员快照。 */
  replaceCachedGroupMembers(groupId: string, members: readonly GroupMemberData[]): void {
    const present = new Set(members.map(member => member.uid));
    const removed = this.cachedReadCursors(groupId).filter(row => !present.has(row.uid)).map(row => row.uid);
    if (removed.length) this.removeCachedGroupMembers(groupId, removed);
    this.stateStore?.replaceGroupMembers(groupId, members);
  }

  /** @internal 消息/通知/局部查询只合并成员，不标记为完整列表。 */
  upsertCachedGroupMembers(groupId: string, members: readonly GroupMemberData[]): void {
    this.stateStore?.upsertGroupMembers(groupId, members);
  }

  /** @internal 成员退出、移除后同步本地状态。 */
  removeCachedGroupMembers(groupId: string, uids: readonly string[]): void {
    if (!uids.length) return;
    this.readCursorEpoch++;
    this.readCursors.set(groupId, this.cachedReadCursors(groupId).filter(row => !uids.includes(row.uid)));
    this.stateStore?.removeGroupMembers(groupId, uids);
  }

  /** @internal 原始 READINDEX 本地状态；不是可展示的已读用户列表。 */
  cachedReadCursors(conversationId: string): StoredReadCursor[] {
    if (!this.online && !this.stateStore) return [];
    let rows = this.readCursors.get(conversationId);
    if (!rows) {
      rows = this.stateStore?.listReadCursors(conversationId) ?? [];
      this.readCursors.set(conversationId, rows);
    }
    return structuredClone(rows);
  }

  /** @internal Raw local native aggregate; does not fetch, mark read or apply renderer privacy policy. */
  cachedReadSummary(conversationId: string): ConversationReadSummary | undefined {
    const uid = this.imUid ?? this.uid;
    return uid ? this.stateStore?.getReadSummary(conversationId, uid) : undefined;
  }

  /** @internal Native onUpdateReadIndex_: cache all changed summaries before one batch notification. */
  updateReadSummaries(conversationIds: readonly string[]): void {
    if (!this.online) return;
    const changed: ConversationReadSummary[] = [];
    for (const id of conversationIds) {
      const summary = this.cachedReadSummary(id);
      // Native skips absent last-sent messages without clearing the previous notification entry.
      if (!summary) continue;
      const previous = this.readSummaryNotifications.get(id);
      if (previous && equalConversationReadSummaries(previous, summary)) continue;
      this.readSummaryNotifications.set(id, structuredClone(summary));
      changed.push(summary);
    }
    if (changed.length) emitEventRoutes(this.emit.bind(this), new ConversationReadSummaryNoticeEvent(this, changed));
  }

  /** @internal 联系人持有地址，账号负责查询期间生命周期与写库隔离。 */
  async readConversationState(address: ConversationAddress): Promise<ConversationReadStateResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const epoch = this.readCursorEpoch;
    const result = await this.im.getConversationReadState(address);
    if (!this.online || generation !== this.loginGeneration || epoch !== this.readCursorEpoch) {
      throw new Error('账号或读游标状态已变化，查询结果已取消');
    }
    if (result.statusCode === 0) {
      this.saveReadCursors(address.threadId, mergeReadCursorState(this.cachedReadCursors(address.threadId), result));
      this.updateReadSummaries([address.threadId]);
    }
    return result;
  }

  /** @internal 50013 只更新其他用户普通读游标；在已保存行上额外防止回退。 */
  applyParticipantReadIndex(conversationId: string, uid: string, index: string): boolean {
    if (!this.online || !conversationId || uid === this.uid || uid === this.imUid) return false;
    validateStoredReadCursors([{ uid, readIndex: index, minIndex: '0' }]);
    const rows = this.cachedReadCursors(conversationId);
    const previous = rows.find(row => row.uid === uid);
    if (BigInt(index) <= BigInt(previous?.readIndex ?? '-1')) return false;
    const next = { uid, readIndex: index, minIndex: previous?.minIndex ?? '0' };
    this.saveReadCursors(conversationId, [...rows.filter(row => row.uid !== uid), next]);
    this.readCursorEpoch++;
    this.updateReadSummaries([conversationId]);
    return true;
  }

  private saveReadCursors(conversationId: string, rows: StoredReadCursor[]): void {
    validateStoredReadCursors(rows);
    this.readCursors.set(conversationId, structuredClone(rows));
    try { this.stateStore?.saveReadCursors(conversationId, rows); }
    catch { this.logger.warn('读游标已更新，但本地状态保存失败'); }
  }

  /** @internal History saves ordinary rows; command2 still emits its single events even without a pull batch. */
  cacheMessages(messages: readonly PrivateMessage[], source: 'server' | 'send-ack' = 'server'): void {
    const generation = this.loginGeneration;
    let pending: PrivateMessage[] = [];
    for (const message of messages) {
      if (generation !== this.loginGeneration) return;
      const deletion = source === 'server' ? messageDeletionCommand(message.msgType, message.content) : undefined;
      const setting = source === 'server' ? settingCommand(message.msgType, message.content) : undefined;
      const conversationCommand = source === 'server' && (message.msgType === 50005 || conversationDeletionCommand(message.msgType, message.content)
        || participantCommand(message.msgType, message.content));
      if (deletion || setting || conversationCommand) {
        if (pending.length) this.stateStore?.upsertMessages(pending, source);
        pending = [];
        if (deletion) this.applyMessageDeletionCommand(deletion.conversationId, deletion.serverMessageId, { ...message });
        else if (conversationCommand) this.applyConversationCommand(message.msgType, message.content, message.threadId, { ...message });
        else this.applySettingCommand(message.msgType, message.content, { ...message });
      } else pending.push(message);
    }
    if (generation === this.loginGeneration && pending.length) this.stateStore?.upsertMessages(pending, source);
  }

  /** @internal ChatContact 的纯本地消息读取。 */
  cachedMessages(conversationId: string, count = 50): PrivateMessage[] {
    return this.stateStore?.listMessages(conversationId, count) ?? [];
  }

  /** @internal Account-scoped local lookup; never creates or fetches a conversation. */
  cachedMessage(conversationId: string, id: string, kind: 'server' | 'client'): PrivateMessage | undefined {
    return this.stateStore?.getMessage(conversationId, id, kind);
  }

  /** @internal Contact-scoped single operation; missing conversation/message is an error, not an upsert. */
  modifyCachedMessageLocalExt(conversationId: string, clientMessageId: string, ext: Readonly<Record<string, string>>): void {
    this.ensureOnline();
    validateMessageLocalExt(ext);
    if (!conversationId || !clientMessageId) return;
    if (!this.stateStore) throw new Error('修改消息本地扩展字段需要启用本地状态库');
    const conversation = this.stateStore.getConversation(conversationId);
    if (!conversation) throw new Error('修改消息本地扩展字段失败：本地会话不存在');
    const message = this.stateStore.modifyMessageLocalExt({ conversationId, clientMessageId, ext });
    if (!message) throw new Error('修改消息本地扩展字段失败：本地消息不存在');
    this.assembler?.receiveMessageUpdate({ conversationType: message.conversationType ?? conversation.conversationType, raw: {} }, message);
  }

  /** Local-only ordered patches, then one flat message-list notice; missing messages are skipped. Not a cross-row transaction. */
  batchModifyMessageLocalExt(updates: readonly MessageLocalExtUpdate[]): void {
    this.ensureOnline();
    if (!Array.isArray(updates)) throw new TypeError('批量本地扩展更新必须是数组');
    for (const update of updates) {
      if (!update || typeof update.conversationId !== 'string' || typeof update.clientMessageId !== 'string') {
        throw new TypeError('本地扩展更新需要字符串 conversationId/clientMessageId');
      }
      validateMessageLocalExt(update.ext);
    }
    if (!updates.length) return;
    if (!this.stateStore) throw new Error('修改消息本地扩展字段需要启用本地状态库');
    for (const update of updates) this.stateStore.modifyMessageLocalExt(update);
    // Desktop rereads after ALL patches, retaining input order and duplicates, even for orphan rows.
    const messages = updates.flatMap(update => {
      const message = this.stateStore!.getMessage(update.conversationId, update.clientMessageId, 'client');
      return message ? [message] : [];
    });
    this.assembler?.receiveMessageListUpdate(messages);
  }

  /** @internal Known conversation snapshot, including nonpersistent accounts; no implicit network/create. */
  cachedConversation(conversationId: string): ImConversation | undefined {
    const current = this.stateStore ? this.stateStore.getConversation(conversationId) : this.transientConversations.get(conversationId);
    return current && structuredClone({ ...current, ...this.pendingSettingExt.get(conversationId) });
  }

  /** @internal Native deletion requires a message-store boundary captured before dispatch. */
  getConversationDeletionBoundary(conversationId: string): string {
    this.ensureOnline();
    if (!this.stateStore) throw new Error('删除会话需要本地消息库；localState: false 无法提供 Desktop 删除边界');
    return this.stateStore.getConversationDeletionBoundary(conversationId);
  }

  /** @internal Called only after a successful response from the current connection. */
  applyConversationDeletion(conversationId: string, conversationType: 1 | 2, boundary: string): void {
    this.ensureOnline();
    if (!this.stateStore) throw new Error('删除会话的本地消息库已关闭');
    this.applyConversationDeletionState(conversationId, boundary);
    // Active deletion emits its delete callback even if a newer message kept the conversation.
    emitEventRoutes(this.emit.bind(this), new ConversationDeleteNoticeEvent({ type: 'conversation.delete',
      conversationId, conversationType, raw: { cmd: 603, lastMessageIndex: boundary } }, this));
  }

  /** @internal Successful native leave uses the same local boundary, but posts update instead of delete. */
  applyConversationLeave(conversationId: string, boundary: string): void {
    this.ensureOnline();
    if (!this.stateStore) throw new Error('退群后的本地消息库已关闭');
    this.applyConversationDeletionState(conversationId, boundary);
    this.scheduleConversationUpdate(conversationId, { cmd: 652, lastMessageIndex: boundary });
  }

  private applyConversationDeletionState(conversationId: string, boundary: string): void {
    let outcome: 'missing' | 'retained' | 'deleted';
    if (this.stateStore) outcome = this.stateStore.applyConversationDeletion(conversationId, boundary);
    else {
      // Passive commands already supply their boundary; transient accounts need no invented message MAX.
      const current = this.cachedConversation(conversationId);
      if (!current) return;
      const plan = conversationDeletionPlan(current, boundary);
      outcome = plan.deleteConversation ? 'deleted' : 'retained';
      this.patchCachedConversation(conversationId, { minIndex: plan.minIndex });
    }
    this.invalidateReadPrivacy(conversationId);
    if (outcome === 'deleted') {
      this.groups.delete(conversationId);
      for (const [uid, stranger] of this.strangers) if (stranger.threadId === conversationId) this.strangers.delete(uid);
      this.transientConversations.delete(conversationId);
      this.pendingSettingExt.delete(conversationId);
      this.readCursors.delete(conversationId); this.readCursorEpoch++;
    }
  }

  /** @internal Native participation, participant update and DeleteConv controls. */
  applyConversationCommand(messageType: number, content: string, outerId: string, raw: Record<string, unknown>, hasBatch = false): boolean {
    if (messageType === 50005) {
      if (!this.online || !this.cachedConversation(outerId)) return true;
      this.patchCachedConversation(outerId, { isParticipant: false });
      this.groups.get(outerId)?.updateMetadata({ isParticipant: false });
      // Even an already-false participant is saved/notified; no member removal or history deletion.
      if (!hasBatch) this.scheduleConversationUpdate(outerId, raw);
      return true;
    }
    const participants = participantCommand(messageType, content);
    if (participants) {
      if (this.online) this.applyParticipantCommand(participants, raw, hasBatch);
      return true;
    }
    const command = conversationDeletionCommand(messageType, content);
    if (!command) return false;
    if (!this.online) return true;
    const current = this.cachedConversation(command.conversationId);
    if (!current) return true; // Native does not create/fetch a missing target.
    const hasNewerMessages = signedMessageIndex(current.lastMessageIndex ?? '0') > signedMessageIndex(command.lastMessageIndex);
    const generation = this.loginGeneration;
    this.applyConversationDeletionState(command.conversationId, command.lastMessageIndex);
    // OperateManager posts update; its worker re-queries and skips a deleted/missing conversation.
    this.scheduleConversationUpdate(command.conversationId, raw);
    queueMicrotask(() => {
      if (!this.online || generation !== this.loginGeneration) return;
      // DeleteConv uses the pre-deletion lastIndex, not the local plan's retained/deleted outcome.
      this.assembler?.receiveNotice(hasNewerMessages
        ? { type: 'conversation.min-index', conversationId: command.conversationId,
          conversationType: current.conversationType, minIndex: command.lastMessageIndex, raw }
        : { type: 'conversation.delete', conversationId: command.conversationId,
          conversationType: current.conversationType, raw });
    });
    return true;
  }

  private applyParticipantCommand(command: ParticipantCommand, raw: Record<string, unknown>, hasBatch: boolean): void {
    const id = command.conversationId;
    const generation = this.loginGeneration;
    for (const uid of command.removed) {
      if (uid === participantDecimalId(this.imUid || this.uid || '')) this.applyConversationCommand(50005, '', id, raw, hasBatch);
    }
    if (command.removed.length) {
      // Native uses its misc worker: re-read the conversation when that work runs.
      void Promise.resolve().then(() => {
        if (!this.online || generation !== this.loginGeneration) return;
        const current = this.cachedConversation(id);
        if (!current) return;
        const removed = new Set(command.removed);
        const members = current.members?.filter(member => !removed.has(member.uid));
        const readCursors = this.cachedReadCursors(id).filter(row => !removed.has(row.uid));
        const changed = this.stateStore ? this.stateStore.removeConversationMembers(id, command.removed)
          : members !== undefined && members.length !== current.members?.length;
        if (changed === undefined) return;
        if (!this.stateStore && changed) this.patchCachedConversation(id, { members });
        // Publish in-memory views only after all durable member/cursor writes commit.
        this.groups.get(id)?.removeCachedMemberIds(command.removed);
        this.readCursors.set(id, readCursors);
        this.readCursorEpoch++;
        if (changed) this.scheduleConversationUpdate(id, raw);
        // Counts and history stay intact; no fabricated Member/operator/reason.
        queueMicrotask(() => {
          if (!this.online || generation !== this.loginGeneration) return;
          this.assembler?.receiveNotice({ type: 'conversation.members-remove', conversationId: id,
            conversationType: current.conversationType, memberUids: command.removed, raw });
        });
      }).catch(error => {
        if (this.online && generation === this.loginGeneration) this.logger.warn('成员移除本地同步失败: %s', toError(error).message);
      });
    }
    if (command.added.length || command.modified.length) {
      void (async () => {
        const response = await this.im.getConversationInfos([{ threadId: id, conversationShortId: participantDecimalId(id),
          conversationType: command.conversationType as 1 | 2, inboxType: command.inboxType }]);
        if (!this.online || generation !== this.loginGeneration) return;
        if (response.statusCode !== 0) throw new Error(`status=${response.statusCode} ${response.statusMsg}`);
        for (const info of response.conversations) this.applyConversationInfo(info);
        this.scheduleConversationUpdate(id, raw);
      })().catch(error => {
        if (this.online && generation === this.loginGeneration) this.logger.warn('成员变更会话补拉失败: %s', toError(error).message);
      });
    }
    // Native also conditionally schedules 2001 after add/remove. Its pull-ready lifecycle
    // is not yet implemented here; do not substitute online or getState (2000 + 2001).
  }

  private saveConversationSnapshot(info: ImConversation, source: 'server' | 'local' = 'server'): ImConversation {
    // Account may hold newer unsaved command ext than the durable store. Merge that live state first.
    if (source === 'server') info = mergeConversationSnapshot(this.cachedConversation(info.conversationId), info, this.imUid || this.uid);
    if (this.stateStore) {
      this.stateStore.upsertConversations([info], source);
      this.pendingSettingExt.delete(info.conversationId);
      return this.stateStore.getConversation(info.conversationId)!;
    }
    this.transientConversations.set(info.conversationId, structuredClone(info));
    this.pendingSettingExt.delete(info.conversationId);
    return info;
  }

  /** @internal Returns whether this was command4, not whether it changed a known conversation. */
  applySettingCommand(messageType: number, content: string, raw: Record<string, unknown>): boolean {
    const command = settingCommand(messageType, content);
    if (!command) return false;
    if (!this.online) return true;
    const current = this.cachedConversation(command.conversationId);
    if (!current) return true; // Never create from a command body.
    const result = applySettingExt(current, command.entries);
    if (result.changed) this.pendingSettingExt.set(command.conversationId, result.state);
    if (result.handled) {
      if (result.changed) {
        const saved = { ...result.state, isFolded: conversationIsFolded(result.state.settingExt) };
        this.pendingSettingExt.set(command.conversationId, saved);
        this.patchCachedConversation(command.conversationId, saved);
      }
      this.scheduleConversationUpdate(command.conversationId, raw);
    } else if (BigInt(command.version) >= BigInt(current.settingVersion ?? '0')) {
      this.refreshSettingConversation(command, current, raw);
    }
    return true;
  }

  private scheduleConversationUpdate(id: string, raw: Record<string, unknown>): void {
    const generation = this.loginGeneration;
    queueMicrotask(() => {
      if (!this.online || generation !== this.loginGeneration) return;
      const current = this.cachedConversation(id);
      if (current) this.assembler?.receiveNotice({ type: 'conversation.update', conversationId: id,
        conversationType: current.conversationType, raw });
    });
  }

  private refreshSettingConversation(command: SettingCommand, current: ImConversation, raw: Record<string, unknown>): void {
    const id = command.conversationId;
    if (!id || this.settingRefreshes.has(id)) return;
    const generation = this.loginGeneration;
    const task = (async () => {
      const response = await this.im.getConversationInfos([{ threadId: id, conversationShortId: current.conversationShortId,
        conversationType: current.conversationType as 1 | 2, inboxType: current.inboxType ?? 0 }]);
      if (!this.online || generation !== this.loginGeneration) return;
      if (response.statusCode !== 0) throw new Error(`status=${response.statusCode} ${response.statusMsg}`);
      for (const info of response.conversations) this.applyConversationInfo(info);
      this.scheduleConversationUpdate(id, raw);
    })();
    this.settingRefreshes.set(id, task);
    void task.catch(error => {
      if (this.online && generation === this.loginGeneration) this.logger.warn('会话设置补拉失败: %s', toError(error).message);
    }).finally(() => {
      if (this.settingRefreshes.get(id) === task) this.settingRefreshes.delete(id);
    });
  }

  /** @internal 删除隐藏当前缓存行，保留 soft-delete 状态；不是永久 tombstone。 */
  removeCachedMessage(conversationId: string, serverMessageId: string): boolean {
    const message = this.cachedMessage(conversationId, serverMessageId, 'server');
    this.invalidateReadPrivacy(conversationId, serverMessageId);
    this.stateStore?.deleteMessage(conversationId, serverMessageId);
    return message !== undefined && message.deleted !== true;
  }

  /** @internal Native command2: server lookup, then live client lookup; return the batch client ID even for a soft-deleted target. */
  applyMessageDeletionCommand(conversationId: string, serverMessageId: string, raw: Record<string, unknown>): string | undefined {
    if (!this.online || !conversationId) return undefined;
    const original = this.cachedMessage(conversationId, serverMessageId, 'server');
    const clientId = original && messageClientId(original);
    if (!clientId) return undefined;
    this.deleteCachedMessageByClientId(conversationId, clientId, true, raw);
    return clientId;
  }

  /** @internal Shared native local delete: notify deletion, optionally update direct references. */
  deleteCachedMessageByClientId(conversationId: string, clientId: string, updateReferences: boolean, raw: Record<string, unknown> = {}): boolean {
    if (!this.online || !conversationId || !clientId) return false;
    const target = this.cachedMessage(conversationId, clientId, 'client');
    if (!target) return false;
    const assembler = this.assembler;
    const generation = this.loginGeneration;
    this.invalidateReadPrivacy(conversationId, target.msgId);
    const summaryChanged = this.stateStore?.deleteMessage(conversationId, clientId, 'client');
    if (summaryChanged) {
      const conversation = this.cachedConversation(conversationId);
      if (conversation) assembler?.receiveNotice({ type: 'conversation.update', conversationId,
        conversationType: conversation.conversationType, raw });
      if (!this.online || generation !== this.loginGeneration) return true;
    }
    const references = updateReferences ? this.stateStore?.getReferencingMessages(conversationId, target.msgId) ?? [] : [];
    for (const reference of references) reference.referenceInfo = { ...reference.referenceInfo!, refMessageStatus: 4 };
    const updates = this.stateStore?.upsertMessages(references, 'local-update') ?? [];
    for (const { message } of updates) {
      if (!this.online || generation !== this.loginGeneration) return true;
      assembler?.receiveMessageUpdate({ conversationType: message.conversationType ?? this.cachedConversation(conversationId)?.conversationType ?? 0, raw }, message);
    }
    if (this.online && generation === this.loginGeneration) assembler?.receiveMessageDelete(target, raw);
    return true;
  }

  /** @internal Desktop recall: find client first, then server; retain the original body. */
  markCachedMessageRecalled(conversationId: string, target: { serverMessageId?: string; clientMessageId?: string; createTime?: string; raw?: Record<string, unknown> }): PrivateMessage | undefined {
    // OperateManager's wrapper requires both IDs before ResourceManager's server fallback.
    if (!conversationId || !target.clientMessageId) return undefined;
    const message = (target.clientMessageId ? this.cachedMessage(conversationId, target.clientMessageId, 'client') : undefined)
      ?? (target.serverMessageId ? this.cachedMessage(conversationId, target.serverMessageId, 'server') : undefined);
    if (!message) return undefined;
    const now = BigInt(Date.now());
    const rawTime = target.createTime && /^-?\d+$/.test(target.createTime) ? BigInt(target.createTime) : 0n;
    const timestamp = rawTime > 0n && rawTime < now ? rawTime : now;
    message.ext = { ...message.ext, 's:is_recalled': 'true' };
    message.localExt = { ...message.localExt, 's:text_recall_timestamp': String(timestamp) };
    this.invalidateReadPrivacy(conversationId, message.msgId);
    this.stateStore?.deleteMessageReadPrivacy(conversationId, message.msgId);
    const references = this.stateStore?.getReferencingMessages(conversationId, message.msgId) ?? [];
    // Desktop markRefMessageRecalled changes only direct-reference status, not body/hint or root refs.
    for (const reference of references) {
      reference.referenceInfo = { ...reference.referenceInfo!, refMessageStatus: 3 };
      if (reference.msgId === message.msgId) message.referenceInfo = reference.referenceInfo;
    }
    const updates = this.stateStore?.upsertMessages([message], 'local-update') ?? [];
    this.stateStore?.refreshRecalledSummary(conversationId, messageClientId(message));
    updates.push(...this.stateStore?.upsertMessages(references.filter(reference => reference.msgId !== message.msgId), 'local-update') ?? []);
    this.assembler?.receiveMessageBatch(updates.map(update => update.message), [], target.raw ?? {});
    return updates[0]?.message;
  }

  /** @internal Explicit cache invalidation; protocol deletion notices must not use physical clearing. */
  forgetConversation(conversationId: string): void {
    this.groups.delete(conversationId);
    this.transientConversations.delete(conversationId);
    this.pendingSettingExt.delete(conversationId);
    this.invalidateReadPrivacy(conversationId);
    this.readCursors.delete(conversationId); this.readCursorEpoch++;
    this.stateStore?.deleteConversation(conversationId);
  }

  private invalidateReadPrivacy(conversationId: string, serverMessageId?: string): void {
    this.readPrivacyEpoch++;
    for (const [id, entry] of this.readPrivacyCache) {
      if (entry.query.conversationId === conversationId && (!serverMessageId || serverMessageId === id)) this.readPrivacyCache.delete(id);
    }
  }

  /** @internal 成功的本地可确定动作补丁同步到会话缓存。 */
  patchCachedConversation(
    conversationId: string,
    patch: Partial<Omit<ImConversation, 'conversationId'>>,
  ): void {
    const pending = this.pendingSettingExt.get(conversationId);
    this.stateStore?.patchConversation(conversationId, { ...pending, ...patch });
    const current = this.transientConversations.get(conversationId);
    if (!this.stateStore && current) this.transientConversations.set(conversationId, { ...current, ...structuredClone({ ...pending, ...patch }) });
    this.pendingSettingExt.delete(conversationId);
  }

  // ─── Lifecycle ────────────────────────────────────────────

  continueLogin(): Promise<void> {
    if (this.qrContinuation) return this.qrContinuation;
    const task = this.continueLoginAction(() => this.auth.continueQrLogin());
    this.qrContinuation = task;
    void task.then(
      () => {
        if (this.qrContinuation === task) delete this.qrContinuation;
      },
      () => {
        if (this.qrContinuation === task) delete this.qrContinuation;
      },
    );
    return task;
  }

  async continueLoginWithSms(code: string): Promise<void> {
    await this.continueLoginAction(() => this.auth.continueSmsLogin(code));
  }

  /** 请求或重新发送登录验证码；密码风控要求验证码时也用此方法切换。 */
  async requestLoginSmsCode(): Promise<void> {
    await this.continueLoginAction(() => this.auth.requestSmsCode());
  }

  /** 短信收不到时请求语音验证码；收到后仍调用 continueLoginWithSms(code)。 */
  async requestLoginVoiceCode(): Promise<void> {
    await this.continueLoginAction(() => this.auth.requestVoiceCode());
  }

  /** 同一手机号关联多个账号时，选择 `system.login.accounts` 返回的 secUid。 */
  async continueLoginWithSubAccount(selection: {
    secUid?: string;
    registerNewUser?: boolean;
  }): Promise<void> {
    await this.continueLoginAction(() => this.auth.continueWithSubAccount(selection));
  }

  protected override async beginLogin(generation: number): Promise<void> {
    const preferred = this.preferredUid ?? this.store.resolvePlatformUid();
    const saved = preferred ? this.store.load(preferred) : undefined;
    if (preferred && saved) {
      const controller = new AbortController();
      this.restoreController = controller;
      let restored: Awaited<ReturnType<typeof tryRestoreSession>>;
      try {
        restored = await tryRestoreSession(
          this.store,
          (cfg) => new ApiConnection(cfg as Record<string, string>),
          preferred,
          {
            skipVerify: this.skipVerify, signal: controller.signal,
            probeSession: (client, signal) => this.auth.probeRestoredSession(client as ApiConnection, signal),
          },
        );
      } finally {
        if (this.restoreController === controller) delete this.restoreController;
      }
      this.assertLoginGeneration(generation);
      if (restored.wake) {
        this.emit('system.login.session', {
          status: restored.outcome === 'ok' && restored.wake.verified
            ? 'valid'
            : restored.outcome === 'expired'
              ? 'expired'
              : 'unverified',
          reason: restored.wake.reason,
        });
      }
      if (restored.outcome === 'error') {
        throw new Error(`Session 恢复未通过校验：${restored.wake?.reason ?? '未知错误'}；凭据已保留，请稍后重试登录`);
      }
      if (restored.outcome === 'ok' && restored.wake) {
        const wakeClient = restored.wake.client as ApiConnection;
        this.auth.setClient(wakeClient);
        this.runtime.bindRestored(wakeClient, restored.wake.account);
        this.accountNickname = restored.wake.screenName ?? restored.wake.account.meta.screenName;
        await this.goOnline(generation);
        return;
      }
    }

    this.assertLoginGeneration(generation);
    await this.auth.beginLogin();
  }

  protected override cancelLogin(): void {
    this.restoreController?.abort(new Error('登录已取消'));
    delete this.restoreController;
    this.auth.cancel();
    delete this.qrContinuation;
  }

  protected override onDeviceUpdated(): void {
    void this.applicationSettings?.restart(this.runtime.connection.getApplicationSettingsUrl());
  }

  protected override async stopRuntime(): Promise<void> {
    this.strangerSync?.close();
    delete this.strangerSync;
    this.strangerDetailRefreshes.clear();
    this.applicationSettings?.stop();
    delete this.applicationSettings;
    for (const verification of this.actionVerifications) verification.cancel('账号已停止，业务验证已取消');
    try {
      await super.stopRuntime();
    } finally {
      this.readPrivacyCache.clear();
      this.readReceiptSwitch = undefined;
      this.collectedEmojiState = undefined;
      this.transientConversations.clear();
      this.pendingSettingExt.clear(); this.settingRefreshes.clear();
      this.readPrivacyEpoch++;
      this.readCursors.clear(); this.readCursorEpoch++;
      this.readSummaryNotifications.clear();
      this.receivedMessageKeys.clear();
      const stateStore = this.stateStore;
      this.assembler?.clear();
      delete this.sender;
      delete this.assembler;
      delete this.inboxFeature;
      delete this.stateStore;
      stateStore?.close();
    }
  }

  protected override onLoggedOut(): void {
    this.userRelations.clear();
    delete this.accountProfile;
    this.friends.clear();
    this.strangers.clear();
    this.groups.clear();
  }

  // ─── Contacts（oicq pick*）────────────────────────────────

  pickFriend(uid: string): Friend | undefined {
    this.ensureOnline();
    return this.friends.get(uid);
  }

  pickGroup(groupId: string): Group | undefined {
    this.ensureOnline();
    return this.groups.get(groupId);
  }

  pickStranger(uid: string): Stranger | undefined {
    this.ensureOnline();
    return this.strangers.get(uid);
  }

  /** 创建群聊。当前账号会自动加入；群资料随创建请求原子提交。 */
  async createGroup(
    participantUids: string[],
    options: CreateGroupOptions = {},
  ): Promise<Group> {
    this.ensureOnline();
    if (participantUids.length === 0) throw new Error('创建群聊至少需要一个其他成员');
    if (participantUids.some((uid) => !/^\d+$/.test(uid))) {
      throw new Error('群成员 uid 必须是数字 IM uid');
    }
    const selfUid = this.imUid || this.uid || '';
    if (!/^\d+$/.test(selfUid)) throw new Error('当前账号缺少可用的数字 IM uid');
    const participants = [...new Set([selfUid, ...participantUids])];
    if (participants.length < 2) throw new Error('创建群聊至少需要一个其他成员');
    const response = await this.im.createGroupConversation(participants, options);
    if (response.statusCode !== 0) {
      throw new Error(
        `创建群聊失败: status=${response.statusCode}${response.statusMsg ? ` ${response.statusMsg}` : ''}`,
      );
    }
    let info = response.conversation;
    const groupId = info?.conversationId || info?.conversationShortId;
    const shortId = info?.conversationShortId || groupId;
    if (!info || !groupId || !shortId) {
      throw new Error('创建群聊失败: 响应缺少 conversation');
    }
    info = this.saveConversationSnapshot(info);
    const group = this.bindGroup(groupId, shortId, {
      ...(info.name ? { name: info.name } : {}),
      ...(info.description ? { description: info.description } : {}),
      ...(info.notice ? { notice: info.notice } : {}),
      ...(info.avatar ? { avatar: info.avatar } : {}),
      ...(info.ownerUid ? { ownerUid: info.ownerUid } : {}),
      ...(info.participantsCount !== undefined
        ? { memberCount: info.participantsCount }
        : {}),
      ...(info.muted !== undefined ? { muted: info.muted } : {}),
      ...(info.pinned !== undefined ? { pinned: info.pinned } : {}),
      ...(info.favorite !== undefined ? { favorite: info.favorite } : {}),
      ...(info.isParticipant !== undefined ? { isParticipant: info.isParticipant } : {}),
      ...(info.inboxType !== undefined ? { inboxType: info.inboxType } : {}),
      members: info.members,
    });
    this.rememberGroup(group);
    return group;
  }

  /** 拉取好友会话并原子替换 fl；返回的 Friend 均已绑定当前账号，可直接 sendMsg。 */
  async getFriendList(): Promise<readonly Friend[]> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const relationsAtStart = new Map(this.userRelations);
    const infos = new Map<string, Awaited<ReturnType<ImInboxQueries['friendList']>>['userList'][number]>();
    let friendUids: string[] = [];
    let closeFriendUids: string[] | undefined;
    const seen = new Set<string>();
    let cursor = '0';
    for (;;) {
      const response = await this.inboxQueries.friendList({
        cursor,
        // Desktop Friends page uses /web/familiar/list/ with 100 records per page.
        count: 100,
      });
      if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，好友列表读取已取消');
      this.ensureQuerySucceeded('查询好友列表', response.statusCode, response.statusMsg);
      for (const info of response.userList) infos.set(info.uid, info);
      // Desktop accumulates profiles but replaces membership snapshots on every
      // page, then joins only after the final page. Never filter page-local users.
      friendUids = response.friendUids;
      closeFriendUids = response.closeFriendUids;
      if (!response.hasMore) break;
      if (!response.cursor || response.cursor === cursor || seen.has(response.cursor)) {
        throw new Error('查询好友列表失败: 服务端分页游标未推进');
      }
      seen.add(cursor);
      cursor = response.cursor;
    }
    const next = new Map<string, Friend>();
    const closeSet = new Set(closeFriendUids ?? []);
    const orderedUids = [...closeSet, ...friendUids.filter(uid => !closeSet.has(uid))];
    for (const uid of orderedUids) {
      const info = infos.get(uid);
      if (!info) continue;
      // Do not overwrite a relationship changed by an action while pages were loading.
      if (info.remark !== undefined && this.userRelations.get(info.uid) === relationsAtStart.get(info.uid)) {
        this.updateUserRelation(info.uid, { remark: info.remark });
      }
      const friend = this.bindFriend(info.uid, info.threadId, info.conversationShortId ?? '', {
        nickname: info.nickname,
        ...(info.avatarThumb ? { avatar: info.avatarThumb } : {}),
        ...(info.secUid ? { secUid: info.secUid } : {}),
        ...(info.remark !== undefined ? { remark: info.remark } : {}),
        ...(info.signature !== undefined ? { signature: info.signature } : {}),
        ...(closeFriendUids !== undefined ? { closeFriend: closeSet.has(uid) } : {}),
      });
      next.set(friend.uid, friend);
    }
    this.replaceCache(this.friends, next);
    return [...this.friends.values()];
  }

  /** @internal 好友名册项首次聊天时按 Desktop ONE_TO_ONE_CHAT 创建/补全会话。 */
  async ensureFriendConversation(friend: Friend): Promise<void> {
    if (friend.conversationShortId) return;
    const generation = this.loginGeneration;
    const selfUid = this.imUid || this.uid || '';
    if (!/^\d+$/.test(selfUid)) throw new Error('当前账号缺少可用的数字 IM uid');
    const response = await this.im.createPrivateConversation([selfUid, friend.uid]);
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，请核对远端会话创建结果');
    this.ensureQuerySucceeded('创建私聊会话', response.statusCode, response.statusMsg);
    const conversation = response.conversation;
    if (!conversation?.conversationId || !conversation.conversationShortId) {
      throw new Error('创建私聊会话失败: 响应缺少 conversation');
    }
    friend.bindConversation(conversation.conversationId, conversation.conversationShortId);
    this.applyConversationInfo(conversation);
  }

  /** 拉取群会话并原子替换 gl；返回的 Group 均已绑定当前账号，可直接 sendMsg。 */
  async getGroupList(force = false): Promise<readonly Group[]> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const response = await this.inboxQueries.groupList(force);
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，群列表读取已取消');
    this.ensureQuerySucceeded('查询群列表', response.statusCode, response.statusMsg);
    const next = new Map<string, Group>();
    const snapshots: ImConversation[] = [];
    for (const rawInfo of response.groups) {
      const info = response.fromCache ? this.cachedConversation(rawInfo.conversationId) ?? rawInfo : this.saveConversationSnapshot(rawInfo);
      snapshots.push(info);
      const group = this.bindGroup(
        info.conversationId,
        info.conversationShortId,
        {
          ...(info.name ? { name: info.name } : {}),
          ...(info.description ? { description: info.description } : {}),
          ...(info.notice ? { notice: info.notice } : {}),
          ...(info.avatar ? { avatar: info.avatar } : {}),
          ...(info.ownerUid ? { ownerUid: info.ownerUid } : {}),
          ...(info.participantsCount !== undefined ? { memberCount: info.participantsCount } : {}),
          ...(info.muted !== undefined ? { muted: info.muted } : {}),
          ...(info.pinned !== undefined ? { pinned: info.pinned } : {}),
          ...(info.favorite !== undefined ? { favorite: info.favorite } : {}),
          ...(info.isParticipant !== undefined
            ? { isParticipant: info.isParticipant }
            : {}),
          inboxType: info.inboxType ?? 0,
          members: info.members,
        },
      );
      next.set(group.groupId, group);
    }
    if (!response.fromCache) this.stateStore?.replaceGroups(snapshots);
    for (const [id, group] of this.groups) if (!next.has(id)) this.forgetGroup(id, group);
    for (const [id, conversation] of this.transientConversations) {
      if (conversation.isGroup && !next.has(id)) this.transientConversations.delete(id);
    }
    this.replaceCache(this.groups, next);
    return [...this.groups.values()];
  }

  /** All currently stored box conversations in native order, including groups or repeated peers. No HTTP. */
  getStrangerConversations(): readonly ImConversation[] {
    this.ensureOnline();
    return this.stateStore?.queryStrangerConversations() ?? selectStrangerConversations([...this.transientConversations.values()]);
  }

  /** Local private-contact projection. For every conversation row use getStrangerConversations instead. */
  async getStrangerList(): Promise<readonly Stranger[]> {
    const conversations = this.getStrangerConversations();
    const selfUid = this.imUid || this.uid || '';
    const next = new Map<string, Stranger>();
    for (const info of conversations) {
      if (info.conversationType !== 1 || info.isGroup) continue;
      const uid = parsePeerFromConversationId(info.conversationId, selfUid);
      if (!uid || next.has(uid)) continue; // The highest-sort conversation represents a repeated peer.
      const peer = info.members.find(member => member.uid === uid);
      const stranger = this.bindStranger(uid, info.conversationId, info.conversationShortId, {
        ...(peer?.nickname ? { nickname: peer.nickname } : {}),
        ...(peer?.avatar ? { avatar: peer.avatar } : {}),
        ...(peer?.secUid ? { secUid: peer.secUid } : {}),
        inboxType: info.inboxType ?? 1,
      });
      next.set(stranger.uid, stranger);
    }
    this.replaceCache(this.strangers, next);
    return [...this.strangers.values()];
  }

  /** Refresh recent stranger messages into this account's local state; not a complete-list query. */
  refreshStrangerConversations(): Promise<StrangerSyncResult> {
    this.ensureOnline();
    return this.strangerSync!.refresh();
  }

  /** Consume one older stranger page. A successful result does not imply there are no more pages. */
  loadMoreStrangerConversations(): Promise<StrangerSyncResult> {
    this.ensureOnline();
    return this.strangerSync!.loadMore();
  }

  private consumeStrangerPage(page: RecentStrangerMessagesResponse, generation: number): void {
    if (generation !== this.loginGeneration) throw new Error('账号状态已变化，陌生人同步已取消');
    this.ensureOnline();
    for (const row of page.messages) {
      if (generation !== this.loginGeneration) throw new Error('账号状态已变化，陌生人同步已取消');
      this.ensureOnline();
      const info = buildStrangerConversation(this.cachedConversation(row.conversationId), row, this.imUid || this.uid || '', 1);
      if (!info) continue;
      this.bindConversationInfo(this.saveConversationSnapshot(info, 'local'));
      this.refreshStrangerDetails(info, generation);
    }
    const messages = page.messages.flatMap(row => row.messages)
      .map(inboundFromMessage).filter((message): message is RawInboundMessage => message !== null);
    this.consumeMessageBatch(messages, generation);
  }

  private refreshStrangerDetails(info: ImConversation, generation: number): void {
    const id = info.conversationId;
    if (this.strangerDetailRefreshes.has(id)) return;
    const im = this.im;
    const task = (async () => {
      const response = await im.getConversationInfos([{ threadId: id, conversationShortId: info.conversationShortId,
        conversationType: info.conversationType as 1 | 2, inboxType: info.inboxType ?? 1 }]);
      if (!this.online || generation !== this.loginGeneration || this.im !== im) return;
      if (response.statusCode !== 0) throw new Error(`status=${response.statusCode} ${response.statusMsg}`);
      const updated = response.conversations.find(conversation => conversation.conversationId === id);
      if (!updated) throw new Error('会话详情响应缺少请求的会话');
      this.applyConversationInfo(updated);
      this.scheduleConversationUpdate(id, {});
    })();
    this.strangerDetailRefreshes.set(id, task);
    void task.catch(error => {
      if (this.online && generation === this.loginGeneration) this.logger.warn('陌生人会话资料补拉失败: %s', toError(error).message);
    }).finally(() => {
      if (this.strangerDetailRefreshes.get(id) === task) this.strangerDetailRefreshes.delete(id);
    });
  }

  /** 读取陌生人箱未读数；reset=true 会同时清零，属于有副作用操作。 */
  getStrangerUnreadCount(reset = false) {
    this.ensureOnline();
    return this.im.getStrangerUnreadCount(reset);
  }

  async markAllStrangersRead(): Promise<ImActionResponse> {
    this.ensureOnline();
    return this.im.markAllStrangerConversationsRead();
  }

  async deleteAllStrangerConversations(): Promise<ImActionResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const result = await this.im.deleteAllStrangerConversations();
    // Preserve the dispatched action's actual result, but never let an old
    // login's completion delete a new login's contacts or trigger a replay.
    if (result.statusCode === 0 && this.online && generation === this.loginGeneration) this.strangers.clear();
    return result;
  }

  /** 批量刷新已经加载的好友、群和陌生人会话，并保留现有对象身份。 */
  async refreshContacts(): Promise<readonly ChatContact[]> {
    this.ensureOnline();
    const response = await this.refreshContactAddresses([...this.fl.values(), ...this.gl.values(), ...this.sl.values()]);
    this.ensureQuerySucceeded('刷新会话资料', response.statusCode, response.statusMsg);
    return [...this.friends.values(), ...this.groups.values(), ...this.strangers.values()];
  }

  /** 批量标记消息已读；底层复用 Desktop 的单会话 markRead 调用。 */
  async markMessagesRead(messages: readonly MessageEvent[]): Promise<BatchMessageReadResult> {
    this.ensureOnline();
    if (messages.length === 0) throw new Error('markMessagesRead requires at least one message');
    for (const message of messages) {
      if (message.account !== this) throw new Error('message belongs to another account');
      if (!message.serverMessageId) throw new Error('message has no server message id');
    }
    const response = await this.markReadTargets(messages.map((message) => ({
      threadId: message.threadId,
      conversationShortId: message.conversationShortId,
      conversationType: message.conversationType,
      inboxType: message.inboxType,
      serverMessageId: message.serverMessageId!,
      ...(message.indexInConversation ? { indexInConversation: message.indexInConversation } : {}),
      ...(message.indexInConversationV2 ? { indexInConversationV2: message.indexInConversationV2 } : {}),
      readBadgeCount: 1,
    })));
    const failedKeys = new Set(response.failed.map((item) => `${item.threadId}:${item.serverMessageId}`));
    const failed = messages.filter((message) =>
      failedKeys.has(`${message.threadId}:${message.serverMessageId ?? ''}`));
    const failedSet = new Set(failed);
    return {
      statusCode: response.statusCode,
      statusMsg: response.statusMsg,
      ...(response.checkCode !== undefined ? { checkCode: response.checkCode } : {}),
      succeeded: messages.filter((message) => !failedSet.has(message)),
      failed,
    };
  }

  /**
   * 在已加载的 fl/gl/sl 中搜索会话。与桌面端一样这是本地搜索；调用 get*List 刷新数据。
   */
  searchConversations(query: string): readonly ChatContact[] {
    this.ensureOnline();
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const contacts: ChatContact[] = [
      ...this.friends.values(),
      ...this.groups.values(),
      ...this.strangers.values(),
    ];
    return contacts.filter((contact) => {
      const values = contact instanceof Group
        ? [contact.groupId, contact.name, ...[...contact.memberList.values()].flatMap((member) => [
            member.uid,
            member.displayName,
          ])]
        : [contact.uid, contact.nickname];
      return values.some((value) => value?.toLocaleLowerCase().includes(needle));
    });
  }

  // ─── Events ──────────────────────────────────────────────

  override on<K extends keyof AccountEventMap>(
    event: K,
    listener: (payload: AccountEventMap[K]) => void | Promise<void>,
  ): this;
  override on(event: string, listener: (...args: unknown[]) => void): this;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof AccountEventMap>(event: K, payload?: AccountEventMap[K]): boolean;
  override emit(event: string, ...args: unknown[]): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  // ─── Internal ────────────────────────────────────────────

  private async onLoggedInAccount(account: StoredAccount): Promise<void> {
    const generation = this.loginGeneration;
    this.assertLoginGeneration(generation);
    this.runtime.bindPromoted(this.runtime.connection, account);
    this.refreshLoggerIdentity();
    this.accountNickname = account.meta.screenName;
    await this.goOnline(generation);
  }

  private async goOnline(generation: number): Promise<void> {
    this.assertLoginGeneration(generation);
    const bound = this.runtime.bound;
    const sender = new OutboundSender(bound.client, {
      platformUid: bound.platformUid,
      deviceId: bound.deviceId,
      getStickerEnabledStatus: () => this.collectedEmojiState?.stickerEnabledStatus,
      getConversationSettingExt: (id) => this.cachedConversation(id)?.settingExt,
      onMessage: (message) => {
        if (!this.online || generation !== this.loginGeneration) return;
        this.cacheMessages([message], 'send-ack');
      },
    });
    const assembler = new EventAssembler(this, {
      acceptMessage: (inbound) => {
        if (!this.online || generation !== this.loginGeneration) return false;
        if (!isOrdinaryMessageType(inbound.messageType)) return false;
        const update = this.cacheInboundMessage(inbound);
        assembler.receiveMessageUpdate(inbound, update.message);
        // A synchronous update listener may log out before new-message dispatch.
        return this.online && generation === this.loginGeneration && update.isNew && isDesktopMessageDisplayable(update.message)
          && inbound.senderUid !== bound.platformUid && inbound.senderUid !== this.imUid;
      },
      onMessage: (event) => emitEventRoutes(this.emit.bind(this), event),
      onNotice: (event) => {
        if (this.online && generation === this.loginGeneration) emitEventRoutes(this.emit.bind(this), event);
      },
      onRequest: (event) => emitEventRoutes(this.emit.bind(this), event),
    }, bound.platformUid);
    let stateStore: ImStateStore | undefined;
    let strangerSync: StrangerSync | undefined;
    const applicationSettings = new DesktopSettings({ directory: this.store.accountDataDir(bound.platformUid),
      identity: bound.client.getApplicationSettingsUrl(), request: signal => bound.client.getApplicationSettings(signal),
      onError: () => this.logger.warn('应用配置刷新失败，保留上次可用配置'),
    });
    this.applicationSettings = applicationSettings;
    try {
      const settings = await applicationSettings.start();
      this.assertLoginGeneration(generation);
      const floatHintConfig = desktopFloatHintConfig(settings);
      stateStore = this.localStateOptions === false
        ? undefined
        : createImStateStore({
            accountDir: this.store.accountDataDir(bound.platformUid),
            ...this.localStateOptions,
            userId: bound.platformUid,
            ...(floatHintConfig ? { floatHintConfig } : {}),
          });
      this.sender = sender;
      this.assembler = assembler;
      if (stateStore) this.stateStore = stateStore;
      strangerSync = new StrangerSync({ im: sender.imService, ...(stateStore ? { store: stateStore } : {}),
        assertActive: () => {
          if (generation !== this.loginGeneration) throw new Error('账号状态已变化，陌生人同步已取消');
          this.ensureOnline();
          if (this.sender !== sender) throw new Error('账号连接已变化，陌生人同步已取消');
        },
        consumePage: page => this.consumeStrangerPage(page, generation),
      });
      this.strangerSync = strangerSync;
      this.inboxFeature = new ImInboxQueries(sender.imService, bound.platformUid, stateStore);
      await this.seedThreadShortIds(generation);
      this.assertLoginGeneration(generation);
      await this.startConnection({
        platformUid: bound.platformUid,
        deviceId: bound.deviceId,
        installId: bound.client.getInstallId(),
        sessionCookies: bound.account.session.cookies,
        ...(stateStore ? { cursorStore: stateStore } : {}),
        deviceUserAgent: bound.account.deviceProfile.userAgent,
        imService: sender.imService,
        logger: this.logger,
        onInbound: (inbound) => assembler.receiveMessage(inbound),
        onHistoryBatch: (messages, conversations) => {
          if (!this.online || generation !== this.loginGeneration) return;
          for (const conversation of conversations) this.applyConversationInfo(conversation);
          this.consumeMessageBatch(messages, generation);
        },
        onNotice: (notice) => assembler.receiveNotice(notice),
        onRaw: (cmd, response) => this.emit('message.raw', { cmd, response }),
        onClose: () => {
          if (this.state === 'online') this.setAccountState('reconnecting');
        },
        onReconnecting: (payload) => {
          if (this.state === 'online') this.setAccountState('reconnecting');
          if (this.state === 'reconnecting') this.emit('system.reconnecting', payload);
        },
        onOpen: () => {
          if (this.state !== 'reconnecting') return;
          this.setAccountState('online');
          if (this.onlinePayload) this.emit('system.online', this.onlinePayload);
        },
      });
    } catch (error) {
      strangerSync?.close();
      if (this.strangerSync === strangerSync) delete this.strangerSync;
      applicationSettings.stop();
      if (this.applicationSettings === applicationSettings) delete this.applicationSettings;
      assembler.clear();
      stateStore?.close();
      if (this.sender === sender) {
        this.transientConversations.clear();
        this.pendingSettingExt.clear(); this.settingRefreshes.clear();
        delete this.sender;
        delete this.assembler;
        delete this.inboxFeature;
        delete this.stateStore;
      }
      throw error;
    }
    this.assertLoginGeneration(generation);
    const payload = {
      platformUid: bound.platformUid,
      ...(bound.account.meta.screenName ? { screenName: bound.account.meta.screenName } : {}),
    };
    this.onlinePayload = payload;
    this.accountNickname = payload.screenName;
    this.completeLogin();
    this.startSessionRenewal((scene, signal) => this.auth.refreshSession(scene, signal));
    this.emit('system.online', payload);
    await this.loadOnlineContacts(generation);
  }

  /** 每次登录上线后加载一次；WS 重连沿用当前联系人缓存。 */
  private async loadOnlineContacts(generation: number): Promise<void> {
    const current = () => this.online && generation === this.loginGeneration;
    if (!current()) return;
    const lists = [
      { name: '好友', unit: '个好友', load: () => this.getFriendList() },
      { name: '群', unit: '个群', load: () => this.getGroupList(true) },
      { name: '陌生人', unit: '个陌生人', load: async () => {
        const result = await this.refreshStrangerConversations();
        if (!current()) throw new Error('账号状态已变化，联系人加载已取消');
        this.ensureQuerySucceeded('同步陌生人', result.statusCode, result.statusMsg);
        return this.getStrangerList();
      } },
    ];
    const results = await Promise.allSettled(lists.map(async list => {
      const items = await list.load();
      return items.length;
    }));
    // A late result from a previous login must not announce readiness for a new session.
    if (!current()) return;
    const summary = results.map((result, index) => {
      const list = lists[index]!;
      if (result.status === 'fulfilled') return `${result.value} ${list.unit}`;
      this.logger.warn('%s列表加载失败: %s', list.name, toError(result.reason).message);
      return `${list.name}加载失败`;
    });
    this.logger.info('加载了 %s', summary.join('，'));
  }

  /** @internal 账号共享的发送器，持有消息构造、上传与当前连接。 */
  get outbound(): OutboundSender {
    if (!this.sender || (!this.online && this.state !== 'logging-in')) {
      throw new Error('账号未上线，请先 await account.login() 并完成登录');
    }
    return this.sender;
  }

  /** @internal 联系人使用所属账号的协议连接，不再注入业务动作端口。 */
  get im(): ImService {
    return this.outbound.imService;
  }

  /** @internal All contact views of a UID share this account's relationship snapshot. */
  getUserRelation(uid: string): Readonly<UserRelationState> | undefined {
    const cached = this.userRelations.get(uid);
    if (cached) return cached;
    const persisted = this.stateStore?.getUserRelation(uid);
    if (!persisted) return undefined;
    const relation = Object.freeze(persisted);
    this.userRelations.set(uid, relation);
    return relation;
  }

  /** @internal Call only for confirmed server state, never inferred friend membership. */
  updateUserRelation(uid: string, patch: UserRelationState): void {
    if (!/^\d+$/.test(uid)) throw new Error('用户 ID 无效');
    const relation = Object.freeze({ ...this.getUserRelation(uid), ...patch });
    // Publish confirmed remote state even if the optional local store is unavailable.
    this.userRelations.set(uid, relation);
    try { this.stateStore?.setUserRelation(uid, relation); }
    catch { this.logger.warn('用户关系已更新，但本地状态保存失败'); }
  }

  /** @internal Fresh readback of server relationship; never infer it from a successful HTTP status. */
  async readUserProfile(uid: string, secUid: string | undefined): Promise<ImUserProfile> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    if (!secUid) throw new Error('用户缺少 secUid，请先刷新联系人资料');
    const relationAtStart = this.getUserRelation(uid);
    const profile = await this.im.getUserProfile(secUid);
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，资料读取已取消');
    if (!profile || profile.uid !== uid) throw new Error('用户资料响应缺失或身份不匹配');
    const followStatus = profile.followStatus;
    if (this.getUserRelation(uid) === relationAtStart) this.updateUserRelation(uid, {
      ...(followStatus !== undefined && [0, 1, 2, 4].includes(followStatus)
        ? { followStatus: followStatus as UserFollowStatus } : {}),
      ...(profile.followerStatus === 0 || profile.followerStatus === 1
        ? { followerStatus: profile.followerStatus } : {}),
      ...(profile.blocked !== undefined ? { blocked: profile.blocked } : {}),
      ...(profile.remark !== undefined ? { remark: profile.remark } : {}),
    });
    return profile;
  }

  /** @internal Only verified challenges permit retry; publish state only to the originating login. */
  async runVerifiedAction<T>(target: ActionVerificationTarget, action: () => Promise<T>, publish?: (result: T) => void): Promise<T> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    for (let attempt = 0; ; attempt++) {
      if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，业务操作已取消');
      let result: T;
      try { result = await action(); } catch (error) {
        if (!(error instanceof ActionChallengeError) || attempt >= 2
          || !this.online || generation !== this.loginGeneration) throw error;
        await this.waitForActionVerification(target, error);
        continue;
      }
      // A dispatched mutation can succeed after logout. Return its actual result,
      // but do not repopulate retired/new-login state or turn publication errors
      // into verification retries of an already-completed external operation.
      if (this.online && generation === this.loginGeneration) publish?.(result);
      return result;
    }
  }

  private waitForActionVerification(target: ActionVerificationTarget, challenge: ActionChallengeError): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        this.actionVerifications.delete(verification);
        if (error) reject(error); else resolve();
      };
      const verification = new ActionVerification(this, target, challenge, {
        open: (current, options) => openBrowserVerification(current, { connection: this.runtime.connection }, options),
        complete: () => finish(),
        cancel: reason => finish(new Error(reason)),
      });
      const timer = setTimeout(() => verification.cancel('业务验证超时'), 300_000);
      timer.unref();
      this.actionVerifications.add(verification);
      try { this.emit('system.action.verification', { verification }); }
      catch { verification.cancel('业务验证处理器异常'); }
    });
  }

  /** @internal 会话地址补全，不触发网络请求。 */
  resolveShortId(threadId: string, hint?: string): string | undefined {
    return this.assembler?.resolveShortId(threadId, hint) || hint || (/^\d+$/.test(threadId) ? threadId : undefined);
  }

  /** @internal 入站事件和主动列表共用同一联系人绑定规则。 */
  bindFriend(
    uid: string,
    threadId: string,
    conversationShortId: string,
    metadata: FriendMetadata = {},
  ): Friend {
    const byUid = this.cachedFriend(uid);
    if (byUid?.threadId === threadId) {
      byUid.updateMetadata(metadata);
      return byUid;
    }
    const byThread = this.cachedFriendByThreadId(threadId);
    if (byThread) {
      byThread.updateMetadata(metadata);
      return byThread;
    }
    return Friend.bind(uid, threadId, conversationShortId, this, metadata);
  }

  /** @internal 入站事件和主动列表复用缓存中的群实例。 */
  bindGroup(groupId: string, conversationShortId = groupId, metadata: GroupMetadata = {}): Group {
    const cached = this.cachedGroup(groupId);
    if (cached) {
      cached.updateMetadata(metadata);
      return cached;
    }
    return Group.bind(groupId, conversationShortId, this, metadata);
  }

  /** @internal 陌生人箱独立绑定，不混入好友缓存。 */
  bindStranger(
    uid: string,
    threadId: string,
    conversationShortId: string,
    metadata: StrangerMetadata = {},
  ): Stranger {
    const cached = this.cachedStranger(uid);
    if (cached?.threadId === threadId) {
      cached.updateMetadata(metadata);
      return cached;
    }
    return Stranger.bind(uid, threadId, conversationShortId, this, metadata);
  }

  private async markReadTargets(
    targets: Array<ConversationAddress & ConversationReadMarker>,
  ): Promise<BatchMarkReadResponse> {
    if (targets.length === 0) throw new Error('markMessagesRead requires at least one message');
    const batches = groupByInbox(targets);
    const failed: BatchMarkReadResponse['failed'] = [];
    let statusCode = 0;
    let statusMsg = '';
    let checkCode: number | undefined;
    for (const batch of batches.values()) {
      const result = await this.im.markConversationsRead(batch);
      failed.push(...result.failed);
      if (!statusCode && result.statusCode) {
        statusCode = result.statusCode;
        statusMsg = result.statusMsg;
        checkCode = result.checkCode;
      }
    }
    return {
      statusCode,
      statusMsg,
      ...(checkCode !== undefined ? { checkCode } : {}),
      failed,
    };
  }

  /** @internal ChatContact 刷新当前会话，Account 刷新全部会话。 */
  async refreshContactAddresses(
    addresses: readonly ConversationAddress[],
  ): Promise<ConversationInfoListResponse> {
    if (addresses.length === 0) return { statusCode: 0, statusMsg: '', conversations: [] };
    const generation = this.loginGeneration;
    const conversations: ImConversation[] = [];
    let statusCode = 0;
    let statusMsg = '';
    let checkCode: number | undefined;
    for (const batch of groupByInbox(addresses).values()) {
      const result = await this.im.getConversationInfos(batch);
      if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，会话资料读取已取消');
      conversations.push(...result.conversations);
      if (!statusCode && result.statusCode) {
        statusCode = result.statusCode;
        statusMsg = result.statusMsg;
        checkCode = result.checkCode;
      }
    }
    // 多 inbox 刷新对象是一个 SDK 动作：任一批失败时不将部分新资料写入稳定实例。
    if (statusCode === 0) {
      for (const conversation of conversations) this.applyConversationInfo(conversation);
    }
    return {
      statusCode,
      statusMsg,
      ...(checkCode !== undefined ? { checkCode } : {}),
      conversations,
    };
  }

  /** @internal 将协议资料写回稳定联系人实例。 */
  applyConversationInfo(info: ImConversation): void {
    this.bindConversationInfo(this.saveConversationSnapshot(info));
  }

  private bindConversationInfo(info: ImConversation): void {
    this.assembler?.rememberConversation(info.conversationId, info.conversationShortId);
    if (info.isGroup) {
      const group = this.bindGroup(info.conversationId, info.conversationShortId, {
        ...(info.name ? { name: info.name } : {}),
        ...(info.description ? { description: info.description } : {}),
        ...(info.notice ? { notice: info.notice } : {}),
        ...(info.avatar ? { avatar: info.avatar } : {}),
        ...(info.ownerUid ? { ownerUid: info.ownerUid } : {}),
        ...(info.participantsCount !== undefined
          ? { memberCount: info.participantsCount }
          : {}),
        ...(info.muted !== undefined ? { muted: info.muted } : {}),
        ...(info.pinned !== undefined ? { pinned: info.pinned } : {}),
        ...(info.favorite !== undefined ? { favorite: info.favorite } : {}),
        ...(info.isParticipant !== undefined
          ? { isParticipant: info.isParticipant }
          : {}),
        ...(info.inboxType !== undefined ? { inboxType: info.inboxType } : {}),
        members: info.members,
      });
      this.rememberGroup(group);
      return;
    }
    const selfUid = this.imUid || this.uid || '';
    const peerUid = parsePeerFromConversationId(info.conversationId, selfUid);
    if (!peerUid) return;
    const peer = info.members.find((member) => member.uid === peerUid);
    if (info.isInStrangerBox) {
      const stranger = this.bindStranger(
        peerUid,
        info.conversationId,
        info.conversationShortId,
        peer?.secUid ? { secUid: peer.secUid } : {},
      );
      this.rememberStranger(stranger);
      return;
    }
    if (this.strangers.get(peerUid)?.threadId === info.conversationId) this.strangers.delete(peerUid);
    const friend = this.bindFriend(
      peerUid,
      info.conversationId,
      info.conversationShortId,
      peer?.secUid ? { secUid: peer.secUid } : {},
    );
    this.rememberFriend(friend);
  }

  /** 获取表情资源包描述符；不下载资源包，也不把它当成表情列表。 */
  async getEmojiResources(): Promise<EmojiResourcesResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const result = await this.im.getEmojiResources();
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，表情资源查询已取消');
    return result;
  }

  /** 收藏平台表情。只提交一次；超时或验证失败不会自动重发，也不乐观修改本地收藏。 */
  collectEmoji(options: CollectEmojiOptions): Promise<CollectEmojiResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    return this.im.collectEmoji(options).then(result => {
      if (this.online && generation === this.loginGeneration && result.statusCode === 0 && result.successItems[0]) {
        this.collectedEmojiState = addCollectedEmoji(this.collectedEmojiState, result.successItems[0]);
      }
      return result;
    });
  }

  /** 查询一页收藏。无cursor时刷新首页；传下一页cursor时默认追加，不自动翻页或重试。 */
  async getCollectedEmojis(options: CollectedEmojiListOptions = {}): Promise<CollectedEmojisResponse> {
    this.ensureOnline();
    if (options.firstPage !== undefined && typeof options.firstPage !== 'boolean') throw new TypeError('firstPage must be a boolean');
    const generation = this.loginGeneration;
    const firstPage = options.firstPage ?? options.cursor === undefined;
    const result = await this.im.getCollectedEmojis(options.cursor);
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，收藏表情查询已取消');
    if (result.page) {
      this.collectedEmojiState = mergeCollectedEmojiPage(this.collectedEmojiState, result.page, firstPage);
    }
    return result;
  }

  /** 当前账号内存快照；不是完整在线列表，未加载时为undefined。 */
  getCachedCollectedEmojis(): CollectedEmojiSnapshot | undefined {
    return this.collectedEmojiState && structuredClone(this.collectedEmojiState);
  }

  /** 显式查询用户/会话活动状态；不自动上报前台活动、轮询或推断未知状态。 */
  async getActiveStatus(secUids: readonly string[], conversationIds: readonly string[] = []): Promise<ActiveStatusResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const result = await this.im.getActiveStatus(secUids, conversationIds);
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，活动状态查询已取消');
    return result;
  }

  /** Desktop远端用户搜索；不等同本地searchConversations，不关注/绑定联系人。 */
  async searchUsers(keyword: string, cursor = 0): Promise<UserSearchResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const result = await this.im.searchUsers(keyword, cursor);
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，用户搜索已取消');
    return result;
  }

  /** 显式读取Desktop推荐项快照；不绑定联系人、不修改关系或自动刷新活动状态。 */
  async getRecommendedContacts(): Promise<RecommendedContactsResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const result = await this.im.getRecommendedContacts();
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，推荐联系人查询已取消');
    return result;
  }

  /** 查询新关注通知计数；不标记已读、不修改好友关系、不自动轮询。 */
  async getNewFollowerCount(): Promise<NewFollowerCountResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const result = await this.im.getNewFollowerCount();
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，新关注计数查询已取消');
    return result;
  }

  /** 读取新关注列表并请求服务端标记已读；不改好友关系/本地计数，不自动重试失败页。 */
  async readFollowerNotices(): Promise<FollowerNoticesResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const connection = this.im;
    const notices: FollowerNoticesResponse['notices'] = [];
    const users = new Set<string>(), cursors = new Set<string>();
    let maxTime = '0', minTime = '1', received = 0;
    for (;;) {
      if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，新关注通知读取已取消；已发请求可能已标记已读');
      const cursor = JSON.stringify([maxTime, minTime]);
      if (cursors.has(cursor)) return { statusCode: -3, statusMsg: '通知分页游标未推进；已发请求可能已标记已读', notices: [], truncated: false };
      cursors.add(cursor);
      const page = await connection.readFollowerNoticePage(maxTime, minTime);
      if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，新关注通知读取已取消；已发请求可能已标记已读');
      if (page.statusCode !== 0) return { statusCode: page.statusCode, statusMsg: page.statusMsg, notices: [], truncated: false };
      received += page.notices.length;
      for (const notice of page.notices) {
        if (!users.has(notice.uid)) { users.add(notice.uid); notices.push(notice); }
      }
      if (!page.hasMore || received > 120) return { statusCode: 0, statusMsg: page.statusMsg, notices, truncated: page.hasMore };
      if (!page.notices.length || page.maxTime === undefined || page.minTime === undefined) {
        return { statusCode: -3, statusMsg: '通知分页没有有效进展；已发请求可能已标记已读', notices: [], truncated: false };
      }
      maxTime = page.maxTime; minTime = page.minTime;
    }
  }

  /** 读取 Desktop 用户设置，不改变隐私设置，也不自动轮询。 */
  async getUserSettings(): Promise<UserSettingsResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const result = await this.im.getUserSettings().catch(error => {
      if (generation === this.loginGeneration) this.readReceiptSwitch = undefined;
      throw error;
    });
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，设置查询已取消');
    this.readReceiptSwitch = result.statusCode === 0 ? result.imReadStatusShow : undefined;
    return result;
  }

  /** 查询当前账号的已读展示开关；不是标记消息已读，也不是逐消息读者名单。 */
  async getReadReceiptPrivacy(): Promise<ReadReceiptPrivacyResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const result = await this.im.getReadReceiptPrivacy().catch(error => {
      if (generation === this.loginGeneration) this.readReceiptSwitch = undefined;
      throw error;
    });
    if (!this.online || generation !== this.loginGeneration) throw new Error('账号状态已变化，已读隐私查询已取消');
    this.readReceiptSwitch = result.statusCode === 0 ? result.currentUserSwitch : undefined;
    return result;
  }

  /** 默认复用消息策略缓存，refresh=true 强制联网；返回策略，不推断谁已读。 */
  async getMessageReadPrivacy(queries: readonly MessageReadPrivacyQuery[], refresh = false): Promise<MessageReadPrivacyResponse> {
    this.ensureOnline();
    const generation = this.loginGeneration;
    const epoch = this.readPrivacyEpoch;
    const all = normalizeMessageReadPrivacyQueries(queries);
    if (!all.length) return { statusCode: 0, statusMsg: '', messages: [] };
    const selected = new Map<string, CachedMessageReadPrivacy>();
    const missing: MessageReadPrivacyQuery[] = [];
    for (const query of all) {
      const entry = refresh ? undefined : this.readPrivacyCache.get(query.serverMessageId) ??
        this.stateStore?.getMessageReadPrivacy(query.conversationId, query.serverMessageId);
      if (entry && entry.query.conversationId === query.conversationId && entry.query.conversationShortId === query.conversationShortId &&
          entry.query.conversationType === query.conversationType && entry.query.createTime === query.createTime) {
        selected.set(query.serverMessageId, entry);
      } else missing.push(query);
    }
    const active = () => {
      if (!this.online || generation !== this.loginGeneration || epoch !== this.readPrivacyEpoch) throw new Error('账号状态已变化或消息已删除，已读隐私查询已取消');
    };
    if (missing.length) {
      const result = await this.im.getMessageReadPrivacy(missing).catch(error => {
        if (generation === this.loginGeneration) this.readReceiptSwitch = undefined;
        throw error;
      });
      active();
      if (result.statusCode !== 0) {
        this.readReceiptSwitch = undefined;
        return { ...result, messages: [] };
      }
      this.readReceiptSwitch = result.currentUserSwitch;
      if (result.enableReadState !== true || result.currentUserSwitch === undefined) return { ...result, messages: [] };
      const rows: CachedMessageReadPrivacy[] = [];
      for (const query of missing) {
        const policy = result.messages.find(item => item.serverMessageId === query.serverMessageId);
        if (!policy) return { statusCode: -3, statusMsg: 'Desktop incomplete read privacy response', messages: [] };
        rows.push({ query, policy });
      }
      for (const row of rows) selected.set(row.query.serverMessageId, structuredClone(row));
      try { this.stateStore?.upsertMessageReadPrivacy(rows); }
      catch { this.logger.warn('已读隐私策略已获取，但本地状态保存失败'); }
    } else if (this.readReceiptSwitch === undefined) {
      // Persisted per-message policies cannot authorize display after a restart.
      const result = await this.getReadReceiptPrivacy();
      active();
      if (result.statusCode !== 0) return { ...result, messages: [] };
    }
    active();
    if (this.readReceiptSwitch === undefined) return { statusCode: -3, statusMsg: 'Desktop read switch unavailable', messages: [] };
    for (const [id, entry] of selected) this.readPrivacyCache.set(id, structuredClone(entry));
    return { statusCode: 0, statusMsg: '', currentUserSwitch: this.readReceiptSwitch,
      enableReadState: this.readReceiptSwitch !== -1,
      messages: this.readReceiptSwitch === -1 ? [] : all.map(query => structuredClone(selected.get(query.serverMessageId)!.policy)) };
  }

  /** 当前账号所有群的审核未读；计数为十进制字符串，不按群拆分。 */
  getGroupJoinRequestUnread(): Promise<GroupJoinRequestUnreadResponse> {
    this.ensureOnline();
    return this.im.getGroupJoinRequestUnread();
  }

  /** 清除当前账号审核未读；不会同意/拒绝申请。成功后可查询未读确认。 */
  clearGroupJoinRequestUnread(): Promise<ImActionResponse> {
    this.ensureOnline();
    return this.im.clearGroupJoinRequestUnread();
  }

  /** @internal 群列表和入群信号共享申请资料补全。 */
  async getGroupJoinRequestData(address?: ConversationAddress): Promise<GroupJoinRequestListResponse> {
    const response = await this.im.listGroupJoinRequests({
      ...(address?.conversationShortId
        ? { conversationShortId: address.conversationShortId }
        : {}),
    });
    if (response.statusCode !== 0) return response;
    const profiles = await this.im.resolveUsers(
      response.requests.flatMap((request) => request.applicantSecUid ? [request.applicantSecUid] : []),
    );
    const bySecUid = new Map(profiles.map((profile) => [profile.secUid, profile]));
    return {
      ...response,
      requests: response.requests.map((request) => {
        const profile = request.applicantSecUid
          ? bySecUid.get(request.applicantSecUid)
          : undefined;
        return profile ? {
          ...request,
          applicantNickname: profile.nickname,
          ...(profile.avatarThumb ? { applicantAvatar: profile.avatarThumb } : {}),
        } : request;
      }),
    };
  }

  private async seedThreadShortIds(generation: number): Promise<void> {
    const threads = await this.im.listThreads({ count: 50 });
    this.assertLoginGeneration(generation);
    if (threads.statusCode !== 0) {
      throw new Error(`IM 初始化失败: status=${threads.statusCode} ${threads.statusMsg}`);
    }
    for (const info of threads.conversations) this.saveConversationSnapshot(info);
    let count = 0;
    for (const t of threads.threads) {
      if (t.threadId && t.conversationShortId) {
        this.assembler?.rememberConversation(t.threadId, t.conversationShortId);
        count += 1;
      }
    }
    this.logger.debug('loaded %s conversation short ids', count);
  }

  private cacheInboundMessage(inbound: RawInboundMessage): { message: PrivateMessage; isNew: boolean } {
    const message: PrivateMessage = {
      msgId: inbound.serverMessageId ?? '',
      threadId: inbound.threadId,
      conversationShortId: inbound.conversationShortId,
      conversationType: inbound.conversationType,
      inboxType: inbound.inboxType ?? 0,
      senderUid: inbound.senderUid,
      ...(inbound.senderSecUid ? { senderSecUid: inbound.senderSecUid } : {}),
      ...(inbound.clientMessageId ? { clientMessageId: inbound.clientMessageId } : {}),
      content: inbound.rawContent,
      msgType: inbound.messageType,
      createTime: inbound.createTime ? Number(inbound.createTime) : 0,
      status: inbound.status ?? 0,
      ...(inbound.version ? { version: inbound.version } : {}),
      ...(inbound.orderInConversation ? { orderInConversation: inbound.orderInConversation } : {}),
      ...(inbound.indexInConversation
        ? { indexInConversation: inbound.indexInConversation }
        : {}),
      ...(inbound.indexInConversationV2
        ? { indexInConversationV2: inbound.indexInConversationV2 }
        : {}),
      ...(inbound.ext ? { ext: inbound.ext } : {}),
      ...(inbound.referenceInfo ? { referenceInfo: inbound.referenceInfo } : {}),
      ...(inbound.propertyList ? { propertyList: inbound.propertyList } : {}),
    };
    const update = this.stateStore
      ? this.stateStore.upsertMessages([message])[0]
      : prepareMessageCacheWrite(message, 'server', new Map());
    const cached = update?.message ?? message;
    const keys = [
      ...(cached.clientMessageId ? [JSON.stringify([cached.threadId, 'client', cached.clientMessageId])] : []),
      ...(cached.msgId && cached.msgId !== '0' ? [JSON.stringify([cached.threadId, 'server', cached.msgId])] : []),
    ];
    // Preserve ID-less fallback de-duplication when local persistence is disabled too.
    if (!keys.length) keys.push(JSON.stringify([cached.threadId, cached.senderUid, inbound.createTime ?? inbound.rawContent]));
    const repeated = keys.some(key => this.receivedMessageKeys.has(key));
    for (const key of keys) this.receivedMessageKeys.add(key);
    return { message: cached, isNew: !repeated && update?.isNew !== false };
  }

  /** Shared pull-batch boundary: persist ordinary messages and command effects before publishing. */
  private consumeMessageBatch(messages: readonly RawInboundMessage[], generation: number): void {
    const updates: PrivateMessage[] = [];
    const deletedClientMessageIds: string[] = [];
    const updatedConversationIds: string[] = [];
    for (const message of messages) {
      if (!this.online || generation !== this.loginGeneration) return;
      if (isOrdinaryMessageType(message.messageType)) updates.push(this.cacheInboundMessage(message).message);
      else {
        const deletion = messageDeletionCommand(message.messageType, message.rawContent);
        if (deletion) {
          const clientId = this.applyMessageDeletionCommand(deletion.conversationId, deletion.serverMessageId, message.raw);
          if (clientId) deletedClientMessageIds.push(clientId);
        } else if (this.applyConversationCommand(message.messageType, message.rawContent, message.threadId, message.raw, true)
          || this.applySettingCommand(message.messageType, message.rawContent, message.raw)) updatedConversationIds.push(message.threadId);
      }
    }
    if (this.online && generation === this.loginGeneration) this.assembler?.receiveMessageBatch(updates, deletedClientMessageIds, {}, updatedConversationIds);
  }

  private get inboxQueries(): ImInboxQueries {
    this.ensureOnline();
    return this.inboxFeature!;
  }

  private ensureOnline(): void {
    if (!this.online || !this.sender) {
      throw new Error('账号未上线，请先 await account.login() 并完成登录');
    }
  }

  private replaceCache<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
  }

  private ensureQuerySucceeded(operation: string, statusCode: number, statusMsg: string): void {
    if (statusCode === 0) return;
    throw new Error(`${operation}失败: status=${statusCode}${statusMsg ? ` ${statusMsg}` : ''}`);
  }

  override [captureRejectionSymbol](error: unknown, event: string | symbol): void {
    const normalized = toError(error);
    if (event === 'system.handler.error') {
      this.logger.error(normalized, 'system.handler.error listener failed');
      return;
    }
    this.emit('system.handler.error', { event, error: normalized });
  }

}
