import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createHmac, createHash, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopTicketGuard, desktopCertificateRequest, ticketSignContent, type TicketGuardRequest } from './ticket-guard.js';
import { ApiConnection } from './api-connection.js';
import { AccountStore } from '../store/account-store.js';
import { ImFriendApi } from '../services/im/friends.js';

const LOGIN = new URL('https://imdesktop.douyin.com/passport/web/check_qrconnect/');
const FOLLOW = new URL('https://imdesktop.douyin.com/aweme/v1/web/commit/follow/user/?user_id=fixture');
const NOW = 1_789_124_432;
let directory: string;
let pem: string;
let serverKey: ReturnType<typeof createPrivateKey>;
let rotatedPem: string;
let rotatedServerKey: ReturnType<typeof createPrivateKey>;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'douyin-guard-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
    '-subj', '/CN=offline-fixture', '-days', '1'], { stdio: 'ignore' });
  pem = readFileSync(join(directory, 'cert.pem'), 'utf8');
  serverKey = createPrivateKey(readFileSync(join(directory, 'key.pem')));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', join(directory, 'rotated-key.pem'), '-out', join(directory, 'rotated-cert.pem'),
    '-subj', '/CN=offline-rotated-fixture', '-days', '1'], { stdio: 'ignore' });
  rotatedPem = readFileSync(join(directory, 'rotated-cert.pem'), 'utf8');
  rotatedServerKey = createPrivateKey(readFileSync(join(directory, 'rotated-key.pem')));
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
afterEach(() => jest.restoreAllMocks());

it.each(['record', 'headers', 'tuples'] as const)('native signing replaces browser %s header values without combining identities', async kind => {
  const guard = new DesktopTicketGuard(); certificates(guard); bind(guard);
  const client = new ApiConnection({ desktopTicketGuard: guard.exportState(), initialCookies: 'sessionid=fixture-session' });
  const fields = {
    'BD-Ticket-Guard-Ree-Public-Key': 'browser-key',
    'BD-Ticket-Guard-Client-Data': 'browser-signature',
    'BD-Ticket-Guard-Version': 'browser-version',
    'X-Browser-Marker': 'preserved',
  };
  const headers = kind === 'headers' ? new Headers(fields) : kind === 'tuples' ? Object.entries(fields) : fields;
  let sent!: Headers;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    sent = new Headers(init?.headers);
    return Response.json({ status_code: 0 });
  });
  await client.requestRaw(FOLLOW.href, { method: 'POST', headers });
  const point = sent.get('bd-ticket-guard-ree-public-key')!;
  expect(point).toBe(guard.prepare(FOLLOW, 'fixture-session').headers['bd-ticket-guard-ree-public-key']);
  expect(sent.get('bd-ticket-guard-version')).toBe('2');
  expect(sent.get('x-browser-marker')).toBe('preserved');
  const data = JSON.parse(Buffer.from(sent.get('bd-ticket-guard-client-data')!, 'base64').toString()) as Record<string, unknown>;
  expect(data['ts_sign_ree']).toBe('fixture-ts-sign');
  const shared = diffieHellman({ privateKey: serverKey, publicKey: publicKey({ headers: Object.fromEntries(sent) }) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
  expect(data['req_sign_ree']).toBe(createHmac('sha256', key)
    .update(ticketSignContent('fixture-session', FOLLOW.pathname, Number(data['timestamp']))).digest('base64'));
  expect(new Headers(headers).get('bd-ticket-guard-ree-public-key')).toBe('browser-key');
});

function certificates(guard: DesktopTicketGuard, base64 = false): void {
  guard.acceptCertificateResponse({ message: 'success', data: {
    cert: pem, server_cert: base64 ? Buffer.from(pem).toString('base64') : pem, server_sn: 'fixture-sn',
  } });
}
function bind(guard: DesktopTicketGuard, session = 'fixture-session', signature = 'fixture-ts-sign'): void {
  expect(guard.acceptResponse(guard.prepare(LOGIN, ''), serverData({ ticket: session, ts_sign_ree: signature }), session)).toBe(true);
}
function serverData(value: unknown): Headers {
  return new Headers({ 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify(value)).toString('base64') });
}
function clientData(request: TicketGuardRequest): Record<string, unknown> {
  return JSON.parse(Buffer.from(request.headers['bd-ticket-guard-client-data']!, 'base64').toString('utf8')) as Record<string, unknown>;
}
function publicKey(request: TicketGuardRequest): ReturnType<typeof createPublicKey> {
  const point = Buffer.from(request.headers['bd-ticket-guard-ree-public-key']!, 'base64');
  expect(point.length).toBe(65);
  expect(point[0]).toBe(4);
  return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
}

describe('Desktop onCompleted Session extraction', () => {
  it.each([
    ['ordinary', ['sessionid=plain; Path=/'], 'plain', 'plain', 'plain'],
    ['padded complete ticket', ['sessionid=padded==; Path=/'], 'padded==', undefined, 'padded=='],
    ['padded truncated ticket', ['sessionid=padded==; Path=/'], 'padded', 'padded', 'padded=='],
    ['first repeated cookie', ['sessionid=first; Path=/', 'sessionid=second; Path=/'], 'first', 'first', 'second'],
    ['second repeated cookie', ['sessionid=first; Path=/', 'sessionid=second; Path=/'], 'second', undefined, 'second'],
    ['case sensitive name', ['SessionId=plain; Path=/'], 'plain', undefined, undefined],
    ['secondary only', ['sessionid_ss=plain; Path=/'], 'plain', undefined, undefined],
    ['empty value', ['sessionid=; Path=/'], '', undefined, ''],
  ] as const)('%s keeps guard candidate extraction separate from Cookie storage', async (_label, cookies, ticket, boundSession, storedSession) => {
    const guard = new DesktopTicketGuard(); certificates(guard);
    const connection = new ApiConnection({ desktopTicketGuard: guard.exportState() });
    let saved = guard.exportState();
    connection.enableTicketGuard(state => { saved = state; });
    const headers = serverData({ ticket, ts_sign_ree: 'fixture-issued-signature' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { headers }));
    await connection.requestRaw(LOGIN.toString(), { method: 'POST' });
    expect(saved.binding).toEqual(boundSession ? {
      sessionHash: createHash('sha256').update(boundSession).digest('hex'), tsSignRee: 'fixture-issued-signature',
    } : undefined);
    expect(connection.jar.get('sessionid')).toBe(storedSession);
  });
});

describe('completed-response binding boundary', () => {
  it.each(['text', 'bytes', 'verification'] as const)('does not bind from headers while the %s response body is incomplete or fails', async kind => {
    const guard = new DesktopTicketGuard(); certificates(guard);
    const connection = new ApiConnection({ desktopTicketGuard: guard.exportState(), initialCookies: 'sessionid=original' });
    const snapshots: ReturnType<DesktopTicketGuard['exportState']>[] = [];
    connection.enableTicketGuard(state => snapshots.push(state));
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const headers = serverData({ ticket: 'rotated', ts_sign_ree: 'fixture-issued-signature' });
    headers.set('set-cookie', 'sessionid=rotated; Path=/');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers }));
    const request = kind === 'bytes' ? connection.requestBytes(LOGIN.toString(), {})
      : kind === 'verification' ? connection.requestVerificationRaw(LOGIN.toString(), {})
        : connection.requestRaw(LOGIN.toString(), {});
    const rejected = expect(request).rejects.toThrow('fixture truncated response');
    for (let step = 0; step < 8; step++) await Promise.resolve();
    const beforeBody = connection.getTicketGuardState()?.binding;
    stream.error(new Error('fixture truncated response'));
    await rejected;
    expect(beforeBody).toBeUndefined();
    expect(connection.hasBoundTicket()).toBe(false);
    expect(snapshots.every(state => !state.binding)).toBe(true);
    expect(connection.getCookies()).toBe('sessionid=rotated');
  });

  it.each(['text', 'bytes', 'verification'] as const)('binds after the complete %s body and returns that body without consuming it twice', async kind => {
    const guard = new DesktopTicketGuard(); certificates(guard);
    const connection = new ApiConnection({ desktopTicketGuard: guard.exportState() });
    connection.enableTicketGuard(() => undefined);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const headers = serverData({ ticket: 'completed', ts_sign_ree: 'fixture-issued-signature' });
    headers.set('set-cookie', 'sessionid=completed; Path=/');
    headers.set('x-tt-logid', 'fixture-log');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 201, headers }));
    const request = kind === 'bytes' ? connection.requestBytes(LOGIN.toString(), {})
      : kind === 'verification' ? connection.requestVerificationRaw(LOGIN.toString(), {})
        : connection.requestRaw(LOGIN.toString(), {});
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(connection.hasBoundTicket()).toBe(false);
    const payload = new TextEncoder().encode('complete fixture');
    stream.enqueue(payload); stream.close();
    const result = await request;
    expect(result.status).toBe(201);
    expect(result.headers.get('x-tt-logid')).toBe('fixture-log');
    expect(result.data).toEqual(kind === 'bytes' ? payload : 'complete fixture');
    expect(connection.hasBoundTicket()).toBe(true);
  });

  it.each(['abort', 'retire'] as const)('does not save a completed response retired during body consumption (%s)', async mode => {
    const guard = new DesktopTicketGuard(); certificates(guard);
    const connection = new ApiConnection({ desktopTicketGuard: guard.exportState(), initialCookies: 'sessionid=original' });
    const save = jest.fn(); connection.enableTicketGuard(save); save.mockClear();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const headers = serverData({ ticket: 'late', ts_sign_ree: 'fixture-issued-signature' });
    headers.set('set-cookie', 'sessionid=late; Path=/');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers }));
    const controller = new AbortController();
    const request = connection.requestRaw(LOGIN.toString(), { signal: controller.signal });
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(connection.getCookies()).toBe('sessionid=late');
    if (mode === 'abort') controller.abort(new Error('fixture cancel during body'));
    else connection.invalidateAuthenticationResponses();
    connection.jar.set('sessionid', 'next-login');
    stream.enqueue(new TextEncoder().encode('actual response')); stream.close();
    if (mode === 'abort') await expect(request).rejects.toThrow('fixture cancel during body');
    else await expect(request).resolves.toMatchObject({ rawText: 'actual response' });
    expect(save).not.toHaveBeenCalled();
    expect(connection.getCookies()).toBe('sessionid=next-login');
    expect(connection.hasBoundTicket()).toBe(false);
  });

  it('accepts completed response binding independently of a later business JSON parse failure', async () => {
    const guard = new DesktopTicketGuard(); certificates(guard);
    const connection = new ApiConnection({ desktopTicketGuard: guard.exportState() });
    connection.enableTicketGuard(() => undefined);
    const headers = serverData({ ticket: 'complete-invalid-json', ts_sign_ree: 'fixture-issued-signature' });
    headers.set('set-cookie', 'sessionid=complete-invalid-json; Path=/');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{invalid JSON', { headers }));
    await expect(connection.getPassportAccountInfo()).rejects.toMatchObject({ kind: 'invalid-json' });
    expect(connection.hasBoundTicket()).toBe(true);
  });
});

describe.each(['account-info', 'token-beat'] as const)('%s Session binding', endpoint => {
  it.each([
    ['matching response Session', 'rotated-session', 'rotated-session', true],
    ['missing response Session', '', 'fixture-session', false],
    ['foreign response ticket', 'rotated-session', 'foreign-session', false],
  ] as const)('binds only an issued matching ticket: %s', async (_label, issuedSession, ticket, bound) => {
    const guard = new DesktopTicketGuard(); certificates(guard);
    const connection = new ApiConnection({
      desktopTicketGuard: guard.exportState(), initialCookies: 'sessionid=fixture-session', enableABogus: false,
    });
    const snapshots: Array<{ cookies: string; state: NonNullable<ReturnType<ApiConnection['getTicketGuardState']>> }> = [];
    connection.enableTicketGuard(state => { snapshots.push({ cookies: connection.getCookies(), state }); });
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe(endpoint === 'account-info' ? '/passport/account/info/v2/' : '/passport/token/beat/web/');
      expect(new Headers(init?.headers).get('bd-ticket-guard-ree-public-key')).toBeTruthy();
      const headers = serverData({ ticket, ts_sign_ree: 'fixture-ts-sign' });
      if (issuedSession) headers.append('set-cookie', `sessionid=${issuedSession}; Path=/`);
      return Response.json({ message: 'success', data: {} }, { headers });
    });
    if (endpoint === 'account-info') await connection.getPassportAccountInfo();
    else await connection.sendPassportTokenBeat('boot');
    expect(network).toHaveBeenCalledTimes(1);
    expect(connection.hasBoundTicket()).toBe(bound);
    const saved = snapshots.at(-1)!;
    const restored = new ApiConnection({ initialCookies: saved.cookies, desktopTicketGuard: saved.state });
    expect(restored.hasBoundTicket()).toBe(bound);
    expect(connection.jar.get('sessionid')).toBe(issuedSession || 'fixture-session');
  });
});

it('does not invent binding from a successful beat that only reissues Session cookies', async () => {
  const guard = new DesktopTicketGuard(); certificates(guard);
  const connection = new ApiConnection({ desktopTicketGuard: guard.exportState(), initialCookies: 'sessionid=before', enableABogus: false });
  let saved = { cookies: connection.getCookies(), state: guard.exportState() };
  connection.enableTicketGuard(state => { saved = { cookies: connection.getCookies(), state }; });
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data: { error_code: 0 } }, {
    headers: { 'set-cookie': 'sessionid=after; Path=/', 'bd-ticket-guard-result': '1200' },
  }));
  await expect(connection.sendPassportTokenBeat('boot')).resolves.toMatchObject({ message: 'success' });
  expect(saved.cookies).toBe('sessionid=after');
  expect(new ApiConnection({ initialCookies: saved.cookies, desktopTicketGuard: saved.state }).hasBoundTicket()).toBe(false);
});

describe.each([false, true])('native Session/SS selection (server certificate=%s)', certified => {
  it.each([
    ['unbound-both', false, 'primary', 'secondary', 'secondary'],
    ['unbound-primary', false, 'primary', '', ''],
    ['unbound-secondary', false, '', 'secondary', ''],
    ['unbound-empty', false, '', '', undefined],
    ['primary-match', true, 'fixture-session', 'secondary', 'fixture-session'],
    ['both-match', true, 'fixture-session', 'fixture-session', 'fixture-session'],
    ['secondary-match', true, 'primary', 'fixture-session', 'fixture-session'],
    ['secondary-only-match', true, '', 'fixture-session', 'fixture-session'],
    ['neither-match', true, 'primary', 'secondary', 'secondary'],
    ['primary-only-mismatch', true, 'primary', '', ''],
    ['secondary-only-mismatch', true, '', 'secondary', 'secondary'],
    ['bound-empty', true, '', '', undefined],
  ] as const)('%s', (_label, bound, primary, secondary, selected) => {
    const guard = new DesktopTicketGuard();
    if (certified) certificates(guard);
    if (bound) bind(guard);
    const before = guard.exportState();
    const request = guard.prepare(FOLLOW, primary, secondary, NOW);
    if (selected === undefined) {
      expect(request.headers).toEqual({});
      expect(request.useTicketErrorCode).toBeUndefined();
      return;
    }
    const data = clientData(request);
    const content = ticketSignContent(selected, FOLLOW.pathname, NOW);
    if (certified) {
      const shared = diffieHellman({ privateKey: serverKey, publicKey: publicKey(request) });
      const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
      expect(data['req_sign_ree']).toBe(createHmac('sha256', key).update(content).digest('base64'));
    } else {
      expect(verify('sha256', Buffer.from(content), publicKey(request), Buffer.from(String(data['req_sign_ree']), 'base64'))).toBe(true);
    }
    expect(data['ts_sign_ree']).toBe(bound ? 'fixture-ts-sign' : '');
    expect(request.useTicketErrorCode).toBe(bound ? undefined : 4);
    expect(request.headers).not.toHaveProperty('kTicketGuardUseTicketErrorCodeKey');
    expect(guard.exportState()).toEqual(before); // Selecting a Cookie never creates/rebinds a ticket.
  });
});

it('uses a verified SS binding for HTTP follow but blocks mutation when neither Cookie matches', async () => {
  const guard = new DesktopTicketGuard(); certificates(guard); bind(guard);
  const client = new ApiConnection({ desktopTicketGuard: guard.exportState(), initialCookies: 'sessionid=other; sessionid_ss=fixture-session' });
  client.enableTicketGuard(() => undefined);
  const requests: Array<Record<string, string>> = [];
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    requests.push(Object.fromEntries(new Headers(init?.headers)));
    return Response.json({ status_code: 0, follow_status: 1 });
  });
  const api = new ImFriendApi(client);
  expect(client.hasBoundTicket()).toBe(true);
  await expect(api.setFollowed({ uid: '10002', secUid: 'fixture-peer', followed: true })).resolves.toMatchObject({ followStatus: 1 });
  const request = { headers: requests[0]! }; const data = clientData(request);
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: serverKey, publicKey: publicKey(request) }), Buffer.alloc(0), Buffer.alloc(0), 32));
  expect(data['req_sign_ree']).toBe(createHmac('sha256', key).update(ticketSignContent('fixture-session', FOLLOW.pathname, Number(data['timestamp']))).digest('base64'));
  expect(data['ts_sign_ree']).toBe('fixture-ts-sign');
  client.jar.set('sessionid_ss', 'unbound-secondary');
  expect(client.hasBoundTicket()).toBe(false);
  await expect(api.setFollowed({ uid: '10002', secUid: 'fixture-peer', followed: true })).rejects.toThrow('安全票据');
  expect(network).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps default follow/unfollow outside Passport signing even with login overrides (certified=%s)', async certified => {
  const guard = new DesktopTicketGuard();
  if (certified) certificates(guard);
  bind(guard);
  // Do not disable a_bogus or stub hasBoundTicket: exercise the default connection
  // with deliberately populated login-only overrides and a real synthetic binding.
  const client = new ApiConnection({ desktopTicketGuard: guard.exportState(), initialCookies: 'sessionid=fixture-session',
    aBogus: 'login-only-signature', msToken: 'login-only-token', accountSdkSourceInfo: 'login-only-source',
    deviceId: '10002', installId: '10003' });
  const requests: Request[] = [];
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(String(input), init);
    if (new URL(request.url).pathname === '/passport/ticket_guard/get_client_cert/') {
      expect(certified).toBe(false);
      expect(request.headers.has('cookie')).toBe(false);
      return Response.json({ data: {} });
    }
    requests.push(request);
    return Response.json({ status_code: 0, follow_status: new URL(request.url).searchParams.get('type') === '1' ? 1 : 0 });
  });
  const api = new ImFriendApi(client);
  for (const followed of [true, false]) {
    await expect(api.setFollowed({ uid: '10004', secUid: 'fixture-peer', followed })).resolves
      .toMatchObject({ statusCode: 0, followStatus: followed ? 1 : 0 });
    const request = requests.at(-1)!;
    const url = new URL(request.url);
    expect(url.pathname).toBe(FOLLOW.pathname);
    expect(await request.text()).toBe('');
    for (const key of ['a_bogus', 'msToken', 'account_sdk_source_info', 'passport_jssdk_type', 'qs', 'sign']) {
      expect(url.searchParams.has(key)).toBe(false);
    }
    expect([...request.headers.keys()].some(key => key.startsWith('x-tt-passport-'))).toBe(false);
    expect(request.headers.get('cookie')).toBe('sessionid=fixture-session');
    const signed = { headers: Object.fromEntries(request.headers) };
    const data = clientData(signed);
    const content = ticketSignContent('fixture-session', FOLLOW.pathname, Number(data['timestamp']));
    expect(data['ts_sign_ree']).toBe('fixture-ts-sign');
    if (certified) {
      const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: serverKey, publicKey: publicKey(signed) }), Buffer.alloc(0), Buffer.alloc(0), 32));
      expect(data['req_sign_ree']).toBe(createHmac('sha256', key).update(content).digest('base64'));
    } else {
      expect(verify('sha256', Buffer.from(content), publicKey(signed), Buffer.from(String(data['req_sign_ree']), 'base64'))).toBe(true);
    }
  }
  expect(requests).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(certified ? 2 : 3);
});

it('does not bind response server-data from an SS-only Set-Cookie, and persists SS rotation for restart', async () => {
  const guard = new DesktopTicketGuard(); certificates(guard); bind(guard);
  const client = new ApiConnection({ desktopTicketGuard: guard.exportState(), initialCookies: 'sessionid=other; sessionid_ss=fixture-session' });
  const snapshots: Array<{ cookies: string; state: NonNullable<ReturnType<ApiConnection['getTicketGuardState']>> }> = [];
  client.enableTicketGuard(state => snapshots.push({ cookies: client.getCookies(), state }));
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const headers = serverData({ ticket: 'new-secondary', ts_sign_ree: 'must-not-bind' });
    headers.set('set-cookie', 'sessionid_ss=new-secondary; Path=/; Secure');
    return new Response('{}', { headers });
  });
  await client.requestRaw(LOGIN.toString(), { method: 'POST' });
  expect(client.hasBoundTicket()).toBe(false);
  expect(snapshots.at(-1)!.cookies).toContain('sessionid_ss=new-secondary');
  expect(snapshots.at(-1)!.state.binding).toEqual(guard.exportState().binding);
  const restored = new ApiConnection({ initialCookies: snapshots.at(-1)!.cookies, desktopTicketGuard: snapshots.at(-1)!.state });
  expect(restored.hasBoundTicket()).toBe(false);
  restored.jar.set('sessionid_ss', 'fixture-session');
  expect(restored.hasBoundTicket()).toBe(true);
});

it('preserves the fixed-width private scalar when OpenSSL omits leading zeroes', () => {
  const scalar = Buffer.alloc(32);
  scalar[31] = 1;
  const guard = new DesktopTicketGuard({ version: 1, privateKey: scalar.toString('base64') });
  expect(guard.exportState().privateKey).toBe(scalar.toString('base64'));
  const restored = new DesktopTicketGuard(guard.exportState());
  expect(restored.prepare(LOGIN, '').headers).toEqual(guard.prepare(LOGIN, '').headers);
});

it('uses the exact unauthenticated certificate request contract', () => {
  const { url, init } = desktopCertificateRequest('fixture-did', 'fixture-iid');
  expect(new URL(url).searchParams.get('aid')).toBe('339757');
  expect(new URL(url).searchParams.get('device_platform')).toBe('PC');
  expect(init).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'server_data=1' });
});

it('requires persisted ownership before explicit certificate startup, without making enable a network trigger', async () => {
  const client = new ApiConnection();
  const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data: {} }));
  expect(() => client.startTicketGuard()).toThrow('必须先保存账号密钥');
  client.enableTicketGuard(() => undefined);
  expect(network).not.toHaveBeenCalled();
  client.startTicketGuard();
  client.startTicketGuard();
  client.enableTicketGuard(() => undefined);
  expect(network).toHaveBeenCalledTimes(1);
  for (let step = 0; step < 12; step++) await Promise.resolve();
});

it('does not load another certificate on explicit startup with a native-complete cache', () => {
  const guard = new DesktopTicketGuard(); certificates(guard);
  const client = new ApiConnection({ desktopTicketGuard: guard.exportState() });
  client.enableTicketGuard(() => undefined);
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  client.startTicketGuard();
  expect(network).not.toHaveBeenCalled();
});

it.each([false, true])('normalizes server PEM/base64=%s and matches the server-side ECDH/HKDF/HMAC', base64 => {
  const guard = new DesktopTicketGuard();
  certificates(guard, base64);
  bind(guard);
  const request = guard.prepare(FOLLOW, 'fixture-session', '', NOW);
  const shared = diffieHellman({ privateKey: serverKey, publicKey: publicKey(request) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
  const expected = createHmac('sha256', key).update(`ticket=fixture-session&path=${FOLLOW.pathname}&timestamp=${NOW}`).digest('base64');
  expect(request.headers['bd-ticket-guard-iteration-version']).toBe('3');
  expect(clientData(request)).toEqual({ req_content: 'ticket,path,timestamp', req_sign_ree: expected, timestamp: NOW, ts_sign_ree: 'fixture-ts-sign' });
  expect(guard.exportState().serverCert).toBe(pem);
  expect(guard.exportState().clientCert).toBe(Buffer.from(pem).toString('base64'));
});

it('uses ECDSA SHA256 DER without a server certificate, not a fabricated HMAC', () => {
  const guard = new DesktopTicketGuard();
  bind(guard);
  const request = guard.prepare(FOLLOW, 'fixture-session', '', NOW);
  expect(request.headers['bd-ticket-guard-iteration-version']).toBe('2');
  const signature = Buffer.from(String(clientData(request)['req_sign_ree']), 'base64');
  expect(signature[0]).toBe(0x30);
  expect(verify('sha256', Buffer.from(ticketSignContent('fixture-session', FOLLOW.pathname, NOW)), publicKey(request), signature)).toBe(true);
});

it('uses the native get-ticket serial sentinel before a server serial exists', () => {
  const guard = new DesktopTicketGuard();
  expect(guard.prepare(LOGIN, '').headers['bd-ticket-guard-server-cert-sn']).toBe('0');
  expect(guard.prepare(LOGIN, '', '', NOW, false).headers['bd-ticket-guard-server-cert-sn']).toBeUndefined();
  expect(guard.prepare(FOLLOW, 'fixture-session').headers['bd-ticket-guard-server-cert-sn']).toBeUndefined();
  certificates(guard);
  expect(guard.prepare(LOGIN, '').headers['bd-ticket-guard-server-cert-sn']).toBe('fixture-sn');
  expect(guard.prepare(LOGIN, '', '', NOW, false).headers['bd-ticket-guard-server-cert-sn']).toBeUndefined();
});

it('dispatches persisted-key ECDSA while certificates are pending, then saves and switches to HMAC without another login', async () => {
  const guard = new DesktopTicketGuard(); bind(guard);
  const client = new ApiConnection({ initialCookies: 'sessionid=fixture-session', desktopTicketGuard: guard.exportState() });
  const snapshots: NonNullable<ReturnType<ApiConnection['getTicketGuardState']>>[] = [];
  let saved!: () => void;
  const certificateSaved = new Promise<void>(resolve => { saved = resolve; });
  client.enableTicketGuard(state => { snapshots.push(state); if (state.serverCert) saved(); });
  let finish!: (response: Response) => void;
  const requests: Array<{ path: string; headers: Record<string, string> }> = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, headers: Object.fromEntries(new Headers(init?.headers)) });
    if (path.endsWith('/get_client_cert/')) return new Promise(resolve => { finish = resolve; });
    return Response.json({ status_code: 0 });
  });
  const first = client.requestRaw(FOLLOW.toString(), { method: 'POST' });
  try {
    expect(requests.map(request => request.path)).toEqual(['/passport/ticket_guard/get_client_cert/', FOLLOW.pathname]);
    await expect(first).resolves.toMatchObject({ status: 200 });
    const request = requests[1]!;
    const data = clientData(request);
    expect(request.headers['bd-ticket-guard-iteration-version']).toBe('2');
    expect(data['ts_sign_ree']).toBe('fixture-ts-sign');
    expect(verify('sha256', Buffer.from(ticketSignContent('fixture-session', FOLLOW.pathname, Number(data['timestamp']))),
      publicKey(request), Buffer.from(String(data['req_sign_ree']), 'base64'))).toBe(true);
    expect(snapshots).toHaveLength(1);
  } finally {
    finish(Response.json({ message: 'success', data: { server_cert: pem, server_sn: 'fixture-sn' } }));
    await first;
  }
  // Arrival is saved even with no subsequent business request.
  await certificateSaved;
  await client.requestRaw(FOLLOW.toString(), { method: 'POST' });
  const before = requests[1]!; const after = requests[2]!; const data = clientData(after);
  expect(after.headers['bd-ticket-guard-ree-public-key']).toBe(before.headers['bd-ticket-guard-ree-public-key']);
  expect(after.headers['bd-ticket-guard-iteration-version']).toBe('3');
  expect(data['ts_sign_ree']).toBe('fixture-ts-sign');
  const shared = diffieHellman({ privateKey: serverKey, publicKey: publicKey(after) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
  expect(data['req_sign_ree']).toBe(createHmac('sha256', key)
    .update(ticketSignContent('fixture-session', FOLLOW.pathname, Number(data['timestamp']))).digest('base64'));
  expect(snapshots.at(-1)!.serverSn).toBe('fixture-sn');
  expect(requests).toHaveLength(3);
});

it('persists a partial background certificate update even when the server field is malformed and no caller follows', async () => {
  const guard = new DesktopTicketGuard();
  guard.acceptCertificateResponse({ message: 'success', data: { server_cert: pem } });
  const client = new ApiConnection({ desktopTicketGuard: guard.exportState() });
  let saved!: () => void;
  const partialSaved = new Promise<void>(resolve => { saved = resolve; });
  let snapshot = guard.exportState();
  client.enableTicketGuard(state => { snapshot = state; if (state.clientCert) saved(); });
  let finish!: (response: Response) => void;
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).includes('/get_client_cert/')) return new Promise(resolve => { finish = resolve; });
    return Response.json({ ok: true });
  });
  await client.requestRaw(LOGIN.toString(), { method: 'POST' });
  finish(Response.json({ message: 'success', data: { cert: 'partial-client', server_cert: 'malformed', server_sn: 'not-applied' } }));
  await partialSaved;
  expect(snapshot).toMatchObject({ clientCert: Buffer.from('partial-client').toString('base64'), serverCert: pem });
  expect(snapshot.serverSn).toBeUndefined();
  expect(network).toHaveBeenCalledTimes(2);
});

it('keeps request binding instance-local, single-use and tied to response Set-Cookie', () => {
  const guard = new DesktopTicketGuard();
  const other = new DesktopTicketGuard();
  const request = guard.prepare(LOGIN, 'request-session');
  const headers = serverData({ tickets: [{ ticket: 'response-session', ts_sign_ree: 'signature' }] });
  expect(other.acceptResponse(request, headers, 'response-session')).toBe(false);
  expect(guard.acceptResponse(request, headers, 'response-session')).toBe(true);
  expect(guard.hasBinding('response-session')).toBe(true);
  expect(guard.hasBinding('request-session')).toBe(false);
  expect(guard.acceptResponse(request, serverData({ ticket: 'request-session', ts_sign_ree: 'wrong' }), 'request-session')).toBe(false);
});

it.each(['', 'different-session'])('does not bind a server ticket to mismatching response Cookie %s', cookie => {
  const guard = new DesktopTicketGuard();
  expect(guard.acceptResponse(guard.prepare(LOGIN, 'fixture-session'), serverData({ ticket: 'fixture-session', ts_sign_ree: 'signature' }), cookie)).toBe(false);
  expect(guard.hasBinding('fixture-session')).toBe(false);
});

it.each([
  ['empty', { ticket: 'replacement-session', ts_sign_ree: '' }],
  ['missing', { ticket: 'replacement-session' }],
  ['duplicate-empty-last', { tickets: [
    { ticket: 'replacement-session', ts_sign_ree: 'must-not-survive' },
    { ticket: 'replacement-session', ts_sign_ree: '' },
  ] }],
] as const)('replaces an old cached ticket with a non-ready Session entry (%s), including after restore', (_name, body) => {
  const guard = new DesktopTicketGuard();
  bind(guard);
  expect(guard.acceptResponse(guard.prepare(LOGIN, 'fixture-session'), serverData(body), 'replacement-session')).toBe(true);
  expect(guard.hasBinding('fixture-session')).toBe(false);
  expect(guard.hasBinding('replacement-session')).toBe(false);
  expect(guard.exportState().binding).toMatchObject({ tsSignRee: '' });
  for (const current of [guard, new DesktopTicketGuard(guard.exportState())]) {
    const request = current.prepare(FOLLOW, 'replacement-session', 'secondary-session', NOW, false);
    expect(clientData(request)['ts_sign_ree']).toBe('');
    expect(request.useTicketErrorCode).toBe(4);
    // The cached Session still selects the primary Cookie, despite not being ready.
    expect(verify('sha256', Buffer.from(ticketSignContent('replacement-session', FOLLOW.pathname, NOW)),
      publicKey(request), Buffer.from(clientData(request)['req_sign_ree'] as string, 'base64'))).toBe(true);
    bind(current, 'replacement-session', 'renewed-signature');
    expect(current.hasBinding('replacement-session')).toBe(true);
    expect(clientData(current.prepare(FOLLOW, 'replacement-session', '', NOW))['ts_sign_ree']).toBe('renewed-signature');
  }
});

it('uses the last matching response item even when an earlier signature is empty', () => {
  const guard = new DesktopTicketGuard(); bind(guard);
  const data = serverData({ tickets: [
    { ticket: 'fixture-session', ts_sign_ree: '' },
    { ticket: 'fixture-session', ts_sign_ree: 'last-signature' },
  ] });
  expect(guard.acceptResponse(guard.prepare(LOGIN, 'fixture-session'), data, 'fixture-session')).toBe(true);
  expect(guard.hasBinding('fixture-session')).toBe(true);
  expect(clientData(guard.prepare(FOLLOW, 'fixture-session', '', NOW))['ts_sign_ree']).toBe('last-signature');
});

it.each([undefined, null, 123, true])('retains a matching cached Session with default-empty REE signature for %s', signature => {
  const guard = new DesktopTicketGuard(); bind(guard);
  expect(guard.acceptResponse(guard.prepare(LOGIN, 'fixture-session'),
    serverData({ ticket: 'fixture-session', ts_sign_ree: signature }), 'fixture-session')).toBe(true);
  expect(guard.hasBinding('fixture-session')).toBe(false);
  expect(clientData(guard.prepare(FOLLOW, 'fixture-session', '', NOW))['ts_sign_ree']).toBe('');
});

it('does not replace a cached ticket from empty signatures on non-login or nonmatching responses', () => {
  const guard = new DesktopTicketGuard(); bind(guard);
  for (const [url, cookie] of [[FOLLOW, 'fixture-session'], [LOGIN, ''], [LOGIN, 'other-session']] as const) {
    expect(guard.acceptResponse(guard.prepare(url, 'fixture-session'),
      serverData({ ticket: 'fixture-session', ts_sign_ree: '' }), cookie)).toBe(false);
    expect(guard.hasBinding('fixture-session')).toBe(true);
  }
});

it('does not manufacture missing tickets or sign unrelated hosts and paths', () => {
  const guard = new DesktopTicketGuard();
  for (const url of ['https://example.com/passport/web/login/', 'http://imdesktop.douyin.com/passport/web/login/', 'https://imdesktop.douyin.com/unrelated/']) {
    expect(guard.prepare(new URL(url), 'fixture-session').headers).toEqual({});
  }
  expect(clientData(guard.prepare(FOLLOW, 'fixture-session', '', NOW))['ts_sign_ree']).toBe('');
  expect(guard.hasBinding('fixture-session')).toBe(false);
  for (const header of ['invalid-base64', Buffer.from('not json').toString('base64')]) {
    expect(guard.acceptResponse(guard.prepare(LOGIN, ''), new Headers({ 'bd-ticket-guard-server-data': header }), 'fixture-session')).toBe(false);
  }
});

it('preserves keys, certificates and ticket binding across explicit state restore', () => {
  const guard = new DesktopTicketGuard();
  certificates(guard);
  bind(guard);
  const state = guard.exportState();
  expect(JSON.stringify(state)).not.toContain('fixture-session');
  const restored = new DesktopTicketGuard(state);
  expect(restored.prepare(FOLLOW, 'fixture-session', '', NOW)).toEqual(guard.prepare(FOLLOW, 'fixture-session', '', NOW));
  state.binding!.tsSignRee = 'external-mutation';
  expect(clientData(restored.prepare(FOLLOW, 'fixture-session', '', NOW))['ts_sign_ree']).toBe('fixture-ts-sign');
  expect(JSON.stringify(guard)).toBe('{}');
});

it('updates response certificates without re-encoding the client header or losing the serial', () => {
  const guard = new DesktopTicketGuard();
  certificates(guard);
  const encoded = Buffer.from(pem).toString('base64');
  expect(guard.acceptResponse(guard.prepare(FOLLOW, 'fixture-session'), new Headers({
    'bd-ticket-guard-client-cert': encoded, 'bd-ticket-guard-server-cert': encoded,
  }), '')).toBe(true);
  expect(guard.exportState()).toMatchObject({ clientCert: encoded, serverCert: pem, serverSn: 'fixture-sn' });
});

it.each(['response', 'loader'] as const)('retains a warm HMAC key after %s certificate rotation until guard restoration', source => {
  const guard = new DesktopTicketGuard(); certificates(guard); bind(guard);
  const initial = guard.prepare(FOLLOW, 'fixture-session', '', NOW);
  const oldSignature = clientData(initial)['req_sign_ree'];
  if (source === 'response') guard.acceptResponse(guard.prepare(LOGIN, 'fixture-session'),
    new Headers({ 'bd-ticket-guard-server-cert': Buffer.from(rotatedPem).toString('base64') }), '');
  else guard.acceptCertificateResponse({ message: 'success', data: { server_cert: rotatedPem, server_sn: 'rotated-sn' } });
  const saved = guard.exportState();
  expect(saved.serverCert).toBe(rotatedPem);
  expect(saved.serverSn).toBe(source === 'response' ? 'fixture-sn' : 'rotated-sn');
  const current = guard.prepare(FOLLOW, 'fixture-session', '', NOW);
  expect(clientData(current)['req_sign_ree']).toBe(oldSignature);
  const restored = new DesktopTicketGuard(saved).prepare(FOLLOW, 'fixture-session', '', NOW);
  const shared = diffieHellman({ privateKey: rotatedServerKey, publicKey: publicKey(restored) });
  const derived = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
  const expected = createHmac('sha256', derived).update(ticketSignContent('fixture-session', FOLLOW.pathname, NOW)).digest('base64');
  expect(clientData(restored)['req_sign_ree']).toBe(expected);
  expect(expected).not.toBe(oldSignature);
  expect(clientData(restored)['ts_sign_ree']).toBe('fixture-ts-sign');
  expect(restored.headers['bd-ticket-guard-ree-public-key']).toBe(initial.headers['bd-ticket-guard-ree-public-key']);
});

it('does not warm the symmetric cache while disabled; first symmetric signing uses the latest certificate', () => {
  const guard = new DesktopTicketGuard(undefined, { bdticket_config: { session_guard_config: {
    enable: true, ree_enable_symmetric: false, ree_path: [FOLLOW.pathname],
  } } });
  certificates(guard); bind(guard);
  const initial = guard.prepare(FOLLOW, 'fixture-session', '', NOW);
  expect(initial.headers['bd-ticket-guard-iteration-version']).toBe('2');
  guard.acceptCertificateResponse({ message: 'success', data: { server_cert: rotatedPem } });
  const firstSymmetric = guard.prepare(FOLLOW, 'fixture-session', '', NOW, true);
  const shared = diffieHellman({ privateKey: rotatedServerKey, publicKey: publicKey(firstSymmetric) });
  const derived = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
  expect(clientData(firstSymmetric)['req_sign_ree']).toBe(createHmac('sha256', derived)
    .update(ticketSignContent('fixture-session', FOLLOW.pathname, NOW)).digest('base64'));
});

it.each(['certificate-only', 'session-and-certificate', 'cookie-without-ticket'] as const)(
  'uses the current HMAC cache across verification transport and a fresh key after restore (%s)', async mode => {
    const guard = new DesktopTicketGuard(); certificates(guard); bind(guard);
    const connection = new ApiConnection({ initialCookies: 'sessionid=fixture-session', desktopTicketGuard: guard.exportState() });
    let saved = { cookies: connection.getCookies(), guard: guard.exportState() };
    connection.enableTicketGuard(state => { saved = { cookies: connection.getCookies(), guard: structuredClone(state) }; });
    const follows = new ImFriendApi(connection);
    let calls = 0;
    let restored = false;
    const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://imdesktop.douyin.com');
      if (url.pathname === '/passport/web/validate_code/') {
        const headers = new Headers({ 'bd-ticket-guard-server-cert': Buffer.from(rotatedPem).toString('base64') });
        if (mode !== 'certificate-only') headers.set('set-cookie', 'sessionid=rotated; Path=/; Secure');
        if (mode === 'session-and-certificate') headers.set('bd-ticket-guard-server-data',
          Buffer.from(JSON.stringify({ ticket: 'rotated', ts_sign_ree: 'rotated-ticket-sign' })).toString('base64'));
        return Response.json({ message: 'success', data: {} }, { headers });
      }
      expect(url.pathname).toBe(FOLLOW.pathname);
      expect(init).toMatchObject({ method: 'POST', body: '', redirect: 'manual' });
      calls++;
      const headers = new Headers(init?.headers);
      const request = { headers: Object.fromEntries(headers) };
      const value = clientData(request);
      const session = calls > 1 && mode !== 'certificate-only' ? 'rotated' : 'fixture-session';
      expect(headers.get('cookie')).toContain(`sessionid=${session}`);
      expect(headers.get('bd-ticket-guard-iteration-version')).toBe('3');
      expect(value['ts_sign_ree']).toBe(session === 'rotated' ? 'rotated-ticket-sign' : 'fixture-ts-sign');
      const shared = diffieHellman({ privateKey: restored ? rotatedServerKey : serverKey, publicKey: publicKey(request) });
      const derived = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
      expect(value['req_sign_ree']).toBe(createHmac('sha256', derived)
        .update(ticketSignContent(session, FOLLOW.pathname, Number(value['timestamp']))).digest('base64'));
      if (calls > 1) expect(saved.guard.serverCert).toBe(rotatedPem);
      return Response.json({ status_code: 0, follow_status: 1 });
    });
    const options = { uid: '22', secUid: 'fixture-peer', followed: true };
    await follows.setFollowed(options);
    await connection.requestVerificationRaw('https://imdesktop.douyin.com/passport/web/validate_code/',
      { method: 'POST', body: 'code=fixture' }, 'action', 'xhr');
    expect(saved).toEqual({ cookies: connection.getCookies(), guard: connection.getTicketGuardState() });
    expect(saved.guard.serverCert).toBe(rotatedPem);
    expect(saved.guard.serverSn).toBe('fixture-sn');
    if (mode === 'cookie-without-ticket') {
      await expect(follows.setFollowed(options)).rejects.toThrow('安全票据');
      const next = new ImFriendApi(new ApiConnection({ initialCookies: saved.cookies, desktopTicketGuard: saved.guard }));
      await expect(next.setFollowed(options)).rejects.toThrow('安全票据');
      expect(calls).toBe(1);
      expect(network).toHaveBeenCalledTimes(2);
    } else {
      await follows.setFollowed(options);
      restored = true;
      const next = new ImFriendApi(new ApiConnection({ initialCookies: saved.cookies, desktopTicketGuard: saved.guard }));
      await next.setFollowed(options);
      expect(calls).toBe(3);
      expect(network).toHaveBeenCalledTimes(4);
    }
  },
);

it('normalizes pathname only and rejects malformed timestamps/certificates', () => {
  expect(ticketSignContent('fixture', '/test', 123)).toBe('ticket=fixture&path=/test/&timestamp=123');
  expect(() => ticketSignContent('fixture', '/test?q=1', 123)).toThrow();
  expect(() => ticketSignContent('fixture', '/test', 1.2)).toThrow();
  const guard = new DesktopTicketGuard();
  certificates(guard);
  const before = guard.exportState();
  expect(() => guard.acceptCertificateResponse({ message: 'success', data: { server_cert: 'bad', server_sn: 'new' } })).toThrow();
  expect(guard.exportState()).toEqual(before);
});

it('merges client, server and serial from separate successful certificate responses', () => {
  const guard = new DesktopTicketGuard();
  guard.acceptCertificateResponse({ message: 'success', data: { cert: 'client-text' } });
  expect(guard.exportState()).toMatchObject({ clientCert: Buffer.from('client-text').toString('base64') });
  guard.acceptCertificateResponse({ message: 'success', data: { server_sn: 'serial-only' } });
  expect(guard.exportState().serverSn).toBe('serial-only');
  guard.acceptCertificateResponse({ message: 'success', data: { server_cert: pem } });
  expect(guard.exportState()).toMatchObject({ serverCert: pem, serverSn: 'serial-only' });
  const previous = guard.exportState();
  guard.acceptCertificateResponse({ message: 'success', data: {} });
  expect(guard.exportState()).toEqual(previous);
});

it('preserves native partial-update order: binding then client, with old server and serial on malformed server data', () => {
  const guard = new DesktopTicketGuard(); certificates(guard);
  const headers = serverData({ ticket: 'new-session', ts_sign_ree: 'new-binding' });
  headers.set('bd-ticket-guard-client-cert', 'Y2xpZW50LWNlcnQ=');
  headers.set('bd-ticket-guard-server-cert', 'bad-server');
  headers.set('bd-ticket-guard-server-cert-sn', 'ignored-header');
  expect(() => guard.acceptResponse(guard.prepare(LOGIN, ''), headers, 'new-session')).toThrow();
  expect(guard.hasBinding('new-session')).toBe(true);
  expect(guard.exportState()).toMatchObject({ clientCert: 'Y2xpZW50LWNlcnQ=', serverCert: pem, serverSn: 'fixture-sn' });
});

it('rejects a PEM client header before applying any other certificate field', () => {
  const guard = new DesktopTicketGuard();
  expect(() => guard.acceptResponse(guard.prepare(LOGIN, ''), new Headers({
    'bd-ticket-guard-client-cert': '-----invalid-client', 'bd-ticket-guard-server-cert': Buffer.from(pem).toString('base64'),
  }), '')).toThrow('Base64 encoded');
  expect(guard.exportState().serverCert).toBeUndefined();
});

it('intercepts login and follow with one persisted key, then restores the binding after restart', async () => {
  const snapshots: NonNullable<ReturnType<ApiConnection['getTicketGuardState']>>[] = [];
  const requests: Array<{ path: string; headers: Headers; redirect?: Exclude<RequestInit['redirect'], undefined> }> = [];
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(snapshots.length).toBeGreaterThan(0);
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    requests.push({ path, headers, ...(init?.redirect ? { redirect: init.redirect } : {}) });
    if (path.endsWith('/get_client_cert/')) {
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('bd-ticket-guard-ree-public-key')).toBe(false);
      // This is the observed live shape: data.cert may be absent.
      return Response.json({ message: 'success', data: { server_cert: pem, server_sn: 'fixture-sn' } });
    }
    if (path === LOGIN.pathname) {
      const responseHeaders = serverData({ ticket: 'new-session', ts_sign_ree: 'bound-signature' });
      responseHeaders.append('set-cookie', 'sessionid=new-session; Path=/; Secure');
      return new Response('{}', { headers: responseHeaders });
    }
    return Response.json({ status_code: 0 });
  });
  const client = new ApiConnection({ initialCookies: 'ttwid=fixture', deviceId: 'fixture-did', installId: 'fixture-iid' });
  client.enableTicketGuard(state => snapshots.push(state));
  await client.requestRaw(LOGIN.toString(), { method: 'POST' }, true);
  expect(client.hasBoundTicket()).toBe(true);
  expect(client.jar.get('sessionid')).toBe('new-session');
  await client.requestRaw(FOLLOW.toString(), { method: 'POST', body: '' });
  const restored = new ApiConnection({ initialCookies: client.getCookies(), desktopTicketGuard: client.getTicketGuardState()! });
  restored.enableTicketGuard(state => snapshots.push(state));
  await restored.requestRaw(FOLLOW.toString(), { method: 'POST', body: '' });
  const login = requests.find(item => item.path === LOGIN.pathname)!;
  const follows = requests.filter(item => item.path === FOLLOW.pathname);
  for (const request of follows) {
    expect(request.headers.get('bd-ticket-guard-ree-public-key')).toBe(login.headers.get('bd-ticket-guard-ree-public-key'));
    expect(request.headers.get('bd-ticket-guard-iteration-version')).toBe('3');
    expect(JSON.parse(Buffer.from(request.headers.get('bd-ticket-guard-client-data')!, 'base64').toString()).ts_sign_ree).toBe('bound-signature');
    expect(request.redirect).toBe('manual');
  }
  expect(requests.filter(item => item.path.endsWith('/get_client_cert/'))).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it('does not install an ephemeral signing key when initial persistence fails', () => {
  const client = new ApiConnection();
  expect(() => client.enableTicketGuard(() => { throw new Error('disk full'); })).toThrow('disk full');
  expect(client.getTicketGuardState()).toBeUndefined();
});

it('persists cookie-only rotation even without a new guard binding', async () => {
  const guard = new DesktopTicketGuard();
  certificates(guard);
  bind(guard);
  const client = new ApiConnection({ initialCookies: 'sessionid=fixture-session', desktopTicketGuard: guard.exportState() });
  const cookies: string[] = [];
  client.enableTicketGuard(() => cookies.push(client.getCookies()));
  jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).includes('/get_client_cert/')) return Response.json({
      message: 'success', data: { server_cert: pem, server_sn: 'fixture-sn' },
    });
    return new Response('{}', { headers: { 'set-cookie': 'passport_csrf_token=rotated; Path=/; Secure' } });
  });
  await client.requestRaw('https://imdesktop.douyin.com/aweme/v1/web/user/profile/other/', { method: 'GET' });
  expect(cookies.at(-1)).toContain('passport_csrf_token=rotated');
  expect(client.hasBoundTicket()).toBe(true);
});

it('saves sensitive guard state atomically with owner-only permissions and restores it from AccountStore', () => {
  const root = join(directory, 'persistence');
  const store = new AccountStore({ dataDir: root });
  const guard = new DesktopTicketGuard();
  certificates(guard);
  bind(guard);
  const account = {
    platformUid: '10001', session: AccountStore.buildSession('sessionid=fixture-session', guard.exportState()),
    deviceProfile: { userAgent: 'fixture', bizTraceId: 'trace' },
    meta: { createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  };
  store.save(account);
  const file = join(root, 'accounts', '10001', 'account.json');
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(root, 'accounts', '10001')).filter(name => name.endsWith('.tmp'))).toEqual([]);
  const restored = new ApiConnection(store.toClientConfig(store.load('10001')!));
  expect(restored.hasBoundTicket()).toBe(true);
  expect(restored.getTicketGuardState()).toEqual(guard.exportState());
});

it.each([false, true])('persists empty ticket replacement and blocks follow after disk restore (bad server certificate=%s)', async badCertificate => {
  const guard = new DesktopTicketGuard(); certificates(guard); bind(guard);
  const store = new AccountStore({ dataDir: join(directory, `empty-binding-${badCertificate}`) });
  const client = new ApiConnection({ initialCookies: 'sessionid=fixture-session', desktopTicketGuard: guard.exportState() });
  client.enableTicketGuard(state => store.save({
    platformUid: '10001', session: AccountStore.buildSession(client.getCookies(), state),
    deviceProfile: { userAgent: 'fixture', bizTraceId: 'trace' },
    meta: { createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  }));
  const headers = serverData({ ticket: 'fixture-session', ts_sign_ree: '' });
  headers.set('set-cookie', 'sessionid=fixture-session; Path=/; Secure');
  if (badCertificate) headers.set('bd-ticket-guard-server-cert', 'invalid-server');
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"status_code":0}', { headers }));
  await expect(client.requestRaw(LOGIN.toString(), { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  const restored = new ApiConnection(store.toClientConfig(store.load('10001')!));
  for (const current of [client, restored]) {
    expect(current.hasBoundTicket()).toBe(false);
    expect(current.getTicketGuardState()?.binding?.tsSignRee).toBe('');
    expect(current.getTicketGuardState()?.serverCert).toBe(pem);
    await expect(new ImFriendApi(current).setFollowed({ uid: '22', secUid: 'synthetic-sec', followed: true })).rejects.toThrow('安全票据');
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not let an invalid response certificate hide a successful response or lose rotated cookies', async () => {
  const client = new ApiConnection({ initialCookies: 'sessionid=old-session' });
  const snapshots: Array<{ cookies: string; state: NonNullable<ReturnType<ApiConnection['getTicketGuardState']>> }> = [];
  client.enableTicketGuard(state => snapshots.push({ cookies: client.getCookies(), state }));
  jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).includes('/get_client_cert/')) return Response.json({ message: 'success', data: { server_cert: pem, server_sn: 'fixture-sn' } });
    return new Response('{"status_code":0}', { headers: {
      'set-cookie': 'sessionid=rotated; Path=/; Secure', 'x-ms-token': 'rotated-ms',
      'bd-ticket-guard-client-cert': 'Y2xpZW50LWNlcnQ=', 'bd-ticket-guard-server-cert': 'invalid-server-cert',
    } });
  });
  await expect(client.requestRaw(LOGIN.toString(), { method: 'POST' })).resolves.toMatchObject({ status: 200, rawText: '{"status_code":0}' });
  expect(snapshots.at(-1)!.cookies).toContain('sessionid=rotated');
  expect(snapshots.at(-1)!.cookies).not.toContain('msToken=');
  expect(snapshots.at(-1)!.state).toMatchObject({ clientCert: 'Y2xpZW50LWNlcnQ=', serverCert: pem, serverSn: 'fixture-sn' });
  expect(client.hasBoundTicket()).toBe(false);
});

it('recovers certificate persistence without repeating certificate retrieval or publishing unsaved state', async () => {
  const client = new ApiConnection();
  let failing = false;
  let attempted!: () => void;
  const certificateSaveAttempted = new Promise<void>(resolve => { attempted = resolve; });
  client.enableTicketGuard(() => { if (failing) { attempted(); throw new Error('fixture disk full'); } });
  let finish!: (response: Response) => void;
  const paths: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    return path.endsWith('/get_client_cert/')
      ? new Promise(resolve => { finish = resolve; }) : Response.json({ ok: true });
  });
  const first = client.requestRaw(LOGIN.toString(), { method: 'POST' });
  try {
    expect(paths).toHaveLength(2);
    await expect(first).resolves.toMatchObject({ status: 200 });
  } finally {
    finish(Response.json({ message: 'success', data: { server_cert: pem, server_sn: 'fixture-sn' } }));
  }
  failing = true;
  await certificateSaveAttempted;
  await expect(client.requestRaw(LOGIN.toString(), { method: 'POST' })).rejects.toThrow('fixture disk full');
  expect(paths).toHaveLength(2);
  failing = false;
  await expect(client.requestRaw(LOGIN.toString(), { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(paths).toEqual(['/passport/ticket_guard/get_client_cert/', LOGIN.pathname, LOGIN.pathname]);
});

it('blocks the next authenticated dispatch until failed response persistence recovers, without replaying the prior operation', async () => {
  const guard = new DesktopTicketGuard(); certificates(guard); bind(guard);
  const client = new ApiConnection({ initialCookies: 'sessionid=fixture-session', desktopTicketGuard: guard.exportState() });
  let failing = false;
  client.enableTicketGuard(() => { if (failing) throw new Error('fixture disk full'); });
  const paths: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith('/get_client_cert/')) return Response.json({ message: 'success', data: { server_cert: pem, server_sn: 'fixture-sn' } });
    if (path === LOGIN.pathname) {
      failing = true;
      const headers = serverData({ ticket: 'new-session', ts_sign_ree: 'new-binding' });
      headers.set('set-cookie', 'sessionid=new-session; Path=/; Secure');
      return new Response('{}', { headers });
    }
    return Response.json({ status_code: 0 });
  });
  await expect(client.requestRaw(LOGIN.toString(), { method: 'POST' })).rejects.toThrow('fixture disk full');
  expect(client.hasBoundTicket()).toBe(true);
  await expect(client.requestRaw(FOLLOW.toString(), { method: 'POST', body: '' })).rejects.toThrow('fixture disk full');
  expect(paths).not.toContain(FOLLOW.pathname);
  failing = false;
  await expect(client.requestRaw(FOLLOW.toString(), { method: 'POST', body: '' })).resolves.toMatchObject({ status: 200 });
  expect(paths.filter(path => path === LOGIN.pathname)).toHaveLength(1);
  expect(paths.filter(path => path === FOLLOW.pathname)).toHaveLength(1);
});

it('does not start certificate or business requests for an already cancelled caller', async () => {
  const client = new ApiConnection(); client.enableTicketGuard(() => undefined);
  const controller = new AbortController();
  const reason = new Error('caller cancelled'); controller.abort(reason);
  const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
  await expect(client.requestRaw(LOGIN.toString(), { method: 'POST', signal: controller.signal })).rejects.toBe(reason);
  expect(network).not.toHaveBeenCalled();
});

it.each(['server-only', 'serial-only', 'client-only', 'server-and-serial'] as const)('uses native startup certificate presence gate (%s)', async kind => {
  const guard = new DesktopTicketGuard();
  guard.acceptCertificateResponse({ message: 'success', data: {
    ...(kind === 'server-only' || kind === 'server-and-serial' ? { server_cert: pem } : {}),
    ...(kind === 'serial-only' || kind === 'server-and-serial' ? { server_sn: 'fixture-sn' } : {}),
    ...(kind === 'client-only' ? { cert: 'client' } : {}),
  } });
  expect(guard.needsCertificate()).toBe(kind !== 'server-and-serial');
  const client = new ApiConnection({ desktopTicketGuard: guard.exportState() });
  client.enableTicketGuard(() => undefined);
  const paths: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    return path.endsWith('/get_client_cert/')
      ? Response.json({ message: 'success', data: { server_cert: pem, server_sn: 'fixture-sn' } }) : Response.json({});
  });
  await client.requestRaw(LOGIN.toString(), { method: 'POST' });
  expect(paths).toEqual(kind === 'server-and-serial' ? [LOGIN.pathname] : ['/passport/ticket_guard/get_client_cert/', LOGIN.pathname]);
});

it('accepts a new login response but not a retired response on the same connection', async () => {
  const guard = new DesktopTicketGuard(); certificates(guard); bind(guard);
  const client = new ApiConnection({ initialCookies: 'sessionid=fixture-session', desktopTicketGuard: guard.exportState() });
  const saved = jest.fn(); client.enableTicketGuard(saved);
  const finishes: Array<(response: Response) => void> = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const old = client.requestRaw(LOGIN.toString(), { method: 'POST' });
  client.invalidateAuthenticationResponses();
  const fresh = client.requestRaw(LOGIN.toString(), { method: 'POST' });
  const headers = serverData({ ticket: 'fresh', ts_sign_ree: 'fresh-bound' });
  headers.set('set-cookie', 'sessionid=fresh; Path=/');
  finishes[1]!(new Response('{}', { headers })); await fresh;
  const current = client.getTicketGuardState(); const writes = saved.mock.calls.length;
  const stale = serverData({ ticket: 'stale', ts_sign_ree: 'stale-bound' });
  stale.set('set-cookie', 'sessionid=stale; Path=/');
  stale.set('x-ms-token', 'stale-token');
  stale.set('bd-ticket-guard-client-cert', 'stale-cert');
  finishes[0]!(new Response('{"status_code":0}', { headers: stale }));
  await expect(old).resolves.toMatchObject({ data: '{"status_code":0}' });
  expect(client.getCookies()).toBe('sessionid=fresh');
  expect(client.getTicketGuardState()).toEqual(current);
  expect(current?.privateKey).toBe(guard.exportState().privateKey);
  expect(client.hasBoundTicket()).toBe(true);
  expect(saved).toHaveBeenCalledTimes(writes);
});

it('shares one failed certificate load and does not invent a business-request retry loop', async () => {
  const client = new ApiConnection(); client.enableTicketGuard(() => undefined);
  let certCalls = 0;
  const headers: Headers[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).includes('/get_client_cert/')) { certCalls++; throw new Error('fixture cert failure'); }
    headers.push(new Headers(init?.headers));
    return Response.json({});
  });
  await Promise.all([client.requestRaw(LOGIN.toString(), { method: 'POST' }), client.requestRaw(LOGIN.toString(), { method: 'POST' })]);
  await client.requestRaw(LOGIN.toString(), { method: 'POST' });
  expect(certCalls).toBe(1);
  expect(headers).toHaveLength(3);
  expect(headers.every(value => value.has('bd-ticket-guard-ree-public-key') && value.get('bd-ticket-guard-server-cert-sn') === '0')).toBe(true);
  expect(client.hasBoundTicket()).toBe(false);
});

it('cancels one business request without cancelling pending certificates or delaying another caller', async () => {
  const client = new ApiConnection(); client.enableTicketGuard(() => undefined);
  let finish!: (value: Response) => void;
  let certificateSignal: AbortSignal | null | undefined;
  const paths: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith('/get_client_cert/')) {
      certificateSignal = init?.signal;
      return new Promise(resolve => { finish = resolve; });
    }
    if (path === LOGIN.pathname) return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    return Response.json({ ok: true });
  });
  const controller = new AbortController(); const reason = new Error('cancel one waiter');
  const first = client.requestRaw(LOGIN.toString(), { method: 'POST', signal: controller.signal });
  const secondPath = 'https://imdesktop.douyin.com/passport/web/sms_login/';
  const second = client.requestRaw(secondPath, { method: 'POST' });
  let rejected: unknown;
  const observed = first.catch(error => { rejected = error; });
  controller.abort(reason);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  try {
    expect(rejected).toBe(reason);
    expect(paths).toEqual(['/passport/ticket_guard/get_client_cert/', LOGIN.pathname, new URL(secondPath).pathname]);
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(certificateSignal?.aborted).toBe(false);
  } finally {
    finish(Response.json({ message: 'success', data: { server_cert: pem, server_sn: 'fixture-sn' } }));
    await observed;
    await second;
  }
  expect(paths).toEqual(['/passport/ticket_guard/get_client_cert/', LOGIN.pathname, new URL(secondPath).pathname]);
});
