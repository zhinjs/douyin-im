import { runInNewContext } from 'node:vm';
import { verificationXhrBridgeScript } from './verification-xhr.js';
import { ApiConnection } from '../../desktop/api-connection.js';

class NativeFixture extends EventTarget {
  readyState = 0;
  status = 0;
  statusText = '';
  responseText = '';
  responseURL = '';
  response: unknown;
  responseType = '';
  timeout = 0;
  withCredentials = false;
  open = undefined as unknown as (method: string, url: string, async?: boolean) => void;
  constructor() { super(); delete (this as Partial<NativeFixture>).open; }
  setRequestHeader(_key: string, _value: string): void { void _key; void _value; }
  getResponseHeader(_key: string): string | null { void _key; return null; }
  getAllResponseHeaders(): string { return ''; }
  send(_body?: string): void { void _body; }
  abort(): void { /* native fallback fixture */ }
}
const nativeOpen = jest.fn();
NativeFixture.prototype.open = nativeOpen;

function fixture() {
  const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    status: 200, statusText: 'OK', headers: { 'X-Fixture': 'yes' }, rawText: '{"error_code":0}',
  }) });
  const window = { XMLHttpRequest: NativeFixture, __LOGIN_VERIFY__: { sessionToken: 'local-token' } };
  runInNewContext(verificationXhrBridgeScript(), { window, fetch, URL, URLSearchParams, Event, AbortController, setTimeout, clearTimeout });
  return { xhr: new window.XMLHttpRequest(), fetch };
}
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(() => { nativeOpen.mockClear(); jest.restoreAllMocks(); jest.useRealTimers(); });

it.each([
  ['login', 'fixture-csrf'], ['login', ''], ['action', 'fixture-csrf'], ['action', ''],
] as const)('keeps direct %s XHR outside normal login signing while retaining account guards (CSRF=%s)', async (context, csrf) => {
  const connection = new ApiConnection({ initialCookies: `sessionid=fixture-session; passport_csrf_token=${csrf}` });
  connection.enableTicketGuard(() => undefined);
  let sent: Headers | undefined;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
    if (String(target).includes('/get_client_cert/')) return Response.json({ message: 'success', data: {} });
    sent = new Headers(init?.headers);
    return Response.json({ error_code: 0 });
  });
  const proxy = jest.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    const result = await connection.requestVerificationRaw(payload.url, {
      method: payload.method, headers: payload.headers,
    }, context, payload.pipeline);
    return { ok: true, json: async () => ({ status: result.status, statusText: 'OK', rawText: result.rawText, headers: {} }) };
  });
  const window = { XMLHttpRequest: NativeFixture, __LOGIN_VERIFY__: { sessionToken: 'local-token' } };
  runInNewContext(verificationXhrBridgeScript(), { window, fetch: proxy, URL, URLSearchParams, Event, AbortController, setTimeout, clearTimeout });
  const xhr = new window.XMLHttpRequest();
  const loaded = new Promise<void>((resolve, reject) => {
    xhr.addEventListener('load', () => resolve());
    xhr.addEventListener('error', () => reject(new Error('fixture proxy failed')));
  });
  xhr.open('GET', '/passport/web/validate_code/?code=fixture');
  xhr.setRequestHeader('x-use-secondary-verify-sdk', '1');
  xhr.send(); await loaded;
  expect(sent?.get('x-use-secondary-verify-sdk')).toBe('1');
  expect(sent?.get('referer')).toBe('https://imdesktop.douyin.com');
  expect(sent?.get('cookie')).toContain('sessionid=fixture-session');
  expect(sent?.get('x-tt-passport-csrf-token')).toBe(csrf);
  expect(sent?.get('bd-ticket-guard-ree-public-key')).toBeTruthy();
  for (const header of ['x-tt-passport-aid-sign', 'x-tt-passport-trace-id', 'x-tt-passport-verify-portrait']) {
    expect(sent?.has(header)).toBe(false);
  }
});

it('proxies only Desktop Passport XHR and preserves response states, headers and body', async () => {
  const { xhr, fetch } = fixture();
  const states: number[] = [];
  const loaded = jest.fn();
  xhr.addEventListener('readystatechange', () => states.push(xhr.readyState));
  xhr.addEventListener('load', loaded);
  xhr.open('POST', '/passport/web/validate_code/?aid=339757');
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.send('code=3437');
  await flush();
  expect(states).toEqual([1, 2, 3, 4]);
  expect(loaded).toHaveBeenCalledTimes(1);
  expect(xhr.status).toBe(200);
  expect(xhr.responseText).toBe('{"error_code":0}');
  expect(xhr.getResponseHeader('x-FIXTURE')).toBe('yes');
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    url: 'https://imdesktop.douyin.com/passport/web/validate_code/?aid=339757', method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, pipeline: 'xhr', body: 'code=3437',
  });
  expect(nativeOpen).not.toHaveBeenCalled();
});

it.each(['https://verify.zijieapi.com/captcha/get', 'https://example.com/passport/web/test/', '/api/complete'])('leaves unrelated traffic on the native browser path: %s', url => {
  const { xhr, fetch } = fixture();
  xhr.open('GET', url);
  expect(nativeOpen).toHaveBeenCalledWith('GET', url, true, undefined, undefined);
  expect(fetch).not.toHaveBeenCalled();
});

it('distinguishes HTTP business errors from transport failures and supports JSON responseType', async () => {
  const { xhr, fetch } = fixture();
  fetch.mockResolvedValue({ ok: true, json: async () => ({ status: 403, statusText: 'ERROR', rawText: '{"error_code":8}', headers: {} }) });
  const load = jest.fn(); const error = jest.fn();
  xhr.addEventListener('load', load); xhr.addEventListener('error', error);
  xhr.open('GET', '/passport/web/send_code/'); xhr.responseType = 'json'; xhr.send();
  await flush();
  expect(xhr.response).toEqual({ error_code: 8 }); expect(xhr.status).toBe(403);
  expect(load).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled();
});

it('aborts without delivering a late success', async () => {
  const { xhr } = fixture(); const load = jest.fn(); const abort = jest.fn();
  xhr.addEventListener('load', load); xhr.addEventListener('abort', abort);
  xhr.open('GET', '/passport/web/send_code/'); xhr.send(); xhr.abort();
  await flush();
  expect(abort).toHaveBeenCalledTimes(1); expect(load).not.toHaveBeenCalled(); expect(xhr.readyState).toBe(0);
});

it('reports timeout once and never converts a later response into success', async () => {
  jest.useFakeTimers();
  const { xhr, fetch } = fixture(); fetch.mockReturnValue(new Promise(() => undefined));
  const timeout = jest.fn(); const load = jest.fn();
  xhr.addEventListener('timeout', timeout); xhr.addEventListener('load', load);
  xhr.open('GET', '/passport/web/send_code/'); xhr.timeout = 10; xhr.send();
  jest.advanceTimersByTime(11); await flush();
  expect(timeout).toHaveBeenCalledTimes(1); expect(load).not.toHaveBeenCalled(); expect(xhr.readyState).toBe(4);
});
