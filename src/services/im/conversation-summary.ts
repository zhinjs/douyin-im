import { readJsonInteger } from '../../http/lossless-json.js';
import { messageClientId } from './message-cache.js';
import { isDesktopMessageVisible } from './message-display.js';
import { calculateDesktopSortOrder, desktopCellSortTime, isDesktopFloatMessage } from './conversation-float.js';
import { latestMessageProperty, LATEST_MESSAGE_PROPERTY_KEY, readConversationPropertyInfo, serializeConversationPropertyInfo } from './message-property.js';
import type { ImConversation, PrivateMessage } from './types.js';
import type { MessageFloatHintConfig } from '../../desktop/settings.js';

/** Local derived fields, separate from network DTOs; message bodies remain in the message store. */
export interface ConversationSummaryRecord {
  lastMessageIndex: string;
  lastClientId: string;
  hintClientId: string;
  lastMessageTime?: number;
  sortOrder?: string;
  maxIndex?: string;
  maxOrder?: string;
  localExt?: Readonly<Record<string, string>>;
}

interface Summary extends ConversationSummaryRecord {
  lastMessageTime: number;
  sortOrder: string;
  maxIndex: string;
  maxOrder: string;
  localExt: Readonly<Record<string, string>>;
  last?: PrivateMessage | undefined;
  hint?: PrivateMessage | undefined;
  property?: PrivateMessage | undefined;
}

interface SummaryStorage {
  conversation(id: string): ImConversation | undefined;
  load(id: string): ConversationSummaryRecord | undefined;
  save(id: string, summary: ConversationSummaryRecord): void;
  /** Return only after the localExt-only write is committed; preserve stored selectors. */
  commitLocalExt(id: string, localExt: Readonly<Record<string, string>>): void;
  messages(id: string): readonly PrivateMessage[];
}

/** Missing configuration is the native disabled default, not proof that remote settings disable it. */
export function isDesktopHintMessage(message: PrivateMessage, config?: MessageFloatHintConfig): boolean {
  if (!config?.enable) return true;
  const excluded = config.notHintMessages[message.msgType];
  const aweType = Number(readJsonInteger(message.content, 'aweType', 32) ?? -1n);
  return !excluded?.includes(aweType);
}

function order(message: PrivateMessage): bigint {
  // Never synthesize native order_index from createTime or either conversation index.
  return BigInt(message.orderIndex ?? message.orderInConversation ?? '0');
}

function record(summary: Summary): ConversationSummaryRecord {
  return { lastMessageIndex: summary.lastMessageIndex, lastClientId: summary.lastClientId, hintClientId: summary.hintClientId,
    lastMessageTime: summary.lastMessageTime, sortOrder: summary.sortOrder, maxIndex: summary.maxIndex, maxOrder: summary.maxOrder,
    localExt: structuredClone(summary.localExt) };
}

function setLast(summary: Summary, message?: PrivateMessage): void {
  summary.last = message && structuredClone(message);
  summary.lastClientId = message ? messageClientId(message) : '';
  summary.lastMessageIndex = message?.indexInConversation ?? '0';
}

function setHint(summary: Summary, message?: PrivateMessage): void {
  summary.hint = message && structuredClone(message);
  summary.hintClientId = message ? messageClientId(message) : '';
}

/**
 * Native last/hint selection and its cache-vs-DB boundary, shared by JSON and SQLite.
 * Includes ordinary incoming-message float/order/property updates, not unread/contact state machines.
 */
export class ConversationSummaryCache {
  private readonly cache = new Map<string, Summary>();
  private readonly floatHintConfig: MessageFloatHintConfig | undefined;

  constructor(private readonly storage: SummaryStorage, floatHintConfig?: MessageFloatHintConfig, private readonly userId = '') {
    this.floatHintConfig = floatHintConfig && structuredClone(floatHintConfig);
  }

  private get(id: string): Summary | undefined {
    const conversation = this.storage.conversation(id);
    if (!conversation) return undefined;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const saved = this.storage.load(id);
    const summary: Summary = { lastMessageIndex: '0', lastClientId: '', hintClientId: '', ...saved,
      lastMessageTime: saved?.lastMessageTime ?? conversation.lastMessageTime,
      sortOrder: saved?.sortOrder ?? conversation.sortOrder ?? '0',
      maxIndex: saved?.maxIndex ?? conversation.maxIndex ?? '0', maxOrder: saved?.maxOrder ?? conversation.maxOrder ?? '0',
      localExt: structuredClone(saved?.localExt ?? conversation.localExt ?? {}) };
    if (saved) {
      const messages = this.storage.messages(id).filter(message => !message.deleted);
      summary.last = saved.lastClientId ? messages.find(message => messageClientId(message) === saved.lastClientId) : undefined;
      summary.hint = saved.hintClientId ? messages.find(message => messageClientId(message) === saved.hintClientId) : undefined;
      const propertyId = readConversationPropertyInfo(summary.localExt).clientId;
      summary.property = propertyId ? messages.find(message => messageClientId(message) === propertyId) : undefined;
    }
    this.cache.set(id, summary);
    return summary;
  }

  /** Capture live pointers before the underlying message row is deleted/replaced. */
  prepare(id: string): void { this.get(id); }

  forget(id: string): void { this.cache.delete(id); }

  /** A full server merge recalculates order, then persists the current conversation, including live selectors. */
  saveMerged(id: string): void {
    const conversation = this.storage.conversation(id);
    if (!conversation) return;
    const saved = this.storage.load(id);
    const summary = this.cache.get(id) ?? (saved ? this.get(id) : undefined);
    if (!summary) return;
    calculateDesktopSortOrder(summary, 0, !!conversation.pinned, desktopCellSortTime(conversation.settingExt?.['a:cell_sort_time']));
    // Native mergeConversation ends with proxy.saveConversation(conv, true), unlike localExt-only writes.
    this.storage.save(id, record(summary));
  }

  /** Native updates only localExt: do not accidentally commit unsaved last/hint pointer changes. */
  markPropertyRead(id: string): boolean {
    if (!id) return false;
    const conversation = this.storage.conversation(id);
    if (!conversation) return false;
    const cached = this.cache.get(id);
    const saved = this.storage.load(id);
    const info = readConversationPropertyInfo(cached?.localExt ?? saved?.localExt ?? conversation.localExt);
    if (!info.clientId || info.markRead) return false;
    const summary = cached ?? this.get(id)!;
    const localExt = { ...summary.localExt, [LATEST_MESSAGE_PROPERTY_KEY]: serializeConversationPropertyInfo({ ...info, markRead: true }) };
    this.storage.commitLocalExt(id, localExt);
    summary.localExt = localExt;
    return true;
  }

  project(conversation: ImConversation): ImConversation {
    // A network-only DTO remains a network-only DTO until a summary actually exists.
    const summary = this.cache.get(conversation.conversationId) ??
      (this.storage.load(conversation.conversationId) ? this.get(conversation.conversationId) : undefined);
    if (!summary) return conversation;
    const project = (message?: PrivateMessage): PrivateMessage | null =>
      message && messageClientId(message) && message.content ? structuredClone(message) : null;
    return { ...conversation, lastMessageIndex: summary.lastMessageIndex,
      lastMessageTime: summary.lastMessageTime, sortOrder: summary.sortOrder, maxIndex: summary.maxIndex, maxOrder: summary.maxOrder,
      localExt: structuredClone(summary.localExt), propertyInfo: readConversationPropertyInfo(summary.localExt), propertyMessage: project(summary.property),
      lastMessage: project(summary.last), hintMessage: project(summary.hint) };
  }

  /** Native DB-backed query hydration uses stored client IDs first and at most 20 repair pages. */
  query(conversation: ImConversation): ImConversation {
    const id = conversation.conversationId;
    const saved = this.storage.load(id);
    const summary: Summary = { lastMessageIndex: conversation.lastMessageIndex ?? '0', lastClientId: '', hintClientId: '', ...saved,
      lastMessageTime: saved?.lastMessageTime ?? conversation.lastMessageTime,
      sortOrder: conversation.sortOrder ?? '0',
      maxIndex: saved?.maxIndex ?? conversation.maxIndex ?? '0', maxOrder: saved?.maxOrder ?? conversation.maxOrder ?? '0',
      localExt: structuredClone(saved?.localExt ?? conversation.localExt ?? {}) };
    const all = this.storage.messages(id);
    if (BigInt(summary.maxIndex) < 0n || BigInt(summary.maxOrder) < 0n) {
      // Native SQL MAX includes soft-deleted rows. An empty aggregate maps NULL to zero.
      const max = (read: (message: PrivateMessage) => bigint): bigint => all.length
        ? all.reduce((value, message) => read(message) > value ? read(message) : value, read(all[0]!)) : 0n;
      const index = max(message => BigInt(message.indexInConversation ?? '0'));
      const orderIndex = max(order);
      const changed = index > BigInt(summary.maxIndex) || orderIndex > BigInt(summary.maxOrder);
      if (index > BigInt(summary.maxIndex)) summary.maxIndex = String(index);
      if (orderIndex > BigInt(summary.maxOrder)) summary.maxOrder = String(orderIndex);
      if (changed) this.storage.save(id, record(summary));
    }
    const rows = all.filter(message => !message.deleted);
    const last = summary.lastClientId ? rows.find(message => messageClientId(message) === summary.lastClientId) : undefined;
    const hint = summary.hintClientId ? rows.find(message => messageClientId(message) === summary.hintClientId) : undefined;
    if (last) setLast(summary, last); // Direct hits do not re-run visibility/hint filters.
    if (hint) setHint(summary, hint);
    const propertyId = readConversationPropertyInfo(summary.localExt).clientId;
    if (propertyId) summary.property = rows.find(message => messageClientId(message) === propertyId);
    if (!summary.last || !summary.hint) this.recalculate(id, summary, 20);
    this.cache.set(id, summary); // Native ends by replacing the cache without forcing a DB save.
    return this.project(conversation);
  }

  saved(message: PrivateMessage): void {
    const id = message.threadId;
    const summary = this.get(id);
    if (!summary) return;
    if (message.ext?.['s:is_recalled'] === 'true') { this.removed(id, messageClientId(message)); return; }
    if (!summary.last || !summary.hint) { this.recalculate(id, summary); return; }
    if (!isDesktopMessageVisible(message)) return;
    let changed = false;
    const index = BigInt(message.indexInConversation ?? '0');
    if (index > BigInt(summary.maxIndex)) { summary.maxIndex = String(index); changed = true; }
    if (order(message) > BigInt(summary.maxOrder)) { summary.maxOrder = String(order(message)); changed = true; }
    if (order(message) >= order(summary.last)) { setLast(summary, message); changed = true; }
    if (order(message) >= order(summary.hint) && isDesktopHintMessage(message, this.floatHintConfig)) {
      setHint(summary, message); changed = true;
    }
    if (message.createTime > summary.lastMessageTime && isDesktopFloatMessage(message, this.userId, this.floatHintConfig)) {
      const conversation = this.storage.conversation(id)!;
      const rawCellTime = conversation.settingExt?.['a:cell_sort_time'];
      const cellTime = desktopCellSortTime(rawCellTime);
      calculateDesktopSortOrder(summary, message.createTime, !!conversation.pinned, cellTime);
      changed = true; // Native caller saves even if calculate rejects the timestamp or sort is unchanged.
    }
    changed = this.updateProperty(id, summary, message) || changed;
    // Incremental setters trigger a save even when the IDs did not change.
    if (changed) this.storage.save(id, record(summary));
  }

  /** True means last/hint was hit, not that DB columns changed or a replacement was found. */
  removed(id: string, clientId: string): boolean {
    if (!id || !clientId) return false;
    const summary = this.get(id);
    if (!summary) return false;
    let hit = false;
    if (summary.lastClientId === clientId) { setLast(summary); hit = true; }
    if (summary.hintClientId === clientId) { setHint(summary); hit = true; }
    if (readConversationPropertyInfo(summary.localExt).clientId === clientId) summary.property = undefined;
    if (hit) this.recalculate(id, summary);
    return hit;
  }

  private updateProperty(id: string, summary: Summary, message: PrivateMessage): boolean {
    // Native non-self return-register value is ambiguous; deterministic false with the proven no-mutation behavior.
    if (!this.userId || message.senderUid !== this.userId) return false;
    const previous = readConversationPropertyInfo(summary.localExt);
    const next = latestMessageProperty(message, this.userId);
    const newer = BigInt(next.createdAt) > BigInt(previous.createdAt) &&
      BigInt(next.createdAt) > BigInt(Math.trunc(summary.hint!.createTime / 1000));
    const cancelled = previous.clientId === messageClientId(message) && BigInt(next.createdAt) < BigInt(previous.createdAt);
    if (newer || cancelled) {
      summary.localExt = { ...summary.localExt, [LATEST_MESSAGE_PROPERTY_KEY]: serializeConversationPropertyInfo(next) };
      summary.property = newer || next.clientId ? structuredClone(message) : undefined;
      if (newer) {
        const conversation = this.storage.conversation(id)!;
        const timestamp = BigInt.asIntN(64, BigInt(next.createdAt) * 1000n);
        // Reject non-safe JS timestamps rather than silently round native int64 milliseconds.
        if (timestamp >= BigInt(Number.MIN_SAFE_INTEGER) && timestamp <= BigInt(Number.MAX_SAFE_INTEGER)) {
          calculateDesktopSortOrder(summary, Number(timestamp), !!conversation.pinned, desktopCellSortTime(conversation.settingExt?.['a:cell_sort_time']));
        }
      }
      return true;
    }
    if (previous.clientId !== messageClientId(message)) return false;
    summary.property = structuredClone(message);
    return true;
  }

  private recalculate(id: string, summary: Summary, maxPages = 10): void {
    let cursor = 9223372036854775807n;
    const rows = this.storage.messages(id).filter(message => !message.deleted)
      .sort((a, b) => order(a) > order(b) ? -1 : order(a) < order(b) ? 1 : 0);
    for (let page = 0; page < maxPages && (!summary.last || !summary.hint) && cursor > 0n; page++) {
      // Native LIMIT precedes map deduplication and visibility/hint filtering.
      const candidates = rows.filter(message => order(message) < cursor).slice(0, 200);
      const byOrder = new Map(candidates.map(message => [order(message), message]));
      if (!byOrder.size) break; // Empty page does not clear or save.
      const before = record(summary);
      let last: PrivateMessage | undefined;
      let hint: PrivateMessage | undefined;
      for (const message of byOrder.values()) {
        if (!isDesktopMessageVisible(message)) continue;
        last ??= message;
        if (isDesktopHintMessage(message, this.floatHintConfig)) { hint = message; break; }
      }
      // Each native page starts fresh, even if a prior page had a last but no hint.
      setLast(summary, last); setHint(summary, hint);
      const after = record(summary);
      if (before.lastMessageIndex !== after.lastMessageIndex || before.lastClientId !== after.lastClientId || before.hintClientId !== after.hintClientId) {
        this.storage.save(id, after);
      }
      cursor = [...byOrder.keys()].at(-1)!;
    }
  }
}
