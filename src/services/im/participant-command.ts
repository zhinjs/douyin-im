import { parseJsonWithBigInts, readJsonInteger } from '../../http/lossless-json.js';

export interface ParticipantCommand {
  conversationId: string;
  conversationType: number;
  inboxType: number;
  added: string[];
  modified: string[];
  removed: string[];
}

/** CommandMessage::from_json / command7; retain integer bits and duplicate UID order. */
export function participantCommand(messageType: number, content: string): ParticipantCommand | undefined {
  if (messageType !== 50001 || readJsonInteger(content, 'command_type', 32) !== 7n) return undefined;
  const body = parseJsonWithBigInts(content) as Record<string, unknown>;
  const conversationId = body['conversation_id'];
  const conversationType = readJsonInteger(content, 'conversation_type', 32);
  const inboxType = readJsonInteger(content, 'inbox_type', 32);
  if (typeof conversationId !== 'string' || !conversationId || conversationType === undefined || inboxType === undefined) return undefined;
  const list = (key: string): string[] | undefined => {
    const value = body[key];
    if (!Array.isArray(value)) return [];
    // Intentional safety boundary: native truncates floats; SDK refuses lossy UID tokens.
    if (value.some(uid => typeof uid !== 'bigint')) return undefined;
    return value.map(uid => String(BigInt.asIntN(64, uid as bigint)));
  };
  const added = list('added_participant');
  const modified = list('modified_participant');
  const removed = list('removed_participant');
  if (!added || !modified || !removed) return undefined;
  return { conversationId, conversationType: Number(conversationType), inboxType: Number(inboxType), added, modified, removed };
}

/** Native safeStoll @2830c4 calls strtoll(base10), without checking errno/endptr. */
export function participantDecimalId(value: string): string {
  const prefix = value.match(/^[ \t\n\r\f\v]*[+-]?\d+/)?.[0];
  if (!prefix) return '0';
  const integer = BigInt(prefix.trim());
  return String(integer < -9223372036854775808n ? -9223372036854775808n
    : integer > 9223372036854775807n ? 9223372036854775807n : integer);
}
