import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import type { GroupMemberData, ImConversation, PrivateMessage, UserFollowStatus, UserFollowerStatus, StrangerSyncCursors } from './types.js';
import { normalizeStrangerCursors } from './stranger-cursors.js';
import { selectStrangerConversations } from './stranger-list.js';
import type { FrontierCursor, FrontierCursorStore } from './frontier-cursors.js';
import { normalizeMessageReadPrivacyQueries, type MessageReadPrivacy, type MessageReadPrivacyQuery } from './user-settings.js';
import { calculateConversationReadSummary, selectLastSentMessage, validateStoredReadCursors, type ConversationReadSummary, type StoredReadCursor } from './read-state.js';
import { messageClientId, normalizeClientId, prepareMessageCacheWrite, type MessageCacheSource, type MessageCacheUpdate } from './message-cache.js';
import { ConversationSummaryCache, type ConversationSummaryRecord } from './conversation-summary.js';
import type { MessageFloatHintConfig } from '../../desktop/settings.js';
import { mergeConversationSnapshot } from './conversation-state.js';
import { conversationDeletionPlan, maxStoredMessageIndex, signedMessageIndex } from './conversation-delete.js';

export interface CachedMessageReadPrivacy {
  query: MessageReadPrivacyQuery;
  policy: MessageReadPrivacy;
}

export type ImStateStoreBackend = 'sqlite' | 'json';

/** Local-only patch; IDs refer to one account's retained client-message rows. */
export interface MessageLocalExtUpdate {
  conversationId: string;
  clientMessageId: string;
  ext: Readonly<Record<string, string>>;
}

/** SDK rejects malformed maps before writes, instead of relying on native protobuf coercion. */
export function validateMessageLocalExt(ext: Readonly<Record<string, string>>): void {
  if (!ext || typeof ext !== 'object' || Array.isArray(ext) || Object.values(ext).some(value => typeof value !== 'string')) {
    throw new TypeError('消息本地扩展字段必须是字符串键值对象');
  }
}

/** Account-scoped user relationship; independent of friend/stranger/group membership. */
export interface UserRelationState {
  followStatus?: UserFollowStatus;
  followerStatus?: UserFollowerStatus;
  blocked?: boolean;
  remark?: string;
}

export interface ImStateStoreOptions {
  accountDir: string;
  backend?: ImStateStoreBackend;
  maxMessagesPerConversation?: number;
  /** @internal IM initialization snapshot of Desktop application settings. */
  floatHintConfig?: MessageFloatHintConfig;
  /** @internal Current IM option user, for native group-notice float exceptions. */
  userId?: string;
}

export interface LocalImStateOptions {
  /** 默认 sqlite；json 仅用于显式需要可读文件的场景。 */
  backend?: ImStateStoreBackend;
  /** 每个会话最多保留的消息数，默认 1000。 */
  maxMessagesPerConversation?: number;
}

/**
 * 与抖音聊天本地 IM 数据库等价的最小持久化边界。
 *
 * 网络同步、实时事件和上层联系人都读写同一份状态；具体 SQLite/JSON
 * 文件格式不会泄漏到 Account、Group 或 MessageEvent。
 */
export interface ImStateStore extends FrontierCursorStore {
  readonly backend: ImStateStoreBackend;
  getStrangerSyncCursors(): StrangerSyncCursors;
  setStrangerSyncCursors(cursors: StrangerSyncCursors): void;
  getUserRelation(uid: string): UserRelationState | undefined;
  setUserRelation(uid: string, relation: UserRelationState): void;
  getMessageReadPrivacy(conversationId: string, serverMessageId: string): CachedMessageReadPrivacy | undefined;
  upsertMessageReadPrivacy(entries: readonly CachedMessageReadPrivacy[]): void;
  deleteMessageReadPrivacy(conversationId: string, serverMessageId: string): void;
  listReadCursors(conversationId: string): StoredReadCursor[];
  saveReadCursors(conversationId: string, rows: readonly StoredReadCursor[]): void;
  /** Native last-self-message aggregate from retained rows, before privacy filtering. */
  getReadSummary(conversationId: string, selfUid: string): ConversationReadSummary | undefined;
  replaceGroups(groups: readonly ImConversation[]): void;
  upsertConversations(conversations: readonly ImConversation[], source?: 'server' | 'local'): void;
  getConversation(conversationId: string): ImConversation | undefined;
  patchConversation(
    conversationId: string,
    patch: Partial<Omit<ImConversation, 'conversationId'>>,
  ): void;
  listGroups(): ImConversation[] | undefined;
  /** Complete matching local rows, with no remote completeness/hasMore claim. */
  queryStrangerConversations(): ImConversation[];
  getConversationDeletionBoundary(conversationId: string): string;
  applyConversationDeletion(conversationId: string, boundary: string): 'missing' | 'retained' | 'deleted';
  deleteConversation(conversationId: string): void;
  replaceGroupMembers(groupId: string, members: readonly GroupMemberData[]): void;
  upsertGroupMembers(groupId: string, members: readonly GroupMemberData[]): void;
  removeGroupMembers(groupId: string, uids: readonly string[]): void;
  /** Atomic command7 removal. Undefined means missing conversation; boolean reports embedded-list change. */
  removeConversationMembers(conversationId: string, uids: readonly string[]): boolean | undefined;
  listGroupMembers(groupId: string): GroupMemberData[] | undefined;
  /** Send acknowledgements lack a MessageBody: only seed a missing cache entry. */
  upsertMessages(messages: readonly PrivateMessage[], source?: MessageCacheSource): MessageCacheUpdate[];
  /** Patch one retained client row, including empty maps; never synthesize a missing message. */
  modifyMessageLocalExt(update: MessageLocalExtUpdate): PrivateMessage | undefined;
  /** Returns whether deletion hit a local last/hint slot, for the conversation-update callback. */
  deleteMessage(conversationId: string, id: string, kind?: 'server' | 'client'): boolean;
  /** Recall reuses deletion's summary selection, without emitting a single conversation update. */
  refreshRecalledSummary(conversationId: string, clientId: string): void;
  /** Local property-read transition only; network reporting and events belong to Account. */
  markPropertyRead(conversationId: string): boolean;
  listMessages(conversationId: string, count?: number): PrivateMessage[];
  getMessage(conversationId: string, id: string, kind: 'server' | 'client'): PrivateMessage | undefined;
  /** All non-deleted direct references in this conversation's retained cache, not a history page. */
  getReferencingMessages(conversationId: string, serverMessageId: string): PrivateMessage[];
  close(): void;
}

interface JsonState {
  version: 1;
  strangerSyncCursors?: StrangerSyncCursors;
  conversations: Record<string, ImConversation>;
  groupSnapshot?: true;
  groupMembers: Record<string, Record<string, GroupMemberData>>;
  completeMemberLists: Record<string, true>;
  messages: Record<string, Record<string, PrivateMessage>>;
  frontierCursors?: Record<string, FrontierCursor[]>;
  userRelations?: Record<string, UserRelationState>;
  messageReadPrivacy?: Record<string, CachedMessageReadPrivacy>;
  readCursors?: Record<string, StoredReadCursor[]>;
  conversationSummaries?: Record<string, ConversationSummaryRecord>;
}

const DEFAULT_MESSAGE_LIMIT = 1_000;

function emptyJsonState(): JsonState {
  return {
    version: 1,
    conversations: {},
    groupMembers: {},
    completeMemberLists: {},
    messages: {},
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function privacyKey(conversationId: string, serverMessageId: string): string {
  return JSON.stringify([conversationId, serverMessageId]);
}

function validatePrivacy(entries: readonly CachedMessageReadPrivacy[]): void {
  for (const { query, policy } of entries) {
    if (normalizeMessageReadPrivacyQueries([query]).length !== 1 || policy.serverMessageId !== query.serverMessageId ||
        !Number.isSafeInteger(policy.errorCode) || ![policy.on, policy.off].every(list => Array.isArray(list) &&
          list.every(uid => typeof uid === 'string' && /^[1-9]\d*$/.test(uid) && BigInt(uid) <= 9223372036854775807n))) {
      throw new Error('Invalid cached read privacy');
    }
  }
}

function compareMessage(left: PrivateMessage, right: PrivateMessage): number {
  const a = left.indexInConversationV2 || left.indexInConversation;
  const b = right.indexInConversationV2 || right.indexInConversation;
  if (a && b) {
    try {
      const delta = BigInt(a) - BigInt(b);
      if (delta !== 0n) return delta < 0n ? -1 : 1;
    } catch {
      // 非法索引退回时间排序。
    }
  }
  return left.createTime - right.createTime;
}

function validateLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('message cache count must be a positive safe integer');
  }
  return limit;
}

class JsonImStateStore implements ImStateStore {
  readonly backend = 'json' as const;
  private readonly file: string;
  private readonly maxMessages: number;
  private state: JsonState;
  private summaryWrites = 0;
  private readonly summaries: ConversationSummaryCache;
  getReadSummary(conversationId: string, selfUid: string): ConversationReadSummary | undefined {
    const message = selectLastSentMessage(Object.values(this.state.messages[conversationId] ?? {}), conversationId, selfUid);
    return message && calculateConversationReadSummary(conversationId, message, selfUid,
      Object.values(this.state.groupMembers[conversationId] ?? {}), this.listReadCursors(conversationId));
  }
  private createSummaries(floatHintConfig?: MessageFloatHintConfig, userId?: string): ConversationSummaryCache { return new ConversationSummaryCache({
    conversation: id => this.state.conversations[id],
    load: id => this.state.conversationSummaries?.[id],
    save: (id, summary) => { this.state.conversationSummaries ??= {}; this.state.conversationSummaries[id] = clone(summary); this.summaryWrites++; },
    commitLocalExt: (id, localExt) => {
      const previous = this.state;
      const saved = previous.conversationSummaries?.[id];
      this.state = { ...previous, conversationSummaries: { ...previous.conversationSummaries,
        [id]: { ...(saved ?? { lastClientId: '', hintClientId: '', lastMessageIndex: '0' }), localExt: clone(localExt) } } };
      try { this.flush(); }
      catch (error) { this.state = previous; throw error; }
      this.summaryWrites++;
    },
    messages: id => Object.values(this.state.messages[id] ?? {}),
  }, floatHintConfig, userId); }

  listReadCursors(conversationId: string): StoredReadCursor[] {
    const rows = this.state.readCursors?.[JSON.stringify(conversationId)] ?? [];
    validateStoredReadCursors(rows);
    return clone(rows);
  }

  saveReadCursors(conversationId: string, rows: readonly StoredReadCursor[]): void {
    validateStoredReadCursors(rows);
    const merged = new Map(this.listReadCursors(conversationId).map(row => [row.uid, row]));
    for (const row of rows) merged.set(row.uid, clone(row));
    this.state.readCursors ??= {};
    this.state.readCursors[JSON.stringify(conversationId)] = [...merged.values()];
    this.flush();
  }

  constructor(accountDir: string, maxMessages: number, floatHintConfig?: MessageFloatHintConfig, private readonly userId?: string) {
    mkdirSync(accountDir, { recursive: true });
    this.file = join(accountDir, 'im-state.json');
    this.maxMessages = maxMessages;
    this.state = this.load();
    this.summaries = this.createSummaries(floatHintConfig, userId);
  }

  getUserRelation(uid: string): UserRelationState | undefined {
    const relation = this.state.userRelations?.[uid];
    return relation ? clone(relation) : undefined;
  }

  setUserRelation(uid: string, relation: UserRelationState): void {
    if (!/^\d+$/.test(uid)) throw new Error('Invalid user relation UID');
    this.state.userRelations ??= {};
    this.state.userRelations[uid] = clone(relation);
    this.flush();
  }

  getMessageReadPrivacy(conversationId: string, serverMessageId: string): CachedMessageReadPrivacy | undefined {
    const entry = this.state.messageReadPrivacy?.[privacyKey(conversationId, serverMessageId)];
    if (!entry) return undefined;
    try { validatePrivacy([entry]); return clone(entry); } catch { return undefined; }
  }

  upsertMessageReadPrivacy(entries: readonly CachedMessageReadPrivacy[]): void {
    validatePrivacy(entries);
    if (!entries.length) return;
    this.state.messageReadPrivacy ??= {};
    for (const entry of entries) this.state.messageReadPrivacy[privacyKey(entry.query.conversationId, entry.query.serverMessageId)] = clone(entry);
    this.flush();
  }

  deleteMessageReadPrivacy(conversationId: string, serverMessageId: string): void {
    if (this.state.messageReadPrivacy) delete this.state.messageReadPrivacy[privacyKey(conversationId, serverMessageId)];
    this.flush();
  }

  replaceGroups(groups: readonly ImConversation[]): void {
    const groupIds = new Set(groups.map((group) => group.conversationId));
    for (const [id, conversation] of Object.entries(this.state.conversations)) {
      if (!conversation.isGroup) continue;
      if (!groupIds.has(id)) this.removeConversation(id);
    }
    for (const group of groups) {
      this.state.conversations[group.conversationId] = clone(mergeConversationSnapshot(this.getConversation(group.conversationId), group, this.userId));
      this.summaries.saveMerged(group.conversationId);
    }
    this.state.groupSnapshot = true;
    this.flush();
  }

  upsertConversations(conversations: readonly ImConversation[], source: 'server' | 'local' = 'server'): void {
    if (conversations.length === 0) return;
    for (const conversation of conversations) {
      this.state.conversations[conversation.conversationId] = clone(
        source === 'local' ? conversation : mergeConversationSnapshot(this.getConversation(conversation.conversationId), conversation, this.userId));
      if (source === 'server') this.summaries.saveMerged(conversation.conversationId);
    }
    this.flush();
  }

  patchConversation(
    conversationId: string,
    patch: Partial<Omit<ImConversation, 'conversationId'>>,
  ): void {
    const current = this.state.conversations[conversationId];
    if (!current) return;
    this.state.conversations[conversationId] = { ...current, ...clone(patch) };
    this.flush();
  }

  listGroups(): ImConversation[] | undefined {
    if (!this.state.groupSnapshot) return undefined;
    return Object.values(this.state.conversations)
      .filter((conversation) => conversation.isGroup && !conversation.deleted)
      .map(conversation => this.summaries.project(clone(conversation)));
  }

  getConversation(conversationId: string): ImConversation | undefined {
    const value = this.state.conversations[conversationId];
    return value && !value.deleted ? this.summaries.project(clone(value)) : undefined;
  }

  queryStrangerConversations(): ImConversation[] {
    const rows = Object.values(this.state.conversations).map(conversation => ({ ...conversation,
      sortOrder: this.state.conversationSummaries?.[conversation.conversationId]?.sortOrder ?? conversation.sortOrder ?? '0',
    }));
    const writes = this.summaryWrites;
    const result = selectStrangerConversations(rows).map(conversation => this.summaries.query(conversation));
    if (this.summaryWrites !== writes) this.flush();
    return result;
  }

  getConversationDeletionBoundary(conversationId: string): string {
    return maxStoredMessageIndex(Object.values(this.state.messages[conversationId] ?? {}));
  }

  applyConversationDeletion(conversationId: string, boundary: string): 'missing' | 'retained' | 'deleted' {
    const index = signedMessageIndex(boundary);
    const current = this.getConversation(conversationId);
    if (!current) return 'missing';
    const plan = conversationDeletionPlan(current, boundary);
    // Prepare a complete candidate before committing; failed JSON writes must not publish deletion in memory.
    const previous = this.state;
    const next = clone(previous);
    next.conversations[conversationId] = { ...next.conversations[conversationId]!, minIndex: plan.minIndex,
      ...(plan.deleteConversation ? { deleted: true } : {}) };
    for (const message of Object.values(next.messages[conversationId] ?? {})) {
      if (!plan.deleteAllMessages && signedMessageIndex(message.indexInConversation ?? '0') > index) continue;
      message.deleted = true;
      if (plan.deleteAllMessages) delete message.propertyList;
      if (next.messageReadPrivacy) delete next.messageReadPrivacy[privacyKey(conversationId, message.msgId)];
    }
    this.state = next;
    try { this.flush(); } catch (error) { this.state = previous; throw error; }
    if (plan.deleteConversation) this.summaries.forget(conversationId);
    return plan.deleteConversation ? 'deleted' : 'retained';
  }

  deleteConversation(conversationId: string): void {
    this.removeConversation(conversationId);
    this.flush();
  }

  replaceGroupMembers(groupId: string, members: readonly GroupMemberData[]): void {
    this.state.groupMembers[groupId] = Object.fromEntries(
      members.map((member) => [member.uid, clone(member)]),
    );
    if (this.state.readCursors) this.state.readCursors[JSON.stringify(groupId)] = this.listReadCursors(groupId).filter(row => members.some(member => member.uid === row.uid));
    this.state.completeMemberLists[groupId] = true;
    this.flush();
  }

  upsertGroupMembers(groupId: string, members: readonly GroupMemberData[]): void {
    if (members.length === 0) return;
    const current = this.state.groupMembers[groupId] ?? {};
    for (const member of members) current[member.uid] = clone(member);
    this.state.groupMembers[groupId] = current;
    this.flush();
  }

  removeGroupMembers(groupId: string, uids: readonly string[]): void {
    const current = this.state.groupMembers[groupId];
    if (uids.length === 0) return;
    for (const uid of uids) if (current) delete current[uid];
    if (this.state.readCursors) this.state.readCursors[JSON.stringify(groupId)] = this.listReadCursors(groupId).filter(row => !uids.includes(row.uid));
    this.flush();
  }

  removeConversationMembers(conversationId: string, uids: readonly string[]): boolean | undefined {
    const current = this.getConversation(conversationId);
    if (!current) return undefined;
    if (!uids.length) return false;
    const removed = new Set(uids);
    const members = current.members?.filter(member => !removed.has(member.uid));
    const changed = members !== undefined && members.length !== current.members?.length;
    const previous = this.state;
    const next = clone(previous);
    if (changed) next.conversations[conversationId]!.members = members;
    for (const uid of uids) if (next.groupMembers[conversationId]) delete next.groupMembers[conversationId]![uid];
    const key = JSON.stringify(conversationId);
    if (next.readCursors?.[key]) next.readCursors[key] = next.readCursors[key]!.filter(row => !removed.has(row.uid));
    this.state = next;
    try { this.flush(); } catch (error) { this.state = previous; throw error; }
    return changed;
  }

  listGroupMembers(groupId: string): GroupMemberData[] | undefined {
    if (!this.state.completeMemberLists[groupId]) return undefined;
    return Object.values(this.state.groupMembers[groupId] ?? {}).map(clone);
  }

  upsertMessages(messages: readonly PrivateMessage[], source: MessageCacheSource = 'server'): MessageCacheUpdate[] {
    const updates: MessageCacheUpdate[] = [];
    if (messages.length === 0) return updates;
    const touched = new Set<string>();
    for (const message of messages) {
      const current = this.state.messages[message.threadId] ?? {};
      const write = prepareMessageCacheWrite(message, source, new Map(Object.entries(current)));
      if (!write) continue;
      this.summaries.prepare(message.threadId);
      for (const key of write.removeKeys) delete current[key];
      current[write.key] = write.message;
      updates.push({ message: clone(write.message), isNew: write.isNew });
      this.state.messages[message.threadId] = current;
      if (source === 'server') this.summaries.saved(write.message);
      touched.add(message.threadId);
    }
    for (const conversationId of touched) {
      const current = this.state.messages[conversationId] ?? {};
      const sorted = Object.entries(current)
        .sort((left, right) => compareMessage(right[1], left[1]));
      this.state.messages[conversationId] = Object.fromEntries(sorted.slice(0, this.maxMessages));
    }
    this.flush();
    return updates;
  }

  modifyMessageLocalExt({ conversationId, clientMessageId, ext }: MessageLocalExtUpdate): PrivateMessage | undefined {
    validateMessageLocalExt(ext);
    if (!conversationId || !clientMessageId) return undefined;
    const rows = this.state.messages[conversationId] ?? {};
    const entry = Object.entries(rows).find(([, message]) => !message.deleted && messageClientId(message) === normalizeClientId(clientMessageId));
    if (!entry) return undefined;
    const [key, old] = entry;
    const updated = { ...old, localExt: { ...old.localExt, ...ext } };
    rows[key] = updated;
    try { this.flush(); }
    catch (error) { rows[key] = old; throw error; }
    // Native patches the message proxy directly, not the conversation summary selection.
    return clone(updated);
  }

  deleteMessage(conversationId: string, id: string, kind: 'server' | 'client' = 'server'): boolean {
    const current = this.state.messages[conversationId];
    const target = this.getMessage(conversationId, id, kind);
    if (target) this.summaries.prepare(conversationId);
    const serverMessageId = kind === 'server' ? id : target?.msgId;
    if (target && current) {
      const clientId = messageClientId(target);
      for (const [key, message] of Object.entries(current)) {
        if (key !== `s:${serverMessageId}` && (!clientId || messageClientId(message) !== clientId)) continue;
        message.deleted = true;
        if (this.state.messageReadPrivacy) delete this.state.messageReadPrivacy[privacyKey(conversationId, message.msgId)];
      }
    }
    if (serverMessageId && this.state.messageReadPrivacy) delete this.state.messageReadPrivacy[privacyKey(conversationId, serverMessageId)];
    const summaryChanged = target ? this.summaries.removed(conversationId, messageClientId(target)) : false;
    this.flush();
    return summaryChanged;
  }

  listMessages(conversationId: string, count = 50): PrivateMessage[] {
    const limit = validateLimit(count, 50);
    const messages = Object.values(this.state.messages[conversationId] ?? {})
      .filter(message => message.deleted !== true)
      .sort(compareMessage);
    return messages.slice(-limit).map(clone);
  }

  refreshRecalledSummary(conversationId: string, clientId: string): void {
    this.summaries.removed(conversationId, clientId);
    this.flush();
  }

  markPropertyRead(conversationId: string): boolean {
    return this.summaries.markPropertyRead(conversationId);
  }

  getMessage(conversationId: string, id: string, kind: 'server' | 'client'): PrivateMessage | undefined {
    if (!conversationId || !id || (kind === 'server' && id === '0')) return undefined;
    const messages = this.state.messages[conversationId] ?? {};
    const result = kind === 'server' ? messages[`s:${id}`]
      : Object.values(messages).find(message => message.deleted !== true && messageClientId(message) === normalizeClientId(id));
    return result ? clone(result) : undefined;
  }

  getReferencingMessages(conversationId: string, serverMessageId: string): PrivateMessage[] {
    if (!conversationId || !serverMessageId || serverMessageId === '0') return [];
    return Object.values(this.state.messages[conversationId] ?? {})
      .filter(message => message.deleted !== true && message.referenceInfo?.refMessageId === serverMessageId)
      .map(clone);
  }

  close(): void {}

  getStrangerSyncCursors(): StrangerSyncCursors {
    return normalizeStrangerCursors(this.state.strangerSyncCursors);
  }

  setStrangerSyncCursors(cursors: StrangerSyncCursors): void {
    const next = normalizeStrangerCursors(cursors);
    const previous = this.state.strangerSyncCursors;
    this.state.strangerSyncCursors = next;
    try { this.flush(); }
    catch (error) {
      if (previous === undefined) delete this.state.strangerSyncCursors;
      else this.state.strangerSyncCursors = previous;
      throw error;
    }
  }

  getFrontierCursors(namespace: string): FrontierCursor[] | undefined {
    const value = this.state.frontierCursors?.[namespace];
    return value ? clone(value) : undefined;
  }

  setFrontierCursors(namespace: string, cursors: FrontierCursor[]): void {
    this.state.frontierCursors ??= {};
    this.state.frontierCursors[namespace] = clone(cursors);
    this.flush();
  }

  private removeConversation(conversationId: string): void {
    this.summaries.forget(conversationId);
    if (this.state.conversationSummaries) delete this.state.conversationSummaries[conversationId];
    if (this.state.readCursors) delete this.state.readCursors[JSON.stringify(conversationId)];
    delete this.state.conversations[conversationId];
    delete this.state.groupMembers[conversationId];
    delete this.state.completeMemberLists[conversationId];
    delete this.state.messages[conversationId];
    for (const [key, entry] of Object.entries(this.state.messageReadPrivacy ?? {})) {
      if (entry.query.conversationId === conversationId) delete this.state.messageReadPrivacy![key];
    }
  }

  private load(): JsonState {
    if (!existsSync(this.file)) return emptyJsonState();
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<JsonState>;
      if (parsed.version !== 1) return emptyJsonState();
      return {
        version: 1,
        conversations: parsed.conversations ?? {},
        ...(parsed.groupSnapshot ? { groupSnapshot: true } : {}),
        groupMembers: parsed.groupMembers ?? {},
        completeMemberLists: parsed.completeMemberLists ?? {},
        messages: parsed.messages ?? {},
        ...(parsed.strangerSyncCursors !== undefined ? { strangerSyncCursors: parsed.strangerSyncCursors } : {}),
        frontierCursors: parsed.frontierCursors ?? {},
        userRelations: parsed.userRelations ?? {},
        messageReadPrivacy: parsed.messageReadPrivacy ?? {},
        readCursors: parsed.readCursors ?? {},
        conversationSummaries: parsed.conversationSummaries ?? {},
      };
    } catch {
      return emptyJsonState();
    }
  }

  private flush(): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state));
    renameSync(temporary, this.file);
  }
}

class SqliteImStateStore implements ImStateStore {
  readonly backend = 'sqlite' as const;
  private readonly database: DatabaseSync;
  private readonly maxMessages: number;
  private readonly summaries: ConversationSummaryCache;
  getReadSummary(conversationId: string, selfUid: string): ConversationReadSummary | undefined {
    const messages = this.database.prepare('SELECT payload FROM messages WHERE conversation_id = ? ORDER BY rowid').all(conversationId)
      .map(row => JSON.parse(String(row['payload'])) as PrivateMessage);
    const message = selectLastSentMessage(messages, conversationId, selfUid);
    if (!message) return undefined;
    const members = this.database.prepare('SELECT payload FROM group_members WHERE group_id = ? ORDER BY rowid').all(conversationId)
      .map(row => JSON.parse(String(row['payload'])) as GroupMemberData);
    return calculateConversationReadSummary(conversationId, message, selfUid, members, this.listReadCursors(conversationId));
  }
  private createSummaries(floatHintConfig?: MessageFloatHintConfig, userId?: string): ConversationSummaryCache { return new ConversationSummaryCache({
    conversation: id => {
      const row = this.database.prepare('SELECT payload FROM conversations WHERE conversation_id = ?').get(id);
      return row ? JSON.parse(String(row['payload'])) as ImConversation : undefined;
    },
    load: id => {
      const row = this.database.prepare('SELECT payload FROM conversation_summaries WHERE conversation_id = ?').get(id);
      return row ? JSON.parse(String(row['payload'])) as ConversationSummaryRecord : undefined;
    },
    save: (id, summary) => {
      this.database.prepare(`INSERT INTO conversation_summaries(conversation_id, payload) VALUES (?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET payload=excluded.payload`).run(id, JSON.stringify(summary));
    },
    commitLocalExt: (id, localExt) => this.transaction(() => {
      const row = this.database.prepare('SELECT payload FROM conversation_summaries WHERE conversation_id = ?').get(id);
      const saved = row ? JSON.parse(String(row['payload'])) as ConversationSummaryRecord
        : { lastClientId: '', hintClientId: '', lastMessageIndex: '0' };
      this.database.prepare(`INSERT INTO conversation_summaries(conversation_id, payload) VALUES (?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET payload=excluded.payload`).run(id, JSON.stringify({ ...saved, localExt }));
    }),
    messages: id => this.database.prepare('SELECT payload FROM messages WHERE conversation_id = ? ORDER BY rowid').all(id)
      .map(row => JSON.parse(String(row['payload'])) as PrivateMessage),
  }, floatHintConfig, userId); }

  listReadCursors(conversationId: string): StoredReadCursor[] {
    const rows = this.database.prepare('SELECT uid, read_index, min_index FROM read_cursors WHERE conversation_id = ? ORDER BY rowid').all(conversationId)
      .map(row => ({ uid: String(row['uid']), readIndex: String(row['read_index']), minIndex: String(row['min_index']) }));
    validateStoredReadCursors(rows);
    return rows;
  }

  saveReadCursors(conversationId: string, rows: readonly StoredReadCursor[]): void {
    validateStoredReadCursors(rows);
    const upsert = this.database.prepare(`INSERT INTO read_cursors(conversation_id, uid, read_index, min_index) VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, uid) DO UPDATE SET read_index=excluded.read_index, min_index=excluded.min_index`);
    this.transaction(() => { for (const row of rows) upsert.run(conversationId, row.uid, row.readIndex, row.minIndex); });
  }

  getUserRelation(uid: string): UserRelationState | undefined {
    const row = this.database.prepare('SELECT payload FROM user_relations WHERE uid = ?').get(uid);
    return row ? JSON.parse(String(row['payload'])) as UserRelationState : undefined;
  }

  setUserRelation(uid: string, relation: UserRelationState): void {
    if (!/^\d+$/.test(uid)) throw new Error('Invalid user relation UID');
    this.database.prepare('INSERT INTO user_relations(uid, payload) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET payload = excluded.payload')
      .run(uid, JSON.stringify(relation));
  }

  getMessageReadPrivacy(conversationId: string, serverMessageId: string): CachedMessageReadPrivacy | undefined {
    const row = this.database.prepare('SELECT payload FROM message_read_privacy WHERE conversation_id = ? AND message_id = ?')
      .get(conversationId, serverMessageId);
    if (!row) return undefined;
    try {
      const entry = JSON.parse(String(row['payload'])) as CachedMessageReadPrivacy;
      validatePrivacy([entry]); return entry;
    } catch { return undefined; }
  }

  upsertMessageReadPrivacy(entries: readonly CachedMessageReadPrivacy[]): void {
    validatePrivacy(entries);
    if (!entries.length) return;
    const upsert = this.database.prepare(`INSERT INTO message_read_privacy(conversation_id, message_id, payload) VALUES (?, ?, ?)
      ON CONFLICT(conversation_id, message_id) DO UPDATE SET payload = excluded.payload`);
    this.transaction(() => {
      for (const entry of entries) upsert.run(entry.query.conversationId, entry.query.serverMessageId, JSON.stringify(entry));
    });
  }

  deleteMessageReadPrivacy(conversationId: string, serverMessageId: string): void {
    this.database.prepare('DELETE FROM message_read_privacy WHERE conversation_id = ? AND message_id = ?').run(conversationId, serverMessageId);
  }

  constructor(accountDir: string, maxMessages: number, floatHintConfig?: MessageFloatHintConfig, private readonly userId?: string) {
    mkdirSync(accountDir, { recursive: true });
    this.maxMessages = maxMessages;
    // 只使用 v22.5.0 首发即具备的构造能力；后续选项改用 PRAGMA，保持最低版本契约。
    this.database = new DatabaseSync(join(accountDir, 'im-state.sqlite'));
    this.summaries = this.createSummaries(floatHintConfig, userId);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        conversation_type INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        list_position INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (group_id, uid)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS member_snapshots (
        group_id TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS state_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS user_relations (
        uid TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS message_read_privacy (
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, message_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS read_cursors (
        conversation_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        read_index TEXT NOT NULL,
        min_index TEXT NOT NULL,
        PRIMARY KEY (conversation_id, uid)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        conversation_id TEXT NOT NULL,
        message_key TEXT NOT NULL,
        create_time INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, message_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_by_conversation_time
        ON messages (conversation_id, create_time);
      PRAGMA user_version = 1;
    `);
  }

  replaceGroups(groups: readonly ImConversation[]): void {
    this.transaction(() => {
      const incoming = new Set(groups.map((group) => group.conversationId));
      const existing = this.database.prepare(
        'SELECT conversation_id FROM conversations WHERE conversation_type = 2',
      ).all();
      for (const row of existing) {
        const id = String(row['conversation_id'] ?? '');
        if (id && !incoming.has(id)) this.deleteConversationRows(id);
      }
      const upsert = this.database.prepare(`
        INSERT INTO conversations (
          conversation_id, conversation_type, payload, updated_at, list_position
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          conversation_type = excluded.conversation_type,
          payload = excluded.payload,
          updated_at = excluded.updated_at,
          list_position = excluded.list_position
      `);
      const now = Date.now();
      for (const [position, group] of groups.entries()) {
        upsert.run(
          group.conversationId,
          group.conversationType,
          JSON.stringify(mergeConversationSnapshot(this.getConversation(group.conversationId), group, this.userId)),
          now,
          position,
        );
        this.summaries.saveMerged(group.conversationId);
      }
      this.database.prepare(`
        INSERT INTO state_meta (key, value) VALUES ('group_snapshot', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(now));
    });
  }

  upsertConversations(conversations: readonly ImConversation[], source: 'server' | 'local' = 'server'): void {
    if (conversations.length === 0) return;
    const upsert = this.database.prepare(`
      INSERT INTO conversations (conversation_id, conversation_type, payload, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        conversation_type = excluded.conversation_type,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    this.transaction(() => {
      for (const conversation of conversations) {
        upsert.run(
          conversation.conversationId,
          conversation.conversationType,
          JSON.stringify(source === 'local' ? conversation : mergeConversationSnapshot(this.getConversation(conversation.conversationId), conversation, this.userId)),
          now,
        );
        if (source === 'server') this.summaries.saveMerged(conversation.conversationId);
      }
    });
  }

  patchConversation(
    conversationId: string,
    patch: Partial<Omit<ImConversation, 'conversationId'>>,
  ): void {
    const row = this.database.prepare(
      'SELECT payload FROM conversations WHERE conversation_id = ?',
    ).get(conversationId);
    if (!row) return;
    const current = JSON.parse(String(row['payload'] ?? '{}')) as ImConversation;
    const updated = { ...current, ...patch };
    this.database.prepare(`
      UPDATE conversations
      SET conversation_type = ?, payload = ?, updated_at = ?
      WHERE conversation_id = ?
    `).run(updated.conversationType, JSON.stringify(updated), Date.now(), conversationId);
  }

  listGroups(): ImConversation[] | undefined {
    const complete = this.database.prepare(
      "SELECT value FROM state_meta WHERE key = 'group_snapshot'",
    ).get();
    if (!complete) return undefined;
    return this.database.prepare(
      'SELECT payload FROM conversations WHERE conversation_type = 2 ORDER BY list_position',
    ).all().map((row) => JSON.parse(String(row['payload'] ?? '{}')) as ImConversation)
      .filter(conversation => !conversation.deleted).map(conversation => this.summaries.project(conversation));
  }

  getConversation(conversationId: string): ImConversation | undefined {
    const row = this.database.prepare('SELECT payload FROM conversations WHERE conversation_id = ?').get(conversationId);
    const conversation = row ? JSON.parse(String(row['payload'])) as ImConversation : undefined;
    return conversation && !conversation.deleted ? this.summaries.project(conversation) : undefined;
  }

  queryStrangerConversations(): ImConversation[] {
    const rows = this.database.prepare(`SELECT c.payload, s.payload AS summary_payload
      FROM conversations c LEFT JOIN conversation_summaries s ON s.conversation_id = c.conversation_id`).all()
      .map(row => {
        const conversation = JSON.parse(String(row['payload'])) as ImConversation;
        const summary = row['summary_payload'] == null ? undefined : JSON.parse(String(row['summary_payload'])) as ConversationSummaryRecord;
        return { ...conversation, sortOrder: summary?.sortOrder ?? conversation.sortOrder ?? '0' };
      });
    return selectStrangerConversations(rows).map(conversation => this.summaries.query(conversation));
  }

  getConversationDeletionBoundary(conversationId: string): string {
    const rows = this.database.prepare('SELECT payload FROM messages WHERE conversation_id = ?').all(conversationId);
    return maxStoredMessageIndex(rows.map(row => JSON.parse(String(row['payload'])) as PrivateMessage));
  }

  applyConversationDeletion(conversationId: string, boundary: string): 'missing' | 'retained' | 'deleted' {
    const index = signedMessageIndex(boundary);
    const outcome = this.transaction(() => {
      const current = this.getConversation(conversationId);
      if (!current) return 'missing';
      const plan = conversationDeletionPlan(current, boundary);
      this.patchConversation(conversationId, { minIndex: plan.minIndex, ...(plan.deleteConversation ? { deleted: true } : {}) });
      const rows = this.database.prepare('SELECT message_key, payload FROM messages WHERE conversation_id = ?').all(conversationId);
      const update = this.database.prepare('UPDATE messages SET payload = ? WHERE conversation_id = ? AND message_key = ?');
      const clearPrivacy = this.database.prepare('DELETE FROM message_read_privacy WHERE conversation_id = ? AND message_id = ?');
      for (const row of rows) {
        const message = JSON.parse(String(row['payload'])) as PrivateMessage;
        if (!plan.deleteAllMessages && signedMessageIndex(message.indexInConversation ?? '0') > index) continue;
        message.deleted = true;
        if (plan.deleteAllMessages) delete message.propertyList;
        update.run(JSON.stringify(message), conversationId, String(row['message_key']));
        clearPrivacy.run(conversationId, message.msgId);
      }
      return plan.deleteConversation ? 'deleted' : 'retained';
    });
    if (outcome === 'deleted') this.summaries.forget(conversationId);
    return outcome;
  }

  deleteConversation(conversationId: string): void {
    this.transaction(() => this.deleteConversationRows(conversationId));
  }

  replaceGroupMembers(groupId: string, members: readonly GroupMemberData[]): void {
    this.transaction(() => {
      this.database.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
      const insert = this.database.prepare(
        'INSERT INTO group_members (group_id, uid, payload) VALUES (?, ?, ?)',
      );
      for (const member of members) insert.run(groupId, member.uid, JSON.stringify(member));
      this.database.prepare('DELETE FROM read_cursors WHERE conversation_id = ? AND uid NOT IN (SELECT uid FROM group_members WHERE group_id = ?)').run(groupId, groupId);
      this.database.prepare(`
        INSERT INTO member_snapshots (group_id, completed_at) VALUES (?, ?)
        ON CONFLICT(group_id) DO UPDATE SET completed_at = excluded.completed_at
      `).run(groupId, Date.now());
    });
  }

  upsertGroupMembers(groupId: string, members: readonly GroupMemberData[]): void {
    if (members.length === 0) return;
    const upsert = this.database.prepare(`
      INSERT INTO group_members (group_id, uid, payload) VALUES (?, ?, ?)
      ON CONFLICT(group_id, uid) DO UPDATE SET payload = excluded.payload
    `);
    this.transaction(() => {
      for (const member of members) upsert.run(groupId, member.uid, JSON.stringify(member));
    });
  }

  removeGroupMembers(groupId: string, uids: readonly string[]): void {
    if (uids.length === 0) return;
    const remove = this.database.prepare('DELETE FROM group_members WHERE group_id = ? AND uid = ?');
    this.transaction(() => {
      const removeRead = this.database.prepare('DELETE FROM read_cursors WHERE conversation_id = ? AND uid = ?');
      for (const uid of uids) { remove.run(groupId, uid); removeRead.run(groupId, uid); }
    });
  }

  removeConversationMembers(conversationId: string, uids: readonly string[]): boolean | undefined {
    return this.transaction(() => {
      const current = this.getConversation(conversationId);
      if (!current) return undefined;
      const removed = new Set(uids);
      const members = current.members?.filter(member => !removed.has(member.uid));
      const changed = members !== undefined && members.length !== current.members?.length;
      if (changed) this.patchConversation(conversationId, { members });
      const removeMember = this.database.prepare('DELETE FROM group_members WHERE group_id = ? AND uid = ?');
      const removeRead = this.database.prepare('DELETE FROM read_cursors WHERE conversation_id = ? AND uid = ?');
      for (const uid of uids) { removeMember.run(conversationId, uid); removeRead.run(conversationId, uid); }
      return changed;
    });
  }

  listGroupMembers(groupId: string): GroupMemberData[] | undefined {
    const complete = this.database.prepare(
      'SELECT group_id FROM member_snapshots WHERE group_id = ?',
    ).all(groupId).length > 0;
    if (!complete) return undefined;
    return this.database.prepare(
      'SELECT payload FROM group_members WHERE group_id = ?',
    ).all(groupId).map((row) => JSON.parse(String(row['payload'] ?? '{}')) as GroupMemberData);
  }

  upsertMessages(messages: readonly PrivateMessage[], source: MessageCacheSource = 'server'): MessageCacheUpdate[] {
    const updates: MessageCacheUpdate[] = [];
    if (messages.length === 0) return updates;
    const upsert = this.database.prepare(`
      INSERT INTO messages (conversation_id, message_key, create_time, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, message_key) DO UPDATE SET
        create_time = excluded.create_time,
        payload = excluded.payload
    `);
    const touched = new Set<string>();
    this.transaction(() => {
      const select = this.database.prepare('SELECT message_key, payload FROM messages WHERE conversation_id = ? ORDER BY rowid');
      const remove = this.database.prepare('DELETE FROM messages WHERE conversation_id = ? AND message_key = ?');
      const conversations = new Map<string, Map<string, PrivateMessage>>();
      for (const message of messages) {
        if (!message.threadId) continue;
        let current = conversations.get(message.threadId);
        if (!current) {
          current = new Map(select.all(message.threadId).map(row => [String(row['message_key']), JSON.parse(String(row['payload'])) as PrivateMessage]));
          conversations.set(message.threadId, current);
        }
        const write = prepareMessageCacheWrite(message, source, current);
        if (!write) continue;
        this.summaries.prepare(message.threadId);
        for (const key of write.removeKeys) {
          remove.run(message.threadId, key);
          current.delete(key);
        }
        current.set(write.key, write.message);
        upsert.run(message.threadId, write.key, write.message.createTime, JSON.stringify(write.message));
        if (source === 'server') this.summaries.saved(write.message);
        updates.push({ message: clone(write.message), isNew: write.isNew });
        touched.add(message.threadId);
      }
      for (const conversationId of touched) {
        // Match the JSON backend: select by the same lossless conversation ordering before truncating.
        const rows = select.all(conversationId).map(row => ({ key: String(row['message_key']), message: JSON.parse(String(row['payload'])) as PrivateMessage }));
        rows.sort((left, right) => compareMessage(right.message, left.message));
        for (const row of rows.slice(this.maxMessages)) remove.run(conversationId, row.key);
      }
    });
    return updates;
  }

  getMessage(conversationId: string, id: string, kind: 'server' | 'client'): PrivateMessage | undefined {
    if (!conversationId || !id || (kind === 'server' && id === '0')) return undefined;
    if (kind === 'server') {
      const row = this.database.prepare('SELECT payload FROM messages WHERE conversation_id = ? AND message_key = ?')
        .get(conversationId, `s:${id}`);
      return row ? JSON.parse(String(row['payload'])) as PrivateMessage : undefined;
    }
    // Scan only this conversation's bounded cache, not a truncated history page or other accounts.
    const rows = this.database.prepare('SELECT payload FROM messages WHERE conversation_id = ? ORDER BY rowid').all(conversationId);
    const normalizedId = normalizeClientId(id);
    return rows.map(row => JSON.parse(String(row['payload'])) as PrivateMessage)
      .find(message => message.deleted !== true && messageClientId(message) === normalizedId);
  }

  modifyMessageLocalExt({ conversationId, clientMessageId, ext }: MessageLocalExtUpdate): PrivateMessage | undefined {
    validateMessageLocalExt(ext);
    if (!conversationId || !clientMessageId) return undefined;
    let updated: PrivateMessage | undefined;
    this.transaction(() => {
      const rows = this.database.prepare('SELECT message_key, payload FROM messages WHERE conversation_id = ? ORDER BY rowid').all(conversationId);
      const id = normalizeClientId(clientMessageId);
      for (const row of rows) {
        const message = JSON.parse(String(row['payload'])) as PrivateMessage;
        if (message.deleted || messageClientId(message) !== id) continue;
        updated = { ...message, localExt: { ...message.localExt, ...ext } };
        this.database.prepare('UPDATE messages SET payload = ? WHERE conversation_id = ? AND message_key = ?')
          .run(JSON.stringify(updated), conversationId, String(row['message_key']));
        break;
      }
    });
    return updated;
  }

  deleteMessage(conversationId: string, id: string, kind: 'server' | 'client' = 'server'): boolean {
    let summaryChanged = false;
    this.transaction(() => {
      const target = this.getMessage(conversationId, id, kind);
      if (target) this.summaries.prepare(conversationId);
      const serverMessageId = kind === 'server' ? id : target?.msgId;
      if (target) {
        const clientId = messageClientId(target);
        const rows = this.database.prepare('SELECT message_key, payload FROM messages WHERE conversation_id = ?').all(conversationId);
        const update = this.database.prepare('UPDATE messages SET payload = ? WHERE conversation_id = ? AND message_key = ?');
        const clearPrivacy = this.database.prepare('DELETE FROM message_read_privacy WHERE conversation_id = ? AND message_id = ?');
        for (const row of rows) {
          const message = JSON.parse(String(row['payload'])) as PrivateMessage;
          if (row['message_key'] !== `s:${serverMessageId}` && (!clientId || messageClientId(message) !== clientId)) continue;
          message.deleted = true;
          update.run(JSON.stringify(message), conversationId, String(row['message_key']));
          clearPrivacy.run(conversationId, message.msgId);
        }
      }
      if (serverMessageId) this.database.prepare('DELETE FROM message_read_privacy WHERE conversation_id = ? AND message_id = ?').run(conversationId, serverMessageId);
      if (target) summaryChanged = this.summaries.removed(conversationId, messageClientId(target));
    });
    return summaryChanged;
  }

  getReferencingMessages(conversationId: string, serverMessageId: string): PrivateMessage[] {
    if (!conversationId || !serverMessageId || serverMessageId === '0') return [];
    // The payload carries reference fields; scan the whole retained conversation, with no page limit.
    return this.database.prepare('SELECT payload FROM messages WHERE conversation_id = ?').all(conversationId)
      .map(row => JSON.parse(String(row['payload'])) as PrivateMessage)
      .filter(message => message.deleted !== true && message.referenceInfo?.refMessageId === serverMessageId);
  }

  refreshRecalledSummary(conversationId: string, clientId: string): void {
    this.transaction(() => { this.summaries.removed(conversationId, clientId); });
  }

  markPropertyRead(conversationId: string): boolean {
    return this.summaries.markPropertyRead(conversationId);
  }

  listMessages(conversationId: string, count = 50): PrivateMessage[] {
    const limit = validateLimit(count, 50);
    const rows = this.database.prepare(`
      SELECT payload FROM messages
      WHERE conversation_id = ?
      ORDER BY rowid
    `).all(conversationId);
    return rows
      .map((row) => JSON.parse(String(row['payload'] ?? '{}')) as PrivateMessage)
      .filter(message => message.deleted !== true)
      .sort(compareMessage)
      .slice(-limit);
  }

  close(): void {
    this.database.close();
  }

  getFrontierCursors(namespace: string): FrontierCursor[] | undefined {
    const row = this.database.prepare('SELECT value FROM state_meta WHERE key = ?').get(`frontier:${namespace}`);
    return row ? JSON.parse(String(row['value'])) as FrontierCursor[] : undefined;
  }

  getStrangerSyncCursors(): StrangerSyncCursors {
    const row = this.database.prepare("SELECT value FROM state_meta WHERE key = 'stranger_sync_cursors'").get();
    return normalizeStrangerCursors(row ? JSON.parse(String(row['value'])) as StrangerSyncCursors : undefined);
  }

  setStrangerSyncCursors(cursors: StrangerSyncCursors): void {
    const next = normalizeStrangerCursors(cursors);
    this.database.prepare(`
      INSERT INTO state_meta (key, value) VALUES ('stranger_sync_cursors', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(next));
  }

  setFrontierCursors(namespace: string, cursors: FrontierCursor[]): void {
    this.database.prepare(`
      INSERT INTO state_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(`frontier:${namespace}`, JSON.stringify(cursors));
  }

  private deleteConversationRows(conversationId: string): void {
    this.summaries.forget(conversationId);
    this.database.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(conversationId);
    this.database.prepare('DELETE FROM read_cursors WHERE conversation_id = ?').run(conversationId);
    this.database.prepare('DELETE FROM conversations WHERE conversation_id = ?').run(conversationId);
    this.database.prepare('DELETE FROM group_members WHERE group_id = ?').run(conversationId);
    this.database.prepare('DELETE FROM member_snapshots WHERE group_id = ?').run(conversationId);
    this.database.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    this.database.prepare('DELETE FROM message_read_privacy WHERE conversation_id = ?').run(conversationId);
  }

  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function createImStateStore(options: ImStateStoreOptions): ImStateStore {
  const maxMessages = validateLimit(options.maxMessagesPerConversation, DEFAULT_MESSAGE_LIMIT);
  return options.backend === 'json'
    ? new JsonImStateStore(options.accountDir, maxMessages, options.floatHintConfig, options.userId)
    : new SqliteImStateStore(options.accountDir, maxMessages, options.floatHintConfig, options.userId);
}
