import { decodeRequestRaw } from './codec.js';
import { createHash } from 'node:crypto';
import {
  DESKTOP_IM_PROFILE,
  DESKTOP_PC_UA,
  desktopCookieProtoOptions,
} from './desktop.js';
import { desktopBodyDigest, ImProtoTransport, ImProtoTransportError } from './transport.js';
import { decodeWire } from './wire.js';
import protobuf from 'protobufjs';

function rawVarint(value: bigint): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest ? byte | 0x80 : byte);
  } while (rest);
  return Buffer.from(bytes);
}

function rawField(field: number, value: bigint): Buffer {
  return Buffer.concat([rawVarint(BigInt(field << 3)), rawVarint(value)]);
}

function rawBytes(field: number, value: Uint8Array | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([rawVarint(BigInt(field << 3 | 2)), rawVarint(BigInt(bytes.length)), bytes]);
}

function rawKv(field: number, key: string, value: string): Buffer {
  return rawBytes(field, Buffer.concat([rawBytes(1, key), rawBytes(2, value)]));
}

describe('desktop Cookie protobuf envelope', () => {
  afterEach(() => jest.restoreAllMocks());

  it('matches installed native Cronet digests for empty, text and binary bodies', () => {
    // Produced offline by scripts/research/native-cronet-digest.c, not this implementation.
    expect(desktopBodyDigest(new Uint8Array())).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(desktopBodyDigest(Buffer.from('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    const backing = Uint8Array.from([0x99, 0x00, 0xff, 0x80, 0x61, 0x00, 0xc3, 0xa9, 0x88]);
    expect(desktopBodyDigest(backing.subarray(1, -1))).toBe('40c758c1e115f6e2f4136504a2f3ce8b');
    expect(desktopBodyDigest(Buffer.from(backing).subarray(1, -1))).toBe('40c758c1e115f6e2f4136504a2f3ce8b');
  });

  it('matches the current Douyin Chat native SDK identity', async () => {
    let requestBody: Uint8Array | undefined;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestBody = new Uint8Array(init?.body as ArrayBuffer);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    });
    const transport = new ImProtoTransport(
      { getUserAgent: () => 'desktop-UA', getCookies: () => 'sessionid=<REDACTED>', getInstallId: () => '1234567890123457' },
    );

    const conversationId = '0:1:1150530166719210:3138463854771706';
    const shortId = '7678270758086263345';
    const content = '{"aweType":700,"type":0,"richTextInfos":[],"text":"qwq"}';
    const clientMessageId = '00000000-0000-0000-0000-000000000000';
    const stime = '1700000000000.0000';
    const desktopOptions = desktopCookieProtoOptions('3249781169');
    await transport.sendCookieProto(100, 0, '/v1/message/send', {
      sendMessageBody: {
        conversationId,
        conversationType: 1,
        conversationShortId: (
          protobuf.util.Long as unknown as { fromString(value: string): unknown }
        ).fromString(shortId),
        content,
        ext: {
          's:mentioned_users': '',
          's:client_message_id': clientMessageId,
          's:stime': stime,
        },
        messageType: 7,
        clientMessageId,
      },
    }, desktopOptions);

    expect(requestBody).toBeDefined();
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('iid')).toBe('1234567890123457');
    const topLevelFields = decodeWire(requestBody!).map((field) => field.field);
    expect(topLevelFields).not.toContain(23);
    expect(topLevelFields).not.toContain(24);

    const inner = Buffer.concat([
      rawBytes(1, conversationId),
      rawField(2, 1n),
      rawField(3, BigInt(shortId)),
      rawBytes(4, content),
      rawKv(5, 's:mentioned_users', ''),
      rawKv(5, 's:client_message_id', clientMessageId),
      rawKv(5, 's:stime', stime),
      rawField(6, 7n),
      rawBytes(8, clientMessageId),
    ]);
    const expectedParts = [
      rawField(1, 100n), rawField(2, 1n), rawBytes(3, DESKTOP_IM_PROFILE.version), rawBytes(4, ''),
      rawField(5, 3n), rawField(6, 0n), rawBytes(7, DESKTOP_IM_PROFILE.buildNumber),
      rawBytes(8, rawBytes(100, inner)), rawBytes(9, '3249781169'),
      rawBytes(11, desktopOptions.devicePlatform), rawBytes(14, DESKTOP_IM_PROFILE.version),
      rawField(18, 1n), rawBytes(21, DESKTOP_IM_PROFILE.biz), rawBytes(22, DESKTOP_IM_PROFILE.access),
    ];
    expect(Buffer.from(requestBody!)).toEqual(Buffer.concat(expectedParts));
    // Independent wire fixture: hash the entire binary envelope, not its text/content or just body100.
    const digest = createHash('md5').update(Buffer.concat(expectedParts)).digest('hex');
    expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).get('x-ss-stub')).toBe(digest);
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(digest).not.toBe(createHash('md5').update(content).digest('hex'));
    expect(digest).not.toBe(createHash('md5').update(inner).digest('hex'));
    const envelope = await decodeRequestRaw(requestBody!);
    expect(envelope).toMatchObject({
      cmd: 100,
      refer: 'PC',
      authType: 'SESSION_AUTH',
      inboxType: 0,
      deviceId: '3249781169',
      sdkVersion: DESKTOP_IM_PROFILE.version,
      buildNumber: DESKTOP_IM_PROFILE.buildNumber,
      devicePlatform: desktopOptions.devicePlatform,
      versionCode: DESKTOP_IM_PROFILE.version,
      biz: 'douyin_im_pc',
      access: 'cpp_sdk',
    });
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(`${url.origin}${url.pathname}`).toBe(`${DESKTOP_IM_PROFILE.apiUrl}/v1/message/send`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      aid: '339757',
      app_name: 'aweme_im_desktop',
      device_id: '3249781169',
      version_code: '1.2.1',
    });
    expect(requestInit).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ 'User-Agent': DESKTOP_PC_UA, Accept: 'x-protobuf' }),
    }));
    expect(new Headers(requestInit!.headers).has('sdk-version')).toBe(false); // Native adds this only in token auth mode.
  });

  it('does not report the empty JSON gateway shell as a successful read receipt', async () => {
    const responseBody = Buffer.from('{"BaseResp":{},"Header":{},"Method":0,"Service":0}');
    expect(responseBody).toHaveLength(50);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/x-protobuf' }),
      arrayBuffer: async () => responseBody.buffer.slice(
        responseBody.byteOffset,
        responseBody.byteOffset + responseBody.byteLength,
      ),
    } as Response);
    const transport = new ImProtoTransport(
      { getUserAgent: () => 'desktop-UA', getCookies: () => 'sessionid=<REDACTED>' },
    );

    await expect(transport.sendCookieProto(2002, 1, '/v1/conversation/mark_read', {
      markConversationReadBody: {},
    }, desktopCookieProtoOptions('3249781169'))).rejects.toThrow(
      'IM Cookie response decode failed cmd=2002 /v1/conversation/mark_read: index out of range',
    );
  });

  it('uses the native 20 second deadline without retrying a failed POST', async () => {
    const signal = new AbortController().signal;
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const error = new Error('transport failed');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    const transport = new ImProtoTransport({ getUserAgent: () => 'desktop-UA', getCookies: () => '' });
    await expect(transport.sendCookieProto(608, 0, '/v1/conversation/get_info', {
      getConversationInfoV2Body: {},
    }, desktopCookieProtoOptions('123'))).rejects.toMatchObject({
      name: 'ImProtoTransportError', stage: 'network', cmd: 608, endpoint: '/v1/conversation/get_info', cause: error,
    });
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]!.signal).toBe(signal);
  });

  it.each(['http', 'decode', 'network'] as const)('labels %s failures without exposing an HTTP body', async stage => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: stage !== 'http', status: stage === 'http' ? 503 : 200,
      arrayBuffer: async () => {
        if (stage === 'network') throw new Error('fixture read failed');
        return Buffer.from('not protobuf: private server diagnostics');
      } } as unknown as Response);
    const transport = new ImProtoTransport({ getUserAgent: () => '', getCookies: () => '' });
    const result = transport.sendCookieProto(603, 0, '/v1/conversation/delete', {}, desktopCookieProtoOptions('123'));
    await expect(result).rejects.toBeInstanceOf(ImProtoTransportError);
    await expect(result).rejects.toMatchObject({ stage, cmd: 603, endpoint: '/v1/conversation/delete' });
    if (stage === 'http') await expect(result).rejects.toThrow('IM Cookie HTTP 503 /v1/conversation/delete');
    const error = await result.catch((failure: Error) => failure);
    expect(String(error)).not.toContain('private server diagnostics');
  });

  it('does not relabel local request-preparation errors as network failures', async () => {
    const cause = new TypeError('fixture cookie provider bug');
    const fetch = jest.spyOn(globalThis, 'fetch');
    const transport = new ImProtoTransport({ getUserAgent: () => '', getCookies: () => { throw cause; } });
    await expect(transport.sendCookieProto(603, 0, '/v1/conversation/delete', {}, desktopCookieProtoOptions('123')))
      .rejects.toBe(cause);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the IM initialization identity snapshot when renderer IID changes', async () => {
    let installId = '456';
    const client = { getUserAgent: () => 'fixture', getCookies: () => '', getInstallId: () => installId };
    const transport = new ImProtoTransport(client);
    const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array()));
    const options = desktopCookieProtoOptions('123');
    installId = '987';
    await transport.sendCookieProto(604, 1, '/v1/conversation/mark_read', {}, options);
    expect(new URL(String(request.mock.calls[0]![0])).searchParams.get('iid')).toBe('456');
    const renewed = new ImProtoTransport(client);
    await renewed.sendCookieProto(604, 1, '/v1/conversation/mark_read', {}, options);
    expect(new URL(String(request.mock.calls[1]![0])).searchParams.get('iid')).toBe('987');
  });
});
