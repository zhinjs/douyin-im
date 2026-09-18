// Complete synthetic QR -> cookie/ticket -> promotion -> disk restore -> follow chain.
// Only device registration (no host hardware) and final fetch are replaced. No real login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createPublicKey, createPrivateKey, diffieHellman, hkdfSync, createHmac, verify } from 'node:crypto';
import { ApiConnection } from '../../lib/desktop/api-connection.js';
import { AccountStore } from '../../lib/store/account-store.js';
import { ImFriendApi } from '../../lib/services/im/friends.js';
import { runLoginTicketAcceptance } from './login-ticket-acceptance.mjs';

const uid = '1150530166719210'; // Harness identity restriction, not a live account lookup.
const session = 'offline-qr-chain-session', binding = 'offline-qr-chain-binding';
const followPath = '/aweme/v1/web/commit/follow/user/';

for (const scenario of ['ree', 'hmac', 'unbound', 'incomplete-body',
  'captcha-ree', 'captcha-hmac', 'secondary-ree', 'secondary-hmac',
  'page-captcha-ree', 'page-captcha-hmac', 'page-secondary-ree', 'page-secondary-hmac',
  'cancel-captcha', 'cancel-secondary', 'verification-host-error', 'abort-verification']) {
  test(`actual QR methods, response binding and restored follow: ${scenario}`, { timeout: 20_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-qr-chain-'));
    const originalFetch = globalThis.fetch;
    const paths = [], reports = [];
    let serverCert, serverKey, loginPublicKey, client, firstPoll, activeVerification, verificationError;
    let followCalls = 0, qrShown = 0, pollCalls = 0, verificationCalls = 0;
    const hmac = scenario.endsWith('hmac');
    const challenge = !['ree', 'hmac', 'unbound', 'incomplete-body'].includes(scenario);
    const secondary = scenario.includes('secondary');
    const pageMode = scenario.startsWith('page-');
    let completedFp = 'offline-completed-fp';
    const interrupted = scenario.startsWith('cancel-') || scenario === 'verification-host-error' || scenario === 'abort-verification';
    const controller = new AbortController();
    try {
      if (hmac) {
        // Certificate files are separate from the initially empty account store.
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
          '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
          '-subj', '/CN=offline-qr-chain', '-days', '1'], { stdio: 'ignore' });
        serverCert = readFileSync(join(directory, 'cert.pem'), 'utf8');
        serverKey = createPrivateKey(readFileSync(join(directory, 'key.pem')));
      }
      const storeDirectory = mkdtempSync(join(directory, 'store-'));
      globalThis.fetch = async (target, init) => {
        const url = new URL(target), headers = new Headers(init.headers);
        if (pageMode && url.origin === 'https://vcs.zijieapi.com' && url.pathname === '/vc/setting') {
          return Response.json({ data: { verify: {} } });
        }
        assert.equal(url.origin, 'https://imdesktop.douyin.com');
        paths.push(url.pathname);
        switch (url.pathname) {
          case '/passport/ticket_guard/get_client_cert/':
            assert.equal(headers.has('cookie'), false);
            assert.equal(headers.has('bd-ticket-guard-ree-public-key'), false);
            return Response.json({ message: 'success', data: serverCert ? { server_cert: serverCert, server_sn: 'fixture-sn' } : {} });
          case '/ttwid/check/':
            assert.equal(init.method, 'POST');
            return Response.json({ status_code: 0 }, { headers: { 'set-cookie': 'ttwid=offline-warmup; Path=/' } });
          case '/passport/web/get_qrcode/':
            assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
            assert.equal(url.searchParams.get('device_id'), '10002');
            assert.equal(url.searchParams.get('iid'), '10003');
            assert.ok(url.searchParams.get('sign')); assert.ok(url.searchParams.get('a_bogus'));
            assert.ok(headers.get('x-tt-passport-aid-sign'));
            loginPublicKey = headers.get('bd-ticket-guard-ree-public-key');
            assert.ok(loginPublicKey); assert.equal(init.redirect, 'manual');
            return Response.json({ message: 'success', data: {
              qrcode: 'c3ludGhldGljLW5vdC1hLXJlYWwtcXI=', token: 'offline-qr-token', expire_time: 9999999999,
            } }, { headers: { 'set-cookie': 'passport_csrf_token=offline-csrf; Path=/' } });
          case '/passport/web/check_qrconnect/': {
            pollCalls++;
            assert.equal(qrShown, 1); assert.equal(init.method, 'POST');
            assert.equal(new URLSearchParams(init.body).get('token'), 'offline-qr-token');
            assert.equal(headers.get('x-tt-passport-csrf-token'), challenge && pollCalls > 1 ? 'offline-challenge-csrf' : 'offline-csrf');
            assert.equal(headers.get('bd-ticket-guard-ree-public-key'), loginPublicKey);
            assert.ok(url.searchParams.get('sign')); assert.ok(url.searchParams.get('a_bogus'));
            assert.equal(client.hasBoundTicket(), false);
            if (challenge && pollCalls === 1) {
              assert.equal(verificationCalls, 0);
              firstPoll = { query: url.searchParams, body: init.body };
              const data = secondary ? {
                error_code: 2046, sms_code_key: 'offline-sms-key+/=',
                verify_center_secondary_decision_conf: JSON.stringify({ verify_from: 'passport', std_verify_way: 'mobile_sms_verify' }),
              } : { error_code: 1105,
                verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'offline-challenge' }),
              };
              return Response.json({ message: 'error', data }, { headers: {
                'set-cookie': 'passport_csrf_token=offline-challenge-csrf; Path=/', 'x-ms-token': 'offline-challenge-ms',
              } });
            }
            if (challenge) {
              assert.equal(interrupted, false, 'a cancelled/failed verification must never replay the login');
              assert.equal(pollCalls, 2); assert.equal(verificationCalls, 1);
              // C321 reuses original signed params; only captcha fp/verifyFp or
              // the server's secondary sms_code_key are added, not callback fields.
              for (const name of ['sign', 'qs', 'ts', 'biz_trace_id']) {
                assert.equal(url.searchParams.get(name), firstPoll.query.get(name));
              }
              assert.equal(url.searchParams.has('isResend'), false);
              assert.equal(url.searchParams.get('msToken'), firstPoll.query.get('msToken'), 'business headers are not BDMS report responses');
              assert.equal(url.searchParams.get('fp'), secondary ? null : completedFp);
              assert.equal(url.searchParams.get('verifyFp'), secondary ? null : completedFp);
              const body = new URLSearchParams(init.body);
              if (secondary) {
                assert.equal(body.get('sms_code_key'), 'offline-sms-key+/=');
                // C321's module83848 keeps original percent escapes before qD
                // serializes again; fetchSec's decoding parser is different.
                const original = Object.fromEntries(firstPoll.body.split('&').map(pair => pair.split('=')));
                original.sms_code_key = 'offline-sms-key+/=';
                const expected = Object.entries(original).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
                assert.equal(init.body, expected);
              } else {
                assert.equal(init.body, firstPoll.body);
              }
              assert.equal(headers.get('cookie').includes('sessionid='), false);
            }
            const responseHeaders = new Headers({ 'set-cookie': `sessionid=${session}; Path=/; Secure` });
            if (scenario !== 'unbound') responseHeaders.set('bd-ticket-guard-server-data', Buffer.from(JSON.stringify({
              ticket: session, ts_sign_ree: binding,
            })).toString('base64'));
            if (scenario === 'incomplete-body') {
              return new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture body lost')); } }), { headers: responseHeaders });
            }
            return Response.json({ message: 'success', data: { status: 'confirmed', error_code: 0, user_data: {} } }, { headers: responseHeaders });
          }
          case '/aweme/v1/web/user/profile/self/':
            assert.equal(init.method, 'GET'); assert.ok(headers.get('cookie').includes(`sessionid=${session}`));
            return Response.json({ status_code: 0, user: { uid, nickname: 'offline fixture' } });
          case followPath: {
            followCalls++;
            assert.equal(init.method, 'POST'); assert.equal(init.body, ''); assert.equal(init.redirect, 'manual');
            assert.equal(url.searchParams.get('user_id'), '10004'); assert.equal(url.searchParams.get('secUid'), 'offline-peer');
            assert.equal(url.searchParams.get('type'), '1'); assert.equal(url.searchParams.get('tag'), 'frienddetail');
            // follow does not inherit Passport's BDMS query signing merely because the default is enabled.
            assert.equal(url.searchParams.has('a_bogus'), false);
            assert.equal(headers.get('bd-ticket-guard-ree-public-key'), loginPublicKey);
            assert.ok(headers.get('cookie').includes(`sessionid=${session}`));
            const point = Buffer.from(loginPublicKey, 'base64');
            const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
              x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
            const data = JSON.parse(Buffer.from(headers.get('bd-ticket-guard-client-data'), 'base64').toString());
            assert.equal(data.ts_sign_ree, binding); assert.equal(data.req_content, 'ticket,path,timestamp');
            assert.equal(Number.isSafeInteger(data.timestamp), true);
            const content = Buffer.from(`ticket=${session}&path=${followPath}&timestamp=${data.timestamp}`);
            const signature = Buffer.from(data.req_sign_ree, 'base64');
            assert.equal(headers.get('bd-ticket-guard-iteration-version'), hmac ? '3' : '2');
            if (hmac) {
              const shared = diffieHellman({ privateKey: serverKey, publicKey });
              const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
              assert.deepEqual(signature, createHmac('sha256', key).update(content).digest());
            } else assert.equal(verify('sha256', content, publicKey, signature), true);
            return Response.json({ status_code: 0, follow_status: 1 });
          }
          default: throw new Error(`Unexpected synthetic route: ${url.pathname}`);
        }
      };
      client = new ApiConnection({ deviceId: '10002', installId: '10003' });
      client.initializeDevice = async () => ({ deviceId: client.getDeviceId(), installId: client.getInstallId() });
      const run = runLoginTicketAcceptance({ directory: storeDirectory, connection: client, signal: controller.signal,
        showQr: info => { qrShown++; assert.equal(info.token, 'offline-qr-token'); },
        openVerification: verification => (async () => {
          assert.equal(challenge, true); verificationCalls++; activeVerification = verification;
          assert.equal(verification.operation, 'qr-connect');
          assert.equal(verification.errorCode, secondary ? 2046 : 1105);
          assert.ok(verification.methods.includes(secondary ? 'auxiliary-mobile-sms' : 'captcha'));
          // No pending callback may promote an account or issue a second poll.
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(pollCalls, 1); assert.equal(followCalls, 0);
          assert.equal(new AccountStore({ dataDir: storeDirectory }).load(uid), undefined);
          assert.equal(paths.includes('/aweme/v1/web/user/profile/self/'), false);
          if (scenario.startsWith('cancel-')) { verification.cancel('offline-user-cancelled'); return; }
          if (scenario === 'verification-host-error') throw new Error('offline-verification-host-failed');
          if (scenario === 'abort-verification') { controller.abort(new Error('offline-aborted')); return; }
          if (pageMode) {
            await completeOnLocalPage(verification, secondary, originalFetch, fp => { completedFp = fp; });
            return;
          }
          await verification.complete({ ...(secondary ? {} : { fp: 'offline-completed-fp' }), fields: {
            token: 'must-not-replace-qr', sms_code_key: 'must-not-replace-server-key', sessionid: 'must-not-be-a-cookie',
          } });
        })().catch(error => { verificationError = error; throw error; }), report: item => reports.push(item) });
      const store = new AccountStore({ dataDir: storeDirectory });
      if (interrupted) {
        await assert.rejects(run);
        assert.equal(verificationCalls, 1); assert.equal(pollCalls, 1);
        assert.equal(activeVerification.signal.aborted, true);
        await assert.rejects(activeVerification.complete({ fp: 'too-late' }), /登录验证已结束/);
        assert.equal(client.hasBoundTicket(), false); assert.equal(client.jar.get('sessionid'), undefined);
        assert.equal(store.load(uid), undefined);
        assert.equal(paths.includes('/aweme/v1/web/user/profile/self/'), false);
        assert.equal(followCalls, 0);
        assert.equal(reports.some(item => item.phase === 'result'), false);
        // A failed assertion inside the UI callback is not evidence of correct
        // cancellation: the acceptance tool also cancels when that callback throws.
        if (scenario === 'verification-host-error') assert.equal(verificationError?.message, 'offline-verification-host-failed');
        else assert.equal(verificationError, undefined);
      } else if (scenario === 'incomplete-body') {
        await assert.rejects(run, /fixture body lost/);
        assert.equal(client.hasBoundTicket(), false);
        assert.equal(store.load(uid), undefined);
        assert.equal(paths.includes('/aweme/v1/web/user/profile/self/'), false);
      } else {
        const result = await run;
        assert.equal(result.localSigningVerified, scenario !== 'unbound');
        assert.equal(result.followAttempted, false); assert.equal(result.imStarted, false);
        assert.equal(followCalls, 0);
        const saved = store.load(uid);
        assert.equal(saved.platformUid, uid);
        const restored = new ApiConnection(store.toClientConfig(saved));
        const action = new ImFriendApi(restored).setFollowed({ uid: '10004', secUid: 'offline-peer', followed: true });
        if (scenario === 'unbound') { await assert.rejects(action, /安全票据/); assert.equal(followCalls, 0); }
        else { assert.deepEqual(await action, { statusCode: 0, statusMsg: '', followStatus: 1 }); assert.equal(followCalls, 1); }
      }
      // QR polling has a bounded error retry budget, unlike the follow mutation.
      assert.equal(paths.filter(path => path === '/passport/web/check_qrconnect/').length,
        scenario === 'incomplete-body' ? 4 : challenge && !interrupted ? 2 : 1);
      assert.equal(verificationCalls, challenge ? 1 : 0);
      assert.equal(paths.some(path => /token\/beat|\/im\/|websocket/.test(path)), false);
      assert.doesNotMatch(JSON.stringify(reports), /offline-qr-chain-session|offline-qr-chain-binding|offline-qr-token|offline-completed-fp|offline-sms-key|privateKey/);
    } finally { controller.abort(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
  });
}

// Exercise the shipped manual-page JavaScript and its real completion route,
// not just LoginVerification.complete(). Only the official UI is a fixture.
async function completeOnLocalPage(verification, secondary, localFetch, onBoot) {
  const originalWrite = process.stderr.write;
  let announce;
  const announced = new Promise(resolve => { announce = resolve; });
  process.stderr.write = function (chunk, ...args) {
    const match = String(chunk).match(/\[login\] 浏览器打开: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (match) announce(match[1]);
    const callback = args.find(value => typeof value === 'function'); callback?.();
    return true;
  };
  const opened = verification.open({ openBrowser: false, timeoutMs: 5000 });
  const ended = opened.catch(() => undefined);
  try {
    const url = await Promise.race([announced, opened.then(() => { throw new Error('Page closed before announcement'); })]);
    const page = await localFetch(url).then(response => response.text());
    const status = { innerHTML: '', textContent: '' };
    let getterCalls = 0, submissions = 0;
    const browser = { React: {}, ReactDOM: {}, addEventListener: () => undefined, verifySDK: {
      initVerifyOptions: () => undefined,
      getCaptchaWebId: async () => { getterCalls++; return 'wrong-remote-getter'; },
      autoRender: options => {
        assert.equal(options.secondVerifyWebOptions.scene, '4');
        if (secondary) options.secondVerifyWebOptions.callBack({ status: false, fp: 'ignored-secondary-fp' });
        else options.captchaOptions.successCb({ fp: 'ignored-captcha-payload' });
      },
    } };
    const realm = { window: browser, document: { cookie: '', getElementById: () => status,
      createElement: () => ({ remove: () => undefined }),
      head: { appendChild: script => queueMicrotask(() => script.onload?.()) } },
    fetch: (target, init) => {
      const endpoint = new URL(target, url);
      assert.equal(endpoint.origin, new URL(url).origin); assert.equal(endpoint.pathname, '/api/complete');
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { result: secondary ? {} : { fp: browser.__LOGIN_VERIFY__.fp } });
      submissions++;
      return localFetch(endpoint, init);
    }, localStorage: { setItem: () => undefined }, location: { search: '', hostname: '127.0.0.1' },
    URL, URLSearchParams, FormData, TextEncoder, AbortController, setTimeout, clearTimeout };
    for (const script of [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].slice(0, -1)) runInNewContext(script[1], realm);
    assert.equal(typeof browser.__LOGIN_VERIFY__.fp, 'string');
    onBoot(browser.__LOGIN_VERIFY__.fp);
    await browser.startDouyinVerification();
    await opened;
    assert.equal(getterCalls, 0); assert.equal(submissions, 1);
  } finally {
    verification.cancel('offline page cleanup'); await ended;
    process.stderr.write = originalWrite;
  }
}
