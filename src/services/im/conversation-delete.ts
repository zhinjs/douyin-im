import type { ImConversation, PrivateMessage } from './types.js';
import { readJsonInteger } from '../../http/lossless-json.js';

/** Native DeleteConv commands use the body identity and signed indexV1, not the outer message index. */
export function conversationDeletionCommand(messageType: number, content: string): {
  conversationId: string; lastMessageIndex: string;
} | undefined {
  if (messageType !== 50001) return undefined;
  const type = readJsonInteger(content, 'command_type', 32);
  if (type !== 3n && type !== 620n && type !== 1010n) return undefined;
  const body = JSON.parse(content) as Record<string, unknown>;
  const index = readJsonInteger(content, 'last_message_index', 64);
  // Reject missing/malformed fields safely rather than reproducing native's unchecked JSON lookup.
  if (typeof body['conversation_id'] !== 'string' || !body['conversation_id'] || index === undefined) return undefined;
  return { conversationId: body['conversation_id'], lastMessageIndex: String(index) };
}

/** DB-backed Desktop delete boundary uses indexV1, including retained soft-deleted rows. */
export function signedMessageIndex(value: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new TypeError('Invalid conversation deletion index');
  const index = BigInt(value);
  if (index < -9223372036854775808n || index > 9223372036854775807n) throw new RangeError('Conversation deletion index exceeds int64');
  return index;
}

export function maxStoredMessageIndex(messages: readonly PrivateMessage[]): string {
  let max: bigint | undefined;
  for (const message of messages) {
    const index = signedMessageIndex(message.indexInConversation ?? '0');
    if (max === undefined || index > max) max = index;
  }
  // SQL MAX on an empty set yields NULL, read as zero by sqlite3_column_int64.
  return String(max ?? 0n);
}

/** ResourceManager::deleteConversation @56d238; this is not an unconditional clear. */
export function conversationDeletionPlan(conversation: ImConversation, boundary: string): {
  minIndex: string;
  deleteConversation: boolean;
  deleteAllMessages: boolean;
} {
  const requested = signedMessageIndex(boundary);
  const minimum = signedMessageIndex(conversation.minIndex ?? '0');
  if (minimum >= requested) return { minIndex: String(minimum), deleteConversation: true, deleteAllMessages: false };
  const deleteAllMessages = signedMessageIndex(conversation.lastMessageIndex ?? '0') <= requested;
  return { minIndex: String(requested), deleteConversation: deleteAllMessages, deleteAllMessages };
}
