import type { PrivateMessage } from './types.js';

export type MessageCacheSource = 'server' | 'send-ack' | 'local-update';
export interface MessageCacheUpdate { message: PrivateMessage; isNew: boolean }

/** processNewMessage -> isNormalMsg; 40001 has its own recall handler. */
export function isOrdinaryMessageType(type: number): boolean {
  return type < 50000 && type !== 40001;
}

function messageKey(message: PrivateMessage): string | undefined {
  if (message.msgId && message.msgId !== '0') return `s:${message.msgId}`;
  if (message.clientMessageId) return `c:${message.clientMessageId}`;
  return undefined;
}

/** Native server MessageObj lowercases the ASCII UUID in s:client_message_id. */
export function normalizeClientId(id: string): string {
  return id.replace(/[A-Z]/g, character => character.toLowerCase());
}

export function messageClientId(message: PrivateMessage): string {
  return normalizeClientId(message.ext?.['s:client_message_id'] ?? message.clientMessageId ?? '');
}

function positiveOrder(value: string | undefined): boolean {
  if (!value || !/^[0-9]+$/.test(value)) return false;
  const order = BigInt(value);
  return order > 0n && order <= 9223372036854775807n;
}

/**
 * Ordinary server-message merge, not the native send-attempt state machine.
 * Inputs are account/conversation-scoped by the store; raw DTOs stay untouched.
 */
export function prepareMessageCacheWrite(
  incoming: PrivateMessage,
  source: MessageCacheSource,
  current: ReadonlyMap<string, PrivateMessage>,
): (MessageCacheUpdate & { key: string; removeKeys: string[] }) | undefined {
  if (source === 'server' && !isOrdinaryMessageType(incoming.msgType)) return undefined;
  const message = structuredClone(incoming);
  const id = messageClientId(message);
  if (id) message.clientMessageId = id;
  else delete message.clientMessageId;
  if (message.ext && Object.hasOwn(message.ext, 's:client_message_id')) {
    message.ext = { ...message.ext, 's:client_message_id': id };
  }
  const key = messageKey(message);
  if (!key || !message.threadId) return undefined;
  const matches = id ? [...current].filter(([, old]) => messageClientId(old) === id) : [];
  const visibleMatches = matches.filter(([, old]) => old.deleted !== true);
  // An ack lacks a MessageBody. It must not regress either identity of an existing message.
  if (source === 'send-ack' && (current.has(key) || matches.length > 0)) return undefined;
  if (source === 'local-update' && !current.has(key) && matches.length === 0) return undefined;
  // Native saveMessage writes deleted=0; deleted rows are not mergeLocalMsg candidates.
  delete message.deleted;
  if (source === 'server') {
    const old = visibleMatches[0]?.[1];
    // Keep the original wire order separately from the native effective database order.
    delete message.orderIndex;
    if (message.orderInConversation !== undefined) message.orderIndex = message.orderInConversation;
    if (old) {
      if (old.ext || message.ext) message.ext = { ...old.ext, ...message.ext };
      if (old.localExt || message.localExt) message.localExt = { ...old.localExt, ...message.localExt };
      if (!message.content && old.content) message.content = old.content;
      const previousOrder = old.orderIndex ?? old.orderInConversation;
      if (previousOrder !== undefined && positiveOrder(previousOrder)) message.orderIndex = previousOrder;
    }
  }
  return { key, message, isNew: (!current.has(key) || current.get(key)?.deleted === true) && visibleMatches.length === 0,
    removeKeys: matches.map(([oldKey]) => oldKey).filter(oldKey => oldKey !== key) };
}
