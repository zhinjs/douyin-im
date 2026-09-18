import { encodeActionVerificationPack } from './second-verify.js';
import { ApiConnection } from './api-connection.js';
import { PassportRequestError } from './passport-error.js';
import { inspect } from 'node:util';

afterEach(() => jest.restoreAllMocks());

it.each([
  { cookie: '', token: null },
  { cookie: 'passport_csrf_token=;', token: null },
  { cookie: 'passport_csrf_token=primary', token: 'primary' },
  { cookie: 'passport_csrf_token=; passport_csrf_token_default=fallback', token: 'fallback' },
  { cookie: 'passport_csrf_token=primary; passport_csrf_token_default=fallback', token: 'primary' },
  { cookie: 'passport_csrf_token=a%2Bb%25c', token: 'a+b%c' },
  { cookie: 'passport_csrf_token=%u0041%ZZ', token: 'A%ZZ' },
])('uses original AccountSDK CSRF presence and decoding for first pack and middleware: $cookie', async ({ cookie, token }) => {
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ message: 'success', data: {} }));
  const client = new ApiConnection({ initialCookies: cookie });
  const storedCookie = client.getCookies();
  await client.packActionVerification({ verify_from: 'verify_center' });
  for (const pipeline of ['fetch', 'fetchSec'] as const) {
    await client.requestVerificationRaw('https://imdesktop.douyin.com/passport/web/validate_code/',
      { method: 'POST', body: 'code=34' }, 'action', pipeline);
  }
  expect(request).toHaveBeenCalledTimes(3);
  for (const [, init] of request.mock.calls) {
    const headers = new Headers(init?.headers);
    expect(headers.get('x-tt-passport-csrf-token')).toBe(token);
    // Decoding is a header-read rule, not a mutation of stored Cookie bytes.
    if (storedCookie) expect(headers.get('cookie')).toBe(storedCookie);
    expect(headers.has('x-tt-passport-aid-sign')).toBe(false);
  }
  expect(client.getCookies()).toBe(storedCookie);
});

it.each([
  { value: { message: 'success', data: { url: 'https://verify.example/fixture.js' } }, accepted: true },
  { value: { message: 'success', data: { error_code: 99, url: 'https://verify.example/fixture.js' } }, accepted: true },
  { value: { message: 'success', error_code: 99, url: 'https://verify.example/fixture.js' }, accepted: true },
  { value: { message: 'success', data: null, url: 'https://verify.example/fixture.js' }, accepted: true },
  { value: { message: 'error', data: { url: 'https://verify.example/fixture.js' } }, accepted: false },
  { value: { message: 'error', error_code: 8, data: { error_code: 0, url: 'https://verify.example/fixture.js' } }, accepted: false },
  { value: { error_code: 0, data: { url: 'https://verify.example/fixture.js' } }, accepted: false },
  { value: { data: { url: 'https://verify.example/fixture.js' } }, accepted: false },
  { value: { message: true, data: {} }, accepted: false },
  { value: { message: 'SUCCESS', data: {} }, accepted: false },
])('uses outer Passport success before projecting the business pack: %j', async ({ value, accepted }) => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(value));
  const result = new ApiConnection().packActionVerification({ verify_from: 'verify_center' });
  if (accepted) await expect(result).resolves.toEqual('data' in value && value.data || value);
  else await expect(result).rejects.toBeInstanceOf(PassportRequestError);
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps rejected pack details available without leaking them in diagnostics', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'error', data: {
    error_code: 2046, sms_code_key: 'fixture-secret', url: 'https://verify.example/?token=fixture-secret',
  } }));
  const result = await new ApiConnection().packActionVerification({ verify_from: 'verify_center' }).catch(error => error);
  expect(result).toBeInstanceOf(PassportRequestError);
  expect(result.errorCode).toBe(2046);
  expect(result.data.sms_code_key).toBe('fixture-secret');
  expect(inspect(result)).not.toContain('fixture-secret');
});

it.each(['raw', 'fetch', 'fetchSec'] as const)('preserves AccountSDK %s headers in login and action contexts', async pipeline => {
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ message: 'success' }));
  for (const context of ['login', 'action'] as const) for (const csrf of ['', 'fixture-csrf']) {
    const client = new ApiConnection({ initialCookies: `sessionid=fixture-session; passport_csrf_token_default=${csrf}` });
    await client.requestVerificationRaw('https://imdesktop.douyin.com/passport/web/validate_code/', {
      method: 'POST', headers: { 'x-use-secondary-verify-sdk': '1' }, body: 'code=34',
    }, context, pipeline);
    const headers = new Headers(request.mock.calls.at(-1)![1]?.headers);
    expect(headers.get('x-tt-passport-csrf-token')).toBe(pipeline === 'raw' || !csrf ? null : csrf);
    expect(headers.has('x-tt-passport-aid-sign')).toBe(false);
    expect(headers.get('cookie')).toContain('sessionid=fixture-session');
    expect(headers.get('x-use-secondary-verify-sdk')).toBe('1');
    expect(headers.get('referer')).toBe('https://imdesktop.douyin.com');
  }
});

it('keeps the first business verification pack on the same Desktop referer contract', async () => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data: { fixture: true } }));
  await new ApiConnection().packActionVerification({ verify_from: 'verify_center' });
  const headers = new Headers(request.mock.calls[0]![1]?.headers);
  expect(headers.get('referer')).toBe('https://imdesktop.douyin.com');
  expect(headers.has('x-tt-passport-aid-sign')).toBe(false);
});

it.each(['raw', 'bytes'] as const)('applies the Desktop main header after caller overrides (%s)', async kind => {
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
  const client = new ApiConnection();
  const options = { method: 'GET', headers: { ReFeReR: 'http://127.0.0.1:1234/verification?token=fixture' } };
  const url = 'https://imdesktop.douyin.com/passport/fixture/';
  if (kind === 'raw') await client.requestRaw(url, options);
  else await client.requestBytes(url, options);
  expect(new Headers(request.mock.calls[0]![1]?.headers).get('referer')).toBe('https://imdesktop.douyin.com');
});

it.each(['verify.zijieapi.com', 'vcs.zijieapi.com'])('does not extend Desktop account headers to %s', async host => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success' }));
  const client = new ApiConnection({ initialCookies: 'sessionid=fixture; passport_csrf_token=fixture' });
  await client.requestVerificationRaw(`https://${host}/fixture`, { method: 'GET' }, 'login', 'fetchSec');
  const headers = new Headers(request.mock.calls[0]![1]?.headers);
  for (const name of ['referer', 'cookie', 'x-tt-passport-csrf-token', 'x-tt-passport-aid-sign']) {
    expect(headers.has(name)).toBe(false);
  }
});

it('matches the minimal AccountSDK business pack form without login query params', async () => {
  const client = new ApiConnection({ deviceId: 'did', installId: 'iid', initialCookies: 'passport_csrf_token=fixture' });
  const request = jest.spyOn(client, 'requestRaw').mockResolvedValue({ ok: true, status: 200, headers: new Headers(),
    rawText: '{"message":"success","data":{"url":"https://verify.example/script.js"}}', data: '' });
  await expect(client.packActionVerification({ verify_from: 'verify_center', is_login: true, device_id: 'wrong', detail: { key: 'fixture' } }))
    .resolves.toEqual({ url: 'https://verify.example/script.js' });
  const [url, init, passport] = request.mock.calls[0]!;
  expect(url).toBe('https://imdesktop.douyin.com/passport/safe/pack_verify_ways_data/');
  expect(passport).toBe(false);
  expect(new Headers(init.headers).get('x-tt-passport-csrf-token')).toBe('fixture');
  expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
    aid: '339757', verify_from: 'verify_center', device_id: 'did', iid: 'iid', version_code: '1.2.1',
    device_platform: process.platform, detail: '{"key":"fixture"}', mix_mode: '0', fixed_mix_mode: '0',
  });
});

it.each(['darwin', 'win32'] as const)('uses the %s renderer platform in business verification pack, not native certificate PC', platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: platform });
    const fields = Object.fromEntries(new URLSearchParams(encodeActionVerificationPack({ device_platform: 'wrong' }, 'did', 'iid')));
    expect(fields['device_platform']).toBe(platform);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

it.each(['passport_csrf_token_default=fixture-default', 'passport_csrf_token=; passport_csrf_token_default=fixture-default'])('uses default CSRF when the primary cookie is absent or empty (%s)', initialCookies => {
  const client = new ApiConnection({ initialCookies });
  const request = jest.spyOn(client, 'requestRaw').mockResolvedValue({ ok: true, status: 200, headers: new Headers(),
    rawText: '{"message":"success","data":{"url":"https://verify.example/script.js"}}', data: '' });
  return client.packActionVerification({ verify_from: 'verify_center' }).then(() => {
    expect(new Headers(request.mock.calls[0]![1].headers).get('x-tt-passport-csrf-token')).toBe('fixture-default');
  });
});

it.each(['passport_csrf_token_default=fixture-default', 'passport_csrf_token=; passport_csrf_token_default=fixture-default'])('uses the same CSRF fallback in subsequent business verification requests (%s)', async initialCookies => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data: {} }));
  const client = new ApiConnection({ initialCookies });
  await client.requestVerificationRaw('https://imdesktop.douyin.com/passport/web/validate_code/', { method: 'POST' }, 'action');
  expect(new Headers(request.mock.calls[0]![1]?.headers).get('x-tt-passport-csrf-token')).toBe('fixture-default');
});

it('uses Desktop XOR5 field encoding while retaining the business pack form', () => {
  const body = encodeActionVerificationPack({ code: '\u0001😀1', detail: 'a b' }, 'did', 'iid');
  const fields = Object.fromEntries(new URLSearchParams(body));
  expect(fields).toMatchObject({ code: '434', detail: 'a b', mix_mode: '1', fixed_mix_mode: '1' });
  expect(body).toContain('detail=a%20b');
});

it('injects account CSRF for direct business verification without normal login-only headers', async () => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  const client = new ApiConnection({ initialCookies: 'sessionid=fixture-session; passport_csrf_token=jar-csrf' });
  await client.requestVerificationRaw('https://imdesktop.douyin.com/passport/web/validate_code/?code=encoded', {
    method: 'GET', headers: { 'x-tt-passport-csrf-token': '', 'x-use-secondary-verify-sdk': '1' },
  }, 'action');
  const headers = new Headers(request.mock.calls[0]![1]?.headers);
  expect(headers.get('x-tt-passport-csrf-token')).toBe('jar-csrf');
  expect(headers.get('cookie')).toContain('fixture-session');
  expect(headers.get('x-use-secondary-verify-sdk')).toBe('1');
  expect(headers.has('x-tt-passport-aid-sign')).toBe(false);
  expect(new URL(String(request.mock.calls[0]![0])).searchParams.has('is_new_login')).toBe(false);
});
