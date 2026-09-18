import type { ConversationPropertyInfo, MessagePropertyItem, PrivateMessage } from './types.js';
import { parseJsonWithBigInts } from '../../http/lossless-json.js';
import { messageClientId } from './message-cache.js';

export const LATEST_MESSAGE_PROPERTY_KEY = 'a:s_latest_message_property';

function emptyProperty(): ConversationPropertyInfo {
  return { clientId: '', emoji: '', sender: '', createdAt: '0', markRead: false };
}

export function readConversationPropertyInfo(localExt?: Readonly<Record<string, string>>): ConversationPropertyInfo {
  try {
    const value = parseJsonWithBigInts(localExt?.[LATEST_MESSAGE_PROPERTY_KEY] ?? 'null');
    if (!object(value) || typeof value['clientId'] !== 'string' || typeof value['emoji'] !== 'string' ||
      typeof value['sender'] !== 'string' || typeof value['markRead'] !== 'boolean' || typeof value['createdAt'] !== 'bigint' ||
      value['createdAt'] < -9223372036854775808n || value['createdAt'] > 9223372036854775807n) return emptyProperty();
    return { clientId: value['clientId'], emoji: value['emoji'], sender: value['sender'], createdAt: String(value['createdAt']), markRead: value['markRead'] };
  } catch { return emptyProperty(); }
}

export function serializeConversationPropertyInfo(info: ConversationPropertyInfo): string {
  const { createdAt, ...rest } = info;
  return JSON.stringify(rest).slice(0, -1) + `,"createdAt":${BigInt(createdAt)}}`;
}

/** Native map-key order and stable list order decide same-second ties. Caller enforces self/visible/slot gates. */
export function latestMessageProperty(message: PrivateMessage, userId: string): ConversationPropertyInfo {
  const candidates: ConversationPropertyInfo[] = [];
  const keys = Object.keys(message.propertyList ?? {}).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const key of keys) {
    if (!key.startsWith('se:')) continue;
    for (const item of message.propertyList![key]!) {
      if (item.uid === userId) continue;
      candidates.push({ clientId: messageClientId(message), emoji: key.slice(3), sender: item.uid, createdAt: item.createTime, markRead: false });
    }
  }
  candidates.sort((a, b) => BigInt(a.createdAt) > BigInt(b.createdAt) ? -1 : BigInt(a.createdAt) < BigInt(b.createdAt) ? 1 : 0);
  return candidates[0] ?? emptyProperty();
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** MessageBody field 15: map values wrap the capitalized repeated PropertyItemList.Items field. */
export function mapMessageProperties(value: unknown): Readonly<Record<string, readonly MessagePropertyItem[]>> | undefined {
  if (!object(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, list]) => {
    const items = object(list) && Array.isArray(list['Items']) ? list['Items'] : [];
    return [key, items.filter(object).map(item => ({ uid: String(item['uid'] ?? '0'),
      secUid: String(item['secUid'] ?? ''), createTime: String(item['createTime'] ?? '0'),
      idempotentId: String(item['idempotentId'] ?? ''), value: String(item['value'] ?? '') }))];
  }));
}
