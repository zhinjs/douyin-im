import crypto from 'crypto';
import protobuf from 'protobufjs';
import {
  normalizeDesktopTextMessageContent,
  parseSendMessageResponse,
} from './content.js';
import type { ImProtoTransport } from './transport.js';
import { desktopCookieProtoOptions } from './desktop.js';
import type {
  RecallMessageOptions,
  RecallMessageResponse,
  SendMessageOptions,
  SendMessageReference,
  SendMessageResponse,
} from './types.js';

function encodeReference(
  reference: SendMessageReference,
  long: { fromString(s: string): unknown },
): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    referencedMessageId: long.fromString(reference.referencedMessageId),
    hint: reference.hint,
  };
  if (reference.rootMessageId) {
    encoded['rootMessageId'] = long.fromString(reference.rootMessageId);
  }
  if (reference.rootMessageConvIndex) {
    encoded['rootMessageConvIndex'] = long.fromString(reference.rootMessageConvIndex);
  }
  return encoded;
}

/** 抖音聊天消息发送与撤回协议。 */
export class ImSendApi {
  constructor(
    private readonly transport: ImProtoTransport,
    private readonly deviceId = '',
  ) {}

  /** 抖音聊天 Cookie-authenticated HTTP protobuf 发送。 */
  async send(options: SendMessageOptions): Promise<SendMessageResponse> {
    const clientMsgId = crypto.randomUUID();
    const deviceId = this.deviceId;
    if (!deviceId) throw new Error('Cookie IM send requires deviceId');
    const timestamp = Date.now();
    const long = protobuf.util.Long as unknown as { fromString(s: string): unknown };
    const decoded = await this.transport.sendCookieProto(
      100,
      options.inboxType ?? 0,
      '/v1/message/send',
      {
        sendMessageBody: {
          conversationId: options.threadId,
          conversationType: options.conversationType ?? 1,
          conversationShortId: long.fromString(options.conversationShortId || '0'),
          content: normalizeDesktopTextMessageContent(options.content, options.msgType ?? 7),
          messageType: options.msgType ?? 7,
          clientMessageId: clientMsgId,
          ext: {
            's:mentioned_users': '',
            's:client_message_id': clientMsgId,
            's:stime': `${timestamp}.${String(timestamp % 10_000).padStart(4, '0')}`,
          },
          ...(options.mentionedUsers?.length
            ? { mentionedUsers: options.mentionedUsers.map((uid) => long.fromString(uid)) }
            : {}),
          ...(options.reference ? { refMsgInfo: encodeReference(options.reference, long) } : {}),
        },
      },
      desktopCookieProtoOptions(deviceId),
    );
    return parseSendMessageResponse(decoded, clientMsgId);
  }

  /** 撤回已投递消息（cmd 702） */
  async recall(options: RecallMessageOptions): Promise<RecallMessageResponse> {
    const deviceId = this.deviceId;
    if (!deviceId) throw new Error('Cookie IM recall requires deviceId');
    const long = protobuf.util.Long as unknown as { fromString(s: string): unknown };
    const decoded = await this.transport.sendCookieProto(
      702,
      1, // Desktop MessageManager::recallMessage always uses inbox 1.
      '/v1/message/recall',
      {
        recallMessageBody: {
          conversationId: options.threadId,
          conversationShortId: long.fromString(options.conversationShortId || '0'),
          conversationType: options.conversationType ?? 1,
          serverMessageId: long.fromString(options.serverMessageId),
        },
      },
      desktopCookieProtoOptions(deviceId),
    );
    const envelopeStatus = Number(decoded['statusCode'] ?? 0);
    const body = decoded['body'] as Record<string, unknown> | undefined;
    const recall = body?.['recallMessageBody'] as { toast?: string } | undefined;
    return {
      statusCode: envelopeStatus,
      statusMsg: String(decoded['errorDesc'] || recall?.toast || ''),
      recalled: envelopeStatus === 0 || envelopeStatus === 200,
    };
  }
}
