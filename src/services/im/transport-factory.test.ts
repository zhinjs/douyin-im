import { ImService, type ImHttpClient } from './service.js';
import { ImProtoTransport, type ImCookieTransport, type ImTransportFactory } from './transport.js';

const client = {
  getUserAgent: () => 'test-agent',
  getCookies: () => 'sessionid=test',
  getInstallId: () => '42',
  requestRaw: () => { throw new Error('raw HTTP is not used by these fixtures'); },
} as unknown as ImHttpClient;

describe('ImService transport factory', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds the default Cookie transport when no factory is supplied', () => {
    const im = new ImService(client, { deviceId: 'device', platformUid: '10001' });
    expect((im as unknown as { transport: unknown }).transport).toBeInstanceOf(ImProtoTransport);
  });

  it('routes IM protobuf requests through the supplied transport with the bound identity', async () => {
    const sentinel = new Error('custom transport reached');
    const sendCookieProto = jest.fn<ReturnType<ImCookieTransport['sendCookieProto']>,
      Parameters<ImCookieTransport['sendCookieProto']>>().mockRejectedValue(sentinel);
    const custom: ImCookieTransport = { sendCookieProto };
    const factory = jest.fn<ImCookieTransport, Parameters<ImTransportFactory>>(() => custom);
    const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));

    const im = new ImService(client, { deviceId: 'device', platformUid: '10001', transport: factory });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(client, { deviceId: 'device', platformUid: '10001' });
    expect((im as unknown as { transport: unknown }).transport).toBe(custom);
    await expect(im.listThreads()).rejects.toBe(sentinel);
    expect(sendCookieProto).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps each service bound to its own transport instance', () => {
    const first = { sendCookieProto: jest.fn() };
    const second = { sendCookieProto: jest.fn() };
    const a = new ImService(client, { deviceId: 'a', transport: () => first });
    const b = new ImService(client, { deviceId: 'b', transport: () => second });
    expect((a as unknown as { transport: unknown }).transport).toBe(first);
    expect((b as unknown as { transport: unknown }).transport).toBe(second);
  });
});
