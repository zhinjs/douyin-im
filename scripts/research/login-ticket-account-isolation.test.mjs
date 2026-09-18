// Offline multi-account late certificate acceptance. No real account/network/native module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createHmac, verify } from 'node:crypto';
import { ApiConnection } from '../../lib/desktop/api-connection.js';
import { AccountAuth } from '../../lib/sdk/auth/account-auth.js';
import { AccountRuntime } from '../../lib/base/runtime/account-runtime.js';
import { AccountStore } from '../../lib/store/account-store.js';
import { ImFriendApi } from '../../lib/services/im/friends.js';

for (const mode of ['both-active', 'retire-first', 'replace-first']) {
  test(`late certificate ownership across two complete logins: ${mode}`, { timeout: 20_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-certificate-owners-'));
    const savedFetch = globalThis.fetch;
    const store = new AccountStore({ dataDir: join(directory, 'store') });
    const owners = [];
    let collecting = true;
    try {
      for (const index of [1, 2]) {
        const certFile = join(directory, `cert-${index}.pem`), keyFile = join(directory, `key-${index}.pem`);
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
          '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=offline-owner', '-days', '1'], { stdio: 'ignore' });
        const owner = { uid: `1000${index}`, did: `2100${index}`, session: `offline-owner-session-${index}`,
          binding: `offline-owner-binding-${index}`, serial: `offline-serial-${index}`,
          certificate: readFileSync(certFile, 'utf8'), serverKey: createPrivateKey(readFileSync(keyFile)),
          certificateCalls: 0, followCalls: 0 };
        owner.client = new ApiConnection({ deviceId: owner.did, installId: `3100${index}` });
        owner.client.startDeviceLifecycle = async () => ({ deviceId: owner.did, installId: `3100${index}` });
        owner.runtime = new AccountRuntime(store, owner.client);
        const unexpected = () => { throw new Error('Unexpected synthetic login branch'); };
        owner.auth = new AccountAuth({ client: owner.client, store, loginMethod: 'password',
          mobile: '13800000000', password: 'offline-password' }, {
          onQrcode: unexpected, onQrStatus: unexpected, onSms: unexpected, onVoice: unexpected,
          onAccountSelection: unexpected, onSmsRequired: unexpected, onVerification: unexpected,
          onLoggedIn: account => {
            assert.equal(account.platformUid, owner.uid);
            owner.runtime.bindPromoted(owner.client, account);
          },
        });
        owners.push(owner);
      }
      globalThis.fetch = async (target, init) => {
        const url = new URL(target), headers = new Headers(init.headers);
        assert.equal(url.origin, 'https://imdesktop.douyin.com');
        if (url.pathname === '/ttwid/check/') return Response.json({ status_code: 0 });
        const owner = owners.find(item => item.did === url.searchParams.get('device_id'));
        assert.ok(owner, 'every request must retain its device owner');
        if (url.pathname === '/passport/ticket_guard/get_client_cert/') {
          assert.equal(headers.has('cookie'), false);
          assert.equal(headers.has('bd-ticket-guard-ree-public-key'), false);
          assert.equal(init.body, 'server_data=1');
          owner.certificateCalls++;
          if (!collecting) return Response.json({ message: 'success', data: {} });
          assert.equal(owner.certificateCalls, 1);
          return new Promise(resolve => { owner.releaseCertificate = resolve; });
        }
        if (url.pathname === '/passport/web/user/login/') {
          owner.publicPoint = headers.get('bd-ticket-guard-ree-public-key');
          assert.ok(owner.publicPoint);
          assert.equal(headers.get('bd-ticket-guard-server-cert-sn'), '0');
          return Response.json({ message: 'success', data: { user_id_str: owner.uid } }, {
            headers: { 'set-cookie': `sessionid=${owner.session}; Path=/; Secure`,
              'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({
                ticket: owner.session, ts_sign_ree: owner.binding,
              })).toString('base64') },
          });
        }
        assert.equal(url.pathname, '/aweme/v1/web/commit/follow/user/');
        owner.followCalls++;
        assert.equal(init.method, 'POST'); assert.equal(init.body, '');
        assert.equal(headers.get('cookie').includes(`sessionid=${owner.session}`), true);
        assert.equal(headers.get('bd-ticket-guard-ree-public-key'), owner.publicPoint);
        const point = Buffer.from(owner.publicPoint, 'base64');
        const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
          x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
        const data = JSON.parse(Buffer.from(headers.get('bd-ticket-guard-client-data'), 'base64').toString());
        assert.equal(data.ts_sign_ree, owner.binding);
        const content = Buffer.from(`ticket=${owner.session}&path=${url.pathname}&timestamp=${data.timestamp}`);
        const signature = Buffer.from(data.req_sign_ree, 'base64');
        if (owner.persistedCertificate) {
          const shared = diffieHellman({ privateKey: owner.serverKey, publicKey: key });
          const hmac = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
          assert.deepEqual(signature, createHmac('sha256', hmac).update(content).digest());
          assert.equal(headers.get('bd-ticket-guard-iteration-version'), '3');
        } else {
          assert.equal(verify('sha256', content, key, signature), true);
          assert.equal(headers.get('bd-ticket-guard-iteration-version'), '2');
        }
        return Response.json({ status_code: 0, follow_status: 1 });
      };
      await Promise.all(owners.map(owner => owner.auth.beginLogin()));
      assert.deepEqual(store.listUids().sort(), owners.map(owner => owner.uid));
      assert.notEqual(owners[0].publicPoint, owners[1].publicPoint);
      for (const owner of owners) {
        owner.before = store.load(owner.uid);
        assert.equal(owner.before.session.desktopTicketGuard.serverCert, undefined);
        assert.equal(owner.client.hasBoundTicket(), true);
      }
      if (mode === 'retire-first') owners[0].runtime.suspend();
      if (mode === 'replace-first') {
        const record = store.load(owners[0].uid);
        const replacement = new ApiConnection(store.toClientConfig(record));
        owners[0].runtime.bindRestored(replacement, record);
      }
      collecting = false;
      // Deterministically reverse delivery; setImmediate drains the detached
      // fetch/json/persistence microtasks without a time-based polling loop.
      for (const owner of [...owners].reverse()) {
        owner.releaseCertificate(Response.json({ message: 'success', data: {
          server_cert: owner.certificate, server_sn: owner.serial,
        } }));
        await new Promise(resolve => setImmediate(resolve));
      }
      for (const [index, owner] of owners.entries()) {
        owner.persistedCertificate = index === 1 || mode === 'both-active';
        assert.equal(owner.certificateCalls, 1, 'late completion does not trigger another certificate load');
        assert.equal(owner.client.getTicketGuardState().serverSn, owner.serial, 'callback actually completed');
        const saved = store.load(owner.uid);
        assert.equal(saved.session.desktopTicketGuard.privateKey, owner.before.session.desktopTicketGuard.privateKey);
        assert.deepEqual(saved.session.desktopTicketGuard.binding, owner.before.session.desktopTicketGuard.binding);
        assert.equal(saved.session.cookies, owner.before.session.cookies);
        if (owner.persistedCertificate) {
          assert.equal(saved.session.desktopTicketGuard.serverSn, owner.serial);
          assert.equal(saved.session.desktopTicketGuard.serverCert, owner.certificate);
        } else assert.deepEqual(saved, owner.before, 'retired certificate must not overwrite the saved account');
        owner.auth.cancel(); owner.runtime.suspend();
        const reopened = new AccountStore({ dataDir: join(directory, 'store') });
        const restored = new ApiConnection(reopened.toClientConfig(reopened.load(owner.uid)));
        assert.equal(restored.hasBoundTicket(), true);
        const result = await new ImFriendApi(restored).setFollowed({ uid: '10009', secUid: 'offline-peer', followed: true });
        assert.equal(result.followStatus, 1);
        assert.equal(owner.followCalls, 1);
        assert.equal(owner.certificateCalls, owner.persistedCertificate ? 1 : 2);
      }
    } finally {
      for (const owner of owners) {
        owner.auth.cancel(); owner.runtime.suspend();
        owner.releaseCertificate?.(Response.json({ message: 'success', data: {} }));
      }
      await new Promise(resolve => setImmediate(resolve));
      globalThis.fetch = savedFetch;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
