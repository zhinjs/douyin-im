import protobuf from 'protobufjs';
import type { ImProtoTransport } from './transport.js';
import {
  dedupeThreads,
  mapProtoConversation,
  mapProtoConversationListItem,
  mapProtoConversationMeta,
  mapProtoMessage,
} from './mappers.js';
import type {
  MessageListOptions,
  MessageListResponse,
  PrivateMessage,
  ThreadListOptions,
  ThreadListResponse,
  ConversationListOptions,
  ConversationListResponse,
} from './types.js';
import { desktopCookieProtoOptions } from './desktop.js';

const LONG = protobuf.util.Long as unknown as { fromString(value: string): unknown };

function pageSize(value: number | undefined, fallback: number): number {
  const count = value ?? fallback;
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
    throw new RangeError('message page size must be an integer between 1 and 50');
  }
  return count;
}

function cursorString(value: unknown): string {
  const cursor = String(value ?? '0');
  return /^\d+$/.test(cursor) ? cursor : '0';
}

/** 收件箱 / 历史消息查询 */
export class ImInboxApi {
  constructor(
    private readonly transport: ImProtoTransport,
    private readonly platformUid = '',
    private readonly deviceId = '',
  ) {}

  private cookieOptions() {
    return desktopCookieProtoOptions(this.deviceId || '0');
  }

  /** cmd=2006, /v1/conversation/list — Desktop 群聊元数据列表。 */
  async listConversations(options: ConversationListOptions = {}): Promise<ConversationListResponse> {
    const decoded = await this.transport.sendCookieProto(
      2006,
      0,
      '/v1/conversation/list',
      {
        getConversationListBody: {
          sortType: 1,
          cursor: LONG.fromString(cursorString(options.cursor)),
          conType: 2,
          limit: options.count ?? 20,
        },
      },
      this.cookieOptions(),
    );
    const statusCode = Number(decoded['statusCode'] ?? 0);
    const body = decoded['body'] as Record<string, unknown> | null;
    const list = body?.['getConversationListBody'] as { list?: Array<Record<string, unknown>> } | undefined;
    if (statusCode === 0 && !list) {
      return {
        statusCode: -3,
        statusMsg: 'IM response missing getConversationListBody',
        conversations: [],
      };
    }
    return {
      statusCode,
      statusMsg: String(decoded['errorDesc'] ?? ''),
      conversations: statusCode === 0
        ? (list?.list ?? []).map(mapProtoConversationListItem)
        : [],
    };
  }

  /** Desktop Cookie cmd=203。inboxType=1 返回群聊及普通私信。 */
  async listThreads(options: ThreadListOptions = {}): Promise<ThreadListResponse> {
    const cursor = cursorString(options.cursor);
    const decoded = await this.transport.sendCookieProto(
      203,
      options.inboxType ?? 1,
      '/v2/message/get_by_user_init',
      { messagesPerUserInitV2Body: { cursor: LONG.fromString(cursor) } },
      this.cookieOptions(),
    );
    const statusCode = Number(decoded['statusCode'] ?? 0);
    if (statusCode !== 0) {
      return {
        statusCode,
        statusMsg: String(decoded['errorDesc'] ?? ''),
        hasMore: false,
        threads: [],
        cursor: '0',
        conversations: [],
      };
    }
    const body = decoded['body'] as Record<string, unknown> | null;
    const inbox = body?.['messagesPerUserInitV2Body'] as {
      messages?: unknown[];
      conversations?: unknown[];
      nextCursor?: string;
      hasMore?: number;
    } | null;
    if (!inbox) {
      return {
        statusCode: -3,
        statusMsg: 'IM response missing messagesPerUserInitV2Body',
        hasMore: false,
        threads: [],
        cursor: '0',
        conversations: [],
      };
    }
    const rawMessages = (inbox?.messages ?? []) as Record<string, unknown>[];
    const rawConversations = (inbox?.conversations ?? []) as Record<string, unknown>[];
    const threads = rawConversations.length > 0
      ? rawConversations.map((conversation) =>
          mapProtoConversationMeta(conversation, rawMessages, this.platformUid),
        )
      : dedupeThreads(rawMessages.map((message) => mapProtoConversation(message, this.platformUid)));
    return {
      statusCode: 0,
      statusMsg: String(decoded['errorDesc'] ?? ''),
      hasMore: (inbox?.hasMore ?? 0) > 0,
      threads: dedupeThreads(threads),
      cursor: cursorString(inbox?.nextCursor),
      conversations: rawConversations.map(mapProtoConversationListItem),
    };
  }

  /** Desktop Cookie cmd=301；给 ChatContact 历史记录与断线补拉使用。 */
  async getMessages(options: MessageListOptions): Promise<MessageListResponse> {
    const count = pageSize(options.count, 50);
    const direction = options.direction ?? 'older';
    const decoded = await this.transport.sendCookieProto(
      301,
      options.inboxType ?? 0,
      '/v1/message/get_by_conversation',
      {
        messagesInConversationBody: {
          conversationId: options.threadId,
          conversationType: options.conversationType ?? (/^\d+$/.test(options.threadId) ? 2 : 1),
          conversationShortId: LONG.fromString(
            options.conversationShortId ?? (/^\d+$/.test(options.threadId) ? options.threadId : '0'),
          ),
          direction: direction === 'older' ? 1 : 2,
          anchorIndex: LONG.fromString(cursorString(options.cursor)),
          limit: count,
        },
      },
      this.cookieOptions(),
    );
    return this.mapMessageListResponse(decoded, options, direction);
  }

  private mapMessageListResponse(
    decoded: Record<string, unknown>,
    options: MessageListOptions,
    direction: 'older' | 'newer',
  ): MessageListResponse {
    const statusCode = (decoded['statusCode'] as number) ?? 0;
    if (statusCode !== 0) {
      return {
        statusCode,
        statusMsg: (decoded['errorDesc'] as string) ?? '',
        hasMore: false,
        messages: [],
        cursor: '0',
        direction,
      };
    }

    const body = decoded['body'] as Record<string, unknown> | null;
    const cm = body?.['messagesInConversationBody'] as {
      messages?: unknown[];
      nextCursor?: string | number | bigint;
      hasMore?: boolean;
    } | null;
    if (!cm) {
      return {
        statusCode: -3,
        statusMsg: 'IM response missing messagesInConversationBody',
        hasMore: false,
        messages: [],
        cursor: '0',
        direction,
      };
    }

    let messages: PrivateMessage[] = (cm?.messages ?? []).map((m) =>
      mapProtoMessage(m as Record<string, unknown>),
    );
    if (options.includeCurrent !== true && options.cursor != null) {
      const anchor = cursorString(options.cursor);
      messages = messages.filter((message) =>
        message.indexInConversationV2 !== anchor && message.indexInConversation !== anchor,
      );
    }

    return {
      statusCode: 0,
      statusMsg: '',
      hasMore: cm?.hasMore ?? false,
      messages,
      cursor: String(cm?.nextCursor ?? 0),
      direction,
    };
  }
}
