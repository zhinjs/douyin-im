import { ImInboxApi } from './inbox.js';
import type { ImProtoTransport } from './transport.js';

describe('ImInboxApi group conversations', () => {
  it('uses desktop cmd 2006 cookie envelope and returns groups', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      errorDesc: '',
      body: { getConversationListBody: { list: [{
        conversationId: '7681236801654178341', conversationShortId: '7681236801654178341',
        conversationType: 2,
        conversationCoreInfo: { name: '群聊' },
        firstPageParticipants: { participants: [{ userId: '100', role: 1, secUid: 'MS4owner' }] },
      }] } },
    });
    const api = new ImInboxApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '100',
      '3241234567',
    );

    const result = await api.listConversations({ count: 40 });

    expect(sendCookieProto).toHaveBeenCalledWith(
      2006, 0, '/v1/conversation/list',
      { getConversationListBody: { sortType: 1, cursor: expect.anything(), conType: 2, limit: 40 } },
      expect.objectContaining({ deviceId: '3241234567', access: 'cpp_sdk', sdkVersion: '1.2.1' }),
    );
    expect(sendCookieProto.mock.calls[0]![3].getConversationListBody.cursor.toString()).toBe('0');
    expect(result.conversations[0]).toMatchObject({
      conversationId: '7681236801654178341', isGroup: true, name: '群聊',
    });
  });

  it('uses desktop Cookie cmd203 to return private threads without a token', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      errorDesc: 'OK',
      body: { messagesPerUserInitV2Body: { conversations: [{
        conversationId: '0:1:100:200',
        conversationShortId: '900',
        conversationType: 1,
        firstPageParticipants: {
          participants: [{ userId: '200', secUid: 'MS4peer', alias: 'peer' }],
        },
      }] } },
    });
    const api = new ImInboxApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '100',
      '3241234567',
    );

    const result = await api.listThreads();

    expect(sendCookieProto).toHaveBeenCalledWith(
      203, 1, '/v2/message/get_by_user_init',
      { messagesPerUserInitV2Body: { cursor: expect.anything() } },
      expect.objectContaining({ deviceId: '3241234567', access: 'cpp_sdk', sdkVersion: '1.2.1' }),
    );
    expect(sendCookieProto.mock.calls[0]![3].messagesPerUserInitV2Body.cursor.toString()).toBe('0');
    expect(result.threads[0]).toMatchObject({
      threadId: '0:1:100:200',
      conversationShortId: '900',
      peer: { uid: '200', nickname: 'peer' },
    });
  });

  it('keeps cmd301 history cursors as decimal int64 strings', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: { messagesInConversationBody: {
        messages: [], hasMore: true, nextCursor: '9007199254740993',
      } },
    });
    const api = new ImInboxApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '100',
      '3241234567',
    );

    const result = await api.getMessages({
      threadId: '70001', conversationShortId: '70001', conversationType: 2,
      cursor: '9007199254740995', count: 10,
    });

    const request = sendCookieProto.mock.calls[0]?.[3] as {
      messagesInConversationBody?: { anchorIndex?: { toString(): string } };
    };
    expect(request.messagesInConversationBody?.anchorIndex?.toString()).toBe('9007199254740995');
    expect(result).toMatchObject({ cursor: '9007199254740993', hasMore: true, direction: 'older' });
  });

  it('matches Desktop newer/includeCurrent history semantics and preserves inbox type', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: { messagesInConversationBody: {
        messages: [
          { serverMessageId: '1', conversationId: '70001', sender: '20', indexInConversationV2: '9007199254740995' },
          { serverMessageId: '2', conversationId: '70001', sender: '20', indexInConversationV2: '9007199254740996' },
        ],
        hasMore: false,
        nextCursor: '9007199254740996',
      } },
    });
    const api = new ImInboxApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '100',
      '3241234567',
    );

    const result = await api.getMessages({
      threadId: '70001', conversationShortId: '70001', conversationType: 2,
      inboxType: 1, cursor: '9007199254740995', count: 10,
      direction: 'newer', includeCurrent: false,
    });

    expect(sendCookieProto).toHaveBeenCalledWith(
      301, 1, '/v1/message/get_by_conversation',
      { messagesInConversationBody: expect.objectContaining({ direction: 2, anchorIndex: expect.anything(), limit: 10 }) },
      expect.any(Object),
    );
    expect(result.direction).toBe('newer');
    expect(result.messages.map((message) => message.msgId)).toEqual(['2']);
  });

  it('rejects a successful envelope when the desktop inbox body is missing', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, errorDesc: '' });
    const api = new ImInboxApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '100',
      '3241234567',
    );

    await expect(api.listThreads()).resolves.toMatchObject({
      statusCode: -3,
      statusMsg: 'IM response missing messagesPerUserInitV2Body',
      threads: [],
    });
    await expect(api.getMessages({
      threadId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
    })).resolves.toMatchObject({
      statusCode: -3,
      statusMsg: 'IM response missing messagesInConversationBody',
      messages: [],
    });
  });
});
