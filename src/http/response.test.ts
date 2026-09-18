import { ApiConnection } from '../desktop/api-connection.js';
import { DouyinResponseError, parseJsonResponse } from './response.js';

describe('Douyin JSON response diagnostics', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['', {}, 'empty'],
    ['<html>verify</html>', { 'x-vc-bdturing-parameters': 'opaque' }, 'captcha'],
    ['', { 'x-tt-verify-passport-decision': '{}' }, 'passport-verification'],
    ['<script>__ac_nonce="nonce"</script>', {}, 'challenge'],
    ['<html>unexpected</html>', {}, 'invalid-json'],
    ['null', {}, 'invalid-json'],
    ['42', {}, 'invalid-json'],
  ] as const)('classifies %s as %s without leaking bodies or credentials', (rawText, extraHeaders, kind) => {
    const headers = new Headers({ ...extraHeaders, 'x-tt-logid': 'trace-123' });
    const parse = () => parseJsonResponse({ ok: true, status: 200, headers, rawText, data: rawText },
      'https://example.test/api/?msToken=secret-token');
    expect(parse).toThrow(DouyinResponseError);
    try { parse(); } catch (error) {
      expect(error).toMatchObject({ kind, status: 200, endpoint: '/api/', logId: 'trace-123' });
      expect(String(error)).not.toContain('secret-token');
      expect(String(error)).not.toContain('<html>');
    }
  });

  it('rejects HTTP errors even with valid JSON but preserves JSON business errors on HTTP 200', () => {
    const response = {
      ok: false, status: 503, headers: new Headers(), rawText: '{"status_code":0}', data: '',
    };
    expect(() => parseJsonResponse(response, 'https://example.test/api/')).toThrow('HTTP 503');
    expect(parseJsonResponse({ ...response, ok: true, status: 200, rawText: '{"status_code":8}' },
      'https://example.test/api/')).toEqual({ status_code: 8 });
  });

  it.each([302, 401, 429, 503].flatMap(status => [
    { rawText: '', headers: { 'x-vc-bdturing-parameters': 'fixture-secret' } },
    { rawText: '<html>fixture-secret</html>', headers: { 'x-tt-verify-passport-decision': '{"ticket":"fixture-secret"}' } },
    { rawText: '<script>__ac_nonce="fixture-secret"</script>', headers: {} },
  ].map(input => ({ status, ...input }))))('gives transport failure priority over challenge hints (HTTP $status, $rawText)', ({ status, rawText, headers: extra }) => {
    const headers = new Headers({ ...extra, 'x-tt-logid': 'fixture-log' });
    let failure: unknown;
    try {
      parseJsonResponse({ ok: false, status, headers, rawText, data: rawText },
        'https://imdesktop.douyin.com/passport/web/user/login/?token=fixture-secret');
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DouyinResponseError);
    expect(failure).toMatchObject({ kind: 'http', status, endpoint: '/passport/web/user/login/', logId: 'fixture-log' });
    expect(String(failure)).not.toContain('fixture-secret');
    expect(JSON.stringify(failure)).not.toContain('fixture-secret');
  });

  it.each([
    ['qr', (client: ApiConnection) => client.getQrcode()],
    ['qr-poll', (client: ApiConnection) => client.checkQrconnect('fixture-token')],
    ['password', (client: ApiConnection) => client.userLogin('13800000000', 'fixture-password')],
    ['send-sms', (client: ApiConnection) => client.sendCode('13800000000')],
    ['sms-login', (client: ApiConnection) => client.smsLogin('13800000000', '123456')],
    ['account-info', (client: ApiConnection) => client.getPassportAccountInfo()],
    ['token-beat', (client: ApiConnection) => client.sendPassportTokenBeat('boot')],
  ] as const)('returns the actual HTTP failure from %s without offering or dispatching a verification retry', async (_name, invoke) => {
    const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>fixture-secret</html>', {
      status: 503, headers: { 'x-tt-verify-passport-decision': '{"code":"20000","ticket":"fixture-secret"}' },
    }));
    const connection = new ApiConnection({ enableABogus: false });
    await expect(invoke(connection)).rejects.toMatchObject({ name: 'DouyinResponseError', kind: 'http', status: 503 });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('propagates structured errors from Passport without retrying writes', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', {
      headers: { 'x-vc-bdturing-parameters': 'opaque', 'x-tt-logid': 'trace' },
    }));
    const client = new ApiConnection({ enableABogus: false });
    const calls = [() => client.getQrcode()];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ kind: 'captcha', logId: 'trace' });
    expect(fetcher).toHaveBeenCalledTimes(calls.length);
  });

  it('retains raw HTML access for bootstrap challenge handling', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<script>__ac_nonce="nonce"</script>'));
    const client = new ApiConnection();
    await expect(client.requestRaw('https://example.test/', { method: 'GET' }))
      .resolves.toMatchObject({ rawText: '<script>__ac_nonce="nonce"</script>' });
  });

  it('bounds default requests while honoring a caller-owned abort signal', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const client = new ApiConnection({ requestTimeoutMs: 1234 });
    await client.requestRaw('https://example.test/api/', { method: 'GET' });
    expect(timeout).toHaveBeenCalledWith(1234);
    const controller = new AbortController();
    await client.requestRaw('https://example.test/api/', { method: 'GET', signal: controller.signal });
    expect(fetcher.mock.calls[1]?.[1]?.signal).toBe(controller.signal);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(() => new ApiConnection({ requestTimeoutMs: 0 })).toThrow(RangeError);
  });
});
