import { ApiConnection } from './api-connection.js';
import { PassportRequestError } from './passport-error.js';
import { inspect } from 'node:util';
import type { PassportLoginOptions } from './types.js';
import { DESKTOP_LOGIN_USER_AGENT } from './constants.js';
import {
  buildPassportAidSign,
  buildPassportSignQs,
  passportNoonUtcTs,
} from '../passport/signQs.js';

describe('Douyin Chat Desktop login profile', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('does not absorb a cancelled verification response even if transport ignores abort', async () => {
    let release!: (value: Response) => void;
    const transport = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Promise(resolve => { release = resolve; }));
    const connection = new ApiConnection({ initialCookies: 'sessionid=fixture-original' });
    const controller = new AbortController();
    const pending = connection.requestVerificationRaw('https://imdesktop.douyin.com/passport/web/validate_code/', {
      method: 'POST', signal: controller.signal,
    });
    const reason = new Error('fixture verification ended');
    const ended = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    release(Response.json({ message: 'success', data: {} }, {
      headers: { 'Set-Cookie': 'sessionid=fixture-late; Path=/', 'x-ms-token': 'fixture-late-token' },
    }));
    await ended;
    expect(connection.getCookies()).toBe('sessionid=fixture-original');
    expect(connection.getMsToken()).not.toBe('fixture-late-token');
  });

  it('keeps one normal login trace across fresh requests and matches its header', async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      return Response.json({ message: 'success', data: { token: 'fixture-token', qrcode: 'fixture-image' } });
    });
    const client = new ApiConnection({ enableABogus: false });
    await client.getQrcode(); await client.checkQrconnect('fixture-token'); await client.sendCode('13800000000');
    const trace = requests[0]!.url.searchParams.get('biz_trace_id');
    expect(trace).toMatch(/^[0-9a-f]{8}$/);
    for (const request of requests) {
      expect(request.url.searchParams.get('biz_trace_id')).toBe(trace);
      expect(request.headers.get('x-tt-passport-trace-id')).toBe(trace);
    }
  });

  it('separates persistent tokenBeat tracing from per-call account-info and login tracing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-13T00:00:00Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const traces: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const query = new URL(String(input)).searchParams;
      traces.push(query.get('biz_trace_id')!);
      expect(new Headers(init?.headers).get('x-tt-passport-trace-id')).toBe(traces.at(-1));
      return Response.json({ message: 'success', data: { token: 'fixture-token', qrcode: 'fixture-image' } });
    });
    const client = new ApiConnection({ enableABogus: false, bizTraceId: 'abcd1234' });
    await client.sendPassportTokenBeat('boot');
    jest.setSystemTime(Date.now() + 1000); await client.getPassportAccountInfo();
    jest.setSystemTime(Date.now() + 1000); await client.getPassportAccountInfo();
    jest.setSystemTime(Date.now() + 1000); await client.sendPassportTokenBeat('active');
    await client.getQrcode();
    expect(traces[0]).toBe(traces[3]);
    expect(traces[4]).toBe('abcd1234');
    expect(new Set([traces[0], traces[1], traces[2], traces[4]]).size).toBe(4);
    // A second connection must not replace the first connection's beat owner.
    jest.setSystemTime(Date.now() + 1000);
    await new ApiConnection({ enableABogus: false }).sendPassportTokenBeat('boot');
    await client.sendPassportTokenBeat('polling');
    expect(traces[5]).not.toBe(traces[0]);
    expect(traces[6]).toBe(traces[0]);
    // A new account lifecycle creates a new tokenBeat SDK owner, even if the
    // Node connection object is reused. Retired retries remain epoch-rejected.
    client.invalidateAuthenticationResponses();
    jest.setSystemTime(Date.now() + 1000);
    await client.sendPassportTokenBeat('boot');
    expect(traces[7]).not.toBe(traces[0]);
  });

  it.each(['qr', 'password'] as const)('uses the new UTC day for aid-sign but the original ts for a %s verification replay', async kind => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-12T23:59:59Z'));
    const requests: { url: URL; headers: Headers }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      return Response.json({ message: 'error', data: { error_code: 1105 } });
    });
    const client = new ApiConnection({ enableABogus: false });
    const first = kind === 'qr' ? await client.getQrcode().catch(error => error) : await client.userLogin('13800000000', 'fixture-password');
    jest.setSystemTime(new Date('2026-09-13T00:00:01Z'));
    if (kind === 'qr') await client.getQrcode({ error: first, fp: 'fixture-fp' }).catch(() => undefined);
    else await client.userLogin('13800000000', 'fixture-password', { retry: first, fp: 'fixture-fp' });
    expect(requests).toHaveLength(2);
    const initial = requests[0]!, retry = requests[1]!;
    for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) expect(retry.url.searchParams.get(key)).toBe(initial.url.searchParams.get(key));
    expect(retry.headers.get('x-tt-passport-aid-sign')).not.toBe(initial.headers.get('x-tt-passport-aid-sign'));
    expect(retry.headers.get('x-tt-passport-aid-sign')).toBe(buildPassportAidSign({
      aid: '339757', path: retry.url.pathname, ts: passportNoonUtcTs(new Date('2026-09-13T00:00:01Z')),
    }));
  });

  it.each([
    ['A中é', '44e1bda8c6ac'],
    ['a😀b', '6467'],
    ['\ud800A\udfff', '44'],
    ['\u0001😀1', '434'],
    ['\u0005', '0'],
    ['123456', '343736313033'],
  ])('signs and replays the exact Desktop password encoding for %j', async (password, encoded) => {
    const sent: { url: URL; body: string }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push({ url: new URL(String(input)), body: String(init?.body) });
      return Response.json({ message: 'error', data: { error_code: 1105 } });
    });
    const client = new ApiConnection({ enableABogus: false });
    const retry = await client.userLogin('13800000000', password);
    // Callback replay must use the original encoded/signed body, not encode again
    // or use changed credentials passed by a caller to the same endpoint.
    await client.userLogin('13800000000', 'changed-fixture-password', { retry, fp: 'fixture-captcha-fp' });
    expect(sent).toHaveLength(2);
    const original = sent[0]!;
    const body = Object.fromEntries(new URLSearchParams(original.body));
    expect(body['password']).toBe(encoded);
    expect(body['account']).toBe('2e3d332534363d3535353535353535');
    expect(body['mix_mode']).toBe('1');
    expect(body['fixed_mix_mode']).toBe('1');
    const query = Object.fromEntries(original.url.searchParams);
    delete query['sign']; delete query['qs'];
    const signed = buildPassportSignQs({ query, body: { ...body, password: encoded } });
    expect(original.url.searchParams.get('sign')).toBe(signed.sign);
    expect(original.url.searchParams.get('qs')).toBe(signed.qs);
    expect(sent[1]!.body).toBe(original.body);
    for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) {
      expect(sent[1]!.url.searchParams.get(key)).toBe(original.url.searchParams.get(key));
    }
  });

  it.each(['sendCode', 'sendVoiceCode', 'smsLogin', 'userLogin'] as const)(
    'keeps the Desktop international phone boundary in signed %s and its replay', async operation => {
      const sent: { url: URL; body: string }[] = [];
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        sent.push({ url: new URL(String(input)), body: String(init?.body) });
        return Response.json({ message: 'error', data: { error_code: 1105 } });
      });
      const client = new ApiConnection({ enableABogus: false });
      const request = (mobile: string, options: PassportLoginOptions = {}) => {
        if (operation === 'smsLogin') return client.smsLogin(mobile, '123456', options);
        if (operation === 'userLogin') return client.userLogin(mobile, 'fixture-password', options);
        return client[operation](mobile, options);
      };
      const retry = await request('+63 9000000000');
      await request('+86 13800000000', { retry, fp: 'fixture-captcha-fp' });
      expect(sent).toHaveLength(2);
      const original = sent[0]!;
      const body = Object.fromEntries(new URLSearchParams(original.body));
      // Original LOGIN country-code + space + local number -> module83848.MF.
      expect(body[operation === 'userLogin' ? 'account' : 'mobile']).toBe('2e3336253c353535353535353535');
      const query = Object.fromEntries(original.url.searchParams);
      delete query['sign']; delete query['qs'];
      expect(original.url.searchParams.get('sign')).toBe(buildPassportSignQs({ query, body }).sign);
      expect(sent[1]!.body).toBe(original.body);
      expect(sent[1]!.url.searchParams.get('sign')).toBe(original.url.searchParams.get('sign'));
    },
  );

  const verificationRequests = [
    ['qr-poll', (client: ApiConnection, options: PassportLoginOptions) => client.checkQrconnect('fixture-token', {}, options)],
    ['send-sms', (client: ApiConnection, options: PassportLoginOptions) => client.sendCode('13800000000', options)],
    ['send-voice', (client: ApiConnection, options: PassportLoginOptions) => client.sendVoiceCode('13800000000', options)],
    ['sms-login', (client: ApiConnection, options: PassportLoginOptions) => client.smsLogin('13800000000', '123456', options)],
    ['password-login', (client: ApiConnection, options: PassportLoginOptions) => client.userLogin('13800000000', 'fixture-password', options)],
  ] as const;

  it.each(verificationRequests)('re-encodes the original %s form literally for a secondary ticket', async (_name, request) => {
    const sent: { url: URL; body: string }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push({ url: new URL(String(input)), body: String(init?.body) });
      return Response.json({ message: 'error', data: { error_code: 2046 } });
    });
    const client = new ApiConnection({ enableABogus: false });
    const response = await request(client, { verificationFields: { fixture_reserved: 'a+/= %', fixture_object: { x: 1 } } });
    await request(client, { retry: response, verificationFields: { sms_code_key: 'new-key+/=' } });
    const first = sent[0]!, second = sent[1]!;
    // C321 $u.show -> LOGIN module83848 yJ (no decoding) -> qD.
    const expected = first.body.split('&').map(pair => {
      const [key = '', value = ''] = pair.split('=');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }).join('&') + '&sms_code_key=new-key%2B%2F%3D';
    expect(second.body).toBe(expected);
    expect(second.body).toContain('fixture_reserved=a%252B%252F%253D%2520%2525');
    expect(second.body).toContain('fixture_object=%257B%2522x%2522%253A1%257D');
    for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) expect(second.url.searchParams.get(key)).toBe(first.url.searchParams.get(key));
  });

  it.each(verificationRequests)('preserves the challenged %s request and pairs captcha fingerprints', async (_name, send) => {
    const requests: { url: URL; body: unknown }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: new URL(String(input)), body: init?.body });
      return Response.json({ message: 'error', data: { error_code: 1105 } });
    });
    const client = new ApiConnection({ enableABogus: false });
    const response = await send(client, {});
    await send(client, { retry: response, fp: 'fixture-fp' });
    const first = requests[0]!.url.searchParams, retry = requests[1]!.url.searchParams;
    for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) expect(retry.get(key)).toBe(first.get(key));
    expect(retry.has('isResend')).toBe(false);
    expect(retry.get('fp')).toBe('fixture-fp');
    expect(retry.get('verifyFp')).toBe('fixture-fp');
    expect(requests[1]!.body).toBe(requests[0]!.body);
  });

  it('patches a secondary form without re-signing or reusing new caller credentials', async () => {
    const requests: { url: URL; body: string }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: new URL(String(input)), body: String(init?.body) });
      return Response.json({ message: 'error', data: { error_code: 2046 } });
    });
    const client = new ApiConnection({ enableABogus: false });
    const response = await client.smsLogin('13800000000', '123456');
    await client.smsLogin('13900000000', '999999', {
      retry: response, verificationFields: { sms_code_key: 'fixture-key+/=' },
    });
    const first = requests[0]!, second = requests[1]!;
    const original = new URLSearchParams(first.body), retry = new URLSearchParams(second.body);
    expect(retry.get('mobile')).toBe(original.get('mobile'));
    expect(retry.get('code')).toBe(original.get('code'));
    expect(retry.get('sms_code_key')).toBe('fixture-key+/=');
    for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) expect(second.url.searchParams.get(key)).toBe(first.url.searchParams.get(key));
    expect(second.url.searchParams.has('fp')).toBe(false);
    expect(second.url.searchParams.has('verifyFp')).toBe(false);
  });

  it('rejects cross-connection, cross-endpoint, cloned and stale form retries before dispatch', async () => {
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ message: 'error', data: { error_code: 1105 } }));
    const client = new ApiConnection({ enableABogus: false });
    const retry = await client.sendCode('13800000000');
    await expect(new ApiConnection().sendCode('13800000000', { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    await expect(client.sendVoiceCode('13800000000', { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    await expect(client.sendCode('13800000000', { retry: structuredClone(retry) })).rejects.toThrow('已失效或不属于当前连接及接口');
    client.invalidateAuthenticationResponses();
    await expect(client.sendCode('13800000000', { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('replays a challenged QR request without leaking the internal resend marker', async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: new URL(String(input)), init: init! });
      return requests.length === 1
        ? Response.json({ message: 'error', data: { error_code: 1105 } }, {
            headers: { 'Set-Cookie': 'passport_csrf_token=after-challenge; Path=/', 'x-ms-token': 'new-token' },
          })
        : Response.json({ message: 'success', data: { qrcode: 'fixture-code', token: 'fixture-token' } });
    });
    const client = new ApiConnection({ enableABogus: false, msToken: 'old-token' });
    const error = await client.getQrcode().catch(error => error);
    expect(error).toBeInstanceOf(PassportRequestError);
    await expect(client.getQrcode({ error, fp: 'fixture-fp' })).resolves.toMatchObject({ token: 'fixture-token' });
    const first = requests[0]!.url.searchParams, retry = requests[1]!.url.searchParams;
    for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) expect(retry.get(key)).toBe(first.get(key));
    expect(retry.has('isResend')).toBe(false);
    expect(retry.get('fp')).toBe('fixture-fp');
    expect(retry.get('verifyFp')).toBe('fixture-fp');
    expect(retry.get('msToken')).toBe('old-token');
    expect(requests[1]!.init.body).toBeUndefined();
    expect(new Headers(requests[1]!.init.headers).get('x-tt-passport-csrf-token')).toBe('after-challenge');
  });

  it('keeps Passport challenge data private and snapshots it independently from its caller', () => {
    const data = { verify_center_decision_conf: 'private-fixture', nested: { value: 'initial' } };
    const error = new PassportRequestError('/passport/web/get_qrcode/?token=private-query', data);
    data.nested.value = 'changed';
    const copy = error.data; (copy['nested'] as { value: string }).value = 'changed-again';
    expect(error.data['nested']).toEqual({ value: 'initial' });
    for (const rendered of [String(error), JSON.stringify(error), inspect(error)]) {
      expect(rendered).not.toContain('private-fixture');
      expect(rendered).not.toContain('private-query');
    }
  });

  it('rejects foreign and invalidated QR retries before network dispatch', async () => {
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ message: 'error', data: { error_code: 1105 } }));
    const client = new ApiConnection({ enableABogus: false });
    const error = await client.getQrcode().catch(error => error);
    await expect(new ApiConnection().getQrcode({ error })).rejects.toThrow('已失效或不属于当前连接');
    client.invalidateAuthenticationResponses();
    await expect(client.getQrcode({ error })).rejects.toThrow('已失效或不属于当前连接');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('does not expose a QR from a failed Passport envelope with error_code=0', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'error', data: {
      error_code: 0, qrcode: 'fixture-code', token: 'fixture-token', expire_time: 2_000_000_000,
    } }));
    await expect(new ApiConnection({ enableABogus: false }).getQrcode()).rejects.toThrow();
  });

  it('does not override a successful QR envelope with a nested business error_code', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data: {
      error_code: 401, qrcode: 'fixture-code', token: 'fixture-token', expire_time: 2_000_000_000,
    } }));
    await expect(new ApiConnection({ enableABogus: false }).getQrcode()).resolves.toMatchObject({ token: 'fixture-token' });
  });

  it.each([undefined, {}, { qrcode: 'fixture' }, { token: 'fixture' }, { qrcode: 123, token: 'fixture' }])(
    'rejects an unusable QR payload without exposing a broken login event (%j)', async data => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data }));
      await expect(new ApiConnection({ enableABogus: false }).getQrcode()).rejects.toThrow('missing qrcode or token');
    },
  );

  it.each(['record', 'headers', 'tuples'] as const)('preserves %s request headers and overrides defaults case-insensitively', async kind => {
    let sent: Headers | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent = new Headers(init?.headers);
      return Response.json({});
    });
    const fields = { 'user-agent': 'synthetic-browser', accept: 'application/custom', 'x-fixture': 'present', cookie: 'sessionid=foreign' };
    const headers = kind === 'headers' ? new Headers(fields) : kind === 'tuples' ? Object.entries(fields) : fields;
    const client = new ApiConnection({ initialCookies: 'sessionid=owned', enableABogus: false });
    await client.requestRaw('https://imdesktop.douyin.com/passport/account/info/v2/', { headers }, true);
    expect(sent?.get('user-agent')).toBe('synthetic-browser');
    expect(sent?.get('accept')).toBe('application/custom');
    expect(sent?.get('x-fixture')).toBe('present');
    expect(sent?.get('cookie')).toBe('sessionid=owned');
    expect(new Headers(headers).get('cookie')).toBe('sessionid=foreign');
  });

  it('keeps tuple repeated values within the caller layer for byte requests', async () => {
    let sent!: Headers;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent = new Headers(init?.headers);
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const result = await new ApiConnection().requestBytes('https://imdesktop.douyin.com/fixture', {
      headers: [['X-Fixture', 'first'], ['x-fixture', 'second'], ['uSeR-aGeNt', 'fixture-agent']],
    });
    expect(sent.get('x-fixture')).toBe('first, second');
    expect(sent.get('user-agent')).toBe('fixture-agent');
    expect([...result.data]).toEqual([1, 2, 3]);
  });

  it('rejects invalid caller headers rather than dropping them before dispatch', async () => {
    const network = jest.spyOn(globalThis, 'fetch');
    await expect(new ApiConnection().requestRaw('https://imdesktop.douyin.com/fixture', {
      headers: [['invalid header', 'value']],
    })).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it('uses normal Passport Accept and falls back from an empty primary CSRF cookie', async () => {
    const requests: RequestInit[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(init!);
      return new Response(JSON.stringify({
        message: 'success', data: { token: 'offline-token', qrcode: 'fixture', expire_time: 2_000_000_000 },
      }));
    });
    const client = new ApiConnection({
      initialCookies: 'passport_csrf_token=; passport_csrf_token_default=fallback',
      enableABogus: false,
    });
    await client.getQrcode();
    expect(requests[0]!.headers).toMatchObject({
      Accept: 'application/json, text/javascript',
      'x-tt-passport-csrf-token': 'fallback',
    });
    expect(new Headers(requests[0]!.headers).has('Content-Type')).toBe(false);
    expect(requests[0]!.body).toBeUndefined();
    await client.getSelfProfile();
    expect(requests[1]!.headers).toMatchObject({ Accept: 'application/json, text/plain, */*' });
    expect(new Headers(requests[1]!.headers).has('x-tt-passport-csrf-token')).toBe(false);
  });

  it.each([
    ['/passport/web/get_qrcode/', 'deeba488ad62369e0767c683ae27a63f201974a15726636c06df583936525394'],
    ['/passport/token/beat/web/', '4293b9850fe3633a1a62fddfa438a739738edbd0ff26144e0e38b3a924ff3101'],
    ['/passport/account/info/v2/', 'f36f98d9fc409db70391c98f4b31e19ea39f934a45666ece038aa1cc4571e04a'],
  ])('matches the original Desktop HKDF aid-sign vector for %s', (path, expected) => {
    const ts = passportNoonUtcTs(new Date('2026-09-11T08:00:00Z'));
    expect(ts).toBe('1789128000');
    expect(buildPassportAidSign({
      aid: '339757',
      path,
      ts,
    })).toBe(expected);
  });

  it('sends the Passport account check as a signed normal SDK GET without QR or beat parameters', async () => {
    let sentUrl!: URL;
    let sentInit!: RequestInit;
    const payload = { message: 'success', data: { user_id_str: '10001', screen_name: 'fixture' } };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sentUrl = new URL(String(input)); sentInit = init!;
      return Response.json(payload);
    });
    const connection = new ApiConnection({
      initialCookies: 'sessionid=fixture; passport_csrf_token=fixture-csrf',
      deviceId: '123', installId: '456', accountSdkSourceInfo: 'fixture-source', enableABogus: false,
    });
    await expect(connection.getPassportAccountInfo()).resolves.toEqual(payload);
    expect(sentUrl.origin + sentUrl.pathname).toBe('https://imdesktop.douyin.com/passport/account/info/v2/');
    expect(sentInit.method).toBe('GET');
    expect(sentInit.body).toBeUndefined();
    expect(Object.fromEntries(sentUrl.searchParams)).toMatchObject({
      aid: '339757', device_id: '123', iid: '456', device_platform: 'PC',
      passport_jssdk_version: '2.4.12', passport_jssdk_type: 'normal',
      is_from_ttaccountsdk: '1', is_new_login: '1', is_from_iesaccountsaas: '1',
      account_sdk_source: 'web', account_sdk_source_info: 'fixture-source',
    });
    for (const key of ['next', 'token', 'need_logo', 'need_short_url', 'scene', 'version', 'is_native_h5']) {
      expect(sentUrl.searchParams.has(key)).toBe(false);
    }
    const headers = new Headers(sentInit.headers);
    expect(headers.has('content-type')).toBe(false);
    expect(headers.get('accept')).toBe('application/json, text/javascript');
    expect(headers.get('cookie')).toBe(connection.getCookies());
    expect(headers.get('x-tt-passport-csrf-token')).toBe('fixture-csrf');
    expect(headers.get('x-tt-passport-trace-id')).toBe(sentUrl.searchParams.get('biz_trace_id'));
    expect(headers.get('x-tt-passport-aid-sign')).toBe(buildPassportAidSign({
      aid: '339757', path: sentUrl.pathname, ts: sentUrl.searchParams.get('ts')!,
    }));
    const unsigned = Object.fromEntries(sentUrl.searchParams);
    delete unsigned['sign']; delete unsigned['qs'];
    const expected = buildPassportSignQs({ query: unsigned, body: {} });
    expect(sentUrl.searchParams.get('sign')).toBe(expected.sign);
    expect(sentUrl.searchParams.get('qs')).toBe(expected.qs);
    expect([...sentUrl.searchParams.keys()]).toEqual([
      'passport_jssdk_version', 'passport_jssdk_type', 'is_from_ttaccountsdk', 'aid', 'language', 'ts',
      'is_from_iesaccountsaas', 'account_sdk_source', 'account_sdk_source_info', 'p_js_v', 'p_js_t',
      'p_zt', 'p_ver', 'request_host', 'p_bd', 'biz_trace_id', 'is_new_login',
      'device_id', 'iid', 'version_code', 'device_platform', 'sign', 'qs',
    ]);
    expect(connection.getTicketGuardState()).toBeUndefined();
  });

  it.each(['boot', 'active', 'polling'] as const)('sends a single %s beat without the account/login wrapper flags', async scene => {
    let url!: URL; let init!: RequestInit;
    const controller = new AbortController();
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      url = new URL(String(input)); init = options!;
      return Response.json({ message: 'success', data: {} });
    });
    await new ApiConnection({ enableABogus: false, initialCookies: 'sessionid=fixture', verifyPortrait: 'login-only-portrait' }).sendPassportTokenBeat(scene, controller.signal);
    expect(network).toHaveBeenCalledTimes(1);
    expect(url.pathname).toBe('/passport/token/beat/web/');
    expect([...url.searchParams.keys()]).toEqual([
      'passport_jssdk_version', 'passport_jssdk_type', 'is_from_ttaccountsdk', 'aid', 'language', 'ts',
      'scene', 'account_sdk_source', 'account_sdk_source_info', 'p_js_v', 'p_js_t', 'p_zt',
      'p_ver', 'request_host', 'p_bd', 'biz_trace_id', 'version', 'device_id', 'iid',
      'version_code', 'device_platform', 'sign', 'qs',
    ]);
    expect(url.searchParams.get('scene')).toBe(scene);
    expect(url.searchParams.get('version')).toBe('1.2.13');
    expect(url.searchParams.get('passport_jssdk_version')).toBe('2.4.12');
    expect(url.searchParams.has('is_new_login')).toBe(false);
    expect(url.searchParams.has('is_from_iesaccountsaas')).toBe(false);
    expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.has('content-type')).toBe(false);
    expect(headers.get('accept')).toBe('application/json, text/javascript');
    expect(headers.get('cookie')).toBe('sessionid=fixture');
    expect(headers.has('x-tt-passport-verify-portrait')).toBe(false);
    expect(headers.get('x-tt-passport-aid-sign')).toBe(buildPassportAidSign({ aid: '339757', path: url.pathname, ts: url.searchParams.get('ts')! }));
    const query = Object.fromEntries(url.searchParams); delete query['sign']; delete query['qs'];
    expect(url.searchParams.get('sign')).toBe(buildPassportSignQs({ query, body: {} }).sign);
  });

  it.each([
    { message: 'success', data: { error_code: 401 } },
    { message: 'error', data: { error_code: 401 } },
    { message: 'error', data: { error_code: '401' } },
    { message: 'error', error_code: 401, data: {} },
  ])('preserves the original beat business response without fabricating logout (%j)', async payload => {
    const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload));
    await expect(new ApiConnection({ enableABogus: false }).sendPassportTokenBeat('boot')).resolves.toEqual(payload);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid or pre-cancelled beat requests before dispatch', async () => {
    const network = jest.spyOn(globalThis, 'fetch');
    const connection = new ApiConnection();
    // @ts-expect-error A JS caller can still supply an invalid scene.
    await expect(connection.sendPassportTokenBeat('background')).rejects.toThrow('Unsupported');
    const controller = new AbortController(); controller.abort(new Error('beat cancelled'));
    await expect(connection.sendPassportTokenBeat('boot', controller.signal)).rejects.toThrow('beat cancelled');
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps account-check business rejection and verification data intact without retrying', async () => {
    const payload = { message: 'error', data: {
      error_code: 1105, description: 'fixture rejection', verify_center_decision_conf: '{"fixture":true}',
    } };
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload));
    await expect(new ApiConnection({ enableABogus: false }).getPassportAccountInfo()).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch an account check that was already cancelled', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
    await expect(new ApiConnection().getPassportAccountInfo(controller.signal)).rejects.toThrow('fixture cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects cross-connection, cross-endpoint, cloned and stale account-info retries before dispatch', async () => {
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ message: 'error', data: { error_code: 1105 } }));
    const client = new ApiConnection({ enableABogus: false });
    const retry = await client.getPassportAccountInfo();
    await expect(new ApiConnection().getPassportAccountInfo(undefined, { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    await expect(client.sendCode('13800000000', { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    await expect(client.getPassportAccountInfo(undefined, { retry: structuredClone(retry) })).rejects.toThrow('已失效或不属于当前连接及接口');
    const form = await client.sendCode('13800000000');
    await expect(client.getPassportAccountInfo(undefined, { retry: form })).rejects.toThrow('已失效或不属于当前连接及接口');
    client.invalidateAuthenticationResponses();
    await expect(client.getPassportAccountInfo(undefined, { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('rejects cross-connection, cross-endpoint, cross-scene, cloned and stale token-beat retries', async () => {
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ message: 'error', data: { error_code: 1105 } }));
    const client = new ApiConnection({ enableABogus: false });
    const retry = await client.sendPassportTokenBeat('boot');
    await expect(new ApiConnection().sendPassportTokenBeat('boot', undefined, { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    await expect(client.getPassportAccountInfo(undefined, { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    await expect(client.sendPassportTokenBeat('active', undefined, { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    await expect(client.sendPassportTokenBeat('boot', undefined, { retry: structuredClone(retry) })).rejects.toThrow('已失效或不属于当前连接及接口');
    client.invalidateAuthenticationResponses();
    await expect(client.sendPassportTokenBeat('boot', undefined, { retry })).rejects.toThrow('已失效或不属于当前连接及接口');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('uses one stable device id from ttwid bootstrap through QR creation', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.pathname === '/ttwid/check/') {
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({
        message: 'success',
        data: {
          error_code: 0,
          token: 'qr-token',
          qrcode: 'base64',
          expire_time: 2_000_000_000,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new ApiConnection({ deviceId: '3249781169' });

    await client.ttwidCheck();
    await client.getQrcode();
    await client.checkQrconnect('qr-token');

    expect(requests).toHaveLength(3);
    expect(requests[0]!.url.origin).toBe('https://imdesktop.douyin.com');
    expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({
      aid: 339757,
      service: 'imdesktop.douyin.com',
      host: 'https://imdesktop.douyin.com',
      union: false,
    });
    expect((requests[0]!.init?.headers as Record<string, string>)['Cookie']).toBeUndefined();
    expect(requests[1]!.url.origin).toBe('https://imdesktop.douyin.com');
    expect(requests[1]!.url.searchParams.get('aid')).toBe('339757');
    expect(requests[1]!.url.searchParams.get('device_id')).toBe('3249781169');
    expect(requests[1]!.url.searchParams.get('device_platform')).toBe('PC');
    expect(requests[1]!.url.searchParams.get('next')).toBe('https://www.douyin.com');
    expect(requests[1]!.url.searchParams.has('msToken')).toBe(false);
    const unsignedQuery = Object.fromEntries(requests[1]!.url.searchParams);
    delete unsignedQuery['sign'];
    delete unsignedQuery['qs'];
    delete unsignedQuery['msToken'];
    delete unsignedQuery['a_bogus'];
    const desktopSignature = buildPassportSignQs({
      query: unsignedQuery,
      appKey: '3c452fb664e3de0e936108429a0bc697',
    });
    expect(requests[1]!.url.searchParams.get('sign')).toBe(desktopSignature.sign);
    expect(requests[1]!.url.searchParams.get('qs')).toBe(desktopSignature.qs);
    expect(requests[1]!.init?.headers).toMatchObject({
      'User-Agent': DESKTOP_LOGIN_USER_AGENT,
      Referer: 'https://imdesktop.douyin.com',
    });
    const requestHeaders = requests[1]!.init?.headers as Record<string, string>;
    expect(requestHeaders['x-tt-passport-csrf-token']).toBe('');
    expect(requestHeaders['x-tt-passport-trace-id']).toBe(
      requests[1]!.url.searchParams.get('biz_trace_id'),
    );
    expect(requestHeaders['x-tt-passport-aid-sign']).toBe(buildPassportAidSign({
      aid: '339757',
      path: '/passport/web/get_qrcode/',
      ts: requests[1]!.url.searchParams.get('ts')!,
    }));
    expect(String(requests[2]!.init?.body)).toBe(
      'need_logo=false&need_short_url=false&is_frontier=true&token=qr-token&' +
      'is_new_login=1&next=https%3A%2F%2Fwww.douyin.com',
    );
    expect(requests[2]!.url.searchParams.has('msToken')).toBe(false);
    const checkQuery = Object.fromEntries(requests[2]!.url.searchParams);
    delete checkQuery['sign'];
    delete checkQuery['qs'];
    delete checkQuery['msToken'];
    delete checkQuery['a_bogus'];
    const checkSignature = buildPassportSignQs({
      query: checkQuery,
      body: Object.fromEntries(new URLSearchParams(String(requests[2]!.init?.body))),
      appKey: '3c452fb664e3de0e936108429a0bc697',
    });
    expect(requests[2]!.url.searchParams.get('sign')).toBe(checkSignature.sign);
    expect(requests[2]!.url.searchParams.get('qs')).toBe(checkSignature.qs);
  });

  it('does not promote Cookie msToken into the Passport signing token', async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      return Response.json({ message: 'success', data: {} }, {
        headers: { 'Set-Cookie': 'msToken=rotated-cookie; Path=/' },
      });
    });
    const connection = new ApiConnection({ enableABogus: false, initialCookies: 'msToken=initial-cookie' });
    await connection.sendCode('13800000000');
    await connection.sendVoiceCode('13800000000');
    expect(requests.map(request => request.url.searchParams.get('msToken'))).toEqual([null, null]);
    expect(requests.map(request => request.headers.get('cookie'))).toEqual(['msToken=initial-cookie', 'msToken=rotated-cookie']);
  });

  it('keeps an explicit signing token separate from Cookie mutations and export', async () => {
    const requests: URL[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      requests.push(new URL(String(input)));
      return Response.json({ message: 'success', data: {} }, {
        headers: { 'Set-Cookie': 'msToken=rotated-cookie; Path=/' },
      });
    });
    const connection = new ApiConnection({ enableABogus: false, initialCookies: 'msToken=cookie', msToken: 'explicit-token' });
    expect(connection.getCookies()).toBe('msToken=cookie');
    await connection.sendCode('13800000000');
    connection.setMsToken('next-explicit-token');
    await connection.sendVoiceCode('13800000000');
    expect(requests.map(url => url.searchParams.get('msToken'))).toEqual(['explicit-token', 'next-explicit-token']);
    expect(connection.getMsToken()).toBe('next-explicit-token');
    expect(connection.getCookies()).toBe('msToken=rotated-cookie');
    expect(new ApiConnection({ initialCookies: connection.getCookies() }).getMsToken()).toBeUndefined();
  });

  it.each([undefined, 'cached-token', ''])('uses cached-or-absent msToken across normal Passport requests (%s)', async (token) => {
    const urls: URL[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ message: 'success', data: {
        qrcode: 'fixture', token: 'qr-fixture', expire_time: 2_000_000_000,
      } }));
    });
    const connection = new ApiConnection({ enableABogus: false, ...(token === undefined ? {} : { msToken: token }) });
    await connection.getQrcode();
    await connection.checkQrconnect('qr-fixture');
    await connection.sendCode('13800000000');
    for (const url of urls) expect(url.searchParams.get('msToken')).toBe(token || null);
  });

  it('does not import a business x-ms-token header into the next Passport query', async () => {
    const urls: URL[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ message: 'success', data: {} }), {
        headers: urls.length === 1 ? { 'x-ms-token': 'response-token' } : {},
      });
    });
    const connection = new ApiConnection({ enableABogus: false, msToken: 'cached-token' });
    await connection.sendCode('13800000000');
    await connection.sendVoiceCode('13800000000');
    connection.setMsToken('');
    await connection.sendCode('13800000000');
    expect(urls.map(url => url.searchParams.get('msToken'))).toEqual(['cached-token', 'cached-token', null]);
  });

  it.each(['passport', 'verification', 'bytes', 'raw'] as const)(
    'keeps real Set-Cookie updates separate from report-only x-ms-token (%s)', async route => {
      const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data: {} }, {
        headers: {
          'Set-Cookie': 'msToken=cookie-token; Path=/; Secure',
          'x-ms-token': 'report-only-token',
        },
      }));
      const client = new ApiConnection({ enableABogus: false, msToken: 'cached-token' });
      const url = 'https://imdesktop.douyin.com/passport/web/send_code/';
      if (route === 'passport') await client.sendCode('13800000000');
      else if (route === 'verification') await client.requestVerificationRaw(url, { method: 'POST' });
      else if (route === 'bytes') await client.requestBytes(url, { method: 'POST' });
      else await client.requestRaw(url, { method: 'POST' });
      expect(client.getMsToken()).toBe('cached-token');
      expect(client.getCookies()).toContain('msToken=cookie-token');
      expect(client.getCookies()).not.toContain('report-only-token');
      expect(network).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['sms-code', 'is6Digits=1&mix_mode=1&mobile=2e3d332534363d3535353535353535&type=3731&fixed_mix_mode=1'],
    ['voice-code', 'is6Digits=1&mix_mode=1&mobile=2e3d332534363d3535353535353535&type=3731&fixed_mix_mode=1'],
    ['sms-login', 'service=https%3A%2F%2Fwww.douyin.com&mix_mode=1&mobile=2e3d332534363d3535353535353535&code=343736313033&fixed_mix_mode=1&login_only=true'],
    ['password', 'need_check_base_info=true&service=https%3A%2F%2Fwww.douyin.com&account_type=0&mix_mode=1&account=2e3d332534363d3535353535353535&password=55647676726a776134&fixed_mix_mode=1'],
  ])('matches the original first-login wrapper body for %s', async (action, expectedBody) => {
    let sentBody = '';
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sentBody = String(init?.body);
      return new Response(JSON.stringify({ message: 'success', data: {} }));
    });
    const connection = new ApiConnection({ enableABogus: false });
    if (action === 'sms-code') await connection.sendCode('13800000000');
    else if (action === 'voice-code') await connection.sendVoiceCode('13800000000');
    else if (action === 'sms-login') await connection.smsLogin('13800000000', '123456');
    else await connection.userLogin('13800000000', 'Password1');
    expect(sentBody).toBe(expectedBody);
    expect(new URLSearchParams(sentBody).has('safe_mobile_register_to_login')).toBe(false);
  });

  it.each(['sms', 'password'])('preserves original %s selected-account body order and flag', async (method) => {
    let sentBody = '';
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sentBody = String(init?.body);
      return new Response(JSON.stringify({ message: 'success', data: {} }));
    });
    const connection = new ApiConnection({ enableABogus: false });
    const options = { subAccount: { smsCodeKey: 'selection', secUid: 'fixture-sec' } };
    if (method === 'sms') await connection.smsLogin('13800000000', '123456', options);
    else await connection.userLogin('13800000000', 'Password1', options);
    expect(sentBody.startsWith('safe_mobile_register_to_login=true&')).toBe(true);
    const suffix = 'ignore_reused_mobile=1&sms_code_key=selection&sms_code_key_not_mix=1&sec_uid=fixture-sec';
    expect(sentBody.endsWith(suffix + (method === 'sms' ? '&login_only=true' : ''))).toBe(true);
  });

  it('checks Passport before resolving the restored Session Douyin UID through self-profile', async () => {
    let request!: { url: URL; headers: Record<string, string> };
    const paths: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      request = {
        url: new URL(String(input)),
        headers: init?.headers as Record<string, string>,
      };
      paths.push(request.url.pathname);
      if (request.url.pathname === '/passport/account/info/v2/') {
        return Response.json({ message: 'success', data: { user_id_str: 'different-passport-identity' } }, {
          headers: { 'set-cookie': 'sessionid=rotated; Path=/' },
        });
      }
      return new Response(JSON.stringify({
        status_code: 0,
        user: { uid: '1150530166719210', nickname: '测试账号' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new ApiConnection({
      deviceId: '3249781169',
      guid: 'e1e22f562860a101ad6ce426fc446454',
      screenWidth: 1707,
      screenHeight: 1067,
      initialCookies: 'sessionid=session',
    });

    await expect(client.probeSession()).resolves.toEqual({
      status: 'alive',
      uid: '1150530166719210',
      screenName: '测试账号',
      reason: 'ok',
    });
    expect(request.url.pathname).toBe('/aweme/v1/web/user/profile/self/');
    expect(paths).toEqual(['/passport/account/info/v2/', '/aweme/v1/web/user/profile/self/']);
    expect(request.url.searchParams.get('device_id')).toBe('3249781169');
    expect(request.url.searchParams.get('awemeim_guid')).toBe('e1e22f562860a101ad6ce426fc446454');
    expect(request.url.searchParams.get('screen_width')).toBe('1707');
    expect(request.url.searchParams.get('screen_height')).toBe('1067');
    expect(request.headers['Cookie']).toBe('sessionid=rotated');
    expect(request.headers).not.toHaveProperty('x-tt-passport-aid-sign');
  });

  it.each([8, 9])('treats renderer self-profile status %s as an expired session', async (statusCode) => {
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ message: 'success', data: {} }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
      status_code: statusCode,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new ApiConnection({ deviceId: '3249781169' });

    await expect(client.probeSession()).resolves.toMatchObject({ status: 'expired' });
  });

  it.each(['passport', 'profile'] as const)('propagates cancellation during the %s probe without reporting expiry', async stage => {
    const controller = new AbortController(); const reason = new Error('restore cancelled');
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(init?.signal).toBe(controller.signal);
      if (stage === 'profile' && new URL(String(input)).pathname === '/passport/account/info/v2/') {
        return Response.json({ message: 'success', data: {} });
      }
      markStarted();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = new ApiConnection().probeSession(controller.signal);
    const cancelled = expect(pending).rejects.toBe(reason);
    await started;
    controller.abort(reason);
    await cancelled;
  });

  it.each([
    { message: 'error', data: { error_code: 1105, verify_center_decision_conf: 'private-challenge' } },
    { message: 'error', data: { description: 'private-description' } },
    { status_code: 0, user: { uid: '10001' } },
  ])('does not accept an unsuccessful or malformed Passport check as an alive/expired Session (%j)', async payload => {
    const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload));
    const result = await new ApiConnection({ enableABogus: false }).probeSession();
    expect(result.status).toBe('error');
    expect(result.reason).toMatch(/^Passport account check rejected session/);
    expect(result.reason).not.toContain('private-');
    expect(result.uid).toBeUndefined();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('uses the jumpbyte lite Passport flow for QR MFA', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, ...(init ? { init } : {}) });
      const data = url.pathname.endsWith('/send_code/')
        ? { error_code: 0, mobile: '138****8000' }
        : { error_code: 0, ticket: 'verified' };
      return new Response(JSON.stringify({ message: 'success', data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new ApiConnection({ deviceId: '3249781169' });
    const challenge = {
      encrypt_uid: 'encrypted-user',
      biz_params: {
        std_verify_flow_id: 'flow-id',
        std_verify_token: 'verify-token',
      },
      common_params: { new_verify_flow: '1' },
    };

    await client.sendQrMfaCode(challenge);
    await client.validateQrMfaCode(challenge, '123456');

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url.origin).toBe('https://imdesktop.douyin.com');
      expect(request.url.searchParams.get('passport_jssdk_type')).toBe('lite');
      expect(request.url.searchParams.get('passport_jssdk_version')).toBe('5.1.2');
      expect(request.url.searchParams.has('sign')).toBe(false);
      expect(request.url.searchParams.has('qs')).toBe(false);
      expect(request.url.searchParams.get('a_bogus')).toBeTruthy();
    }
    const sendBodyWire = String(requests[0]!.init?.body);
    const validateBodyWire = String(requests[1]!.init?.body);
    const sendBody = new URLSearchParams(sendBodyWire);
    const validateBody = new URLSearchParams(validateBodyWire);
    expect(sendBody.get('encrypt_uid')).toBe('encrypted-user');
    expect(sendBody.get('std_verify_flow_id')).toBe('flow-id');
    expect(sendBody.get('is6Digits')).toBe('1');
    expect(validateBody.get('code')).toBe('343736313033');
    expect(sendBodyWire).toBe(
      'aid=339757&new_authn_sdk_version=1.0.0.421-web&copywriting_key=qr_connect&' +
      'encrypt_uid=encrypted-user&ies_safety_diversion_tag=mfa&is6Digits=1&mix_mode=1&' +
      'new_verify_flow=1&std_verify_flow_id=flow-id&std_verify_scene=account_login&' +
      'std_verify_template=ato&std_verify_token=verify-token&std_verify_type=MFA&' +
      'std_verify_way=mobile_sms_verify&type=3737&verify_ticket=',
    );
    expect(validateBodyWire).toBe(
      'aid=339757&new_authn_sdk_version=1.0.0.421-web&code=343736313033&' +
      'copywriting_key=qr_connect&encrypt_uid=encrypted-user&ies_safety_diversion_tag=mfa&' +
      'mix_mode=1&new_verify_flow=1&std_verify_flow_id=flow-id&' +
      'std_verify_scene=account_login&std_verify_template=ato&std_verify_token=verify-token&' +
      'std_verify_type=MFA&std_verify_way=mobile_sms_verify&type=3737&verify_ticket=',
    );
  });

  it('uses Desktop Passport for SMS and phone-password login', async () => {
    const requests: Array<{ url: URL; body: string }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: new URL(String(input)), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ message: 'success', data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new ApiConnection({ deviceId: '3249781169' });

    await client.sendCode('+86 138-0000-0000');
    await client.sendVoiceCode('+86 138-0000-0000');
    await client.smsLogin('8613800000000', '123456');
    await client.userLogin('13800000000', 'Password1');

    expect(requests.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([
      'https://imdesktop.douyin.com/passport/web/send_code/',
      'https://imdesktop.douyin.com/passport/web/send_voice_code/',
      'https://imdesktop.douyin.com/passport/web/sms_login/',
      'https://imdesktop.douyin.com/passport/web/user/login/',
    ]);
    for (const { url } of requests) {
      expect(url.searchParams.get('aid')).toBe('339757');
      expect(url.searchParams.get('device_platform')).toBe('PC');
      expect(url.searchParams.get('version_code')).toBe('1.2.1');
      expect(url.searchParams.get('sign')).toBeTruthy();
      expect(url.searchParams.get('qs')).toBeTruthy();
    }
    expect(new URLSearchParams(requests[0]!.body).get('mobile')).toBe(
      '2e3d332534363d3535353535353535',
    );
    expect(new URLSearchParams(requests[1]!.body).get('mobile')).toBe(
      '2e3d332534363d3535353535353535',
    );
    expect(new URLSearchParams(requests[2]!.body).get('service')).toBe('https://www.douyin.com');
    expect(new URLSearchParams(requests[2]!.body).get('login_only')).toBe('true');
    expect(new URLSearchParams(requests[2]!.body).has('safe_mobile_register_to_login')).toBe(false);
    expect(new URLSearchParams(requests[3]!.body).get('account')).toBe(
      '2e3d332534363d3535353535353535',
    );
    expect(new URLSearchParams(requests[3]!.body).get('password')).toBe(
      '55647676726a776134',
    );
    expect(new URLSearchParams(requests[3]!.body).has('safe_mobile_register_to_login')).toBe(false);
  });

  it('continues a 1454 multi-account login with the exact desktop selection fields', async () => {
    let body = '';
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      body = String(init?.body ?? '');
      return new Response(JSON.stringify({ message: 'success', data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new ApiConnection({ deviceId: '3249781169' });

    await client.userLogin('13800000000', 'Password1', {
      subAccount: { smsCodeKey: 'selection-key', secUid: 'MS4wLjABAAAAselected' },
    });

    const form = new URLSearchParams(body);
    expect(form.get('ignore_reused_mobile')).toBe('1');
    expect(form.get('sms_code_key')).toBe('selection-key');
    expect(form.get('sms_code_key_not_mix')).toBe('1');
    expect(form.get('sec_uid')).toBe('MS4wLjABAAAAselected');
    expect(form.has('register_new_user')).toBe(false);
  });

  it('isolates verify-center requests from account cookies and Passport headers', async () => {
    let request!: { url: URL; headers: Record<string, string> };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      request = {
        url: new URL(String(input)),
        headers: init?.headers as Record<string, string>,
      };
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json',
        'set-cookie': 'sessionid=untrusted-session; Path=/', 'x-ms-token': 'untrusted-token' } });
    });
    const client = new ApiConnection({
      deviceId: '3249781169',
      initialCookies: 'sessionid=secret-session; passport_csrf_token=secret-csrf',
    });

    await client.requestVerificationRaw('https://vcs.zijieapi.com/vc/setting?aid=339757', {
      method: 'GET',
      headers: { 'X-Setting-Flag': '1' },
    });

    expect(request.url.origin).toBe('https://vcs.zijieapi.com');
    expect(new Headers(request.headers).get('user-agent')).toBe(DESKTOP_LOGIN_USER_AGENT);
    expect(new Headers(request.headers).get('x-setting-flag')).toBe('1');
    expect(request.headers).not.toHaveProperty('Cookie');
    expect(request.headers).not.toHaveProperty('Referer');
    expect(request.headers).not.toHaveProperty('x-tt-passport-aid-sign');
    expect(request.headers).not.toHaveProperty('x-tt-passport-csrf-token');
    expect(client.getCookies()).toBe('sessionid=secret-session; passport_csrf_token=secret-csrf');
    expect(client.getMsToken()).toBeUndefined();
  });
});
