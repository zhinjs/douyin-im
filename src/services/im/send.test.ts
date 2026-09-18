import { buildReplyPayload, isMessageDelivered } from './content.js';
import { ImSendApi } from './send.js';
import type { ImProtoTransport } from './transport.js';

describe('desktop Cookie IM send', () => {
  it.each([0, 200, 3])('uses Desktop recall inbox and outer status %s without requiring a response body', async statusCode => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode });
    const sender = new ImSendApi({ sendCookieProto } as unknown as ImProtoTransport, '3241234567');
    const result = await sender.recall({ threadId: '700', conversationShortId: '700', conversationType: 2, serverMessageId: '9007199254740993', inboxType: 0 });
    expect(result).toEqual({ statusCode, statusMsg: '', recalled: statusCode === 0 || statusCode === 200 });
    expect(sendCookieProto).toHaveBeenCalledWith(702, 1, '/v1/message/recall', expect.anything(), expect.anything());
    const body = sendCookieProto.mock.calls[0]![3].recallMessageBody;
    expect(body.serverMessageId.toString()).toBe('9007199254740993');
  });

  it('sends through Desktop Cookie HTTP without requesting a token', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: { sendMessageBody: { status: 0, serverMessageId: '987', clientMessageId: 'client' } },
    });
    const sender = new ImSendApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '3241234567',
    );

    const result = await sender.send({
      threadId: '0:1:123456789:987654321',
      conversationShortId: '456',
      content: '{"text":"ping","aweType":774}',
      msgType: 7,
    });

    expect(result).toMatchObject({ statusCode: 0, serverMessageId: '987' });
    expect(sendCookieProto).toHaveBeenCalledWith(
      100,
      0,
      '/v1/message/send',
      expect.objectContaining({ sendMessageBody: expect.objectContaining({ conversationId: '0:1:123456789:987654321' }) }),
      expect.objectContaining({
        deviceId: '3241234567',
        access: 'cpp_sdk',
        sdkVersion: '1.2.1',
        devicePlatform: 'mac',
        headers: {},
        query: expect.objectContaining({
          aid: '339757',
          app_name: 'aweme_im_desktop',
          device_id: '3241234567',
        }),
      }),
    );
  });

  it('matches the desktop request accepted by the IM content check', async () => {
    const sendCookieProto = jest.fn().mockImplementation(
      async (
        _cmd: number,
        _inbox: number,
        _endpoint: string,
        body: { sendMessageBody?: { content?: string } },
        options: {
          deviceId?: string;
          httpUserAgent?: string;
          headers?: Record<string, string>;
        },
      ) => {
        const content = JSON.parse(String(body.sendMessageBody?.content)) as Record<string, unknown>;
        const headers = options.headers ?? {};
        const accepted =
          /^324\d{7}$/.test(String(options.deviceId)) &&
          options.httpUserAgent?.includes('douyinim/1.2.1') &&
          Object.keys(headers).length === 0 &&
          content['aweType'] === 700 &&
          content['type'] === 0 &&
          Array.isArray(content['richTextInfos']);
        return accepted
          ? {
              statusCode: 0,
              body: { sendMessageBody: { status: 0, serverMessageId: '987' } },
            }
          : {
              statusCode: 0,
              body: {
                sendMessageBody: {
                  status: 3,
                  serverMessageId: '0',
                  checkMessage: JSON.stringify({ status_code: 8611 }),
                },
              },
            };
      },
    );
    const sender = new ImSendApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '3249781169',
    );

    const result = await sender.send({
      threadId: '0:1:3138463854771706:987654321',
      conversationShortId: '7678270758086263345',
      content: JSON.stringify({ text: 'ping', aweType: 774 }),
      msgType: 7,
    });

    expect(result).toMatchObject({ statusCode: 0, serverMessageId: '987' });
    expect(isMessageDelivered(result)).toBe(true);
  });

  it('sends reply text in field 4 and reference metadata in field 11', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: { sendMessageBody: { status: 0, serverMessageId: '987' } },
    });
    const sender = new ImSendApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '3249781169',
    );
    const payload = buildReplyPayload({
      text: 'child', referencedMessageId: '9988', referencedMessageType: 7,
      referencedUid: '34', referencedSecUid: 'MS4parent', referencedText: 'parent',
    });

    await sender.send({
      threadId: '0:1:12:34', conversationShortId: '77', ...payload, msgType: 7,
    });

    const body = sendCookieProto.mock.calls[0]?.[3] as { sendMessageBody?: Record<string, unknown> };
    expect(body.sendMessageBody?.['content']).toBe(payload.content);
    const reference = body.sendMessageBody?.['refMsgInfo'] as {
      referencedMessageId?: { toString(): string };
      hint?: string;
    };
    expect(reference.referencedMessageId?.toString()).toBe('9988');
    expect(reference.hint).toBe(payload.reference.hint);
  });

  it('encodes desktop mention users in cmd100 field 9', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: { sendMessageBody: { status: 0, serverMessageId: '987' } },
    });
    const sender = new ImSendApi(
      { sendCookieProto } as unknown as ImProtoTransport,
      '3249781169',
    );

    await sender.send({
      threadId: '70001', conversationShortId: '70001', conversationType: 2,
      content: JSON.stringify({ text: '@归雨 hi', aweType: 700, type: 0, richTextInfos: [] }),
      mentionedUsers: ['3138463854771706'],
    });

    const body = sendCookieProto.mock.calls[0]?.[3] as { sendMessageBody?: Record<string, unknown> };
    const mentioned = body.sendMessageBody?.['mentionedUsers'] as Array<{ toString(): string }>;
    expect(mentioned.map((uid) => uid.toString())).toEqual(['3138463854771706']);
  });
});
