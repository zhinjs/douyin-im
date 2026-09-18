// Offline harness checks use the built SDK and synthetic HTTP, never the real account store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ApiConnection } from '../../lib/desktop/api-connection.js';
import { AccountStore } from '../../lib/store/account-store.js';
import { DesktopTicketGuard } from '../../lib/desktop/ticket-guard.js';
import { runLoginTicketAcceptance, verifyRestoredTicketSigning } from './login-ticket-acceptance.mjs';

function boundClient(cookies = 'sessionid=synthetic-session') {
  const guard = new DesktopTicketGuard();
  const request = guard.prepare(new URL('https://imdesktop.douyin.com/passport/web/check_qrconnect/'), '');
  guard.acceptResponse(request, new Headers({ 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({
    ticket: 'synthetic-session', ts_sign_ree: 'synthetic-signature',
  })).toString('base64') }), 'synthetic-session');
  return new ApiConnection({ initialCookies: cookies, desktopTicketGuard: guard.exportState(), enableABogus: false });
}

function restoredClient(current, override = {}) {
  return new ApiConnection({ initialCookies: current.getCookies(), desktopTicketGuard: current.getTicketGuardState(), enableABogus: false, ...override });
}

test('local verification exercises REE signing and matching snapshots without dispatching HTTP', () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('unexpected network'); };
  try {
    const current = boundClient();
    assert.deepEqual(verifyRestoredTicketSigning(current, restoredClient(current), 1780000000), {
      signatureCheckScope: 'local-only', restoredKeyMatches: true, restoredGuardStateMatches: true,
      restoredSessionMatches: true, currentSignatureVerified: true, restoredSignatureVerified: true,
      currentSignatureMode: 'ree', restoredSignatureMode: 'ree', localSigningVerified: true,
    });
  } finally { globalThis.fetch = fetch; }
});

test('two bound connections with different private keys no longer pass restore acceptance', () => {
  const current = boundClient();
  const restored = restoredClient(current, { desktopTicketGuard: { ...current.getTicketGuardState(),
    privateKey: new DesktopTicketGuard().exportState().privateKey } });
  assert.equal(current.hasBoundTicket(), true); assert.equal(restored.hasBoundTicket(), true);
  const result = verifyRestoredTicketSigning(current, restored);
  assert.equal(result.currentSignatureVerified, true); assert.equal(result.restoredSignatureVerified, true);
  assert.equal(result.restoredKeyMatches, false); assert.equal(result.localSigningVerified, false);
});

test('changed Session cookie is detected even when the alternate cookie keeps both connections bound', () => {
  const current = boundClient();
  const restored = restoredClient(current, { initialCookies: 'sessionid=different-session; sessionid_ss=synthetic-session' });
  assert.equal(restored.hasBoundTicket(), true);
  const result = verifyRestoredTicketSigning(current, restored);
  assert.equal(result.restoredSignatureVerified, true); assert.equal(result.restoredSessionMatches, false);
  assert.equal(result.localSigningVerified, false);
});

test('SS-only binding verifies the selected Session without fabricating a primary cookie', () => {
  const current = boundClient('sessionid_ss=synthetic-session');
  assert.equal(verifyRestoredTicketSigning(current, restoredClient(current)).localSigningVerified, true);
  assert.equal(current.jar.get('sessionid'), undefined);
});

test('changed opaque server binding is a restore mismatch, not verified platform acceptance', () => {
  const current = boundClient();
  const state = current.getTicketGuardState();
  const restored = restoredClient(current, { desktopTicketGuard: { ...state, binding: { ...state.binding, tsSignRee: 'other-signature' } } });
  assert.equal(restored.hasBoundTicket(), true);
  const result = verifyRestoredTicketSigning(current, restored);
  assert.equal(result.restoredSignatureVerified, true);
  assert.equal(result.restoredGuardStateMatches, false); assert.equal(result.localSigningVerified, false);
});

test('an unprotected follow policy cannot be labeled as a verified signed request', () => {
  const current = boundClient();
  current.requiresTicket = () => false;
  const result = verifyRestoredTicketSigning(current, restoredClient(current));
  assert.equal(result.currentSignatureMode, 'not-protected'); assert.equal(result.localSigningVerified, false);
});

for (const tamper of ['signature', 'timestamp', 'content', 'server-binding', 'public-key', 'iteration']) {
  test(`local verification rejects tampered ${tamper} without exposing secrets`, () => {
    const current = boundClient(), restored = restoredClient(current);
    const prepare = DesktopTicketGuard.prototype.prepare;
    DesktopTicketGuard.prototype.prepare = function (...args) {
      const original = prepare.apply(this, args), headers = { ...original.headers };
      const data = JSON.parse(Buffer.from(headers['bd-ticket-guard-client-data'], 'base64').toString());
      if (tamper === 'signature') data.req_sign_ree = Buffer.alloc(32).toString('base64');
      if (tamper === 'timestamp') data.timestamp++;
      if (tamper === 'content') data.req_content = 'path,timestamp';
      if (tamper === 'server-binding') data.ts_sign_ree = 'wrong';
      if (tamper === 'public-key') headers['bd-ticket-guard-ree-public-key'] = 'wrong';
      if (tamper === 'iteration') headers['bd-ticket-guard-iteration-version'] = '3';
      headers['bd-ticket-guard-client-data'] = Buffer.from(JSON.stringify(data)).toString('base64');
      return { ...original, headers };
    };
    try {
      const result = verifyRestoredTicketSigning(current, restored);
      assert.equal(result.currentSignatureVerified, false); assert.equal(result.localSigningVerified, false);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-session|synthetic-signature|privateKey|req_sign_ree/);
    } finally { DesktopTicketGuard.prototype.prepare = prepare; }
  });
}

test('local verification checks the certificate-derived HMAC path, not only REE fallback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-signing-fixture-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
      '-subj', '/CN=offline-acceptance-fixture', '-days', '1'], { stdio: 'ignore' });
    const base = boundClient();
    const current = restoredClient(base, { desktopTicketGuard: { ...base.getTicketGuardState(),
      serverCert: readFileSync(join(directory, 'cert.pem'), 'utf8'), serverSn: 'fixture-serial' } });
    const result = verifyRestoredTicketSigning(current, restoredClient(current));
    assert.equal(result.currentSignatureMode, 'hmac'); assert.equal(result.restoredSignatureMode, 'hmac');
    assert.equal(result.localSigningVerified, true);
    const restored = restoredClient(current, { desktopTicketGuard: { ...current.getTicketGuardState(), serverSn: 'different-serial' } });
    const mismatch = verifyRestoredTicketSigning(current, restored);
    assert.equal(mismatch.currentSignatureVerified, true); assert.equal(mismatch.restoredSignatureVerified, true);
    assert.equal(mismatch.restoredGuardStateMatches, false); assert.equal(mismatch.localSigningVerified, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI without explicit --live does not start a login', () => {
  const output = execFileSync(process.execPath, ['scripts/research/login-ticket-acceptance.mjs'], { encoding: 'utf8', timeout: 5000 });
  assert.match(output, /No login started/);
  assert.doesNotMatch(output, /isolated-store|qr-status|retained-store/);
});

for (const scenario of ['bound', 'unbound', 'wrong-account', 'qr-ui-failed']) {
  test(`real Auth/persistence with synthetic ${scenario} response`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-acceptance-fixture-'));
    const originalFetch = globalThis.fetch;
    const requestPaths = [];
    try {
      globalThis.fetch = async target => {
        const url = new URL(target);
        assert.equal(url.hostname, 'imdesktop.douyin.com');
        requestPaths.push(url.pathname);
        if (url.pathname.endsWith('/get_client_cert/')) return Response.json({ message: 'success', data: {} });
        assert.equal(url.pathname, '/passport/web/check_qrconnect/');
        const headers = new Headers({ 'set-cookie': 'sessionid=synthetic-session; Path=/' });
        if (scenario === 'bound') headers.set('bd-ticket-guard-server-data', Buffer.from(JSON.stringify({
          ticket: 'synthetic-session', ts_sign_ree: 'synthetic-signature',
        })).toString('base64'));
        return Response.json({}, { headers });
      };
      const client = new ApiConnection({ deviceId: 'synthetic-device', installId: 'synthetic-install', enableABogus: false });
      client.initializeDevice = async () => ({ deviceId: client.getDeviceId(), installId: client.getInstallId() });
      client.ttwidCheck = async () => { throw new Error('synthetic optional warmup failure'); };
      client.getQrcode = async () => ({ token: 'synthetic-qr-token', qrcodeBase64: 'cW9kZQ==', expireTime: Math.ceil(Date.now() / 1000) + 60 });
      client.checkQrconnect = async () => {
        await client.requestRaw('https://imdesktop.douyin.com/passport/web/check_qrconnect/', { method: 'POST' });
        return { message: 'success', data: { status: 'confirmed', error_code: 0, user_data: {} } };
      };
      client.getSelfProfile = async () => ({ status_code: 0, user: { uid: scenario === 'wrong-account' ? '999' : '1150530166719210' } });
      const reports = [];
      const run = runLoginTicketAcceptance({ directory, connection: client, signal: new AbortController().signal,
        showQr: () => { if (scenario === 'qr-ui-failed') throw new Error('synthetic QR UI failure'); },
        openVerification: () => { throw new Error('unexpected verification'); }, report: item => reports.push(item) });
      if (scenario === 'wrong-account') await assert.rejects(run, /does not match authorized/);
      else if (scenario === 'qr-ui-failed') await assert.rejects(run, /synthetic QR UI failure/);
      else {
        const result = await run;
        assert.equal(result.uidMatches, true);
        assert.equal(result.boundTicket, scenario === 'bound');
        assert.equal(result.restoredBoundTicket, scenario === 'bound');
        assert.equal(result.localSigningVerified, scenario === 'bound');
        assert.equal(result.signatureCheckScope, 'local-only');
        assert.equal(result.imStarted, false);
        assert.equal(result.followAttempted, false);
        const saved = new AccountStore({ dataDir: directory }).load('1150530166719210');
        assert.equal(!!saved.session.desktopTicketGuard?.binding, scenario === 'bound');
        assert.equal(statSync(join(directory, 'accounts/1150530166719210/account.json')).mode & 0o777, 0o600);
      }
      assert.equal(requestPaths.some(path => /follow|im\/|token\/beat/.test(path)), false);
      assert.doesNotMatch(JSON.stringify(reports), /synthetic-session|synthetic-signature|synthetic-qr-token|privateKey/);
      if (scenario === 'qr-ui-failed') assert.deepEqual(readdirSync(join(directory, 'accounts/_pending')), []);
    } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
  });
}

test('cancellation before startup performs no initialization', async () => {
  const controller = new AbortController(); controller.abort(new Error('fixture cancel'));
  await assert.rejects(runLoginTicketAcceptance({ directory: '/unused', connection: {}, signal: controller.signal, showQr() {} }), /fixture cancel/);
});

test('an existing account directory is rejected before network initialization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-acceptance-existing-'));
  try {
    const store = new AccountStore({ dataDir: directory });
    store.save({ platformUid: '10001', session: { cookies: 'sessionid=untouched' },
      deviceProfile: {}, meta: { createdAt: '', updatedAt: '' } });
    await assert.rejects(runLoginTicketAcceptance({ directory, connection: {}, signal: new AbortController().signal, showQr() {} }), /must be empty/);
    assert.equal(store.load('10001').session.cookies, 'sessionid=untouched');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unfinished login directory is rejected without removing its pending state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-acceptance-pending-'));
  try {
    const store = new AccountStore({ dataDir: directory });
    store.createPending({ id: 'fixture-pending', deviceProfile: {}, cookies: 'pending-cookie' });
    await assert.rejects(runLoginTicketAcceptance({ directory, connection: {}, signal: new AbortController().signal, showQr() {} }), /must be empty/);
    assert.equal(store.loadPending('fixture-pending').cookies, 'pending-cookie');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
