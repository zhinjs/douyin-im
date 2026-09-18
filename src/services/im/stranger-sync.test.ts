import { ImService } from './service.js';
import { ImStrangerApi } from './stranger.js';
import { ImProtoTransport } from './transport.js';
import { decodeRequestRaw } from './codec.js';
import type { RecentStrangerMessagesOptions } from './types.js';

const bounds = { latestStrangerVersion: '9223372036854775807', earliestStrangerVersion: '0' };

function setup(decoded: Record<string, unknown>) {
  const transport = new ImProtoTransport({ getUserAgent: () => 'test', getCookies: () => '' });
  const send = jest.spyOn(transport, 'sendCookieProto').mockResolvedValue(decoded);
  return { api: new ImStrangerApi(transport, 'synthetic-device'), send };
}

describe('Desktop recent stranger message sync protocol', () => {
  afterEach(() => jest.restoreAllMocks());

  it('dispatches the public protocol method through real transport and decodes an independent native-tag fixture', async () => {
    // Hand-assembled Response/ResponseBody/GetRecentStrangerMessageRespBody tags.
    // Inner wire vector matches native @0x3d51a4 and @0x3c5884, not this mapper.
    const response = Buffer.from('08ff0f18c8012801321bfa7f18080b1212081b12055863420178180720022a0167420018013a036c6f67', 'hex');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(response));
    const requestRaw = jest.fn().mockRejectedValue(new Error('renderer HTTP must not be used'));
    const im = new ImService({ getUserAgent: () => 'test', getCookies: () => 'sessionid=synthetic',
      getInstallId: () => 'synthetic-iid', requestRaw }, { platformUid: '11', deviceId: 'synthetic-device' });
    const result = await im.getRecentStrangerMessages(bounds);
    expect(result).toEqual({
      statusCode: 0, statusMsg: '', nextStrangerVersion: '11', hasMore: true, logId: 'log',
      messages: [{ conversationId: 'g', conversationShortId: '27', version: '7', badgeCount: 2,
        messages: [{ msgId: '', threadId: '', senderUid: '', content: 'x', msgType: 0,
          createTime: 0, status: 0, version: '99', inboxType: 1 }] }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // hasMore does not cause auto-pagination.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).origin).toBe('https://imapi3-normal.zijieapi.com');
    expect(new URL(String(url)).pathname).toBe('/v1/message/get_recent_stranger_message');
    expect(new URL(String(url)).searchParams.get('iid')).toBe('synthetic-iid');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('cookie')).toBe('sessionid=synthetic');
    const packet = await decodeRequestRaw(init?.body as Uint8Array);
    expect(packet).toMatchObject({ cmd: 2047, inboxType: 1, authType: 'SESSION_AUTH', deviceId: 'synthetic-device',
      body: { getRecentStrangerMessage: { ...bounds, source: 'code_up', newUser: 0, bizInfo: '' } } });
    expect(Object.keys((packet['body'] as Record<string, Record<string, unknown>>)['getRecentStrangerMessage']!)).toEqual([
      'latestStrangerVersion', 'earliestStrangerVersion', 'source', 'newUser', 'bizInfo',
    ]);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it('accepts native negative load-more sentinel and never coerces int64 through Number', async () => {
    const { api, send } = setup({ body: { getRecentStrangerMessage: { nextStrangerVersion: '-1', hasMore: false } } });
    const result = await api.getRecentMessages({ latestStrangerVersion: '-1', earliestStrangerVersion: '9007199254740993', inboxType: 0 });
    expect(result).toMatchObject({ statusCode: 0, nextStrangerVersion: '-1', messages: [] });
    const [cmd, inbox, , body] = send.mock.calls[0]!;
    expect([cmd, inbox]).toEqual([2047, 0]);
    const request = body['getRecentStrangerMessage'] as Record<string, { toString(): string }>;
    expect(request['latestStrangerVersion']!.toString()).toBe('-1');
    expect(request['earliestStrangerVersion']!.toString()).toBe('9007199254740993');
  });

  it('keeps empty and duplicate outer rows, signed versions and explicit nested identities', async () => {
    const rows = [
      { conversationId: 'g', conversationShortId: '9007199254740993', version: '-1' },
      { conversationId: 'g', conversationShortId: '9007199254740993', version: '22', badgeCount: -2,
        messages: [{ conversationId: 'nested', conversationShortId: '9', conversationType: 2, version: '99' }] },
      { conversationId: '', conversationShortId: '0', version: '0', messages: [] },
    ];
    const original = structuredClone(rows);
    const { api } = setup({ statusCode: 0, body: { getRecentStrangerMessage: { nextStrangerVersion: '9007199254740995', hasMore: true, messages: rows } } });
    const result = await api.getRecentMessages({ ...bounds, inboxType: 7 });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({ version: '-1', badgeCount: 0, messages: [] });
    expect(result.messages[1]).toMatchObject({ version: '22', badgeCount: -2,
      messages: [{ threadId: 'nested', conversationShortId: '9', conversationType: 2, version: '99', inboxType: 7 }] });
    expect(rows).toEqual(original);
  });

  it.each([0, 200])('normalizes native success %s only when the page is present', async statusCode => {
    const { api } = setup({ statusCode, errorDesc: 'ok', body: { getRecentStrangerMessage: { nextStrangerVersion: '0', hasMore: false } } });
    await expect(api.getRecentMessages(bounds)).resolves.toEqual({
      statusCode: 0, statusMsg: 'ok', nextStrangerVersion: '0', hasMore: false, messages: [], logId: '',
    });
  });

  it('preserves server errors without publishing any supplied rows or attempting retries', async () => {
    const { api, send } = setup({ statusCode: 8, errorDesc: 'not logged in', logId: 'synthetic-log',
      body: { getRecentStrangerMessage: { nextStrangerVersion: '999', hasMore: true, messages: [{}] } } });
    await expect(api.getRecentMessages(bounds)).resolves.toEqual({
      statusCode: 8, statusMsg: 'not logged in', logId: 'synthetic-log', nextStrangerVersion: '0', hasMore: false, messages: [],
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects missing/malformed pages without partially returning the valid prefix', async () => {
    const { api, send } = setup({});
    const row = { conversationId: 'g', conversationShortId: '1', version: '2' };
    for (const page of [undefined, [], {}, { nextStrangerVersion: '1', hasMore: 1 },
      { nextStrangerVersion: '9223372036854775808', hasMore: false },
      { nextStrangerVersion: '1', hasMore: false, messages: [row, {}] },
      { nextStrangerVersion: '1', hasMore: false, messages: [{ ...row, messages: [null] }] }]) {
      send.mockResolvedValue({ statusCode: 0, body: { getRecentStrangerMessage: page } });
      await expect(api.getRecentMessages(bounds)).resolves.toMatchObject({ statusCode: -3, hasMore: false, messages: [] });
    }
  });

  it('rejects unsafe input before transport instead of wrapping or truncating versions', async () => {
    const { api, send } = setup({});
    for (const invalid of ['', '1.5', '1e3', ' 1', '9223372036854775808', '-9223372036854775809', 9007199254740992]) {
      for (const key of ['latestStrangerVersion', 'earliestStrangerVersion']) {
        await expect(api.getRecentMessages({ ...bounds, [key]: invalid } as RecentStrangerMessagesOptions)).rejects.toThrow();
      }
    }
    for (const inboxType of [NaN, Infinity, 1.5, 2147483648]) {
      await expect(api.getRecentMessages({ ...bounds, inboxType })).rejects.toThrow();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates transport rejection without retries or a successful empty page', async () => {
    const { api, send } = setup({});
    send.mockRejectedValue(new Error('network failed'));
    await expect(api.getRecentMessages(bounds)).rejects.toThrow('network failed');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
