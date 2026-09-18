import { DesktopWebSecureServerCertificates, DESKTOP_WEB_SECURE_SERVER_CERTIFICATE_KEY as KEY, type DesktopWebSecureServerCertificateContext } from './desktop-web-secure-server-certificate.js';
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, webcrypto } from 'node:crypto';
import { DesktopWebSecureSystemCrypto } from './desktop-web-secure-crypto.js';

function fixture() {
  let now = 100_000_000, cached: string | null = null;
  const calls: unknown[][] = [], timers: Array<() => void> = [], requests: Xhr[] = [];
  class Xhr {
    readyState = 0; status = 0; response: unknown = ''; onreadystatechange: (() => void) | null = null;
    constructor() { requests.push(this); }
    open(...args: [string, string]) { calls.push(['open', ...args]); }
    setRequestHeader(...args: [string, string]) { calls.push(['header', ...args]); }
    send(body: string) { calls.push(['send', body]); }
    respond(data: unknown, status = 200, readyState = 4) { this.readyState = readyState; this.status = status; this.response = JSON.stringify(data); this.onreadystatechange?.(); }
  }
  const context: DesktopWebSecureServerCertificateContext = {
    window: { XMLHttpRequest: Xhr, FormData: true }, XMLHttpRequest: Xhr,
    localStorage: {
      getItem(key) { calls.push(['get', key]); return cached; },
      setItem(key, value) { calls.push(['set', key, value]); cached = value; },
    }, Date: { now: () => now }, setTimeout(callback, delay) { calls.push(['timer', delay]); timers.push(callback); },
  };
  return { api: new DesktopWebSecureServerCertificates(context), context, calls, timers, requests,
    cache(value: unknown) { cached = JSON.stringify(value); }, raw(value: string) { cached = value; }, now(value: number) { now = value; },
    success(index = 0) { requests[index]!.respond({ message: 'success', data: { server_cert: 'synthetic-cert', server_sn: 'synthetic-sn' } }); },
  };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('uses the exact relative URL, default-async open, headers, comma-joined body, and response-time cache', async () => {
  const f = fixture(), result = f.api.get(1128);
  expect(f.calls).toEqual([
    ['get', KEY], ['timer', 3000], ['open', 'POST', '/passport/ticket_guard/get_client_cert/?aid=1128&is_from_ttaccountsdk=1'],
    ['header', 'Content-Type', 'application/x-www-form-urlencoded'], ['header', 'Accept', 'application/json'], ['send', 'server_data=1,aid=1128'],
  ]);
  f.now(100_000_125); f.success();
  await expect(result).resolves.toEqual({ cert: 'synthetic-cert', sn: 'synthetic-sn' });
  expect(f.calls.at(-1)).toEqual(['set', KEY, JSON.stringify({ cert: 'synthetic-cert', sn: 'synthetic-sn', createdTime: 100_000_125 })]);
  f.timers[0]!(); await flush(); // Original success does not cancel the timer.
});

it('shares the same in-flight Promise across aids and cache flags, then clears after settlement', async () => {
  const f = fixture(), first = f.api.get(1128);
  expect(f.api.get(6383, false)).toBe(first); expect(f.requests).toHaveLength(1);
  f.success(); await first; await flush();
  const next = f.api.get(6383, false); expect(next).not.toBe(first); expect(f.requests).toHaveLength(2);
  f.success(1); await next;
});

it('accepts a fresh cache without checking cert/sn, and shares cached values across aids', async () => {
  const f = fixture(); f.cache({ createdTime: 100_000_000 });
  await expect(f.api.get(1128)).resolves.toEqual({ cert: undefined, sn: undefined }); await flush();
  await expect(f.api.get(6383)).resolves.toEqual({ cert: undefined, sn: undefined }); expect(f.requests).toHaveLength(0);
});

it.each([0, -1])('expires at or after the exact 24-hour boundary (%d ms)', async offset => {
  const f = fixture(); f.cache({ createdTime: 13_600_000 + offset, cert: 'old', sn: 'old' });
  const result = f.api.get(1128); expect(f.requests).toHaveLength(1); f.success(); await result;
});

it('retains native timestamp concatenation rather than normalizing a string to a number', async () => {
  const f = fixture(); f.cache({ createdTime: '1', cert: 'old', sn: 'old' });
  await expect(f.api.get(1128)).resolves.toEqual({ cert: 'old', sn: 'old' }); expect(f.requests).toHaveLength(0);
});

it.each(['{', 'null'])('rejects corrupt cache %s without network or deleting it', async raw => {
  const f = fixture(); f.raw(raw); await expect(f.api.get(1128)).rejects.toBeInstanceOf(Error);
  expect(f.calls).toEqual([['get', KEY]]);
});

it('bypasses a corrupt cache when explicitly requested, still writes the resulting certificate', async () => {
  const f = fixture(); f.raw('{'); const result = f.api.get(1128, false); f.success(); await result;
  expect(f.calls.some(call => call[0] === 'get')).toBe(false); expect(f.calls.some(call => call[0] === 'set')).toBe(true);
});

it('rejects storage read/write failures, and allows a later call to retry after async rejection', async () => {
  const f = fixture(); f.context.localStorage.getItem = () => { throw Error('storage denied'); };
  await expect(f.api.get(1128)).rejects.toThrow('storage denied'); await flush(); expect(f.requests).toHaveLength(0);
  f.context.localStorage.setItem = () => { throw Error('quota'); };
  const result = f.api.get(1128, false); f.success(); await expect(result).rejects.toThrow('quota');
});

it.each([
  { message: 'failure', data: { description: 'denied' } }, { message: 'failure' }, {}, { message: 'success', data: {} },
])('rejects unsuccessful/empty response %# without treating HTTP 200 as ready', async response => {
  const f = fixture(), result = f.api.get(1128); f.requests[0]!.respond(response);
  await expect(result).rejects.toThrow(response.message === 'success' ? 'get empty cert' : response.data && 'description' in response.data ? 'denied' : response.message || 'get cert error');
  expect(f.calls.some(call => call[0] === 'set')).toBe(false);
});

it.each([0, 199, 300, 500, NaN])('leaves non-2xx status %s pending until the 3000ms outer timeout', async status => {
  const f = fixture(), result = f.api.get(1128); f.requests[0]!.respond({ message: 'success' }, status);
  let settled = false; void result.then(() => { settled = true; }, () => { settled = true; }); await flush(); expect(settled).toBe(false);
  f.timers[0]!(); await expect(result).rejects.toThrow('get cert timeout');
});

it('does not persist a late success after timeout or let it settle a later request', async () => {
  const f = fixture(), first = f.api.get(1128); f.timers[0]!(); await expect(first).rejects.toThrow('get cert timeout'); await flush();
  const second = f.api.get(1128); f.success(0); await flush(); expect(f.calls.some(call => call[0] === 'set')).toBe(false);
  f.success(1); await expect(second).resolves.toEqual({ cert: 'synthetic-cert', sn: 'synthetic-sn' });
});

it('requires the FormData feature check despite never creating FormData', async () => {
  const f = fixture(); delete (f.context.window as { FormData?: unknown }).FormData;
  await expect(f.api.get(1128)).rejects.toThrow('not support XMLHttpRequest'); expect(f.requests).toHaveLength(0);
});

it('propagates malformed JSON responses and null data', async () => {
  const f = fixture(), result = f.api.get(1128);
  f.requests[0]!.readyState = 4; f.requests[0]!.status = 200; f.requests[0]!.response = '{'; f.requests[0]!.onreadystatechange?.();
  await expect(result).rejects.toBeInstanceOf(SyntaxError); await flush();
  const second = f.api.get(1128); f.requests[1]!.respond({ message: 'success', data: null });
  await expect(second).rejects.toBeInstanceOf(TypeError);
});

it('feeds a fetched server certificate into real ECDH-HKDF without claiming client issuance', async () => {
  const crypto = new DesktopWebSecureSystemCrypto(webcrypto.subtle), client = await crypto.generateNewKeyPairPEM(), server = await crypto.generateNewKeyPairPEM();
  const spki = createPublicKey(server.publicPem).export({ format: 'der', type: 'spki' });
  const sequence = (parts: Buffer[]) => { const content = Buffer.concat(parts); return Buffer.concat([Buffer.from([48, content.length]), content]); };
  // Unsigned v3-position container intentionally tests key extraction, NOT certificate trust.
  const certificate = `-----BEGIN CERTIFICATE-----\n${sequence([sequence([...Array.from({ length: 6 }, () => Buffer.from([5, 0])), spki])]).toString('base64')}\n-----END CERTIFICATE-----`;
  const f = fixture(), requested = f.api.get(1128);
  f.requests[0]!.respond({ message: 'success', data: { server_cert: certificate, server_sn: 'synthetic' } });
  const result = await requested; expect(typeof result.cert).toBe('string');
  const derived = await crypto.deriveEcdhKey(client.privatePem, result.cert as string);
  const shared = diffieHellman({ privateKey: createPrivateKey(server.privatePem), publicKey: createPublicKey(client.publicPem) });
  expect(Buffer.from(derived.bytes)).toEqual(Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32)));
});
