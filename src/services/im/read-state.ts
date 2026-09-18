import protobuf from 'protobufjs';
import { desktopCookieProtoOptions } from './desktop.js';
import type { ImProtoTransport } from './transport.js';
import type { ConversationAddressOptions, GroupMemberData, ImActionResponse, PrivateMessage } from './types.js';

/** Raw native aggregate, BEFORE renderer privacy filtering; not a complete live reader census. */
export interface ConversationReadSummary {
  conversationId: string;
  conversationShortId: string;
  conversationType: number;
  clientMessageId: string;
  serverMessageId: string;
  createTime: string;
  readUsers: { uid: string; secUid: string; readIndex: string; minIndex: string }[];
  isAllRead: boolean;
}

/** Native equality sorts copies by signed UID; output order is not part of the change contract. */
export function equalConversationReadSummaries(left: ConversationReadSummary, right: ConversationReadSummary): boolean {
  if (left.conversationId !== right.conversationId || left.conversationShortId !== right.conversationShortId ||
      left.conversationType !== right.conversationType || left.clientMessageId !== right.clientMessageId ||
      left.serverMessageId !== right.serverMessageId || left.createTime !== right.createTime || left.isAllRead !== right.isAllRead ||
      left.readUsers.length !== right.readUsers.length) return false;
  const sorted = (rows: ConversationReadSummary['readUsers']) => [...rows].sort((a, b) => BigInt(a.uid) > BigInt(b.uid) ? -1 : BigInt(a.uid) < BigInt(b.uid) ? 1 : 0);
  const a = sorted(left.readUsers), b = sorted(right.readUsers);
  return a.every((row, i) => row.uid === b[i]!.uid && row.secUid === b[i]!.secUid &&
    row.readIndex === b[i]!.readIndex && row.minIndex === b[i]!.minIndex);
}

/** MsgDbHelper.getLastSendMessage's filters/order; no display, positive-ID or local send-stage gate. */
export function selectLastSentMessage(messages: readonly PrivateMessage[], conversationId: string, selfUid: string): PrivateMessage | undefined {
  let selected: PrivateMessage | undefined;
  for (const message of messages) {
    if (message.threadId !== conversationId || message.senderUid !== selfUid || message.status !== 0 ||
        message.deleted || message.ext?.['s:is_recalled'] === 'true' || [1, 1001, 1002, 1010].includes(message.msgType)) continue;
    if (!Number.isSafeInteger(message.createTime)) throw new Error('cached message createTime is not an exact integer');
    const order = BigInt(int64(message.orderIndex ?? message.orderInConversation ?? '0'));
    const previousOrder = selected && BigInt(int64(selected.orderIndex ?? selected.orderInConversation ?? '0'));
    if (!selected || order > previousOrder! || (order === previousOrder && message.createTime > selected.createTime)) selected = message;
  }
  return selected;
}

/** The caller supplies retained non-deleted participants; missing cursor rows never enter the join. */
export function calculateConversationReadSummary(conversationId: string, message: PrivateMessage, selfUid: string,
  participants: readonly GroupMemberData[], cursors: readonly StoredReadCursor[]): ConversationReadSummary {
  validateStoredReadCursors(cursors);
  if (!Number.isSafeInteger(message.createTime)) throw new Error('cached message createTime is not an exact integer');
  const index = BigInt(int64(message.indexInConversation ?? '0'));
  const members = new Map(participants.map(member => [member.uid, member]));
  const readUsers: ConversationReadSummary['readUsers'] = [];
  let eligible = 0;
  for (const cursor of cursors) {
    const member = members.get(cursor.uid);
    if (!member || cursor.uid === selfUid) continue;
    const minimum = BigInt(cursor.minIndex);
    // ARM64 cneg keeps INT64_MIN negative, followed by a signed comparison.
    if (BigInt.asIntN(64, minimum < 0n ? -minimum : minimum) > index) continue;
    eligible++;
    const visible = message.ext?.['s:visible'];
    const invisible = visible ? !visible.split(',').includes(cursor.uid) : !!message.ext?.['s:invisible']?.split(',').includes(cursor.uid);
    if (index <= BigInt(cursor.readIndex) && !invisible) {
      readUsers.push({ uid: cursor.uid, readIndex: cursor.readIndex, minIndex: cursor.minIndex, secUid: member.secUid ?? '' });
    }
  }
  return { conversationId, conversationShortId: message.conversationShortId ?? '0', conversationType: message.conversationType ?? 0,
    clientMessageId: message.ext?.['s:client_message_id'] ?? '', serverMessageId: message.msgId, createTime: String(message.createTime),
    readUsers, isAllRead: readUsers.length > 0 && readUsers.length === eligible };
}

/** 原始读游标；缺失字段保持缺失，不能拿 undefined 当作 0 覆盖本地状态。 */
export interface ParticipantReadCursor {
  uid: string;
  secUid?: string;
  index?: string;
  indexV2?: string;
  minIndex?: string;
}

export interface ParticipantMinCursor {
  uid: string;
  secUid?: string;
  index?: string;
  indexV2?: string;
}

/** Native READINDEX 保存的两列；不是成员列表或已读展示结果。 */
export interface StoredReadCursor { uid: string; readIndex: string; minIndex: string }

export function validateStoredReadCursors(rows: readonly StoredReadCursor[]): void {
  for (const row of rows) { int64(row.uid, true); int64(row.readIndex); int64(row.minIndex); }
}

/** HTTP 保存使用普通 index，忽略 read response 的 index_min/index_v2；缺省沿用 protobuf 的 0。 */
export function mergeReadCursorState(current: readonly StoredReadCursor[], response: ConversationReadStateResponse): StoredReadCursor[] {
  const rows = new Map(current.map(row => [row.uid, { ...row }]));
  for (const row of response.readIndexes) {
    const previous = rows.get(row.uid) ?? { uid: row.uid, readIndex: '0', minIndex: '0' };
    rows.set(row.uid, { ...previous, readIndex: row.index ?? '0' });
  }
  for (const row of response.minIndexes) {
    const previous = rows.get(row.uid) ?? { uid: row.uid, readIndex: '0', minIndex: '0' };
    rows.set(row.uid, { ...previous, minIndex: row.index ?? '0' });
  }
  const result = [...rows.values()];
  validateStoredReadCursors(result);
  return result;
}

/** RapidJSON 的整数槽与 JSON 字符串不同；保留整数 token 类型，避免 UID 经过 Number。 */
export function readIndexFromP2PContent(content: string): { uid: string; index: string } | undefined {
  try {
    const original: unknown = JSON.parse(content);
    const canonical = JSON.stringify(original);
    let prefix = '__desktop_integer__';
    while (canonical.includes(prefix)) prefix += '_';
    const data: unknown = JSON.parse(content.replace(
      /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      token => /^-?\d+$/.test(token) ? JSON.stringify(prefix + token) : token,
    ), (_key, value: unknown) => typeof value === 'string' && value.startsWith(prefix) ? BigInt(value.slice(prefix.length)) : value);
    const payload = record(data);
    const sender = payload['P2PSender'];
    if (typeof sender !== 'bigint' || sender <= 0n || sender > MAX_I64) return undefined;
    const rawIndex = payload['P2PSenderReadIndex'];
    const index = typeof rawIndex === 'bigint' && rawIndex >= MIN_I64 && rawIndex <= MAX_I64 ? rawIndex : 0n;
    return { uid: sender.toString(), index: index.toString() };
  } catch { return undefined; }
}

export interface ReadCursorsResponse extends ImActionResponse { indexes: ParticipantReadCursor[] }
export interface MinCursorsResponse extends ImActionResponse { indexes: ParticipantMinCursor[] }
export interface ConversationReadStateResponse extends ImActionResponse {
  readIndexes: ParticipantReadCursor[];
  minIndexes: ParticipantMinCursor[];
}
export interface BatchReadCursorsResponse extends ImActionResponse {
  conversations: { conversationId: string; conversationShortId: string; indexes: ParticipantReadCursor[] }[];
  /** 未出现在成功批响应中的会话，不代表其读者列表为空。 */
  missingConversationIds: string[];
}

const LONG = protobuf.util.Long as unknown as { fromString(value: string): unknown };
const MAX_I64 = 9223372036854775807n;
const MIN_I64 = -9223372036854775808n;

function int64(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value)) throw new Error('invalid int64');
  const n = BigInt(value);
  if (n < MIN_I64 || n > MAX_I64 || (positive && n <= 0n)) throw new Error('invalid int64 range');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body');
  return value as Record<string, unknown>;
}

function address(options: ConversationAddressOptions): Record<string, unknown> {
  if (typeof options.threadId !== 'string' || !options.threadId || ![1, 2].includes(options.conversationType)) {
    throw new Error('读游标查询需要有效的会话地址');
  }
  return { conversationId: options.threadId,
    conversationShortId: LONG.fromString(int64(options.conversationShortId, true)),
    conversationType: options.conversationType };
}

function cursors(value: unknown, includeMin: boolean): ParticipantReadCursor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('invalid indexes');
  const seen = new Set<string>();
  return value.map(item => {
    const raw = record(item);
    const uid = int64(raw['userId'], true);
    if (seen.has(uid)) throw new Error('duplicate participant');
    seen.add(uid);
    const row: ParticipantReadCursor = { uid };
    if (raw['secUid'] !== undefined) {
      if (typeof raw['secUid'] !== 'string') throw new Error('invalid secUid');
      row.secUid = raw['secUid'];
    }
    if (raw['index'] !== undefined) row.index = int64(raw['index']);
    if (raw['indexV2'] !== undefined) row.indexV2 = int64(raw['indexV2']);
    if (includeMin && raw['indexMin'] !== undefined) row.minIndex = int64(raw['indexMin']);
    return row;
  });
}

function envelope(decoded: Record<string, unknown>): ImActionResponse {
  return { statusCode: Number(decoded['statusCode'] ?? 0), statusMsg: String(decoded['errorDesc'] ?? '') };
}

/** Native GroupMemberNetwork 的查询合同；本项目保持 HTTP-only，不模拟 native 的 WS-first 调度。 */
export class ImReadStateApi {
  constructor(private readonly transport: ImProtoTransport, private readonly deviceId: string) {}

  getReadIndexes(options: ConversationAddressOptions): Promise<ReadCursorsResponse> {
    return this.query(options, 2000, 'participantsReadIndexBody', '/v3/conversation/get_read_index');
  }

  getMinIndexes(options: ConversationAddressOptions): Promise<MinCursorsResponse> {
    return this.query(options, 2001, 'participantsMinIndexBody', '/v3/conversation/get_min_index');
  }

  /** 两个独立快照，不是原子快照，也不是过滤隐私后的实际读者名单。 */
  async getState(options: ConversationAddressOptions): Promise<ConversationReadStateResponse> {
    const [read, min] = await Promise.all([this.getReadIndexes(options), this.getMinIndexes(options)]);
    if (read.statusCode !== 0 || min.statusCode !== 0) {
      const failure = read.statusCode !== 0 ? read : min;
      return { statusCode: failure.statusCode, statusMsg: failure.statusMsg, readIndexes: [], minIndexes: [] };
    }
    return { statusCode: 0, statusMsg: '', readIndexes: read.indexes, minIndexes: min.indexes };
  }

  async getBatchReadIndexes(options: readonly ConversationAddressOptions[]): Promise<BatchReadCursorsResponse> {
    const requested = new Map<string, ConversationAddressOptions>();
    for (const item of options) {
      address(item);
      const prior = requested.get(item.threadId);
      if (prior && (prior.conversationShortId !== item.conversationShortId || prior.conversationType !== item.conversationType)) {
        throw new Error('同一会话存在冲突的读游标地址');
      }
      requested.set(item.threadId, { ...item });
    }
    const all = [...requested.values()];
    if (!all.length) return { statusCode: 0, statusMsg: '', conversations: [], missingConversationIds: [] };
    const decoded = await this.transport.sendCookieProto(2038, 1,
      '/v1/conversation/batch_get_conversation_participants_readindex', {
        batchGetConversationParticipantsReadindex: {
          conversationId: all.map(item => item.threadId),
          conversationShortId: all.map(item => LONG.fromString(item.conversationShortId)),
          requestFrom: 'impc-chat',
        },
      }, desktopCookieProtoOptions(this.deviceId));
    const status = envelope(decoded);
    const failed = (result: ImActionResponse): BatchReadCursorsResponse => ({ ...result, conversations: [], missingConversationIds: [...requested.keys()] });
    if (status.statusCode !== 0 && status.statusCode !== 200) return failed(status);
    try {
      const body = record(record(decoded['body'])['batchGetConversationParticipantsReadindex']);
      const items = body['conversationParticipantsReadIndex'] ?? [];
      if (!Array.isArray(items)) throw new Error('invalid conversations');
      const seen = new Set<string>();
      const conversations = items.map(item => {
        const raw = record(item);
        const id = raw['conversationId'];
        if (typeof id !== 'string' || !requested.has(id) || seen.has(id)) throw new Error('unexpected conversation');
        seen.add(id);
        const shortId = int64(raw['conversationShortId'], true);
        if (shortId !== requested.get(id)!.conversationShortId) throw new Error('mismatched conversation');
        return { conversationId: id, conversationShortId: shortId, indexes: cursors(raw['participantReadIndex'], true) };
      });
      return { ...status, statusCode: 0, conversations, missingConversationIds: [...requested.keys()].filter(id => !seen.has(id)) };
    } catch {
      return failed({ statusCode: -3, statusMsg: 'Desktop invalid batch read-index response' });
    }
  }

  private async query(options: ConversationAddressOptions, cmd: 2000 | 2001, key: string, path: string): Promise<ReadCursorsResponse> {
    const decoded = await this.transport.sendCookieProto(cmd, 1, path, { [key]: address(options) }, desktopCookieProtoOptions(this.deviceId));
    const status = envelope(decoded);
    if (status.statusCode !== 0 && status.statusCode !== 200) return { ...status, indexes: [] };
    try {
      const body = record(record(decoded['body'])[key]);
      // Native accepts both 0 and 200; the SDK action convention uses 0 for success.
      return { ...status, statusCode: 0, indexes: cursors(body['indexes'], cmd === 2000) };
    } catch {
      return { statusCode: -3, statusMsg: `Desktop invalid ${key} response`, indexes: [] };
    }
  }
}
