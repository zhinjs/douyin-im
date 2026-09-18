import { decodeRequestRaw, encodeRequest } from './codec.js';
import protobuf from 'protobufjs';
import { ImStrangerApi } from './stranger.js';
import type { ImProtoTransport } from './transport.js';

describe('ImStrangerApi', () => {
  // These legacy wrappers are not evidence of Desktop business call sites.
  // In particular, Desktop's single-conversation delete uses shared cmd603.
  it('records the remaining legacy stranger wrapper routes pending Desktop migration', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, errorDesc: '', body: {} });
    const api = new ImStrangerApi(
      { sendCookieProto } as unknown as ImProtoTransport,
    );

    await api.deleteMessage('70001', '80001');
    await api.deleteAllConversations();
    await api.markRead('70001');
    await api.markAllRead();
    await api.getUnreadCount();

    expect(sendCookieProto.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      [1003, '/v1/stranger/delete_message'],
      [1005, '/v1/stranger/delete_all_conversations'],
      [1006, '/v1/stranger/mark_read_conversation'],
      [1007, '/v1/stranger/mark_read_all_conversations'],
      [1008, '/v1/stranger/get_unread_count'],
    ]);
  });

  it('encodes the descriptor oneof tag separately from IMCMD', async () => {
    const bytes = await encodeRequest({
      token: '',
      cmd: 1001,
      inboxType: 1,
      authType: 1,
      body: {
        getStrangerConversationBody: {
          cursor: (protobuf.util.Long as unknown as { fromString(value: string): unknown })
            .fromString('9007199254740994'),
          count: (protobuf.util.Long as unknown as { fromString(value: string): unknown })
            .fromString('20'),
          showTotalUnread: true,
          bizInfo: '',
        },
      },
    });

    await expect(decodeRequestRaw(bytes)).resolves.toMatchObject({
      cmd: 1001,
      body: {
        getStrangerConversationBody: {
          cursor: '9007199254740994',
          count: '20',
          showTotalUnread: true,
        },
      },
    });
  });

  it('does not turn a missing stranger body into a successful empty list', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, errorDesc: '' });
    const api = new ImStrangerApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '3241234567',
    );

    await expect(api.getMessages('90001')).resolves.toMatchObject({
      statusCode: -3,
      statusMsg: 'IM response missing getStrangerMessagesBody',
      messages: [],
    });
  });
});
