import { parseJsonWithBigInts, readJsonInteger } from '../../http/lossless-json.js';
import type { MessageFloatHintConfig } from '../../desktop/settings.js';
import type { PrivateMessage } from './types.js';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Native config allows first; the seven custom filters only override a config rejection. */
export function isDesktopFloatMessage(message: PrivateMessage, userId: string, config?: MessageFloatHintConfig): boolean {
  const aweType = Number(readJsonInteger(message.content, 'aweType', 32) ?? -1n);
  if (!config?.enable || !config.notFloatMessages?.[message.msgType]?.includes(aweType)) return true;
  let content: unknown;
  try { content = parseJsonWithBigInts(message.content); } catch { return false; }
  if (!object(content)) return false;
  if (message.msgType === 1 && aweType === 0) return content['tips'] === '创建成功，快邀请你的粉丝进群吧！';
  if (message.msgType !== 1001) return false;
  const passive = aweType === 100110 || aweType === 100140;
  if (!passive && ![100118, 100113, 100101, 100102].includes(aweType)) return false;
  const users = content[passive ? 'passive_users' : 'active_users'];
  if (!Array.isArray(users)) return false;
  for (const user of users) {
    if (!object(user)) continue;
    const uid = user['uid'];
    // Passive stops at the first object, even if uid is absent/string/float. Active skips those objects.
    if (typeof uid === 'bigint') return String(uid) === userId;
    if (passive) return false;
  }
  return false;
}

export interface ConversationOrder {
  lastMessageTime: number;
  sortOrder: string;
}

export const DESKTOP_PIN_OFFSET = 500000000000000;

/** safe_stoll(base=10) catches invalid_argument/out_of_range as zero; native multiplication wraps int64. */
export function desktopCellSortTime(value?: string): bigint {
  const prefix = value?.match(/^[ \t\n\r\f\v]*[+-]?\d+/)?.[0];
  if (!prefix) return 0n;
  const seconds = BigInt(prefix.trim());
  if (seconds < -9223372036854775808n || seconds > 9223372036854775807n) return 0n;
  return BigInt.asIntN(64, seconds * 1000n);
}

/** Pure order mutation only. Caller owns persistence, unread/contact updates and dispatch. */
export function calculateDesktopSortOrder(state: ConversationOrder, timestamp: number, pinned: boolean, cellSortTime: bigint): boolean {
  if (!Number.isSafeInteger(timestamp) || timestamp > DESKTOP_PIN_OFFSET) return false;
  state.lastMessageTime = Math.max(state.lastMessageTime, timestamp);
  const previous = state.sortOrder;
  const time = BigInt(state.lastMessageTime);
  state.sortOrder = String(pinned ? time + BigInt(DESKTOP_PIN_OFFSET) : time > cellSortTime ? time : cellSortTime);
  return state.sortOrder !== previous;
}
