import protobuf from 'protobufjs';
import { desktopCookieProtoOptions } from './desktop.js';
import { mapProtoMessage } from './mappers.js';
import type { ImProtoTransport } from './transport.js';
import type {
  ImActionResponse,
  RecentStrangerMessagesOptions,
  RecentStrangerMessagesResponse,
  StrangerMessagesResponse,
  StrangerUnreadCountResponse,
} from './types.js';

const LONG = protobuf.util.Long as unknown as { fromString(value: string): unknown };

/** Desktop cmd2047 sync, plus legacy descriptor-backed inbox commands awaiting migration. */
export class ImStrangerApi {
  constructor(
    private readonly transport: ImProtoTransport,
    private readonly deviceId = '',
  ) {}

  private cookieOptions() {
    return desktopCookieProtoOptions(this.deviceId || '0');
  }

  /** One page only; refresh/load-more cursor commits belong to the account's sync lifecycle. */
  async getRecentMessages(options: RecentStrangerMessagesOptions): Promise<RecentStrangerMessagesResponse> {
    const latest = signedInt64(options.latestStrangerVersion, 'latestStrangerVersion');
    const earliest = signedInt64(options.earliestStrangerVersion, 'earliestStrangerVersion');
    const inboxType = options.inboxType ?? 1;
    if (!Number.isInteger(inboxType) || inboxType < -2147483648 || inboxType > 2147483647) {
      throw new RangeError('inboxType must be an int32');
    }
    // rawGetRecentStrangerMessagesV2@0x17ae74 and request_@0x255f00.
    // newUser=0 and bizInfo='' are explicitly present; ext/count/reset flags are not sent.
    const decoded = await this.transport.sendCookieProto(2047, inboxType,
      '/v1/message/get_recent_stranger_message', {
        getRecentStrangerMessage: {
          latestStrangerVersion: LONG.fromString(latest),
          earliestStrangerVersion: LONG.fromString(earliest),
          source: 'code_up', newUser: 0, bizInfo: '',
        },
      }, this.cookieOptions());
    const result = envelopeResult(decoded);
    const empty = { nextStrangerVersion: '0', hasMore: false, messages: [], logId: String(decoded['logId'] ?? '') };
    if (result.statusCode !== 0 && result.statusCode !== 200) return { ...result, ...empty };
    const body = record(record(decoded['body'])?.['getRecentStrangerMessage']);
    // SDK defensive boundary: native falls back to a protobuf default instance for a missing body.
    // Do not let that case look like a valid empty page and advance a persisted sync cursor.
    if (!body) return { statusCode: -3, statusMsg: 'IM response missing getRecentStrangerMessage', ...empty };
    try {
      if (typeof body['hasMore'] !== 'boolean') throw new Error('hasMore must be a boolean');
      const nextStrangerVersion = signedInt64(body['nextStrangerVersion'], 'nextStrangerVersion');
      const rows = records(body['messages'], 'messages');
      const messages = rows.map(row => {
        if (typeof row['conversationId'] !== 'string') throw new Error('conversationId must be a string');
        const badgeCount = row['badgeCount'] ?? 0;
        if (typeof badgeCount !== 'number' || !Number.isInteger(badgeCount) ||
            badgeCount < -2147483648 || badgeCount > 2147483647) throw new Error('badgeCount must be an int32');
        return {
          conversationId: row['conversationId'],
          conversationShortId: signedInt64(row['conversationShortId'], 'conversationShortId'),
          version: signedInt64(row['version'], 'version'),
          badgeCount,
          messages: records(row['messages'], 'messages').map(message => ({ ...mapProtoMessage(message), inboxType })),
        };
      });
      return { statusCode: 0, statusMsg: result.statusMsg, ...empty, nextStrangerVersion, hasMore: body['hasMore'], messages };
    } catch (error) {
      return { statusCode: -3, statusMsg: `Invalid recent stranger page: ${error instanceof Error ? error.message : String(error)}`, ...empty };
    }
  }



  async getMessages(
    conversationShortId: string,
    resetUnreadCount = false,
  ): Promise<StrangerMessagesResponse> {
    assertInt64('conversationShortId', conversationShortId);
    const decoded = await this.transport.sendCookieProto(
      1002,
      1,
      '/v1/stranger/get_messages',
      {
        getStrangerMessagesBody: {
          conversationShortId: LONG.fromString(conversationShortId),
          resetUnreadCount,
        },
      },
      this.cookieOptions(),
    );
    const result = envelopeResult(decoded);
    const payload = decoded['body'] as Record<string, unknown> | undefined;
    const body = payload?.['getStrangerMessagesBody'] as {
      messages?: Array<Record<string, unknown>>;
    } | undefined;
    if (result.statusCode === 0 && !body) {
      return {
        statusCode: -3,
        statusMsg: 'IM response missing getStrangerMessagesBody',
        messages: [],
      };
    }
    return {
      ...result,
      messages: result.statusCode === 0 ? (body?.messages ?? []).map(mapProtoMessage) : [],
    };
  }

  deleteMessage(conversationShortId: string, serverMessageId: string): Promise<ImActionResponse> {
    assertInt64('conversationShortId', conversationShortId);
    assertInt64('serverMessageId', serverMessageId);
    return this.emptyAction(1003, '/v1/stranger/delete_message', 'deleteStrangerMessageBody', {
      serverMessageId: LONG.fromString(serverMessageId),
      conversationShortId: LONG.fromString(conversationShortId),
    });
  }

  deleteAllConversations(): Promise<ImActionResponse> {
    return this.emptyAction(1005, '/v1/stranger/delete_all_conversations', 'deleteStrangerAllConversationBody', {});
  }

  markRead(conversationShortId: string): Promise<ImActionResponse> {
    assertInt64('conversationShortId', conversationShortId);
    return this.emptyAction(1006, '/v1/stranger/mark_read_conversation', 'markStrangerConversationReadBody', {
      conversationShortId: LONG.fromString(conversationShortId),
    });
  }

  markAllRead(): Promise<ImActionResponse> {
    return this.emptyAction(1007, '/v1/stranger/mark_read_all_conversations', 'markStrangerAllConversationReadBody', {});
  }

  async getUnreadCount(resetUnreadCount = false): Promise<StrangerUnreadCountResponse> {
    const decoded = await this.transport.sendCookieProto(
      1008,
      1,
      '/v1/stranger/get_unread_count',
      { getStrangerUnreadCountBody: { resetUnreadCount } },
      this.cookieOptions(),
    );
    const result = envelopeResult(decoded);
    const payload = decoded['body'] as Record<string, unknown> | undefined;
    const body = payload?.['getStrangerUnreadCountBody'] as { userUnreadCount?: string } | undefined;
    if (result.statusCode === 0 && !body) {
      return {
        statusCode: -3,
        statusMsg: 'IM response missing getStrangerUnreadCountBody',
        unreadCount: '0',
      };
    }
    return { ...result, unreadCount: String(body?.userUnreadCount ?? '0') };
  }

  private async emptyAction(
    cmd: number,
    endpoint: string,
    bodyKey: string,
    body: Record<string, unknown>,
  ): Promise<ImActionResponse> {
    const decoded = await this.transport.sendCookieProto(
      cmd,
      1,
      endpoint,
      { [bodyKey]: body },
      this.cookieOptions(),
    );
    return envelopeResult(decoded);
  }


}

function envelopeResult(decoded: Record<string, unknown>): ImActionResponse {
  return {
    statusCode: Number(decoded['statusCode'] ?? 0),
    statusMsg: String(decoded['errorDesc'] ?? ''),
  };
}

function assertInt64(name: string, value: string): void {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a decimal int64 string`);
}

function signedInt64(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new TypeError(`${name} must be a decimal int64 string`);
  const number = BigInt(value);
  if (number < -9223372036854775808n || number > 9223372036854775807n) throw new RangeError(`${name} is outside int64`);
  return number.toString();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function records(value: unknown, name: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => !record(item))) throw new Error(`${name} must contain objects`);
  return value as Record<string, unknown>[];
}
