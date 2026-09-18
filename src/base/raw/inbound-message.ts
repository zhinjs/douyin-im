import type { ImPushMessage } from '../../services/im/ws-client.js';
import type { MessageReferenceInfo, MessagePropertyItem, PrivateMessage, PrivateThread } from '../../services/im/types.js';

/**
 * 入站消息 DTO —— 由 Receiver（传输层）产出，不含任何发送能力。
 * 在 Account/Bot 边界转换为带 reply() 的 MessageEvent。
 */
export interface RawInboundMessage {
  readonly inboxType?: number;
  readonly threadId: string;
  readonly conversationShortId: string;
  readonly conversationType: number;
  readonly senderUid: string;
  readonly senderSecUid?: string;
  readonly serverMessageId?: string;
  readonly clientMessageId?: string;
  readonly indexInConversation?: string;
  readonly indexInConversationV2?: string;
  readonly createTime?: string;
  readonly status?: number;
  readonly version?: string;
  readonly orderInConversation?: string;
  readonly ext?: Readonly<Record<string, string>>;
  readonly referenceInfo?: MessageReferenceInfo;
  readonly propertyList?: Readonly<Record<string, readonly MessagePropertyItem[]>>;
  readonly text: string;
  readonly rawContent: string;
  readonly messageType: number;
  readonly raw: Record<string, unknown>;
}

export function inboundFromPush(push: ImPushMessage): RawInboundMessage | null {
  if (!push.conversationId || !push.senderUid) return null;
  return {
    threadId: push.conversationId,
    ...(push.inboxType !== undefined ? { inboxType: push.inboxType } : {}),
    conversationShortId: push.conversationShortId,
    conversationType: push.conversationType,
    senderUid: push.senderUid,
    ...(push.senderSecUid ? { senderSecUid: push.senderSecUid } : {}),
    ...(push.serverMessageId ? { serverMessageId: push.serverMessageId } : {}),
    ...(push.clientMessageId ? { clientMessageId: push.clientMessageId } : {}),
    ...(push.indexInConversation ? { indexInConversation: push.indexInConversation } : {}),
    ...(push.indexInConversationV2 ? { indexInConversationV2: push.indexInConversationV2 } : {}),
    ...(push.createTime ? { createTime: push.createTime } : {}),
    ...(push.status !== undefined ? { status: push.status } : {}),
    ...(push.version ? { version: push.version } : {}),
    ...(push.orderInConversation ? { orderInConversation: push.orderInConversation } : {}),
    ...(push.ext ? { ext: push.ext } : {}),
    ...(push.referenceInfo ? { referenceInfo: push.referenceInfo } : {}),
    ...(push.propertyList ? { propertyList: push.propertyList } : {}),
    text: extractText(push.content),
    rawContent: push.content,
    messageType: push.messageType,
    raw: push.raw,
  };
}

export function inboundFromThread(
  thread: PrivateThread,
  message: PrivateMessage,
  inboxType?: number,
): RawInboundMessage | null {
  return mappedMessageInbound(message, thread, inboxType);
}

/** A grouped sync message keeps its own identity, not the outer conversation's identity. */
export function inboundFromMessage(message: PrivateMessage): RawInboundMessage | null {
  if (!message.threadId) return null;
  return mappedMessageInbound(message, message, message.inboxType);
}

function mappedMessageInbound(
  message: PrivateMessage,
  thread: Pick<PrivateThread, 'threadId' | 'conversationShortId' | 'conversationType'>,
  inboxType?: number,
): RawInboundMessage | null {
  if (!message.senderUid) return null;
  return {
    threadId: thread.threadId,
    ...(inboxType !== undefined ? { inboxType } : {}),
    conversationShortId: thread.conversationShortId ?? '',
    conversationType: thread.conversationType ?? 1,
    senderUid: message.senderUid,
    ...(message.senderSecUid ? { senderSecUid: message.senderSecUid } : {}),
    ...(message.msgId ? { serverMessageId: message.msgId } : {}),
    ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    ...(message.indexInConversation ? { indexInConversation: message.indexInConversation } : {}),
    ...(message.indexInConversationV2 ? { indexInConversationV2: message.indexInConversationV2 } : {}),
    ...(message.createTime ? { createTime: String(message.createTime) } : {}),
    status: message.status,
    ...(message.version ? { version: message.version } : {}),
    ...(message.orderInConversation ? { orderInConversation: message.orderInConversation } : {}),
    ...(message.ext ? { ext: message.ext } : {}),
    ...(message.referenceInfo ? { referenceInfo: message.referenceInfo } : {}),
    ...(message.propertyList ? { propertyList: message.propertyList } : {}),
    text: extractText(message.content),
    rawContent: message.content,
    messageType: message.msgType,
    raw: message as unknown as Record<string, unknown>,
  };
}

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed?.text ?? content;
  } catch {
    return content;
  }
}
