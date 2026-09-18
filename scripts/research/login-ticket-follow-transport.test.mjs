// Synthetic accounts only. Intercept the final fetch boundary; never call a platform endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublicKey, createPrivateKey, diffieHellman, hkdfSync, createHmac, verify } from 'node:crypto';
import { ApiConnection } from '../../lib/desktop/api-connection.js';
import { DesktopTicketGuard } from '../../lib/desktop/ticket-guard.js';
import { AccountStore } from '../../lib/store/account-store.js';
import { AccountRuntime } from '../../lib/base/runtime/account-runtime.js';
import { ImFriendApi } from '../../lib/services/im/friends.js';

const origin = 'https://imdesktop.douyin.com';
const followPath = '/aweme/v1/web/commit/follow/user/';
const session = 'offline-transport-session';
const binding = 'opaque-offline-binding';

function verifyWireSignature(headers, mode, serverKey, expectedSession = session, expectedBinding = binding) {
  const point = Buffer.from(headers.get('bd-ticket-guard-ree-public-key'), 'base64');
  assert.equal(point.length, 65);
  assert.equal(point[0], 4);
  // Verify from the transmitted public point, not the client's saved private scalar.
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  const data = JSON.parse(Buffer.from(headers.get('bd-ticket-guard-client-data'), 'base64').toString());
  assert.deepEqual(Object.keys(data).sort(), ['req_content', 'req_sign_ree', 'timestamp', 'ts_sign_ree']);
  assert.equal(data.req_content, 'ticket,path,timestamp');
  assert.equal(data.ts_sign_ree, expectedBinding);
  assert.equal(Number.isSafeInteger(data.timestamp), true);
  assert.ok(Math.abs(Math.floor(Date.now() / 1000) - data.timestamp) < 5);
  assert.equal(headers.get('bd-ticket-guard-version'), '2');
  assert.equal(headers.get('bd-ticket-guard-iteration-version'), mode === 'hmac' ? '3' : '2');
  const content = Buffer.from(`ticket=${expectedSession}&path=${followPath}&timestamp=${data.timestamp}`);
  const signature = Buffer.from(data.req_sign_ree, 'base64');
  if (mode === 'hmac') {
    // Reverse ECDH with the synthetic SERVER private key and the on-wire client public key.
    const shared = diffieHellman({ privateKey: serverKey, publicKey });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
    assert.deepEqual(signature, createHmac('sha256', key).update(content).digest());
    assert.notDeepEqual(signature, createHmac('sha256', key).update(Buffer.concat([content, Buffer.from('changed')])).digest());
  } else {
    assert.equal(verify('sha256', content, { key: publicKey, dsaEncoding: 'der' }, signature), true);
    assert.equal(verify('sha256', Buffer.concat([content, Buffer.from('changed')]), publicKey, signature), false);
  }
  return point.toString('base64');
}

for (const mode of ['ree', 'hmac']) for (const cookieName of ['sessionid', 'sessionid_ss']) {
  test(`persisted ${cookieName} ${mode} binding signs the final follow request without network`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-follow-transport-'));
    const originalFetch = globalThis.fetch;
    try {
      const guard = new DesktopTicketGuard();
      let serverKey;
      if (mode === 'hmac') {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
          '-nodes', '-keyout', join(directory, 'server-key.pem'), '-out', join(directory, 'server-cert.pem'),
          '-subj', '/CN=offline-follow-transport', '-days', '1'], { stdio: 'ignore' });
        serverKey = createPrivateKey(readFileSync(join(directory, 'server-key.pem')));
        guard.acceptCertificateResponse({ message: 'success', data: {
          server_cert: readFileSync(join(directory, 'server-cert.pem'), 'utf8'), server_sn: 'offline-sn',
        } });
      }
      const loginRequest = guard.prepare(new URL(`${origin}/passport/web/check_qrconnect/`), '');
      guard.acceptResponse(loginRequest, new Headers({ 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({
        ticket: session, ts_sign_ree: binding,
      })).toString('base64') }), session);
      const cookie = `${cookieName}=${session}`;
      const store = new AccountStore({ dataDir: directory });
      store.save({ platformUid: '10001', session: { cookies: cookie, desktopTicketGuard: guard.exportState() },
        deviceProfile: { deviceId: '10002', installId: '10003', userAgent: 'offline-transport-UA',
          guid: 'offline-guid', bizTraceId: 'offline-trace', screenWidth: 1728, screenHeight: 1117 },
        meta: { createdAt: '', updatedAt: '' } });
      let calls = 0;
      const publicKeys = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin, origin);
        if (url.pathname === '/passport/ticket_guard/get_client_cert/') {
          assert.equal(mode, 'ree');
          assert.equal(new Headers(init.headers).has('cookie'), false);
          return Response.json({ message: 'success', data: {} });
        }
        assert.equal(url.pathname, followPath);
        calls++;
        assert.equal(init.method, 'POST'); assert.equal(init.body, ''); assert.equal(init.redirect, 'manual');
        assert.equal(url.searchParams.get('user_id'), '10004');
        assert.equal(url.searchParams.get('secUid'), 'offline-peer');
        assert.equal(url.searchParams.get('sec_user_id'), null);
        assert.equal(url.searchParams.get('type'), '1'); assert.equal(url.searchParams.get('tag'), 'frienddetail');
        assert.equal(url.searchParams.get('device_id'), '10002'); assert.equal(url.searchParams.get('iid'), '10003');
        assert.equal(url.searchParams.get('verifyFp'), 'verify_10002');
        const headers = new Headers(init.headers);
        assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
        assert.equal(headers.get('accept'), 'application/json, text/plain, */*');
        assert.equal(headers.get('cookie'), cookie); assert.equal(headers.get('user-agent'), 'offline-transport-UA');
        assert.equal(headers.get('referer'), origin);
        publicKeys.push(verifyWireSignature(headers, mode, serverKey));
        return Response.json({ status_code: 0, follow_status: 1 });
      };
      // Each instance is rebuilt from the on-disk account, with no mocked binding or requestRaw.
      for (let index = 0; index < 2; index++) {
        const connection = new ApiConnection({ ...store.toClientConfig(store.load('10001')), enableABogus: false });
        assert.equal(connection.hasBoundTicket(), true);
        assert.deepEqual(await new ImFriendApi(connection).setFollowed({ uid: '10004', secUid: 'offline-peer', followed: true }),
          { statusCode: 0, statusMsg: '', followStatus: 1 });
      }
      assert.equal(calls, 2); assert.equal(publicKeys[0], publicKeys[1]);
    } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const failure of ['missing-binding', 'changed-cookie']) {
  test(`restored ${failure} blocks follow before any fetch, including certificate loading`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-follow-preflight-'));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async () => { calls++; throw new Error('unexpected request'); };
      const guard = new DesktopTicketGuard();
      const request = guard.prepare(new URL(`${origin}/passport/web/check_qrconnect/`), '');
      guard.acceptResponse(request, new Headers({ 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({
        ticket: session, ts_sign_ree: binding,
      })).toString('base64') }), session);
      const state = guard.exportState();
      if (failure === 'missing-binding') delete state.binding;
      const store = new AccountStore({ dataDir: directory });
      store.save({ platformUid: '10001', session: { desktopTicketGuard: state,
        cookies: `sessionid=${failure === 'changed-cookie' ? 'different-session' : session}` },
        deviceProfile: { userAgent: 'offline-UA', bizTraceId: 'offline-trace' },
        meta: { createdAt: '', updatedAt: '' } });
      const connection = new ApiConnection({ ...store.toClientConfig(store.load('10001')), enableABogus: false });
      assert.equal(connection.hasBoundTicket(), false);
      await assert.rejects(new ImFriendApi(connection).setFollowed({ uid: '10004', secUid: 'offline-peer', followed: true }), /安全票据/);
      assert.equal(calls, 0);
    } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
  });
}

// Exercise response reception -> real runtime persistence -> disk reconstruction ->
// final HTTP signature together. Issued tickets here are synthetic, not platform proof.
for (const mode of ['ree', 'hmac']) {
  for (const scenario of ['new-binding', 'secondary-retained', 'cookie-only', 'empty-binding']) {
    test(`token beat rotation ${scenario} preserves restored follow semantics (${mode})`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'douyin-follow-rotation-'));
      const originalFetch = globalThis.fetch;
      let runtime;
      try {
        const guard = new DesktopTicketGuard();
        let serverKey;
        if (mode === 'hmac') {
          execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
            '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
            '-subj', '/CN=offline-rotation', '-days', '1'], { stdio: 'ignore' });
          serverKey = createPrivateKey(readFileSync(join(directory, 'key.pem')));
          guard.acceptCertificateResponse({ message: 'success', data: {
            server_cert: readFileSync(join(directory, 'cert.pem'), 'utf8'), server_sn: 'offline-rotation-sn',
          } });
        }
        guard.acceptResponse(guard.prepare(new URL(`${origin}/passport/web/check_qrconnect/`), ''),
          new Headers({ 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket: session, ts_sign_ree: binding })).toString('base64') }), session);
        const store = new AccountStore({ dataDir: directory });
        store.save({ platformUid: '10001', session: AccountStore.buildSession(
          `sessionid=${session}; sessionid_ss=${session}`, guard.exportState()),
        deviceProfile: { deviceId: '10002', installId: '10003', userAgent: 'offline-rotation-UA',
          guid: 'offline-guid', bizTraceId: 'offline-trace' }, meta: { createdAt: '', updatedAt: '' } });
        const account = store.load('10001');
        const connection = new ApiConnection({ ...store.toClientConfig(account), enableABogus: false });
        runtime = new AccountRuntime(store, connection);
        runtime.bindRestored(connection, account);
        const rotatedSession = 'offline-rotated-session', rotatedBinding = 'offline-rotated-binding';
        let rotated = false, beatCalls = 0, followCalls = 0, fetchCalls = 0;
        const publicKeys = [];
        globalThis.fetch = async (input, init) => {
          fetchCalls++;
          const url = new URL(input), headers = new Headers(init.headers);
          assert.equal(url.origin, origin);
          if (url.pathname === '/passport/ticket_guard/get_client_cert/') {
            assert.equal(mode, 'ree');
            assert.equal(headers.has('cookie'), false);
            return Response.json({ message: 'success', data: {} });
          }
          if (url.pathname === '/passport/token/beat/web/') {
            beatCalls++;
            assert.equal(init.method, 'GET');
            assert.equal(url.searchParams.get('scene'), 'boot');
            assert.equal(headers.get('cookie'), `sessionid=${session}; sessionid_ss=${session}`);
            assert.equal(headers.get('bd-ticket-guard-ree-public-key'), publicKeys[0]);
            const responseHeaders = new Headers();
            responseHeaders.append('set-cookie', `sessionid=${rotatedSession}; Path=/; Secure`);
            if (scenario !== 'secondary-retained') responseHeaders.append('set-cookie', `sessionid_ss=${rotatedSession}; Path=/; Secure`);
            if (scenario === 'new-binding' || scenario === 'empty-binding') responseHeaders.set('bd-ticket-guard-server-data',
              Buffer.from(JSON.stringify({ ticket: rotatedSession, ts_sign_ree: scenario === 'new-binding' ? rotatedBinding : '' })).toString('base64'));
            return Response.json({ message: 'success', data: {} }, { headers: responseHeaders });
          }
          assert.equal(url.pathname, followPath);
          assert.ok(!rotated || ['new-binding', 'secondary-retained'].includes(scenario));
          followCalls++;
          assert.equal(init.method, 'POST'); assert.equal(init.body, ''); assert.equal(init.redirect, 'manual');
          const newTicket = rotated && scenario === 'new-binding';
          const primary = rotated ? rotatedSession : session;
          const secondary = rotated && scenario !== 'secondary-retained' ? rotatedSession : session;
          assert.equal(headers.get('cookie'), `sessionid=${primary}; sessionid_ss=${secondary}`);
          publicKeys.push(verifyWireSignature(headers, mode, serverKey, newTicket ? rotatedSession : session, newTicket ? rotatedBinding : binding));
          return Response.json({ status_code: 0, follow_status: 1 });
        };
        const follow = client => new ImFriendApi(client).setFollowed({ uid: '10004', secUid: 'offline-peer', followed: true });
        await follow(connection);
        await connection.sendPassportTokenBeat('boot');
        rotated = true;
        // Stop the previous owner, then reopen the store rather than reusing its object.
        runtime.suspend();
        const reopened = new AccountStore({ dataDir: directory });
        const saved = reopened.load('10001');
        assert.equal(saved.session.cookies, connection.getCookies());
        assert.deepEqual(saved.session.desktopTicketGuard, connection.getTicketGuardState());
        const restored = new ApiConnection({ ...reopened.toClientConfig(saved), enableABogus: false });
        const ready = scenario === 'new-binding' || scenario === 'secondary-retained';
        assert.equal(restored.hasBoundTicket(), ready);
        if (ready) {
          assert.equal((await follow(restored)).followStatus, 1);
          assert.equal(publicKeys[1], publicKeys[0]);
        } else {
          const before = fetchCalls;
          await assert.rejects(follow(restored), /安全票据/);
          assert.equal(fetchCalls, before);
        }
        assert.equal(beatCalls, 1);
        assert.equal(followCalls, ready ? 2 : 1);
      } finally {
        runtime?.suspend();
        globalThis.fetch = originalFetch;
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
