// Password/SMS, including SMS/voice switches -> binding -> restore -> follow signature.
// Offline only: fake hardware initialization, synthetic HTTP at final fetch, no IM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublicKey, createPrivateKey, diffieHellman, hkdfSync, createHmac, verify } from 'node:crypto';
import { ApiConnection } from '../../lib/desktop/api-connection.js';
import { AccountStore } from '../../lib/store/account-store.js';
import { AccountRuntime } from '../../lib/base/runtime/account-runtime.js';
import { AccountAuth } from '../../lib/sdk/auth/account-auth.js';
import { ImFriendApi } from '../../lib/services/im/friends.js';

const uid = '10001', session = 'offline-credential-session', binding = 'offline-credential-binding';
const followPath = '/aweme/v1/web/commit/follow/user/';

for (const flow of ['password', 'sms', 'password-to-sms', 'sms-to-voice']) for (const scenario of [
  'ree', 'hmac', 'captcha', 'secondary', 'unbound', 'wrong-binding', 'incomplete-body', 'cancel',
  'subaccount', 'subaccount-hmac',
]) {
  const switched = flow.includes('-to-');
  const method = flow.startsWith('password') ? 'password' : 'sms';
  const finalMethod = switched ? 'sms' : method;
  test(`credential login, persistence and restored follow: ${flow}/${scenario}`, { timeout: 20_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-credential-chain-'));
    const savedFetch = globalThis.fetch;
    const requests = new Map(), challenges = [], completions = [], selections = [];
    let client, runtime, auth, serverCert, serverKey, publicPoint;
    let smsSent = 0, voiceSent = 0, smsRequired = 0, followCalls = 0, dispatchCount = 0;
    const challenged = ['captcha', 'secondary', 'cancel'].includes(scenario);
    const subaccount = scenario.startsWith('subaccount');
    const bound = !['unbound', 'wrong-binding', 'incomplete-body', 'cancel'].includes(scenario);
    const loginPath = finalMethod === 'password' ? '/passport/web/user/login/' : '/passport/web/sms_login/';
    const challengePath = flow === 'sms-to-voice' ? '/passport/web/send_voice_code/' : '/passport/web/send_code/';
    try {
      if (scenario.endsWith('hmac')) {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
          '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
          '-subj', '/CN=offline-credential-chain', '-days', '1'], { stdio: 'ignore' });
        serverCert = readFileSync(join(directory, 'cert.pem'), 'utf8');
        serverKey = createPrivateKey(readFileSync(join(directory, 'key.pem')));
      }
      const storeDirectory = mkdtempSync(join(directory, 'store-'));
      const store = new AccountStore({ dataDir: storeDirectory });
      client = new ApiConnection({ deviceId: '10002', installId: '10003' });
      client.startDeviceLifecycle = async () => ({ deviceId: '10002', installId: '10003' });
      runtime = new AccountRuntime(store, client);
      const unexpected = () => { throw new Error('Unexpected credential login branch'); };
      auth = new AccountAuth({ client, store, loginMethod: method, mobile: '13800000000', password: 'a😀b' }, {
        onQrcode: unexpected, onQrStatus: unexpected,
        onVoice: () => { assert.equal(flow, 'sms-to-voice'); voiceSent++; },
        onAccountSelection: selection => { assert.equal(subaccount, true); selections.push(selection); },
        onSmsRequired: () => { assert.equal(flow, 'password-to-sms'); smsRequired++; },
        onSms: () => { assert.equal(finalMethod, 'sms'); smsSent++; },
        onVerification: ({ verification }) => {
          challenges.push(verification.operation);
          if (scenario === 'cancel') verification.cancel('offline cancellation');
          else completions.push(verification.complete(scenario === 'secondary'
            ? { fields: { password: 'must-not-replace', sms_code_key: 'must-not-use' } }
            : { fp: `offline-fp-${challenges.length}` }));
        },
        onLoggedIn: account => { assert.equal(account.platformUid, uid); runtime.bindPromoted(client, account); },
      });
      globalThis.fetch = async (target, init) => {
        dispatchCount++;
        const url = new URL(target), headers = new Headers(init.headers);
        assert.equal(url.origin, 'https://imdesktop.douyin.com');
        if (url.pathname === '/passport/ticket_guard/get_client_cert/') {
          assert.equal(headers.has('cookie'), false);
          return Response.json({ message: 'success', data: serverCert ? { server_cert: serverCert, server_sn: 'offline-sn' } : {} });
        }
        if (url.pathname === '/ttwid/check/') return Response.json({ status_code: 0 });
        if (url.pathname === followPath) {
          followCalls++;
          assert.equal(bound, true, 'unbound credentials must never dispatch follow');
          assert.equal(init.method, 'POST'); assert.equal(init.body, ''); assert.equal(init.redirect, 'manual');
          assert.equal(url.searchParams.get('user_id'), '10004');
          assert.equal(url.searchParams.get('secUid'), 'offline-peer');
          assert.equal(url.searchParams.has('a_bogus'), false);
          assert.ok(headers.get('cookie').includes(`sessionid=${session}`));
          assert.equal(headers.get('bd-ticket-guard-ree-public-key'), publicPoint);
          const point = Buffer.from(publicPoint, 'base64');
          const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
            x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
          const data = JSON.parse(Buffer.from(headers.get('bd-ticket-guard-client-data'), 'base64').toString());
          assert.equal(data.ts_sign_ree, binding); assert.equal(data.req_content, 'ticket,path,timestamp');
          assert.equal(Number.isSafeInteger(data.timestamp), true);
          const content = Buffer.from(`ticket=${session}&path=${followPath}&timestamp=${data.timestamp}`);
          const signature = Buffer.from(data.req_sign_ree, 'base64');
          if (serverKey) {
            const shared = diffieHellman({ privateKey: serverKey, publicKey });
            const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
            assert.deepEqual(signature, createHmac('sha256', key).update(content).digest());
            assert.equal(headers.get('bd-ticket-guard-iteration-version'), '3');
          } else {
            assert.equal(verify('sha256', content, publicKey, signature), true);
            assert.equal(headers.get('bd-ticket-guard-iteration-version'), '2');
          }
          return Response.json({ status_code: 0, follow_status: 1 });
        }
        const passwordFallback = flow === 'password-to-sms' && url.pathname === '/passport/web/user/login/';
        assert.ok(passwordFallback || url.pathname === loginPath || finalMethod === 'sms' && (
          url.pathname === '/passport/web/send_code/' || flow === 'sms-to-voice' && url.pathname === challengePath
        ));
        assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
        assert.equal(client.hasBoundTicket(), false);
        assert.ok(url.searchParams.get('sign')); assert.ok(url.searchParams.get('a_bogus'));
        assert.ok(headers.get('x-tt-passport-aid-sign'));
        const key = headers.get('bd-ticket-guard-ree-public-key'); assert.ok(key);
        if (!publicPoint) publicPoint = key;
        assert.equal(key, publicPoint);
        const sent = requests.get(url.pathname) || [];
        sent.push({ query: url.searchParams, body: init.body }); requests.set(url.pathname, sent);
        const body = new URLSearchParams(init.body);
        if (passwordFallback || finalMethod === 'password') assert.equal(body.get('password'), '6467');
        else {
          assert.equal(body.get('mobile'), '2e3d332534363d3535353535353535');
          assert.equal(body.get(url.pathname === loginPath ? 'code' : 'type'), url.pathname === loginPath ? '343736313033' : '3731');
        }
        if (passwordFallback) {
          assert.equal(sent.length, 1, 'switching to SMS must not retry the protected password');
          return Response.json({ message: 'error', data: { error_code: 1039 } });
        }
        if (switched) {
          assert.equal(body.has('password'), false);
          assert.equal(body.has('account'), false);
          assert.equal(body.has('sec_user_id'), false, 'phone voice flow is not trusted-device one-click login');
        }
        const challengeHere = challenged && (url.pathname === loginPath || url.pathname === challengePath);
        if (challengeHere && sent.length === 1) {
          assert.equal(body.has('sms_code_key'), false, 'prior send-code patch must not leak into SMS login');
          return Response.json({ message: 'error', data: scenario === 'secondary' ? {
            error_code: 2046, sms_code_key: 'offline-server-key+/=',
            verify_center_secondary_decision_conf: '{"verify_from":"verify_center"}',
          } : { error_code: 1105, verify_center_decision_conf: '{"verify_from":"captcha"}' } }, {
            headers: { 'set-cookie': 'passport_csrf_token=offline-csrf; Path=/', 'x-ms-token': 'offline-ms' },
          });
        }
        if (challengeHere) {
          assert.notEqual(scenario, 'cancel'); assert.equal(sent.length, 2);
          assert.equal(headers.get('x-tt-passport-csrf-token'), 'offline-csrf');
          assert.equal(url.searchParams.get('msToken'), sent[0].query.get('msToken'), 'business headers are not BDMS report responses');
          for (const name of ['sign', 'qs', 'ts', 'biz_trace_id']) assert.equal(url.searchParams.get(name), sent[0].query.get(name));
          if (scenario === 'secondary') {
            const original = Object.fromEntries(sent[0].body.split('&').map(pair => pair.split('=')));
            original.sms_code_key = 'offline-server-key+/=';
            assert.equal(init.body, Object.entries(original).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&'));
          } else {
            assert.equal(init.body, sent[0].body);
            assert.equal(url.searchParams.get('fp'), `offline-fp-${challenges.length}`);
          }
        } else assert.equal(sent.length, subaccount && url.pathname === loginPath ? selections.length + 1 : 1);
        if (url.pathname !== loginPath) return Response.json({ message: 'success', data: {} });
        if (finalMethod === 'sms') assert.equal(smsSent, 1);
        if (flow === 'sms-to-voice') assert.equal(voiceSent, 1);
        if (subaccount) {
          if (sent.length === 1) return Response.json({ message: 'error', data: {
            error_code: 1454, sms_code_key: 'offline-selection-key+/=',
            sub_account: [{ sec_uid: 'offline-selected', user_id: uid, is_bind_login_mobile: true }],
          } });
          assert.equal(sent.length, 2);
          assert.equal(body.get('safe_mobile_register_to_login'), 'true');
          assert.equal(body.get('ignore_reused_mobile'), '1');
          assert.equal(body.get('sms_code_key_not_mix'), '1');
          assert.equal(body.get('sms_code_key'), 'offline-selection-key+/=');
          assert.equal(body.get('sec_uid'), 'offline-selected');
          assert.equal(body.has('register_new_user'), false);
          // A selected-account submit is a new login request, unlike a captcha replay.
          assert.notEqual(url.searchParams.get('sign'), sent[0].query.get('sign'));
          // qs describes the first ten sorted query KEY NAMES, not body values.
          // The key set stays the same while sign must cover the new selection body.
          assert.equal(url.searchParams.get('qs'), sent[0].query.get('qs'));
        }
        const responseHeaders = new Headers({ 'set-cookie': `sessionid=${session}; Path=/; Secure` });
        if (scenario !== 'unbound') responseHeaders.set('bd-ticket-guard-server-data', Buffer.from(JSON.stringify({
          ticket: scenario === 'wrong-binding' ? 'other-offline-session' : session, ts_sign_ree: binding,
        })).toString('base64'));
        if (scenario === 'incomplete-body') return new Response(new ReadableStream({
          start(controller) { controller.error(new Error('offline body interrupted')); },
        }), { headers: responseHeaders });
        return Response.json({ message: 'success', data: { user_id_str: uid } }, { headers: responseHeaders });
      };
      const login = async () => {
        await auth.beginLogin();
        if (switched) {
          assert.deepEqual(store.listUids(), []);
          assert.equal(client.hasBoundTicket(), false);
          if (flow === 'password-to-sms') {
            assert.equal(smsRequired, 1);
            await auth.requestSmsCode();
          } else await auth.requestVoiceCode();
        }
        if (finalMethod === 'sms') await auth.continueSmsLogin('123456');
        if (subaccount) {
          assert.equal(selections.length, 1);
          assert.deepEqual(store.listUids(), []);
          assert.equal(client.hasBoundTicket(), false);
          await auth.continueWithSubAccount({ secUid: selections[0].accounts[0].secUid });
        }
      };
      if (['incomplete-body', 'cancel'].includes(scenario)) {
        await assert.rejects(login(), new RegExp(scenario === 'cancel' ? 'offline cancellation' : 'offline body interrupted'));
        assert.deepEqual(store.listUids(), []);
        assert.equal(client.hasBoundTicket(), false);
        assert.equal(followCalls, 0);
        return;
      }
      await login(); await Promise.all(completions);
      assert.deepEqual(store.listUids(), [uid]);
      assert.equal(client.hasBoundTicket(), bound);
      assert.equal(challenges.length, challenged ? finalMethod === 'sms' ? 2 : 1 : 0);
      if (switched) {
        assert.equal(smsRequired, flow === 'password-to-sms' ? 1 : 0);
        assert.equal(voiceSent, flow === 'sms-to-voice' ? 1 : 0);
        if (challenged) assert.deepEqual(challenges, [
          flow === 'sms-to-voice' ? 'send-voice-sms' : 'send-sms', 'sms-login',
        ]);
      }
      const currentState = client.getTicketGuardState(), currentCookies = client.getCookies();
      auth.cancel(); runtime.suspend();
      const reopened = new AccountStore({ dataDir: storeDirectory });
      const restored = new ApiConnection(reopened.toClientConfig(reopened.load(uid)));
      assert.deepEqual(restored.getTicketGuardState(), currentState);
      assert.equal(restored.getCookies(), currentCookies);
      assert.equal(restored.hasBoundTicket(), bound);
      const beforeFollow = dispatchCount;
      const action = new ImFriendApi(restored).setFollowed({ uid: '10004', secUid: 'offline-peer', followed: true });
      if (bound) assert.equal((await action).followStatus, 1);
      else {
        await assert.rejects(action);
        assert.equal(dispatchCount, beforeFollow, 'unbound preflight must also avoid certificate requests');
      }
      assert.equal(followCalls, bound ? 1 : 0);
    } finally {
      auth?.cancel(); runtime?.suspend();
      globalThis.fetch = savedFetch;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
