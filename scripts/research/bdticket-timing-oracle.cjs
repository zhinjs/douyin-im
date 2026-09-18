// Offline native differential: no HTTP adapter, only fresh state and synthetic tickets.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createHmac, createHash, verify } = require('node:crypto');

if (!process.argv[2]) throw new Error('Usage: node scripts/research/bdticket-timing-oracle.cjs /path/to/bdticket.node');
assert.equal(createHash('sha256').update(readFileSync(resolve(process.argv[2]))).digest('hex'),
  'd0827881d497e808c2568f00154efb58674095f98d547dc26a1156622907eed2', 'Use the pinned Desktop native build');
if (!['--worker', '--restore'].includes(process.argv[3])) {
  const directory = mkdtempSync(join(tmpdir(), 'bdticket-timing-offline-'));
  try {
    // An outer deadline also terminates a synchronous native wait, if one exists.
    execFileSync(process.execPath, [__filename, resolve(process.argv[2]), '--worker', directory], {
      stdio: 'inherit', timeout: 15_000,
    });
    execFileSync(process.execPath, [__filename, resolve(process.argv[2]), '--restore', directory], {
      stdio: 'inherit', timeout: 15_000,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
} else {
  const directory = process.argv[4];
  if (process.argv[3] === '--worker') for (const name of ['', '-rotated']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', join(directory, `key${name}.pem`), '-out', join(directory, `cert${name}.pem`),
      '-subj', '/CN=offline-fixture', '-days', '1'], { stdio: 'ignore' });
  }
  const pem = readFileSync(join(directory, 'cert.pem'), 'utf8');
  const serverKey = createPrivateKey(readFileSync(join(directory, 'key.pem')));
  const rotatedPem = readFileSync(join(directory, 'cert-rotated.pem'), 'utf8');
  const rotatedServerKey = createPrivateKey(readFileSync(join(directory, 'key-rotated.pem')));
  const addon = require(resolve(process.argv[2]));
  const host = 'imdesktop.douyin.com';
  const login = '/passport/web/check_qrconnect/';
  const follow = '/aweme/v1/web/commit/follow/user/';
  const session = 'synthetic-offline-session';
  let certificateRequests = 0;
  const prepare = () => addon.handleRequest(host, follow, {}, session, session);
  const data = request => JSON.parse(Buffer.from(request.headers['bd-ticket-guard-client-data'], 'base64'));
  const peer = request => {
    const point = Buffer.from(request.headers['bd-ticket-guard-ree-public-key'], 'base64');
    return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  };
  const content = value => `ticket=${session}&path=${follow}&timestamp=${value.timestamp}`;
  const expectedHmac = (request, privateKey) => {
    const shared = diffieHellman({ privateKey, publicKey: peer(request) });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
    return createHmac('sha256', key).update(content(data(request))).digest('base64');
  };

  if (process.argv[3] === '--restore') {
    addon.registerEventEmitter(event => { if (event === 'pc_request_cert') throw new Error('Complete fixture cert cache should not reload'); });
    addon.refreshSettings({ session_guard_config: { enable: true, ree_enable_symmetric: true, ree_path: [follow] }, enable_full_path_track: false });
    assert.equal(addon.startBDTicket(directory), true);
    setTimeout(() => {
      const restored = prepare();
      assert.equal(restored.headers['bd-ticket-guard-iteration-version'], '3');
      assert.equal(data(restored).req_sign_ree, expectedHmac(restored, rotatedServerKey));
      assert.notEqual(data(restored).req_sign_ree, expectedHmac(restored, serverKey));
      assert.equal(data(restored).ts_sign_ree, 'synthetic-ticket-sign');
      console.log('PASS: fresh native process derives HMAC from the persisted rotated server certificate');
      process.exit(0);
    }, 2000);
    return;
  }

  addon.registerEventEmitter((event, ...args) => {
    if (event !== 'pc_request_cert') return;
    certificateRequests++;
    // Deliberately retain the certificate callback. handleRequest must return without it.
    // Allow native startup/key loading to finish, but never deliver a certificate yet.
    setTimeout(() => {
      const initialLogin = addon.handleRequest(host, login, {}, '', '');
      assert.ok(initialLogin.headers['bd-ticket-guard-ree-public-key']);
      assert.equal(initialLogin.headers['bd-ticket-guard-server-cert-sn'], '0');
      const binding = Buffer.from(JSON.stringify({ ticket: session, ts_sign_ree: 'synthetic-ticket-sign' })).toString('base64');
      addon.handleResponse(host, login, { 'bd-ticket-guard-server-data': [binding] }, session,
        initialLogin.headers, '', '', initialLogin.associated);
      const before = prepare();
      const signed = data(before);
      assert.equal(before.headers['bd-ticket-guard-iteration-version'], '2');
      assert.equal(signed.ts_sign_ree, 'synthetic-ticket-sign');
      assert.equal(verify('sha256', Buffer.from(content(signed)), peer(before), Buffer.from(signed.req_sign_ree, 'base64')), true);
      console.log('PASS: login and bound ECDSA signature return before certificate callback');
      args[1]({ message: 'success', data: { cert: pem, server_cert: Buffer.from(pem).toString('base64'), server_sn: 'synthetic-sn' } },
        '', { httpStatusCode: 0, message: '' });
      const deadline = Date.now() + 3000;
      const check = () => {
        const after = prepare();
        if (after.headers['bd-ticket-guard-iteration-version'] !== '3') {
          assert.ok(Date.now() < deadline, 'native did not switch to HMAC after certificate callback');
          setTimeout(check, 20);
          return;
        }
        const value = data(after);
        const shared = diffieHellman({ privateKey: serverKey, publicKey: peer(after) });
        const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
        assert.equal(value.req_sign_ree, createHmac('sha256', key).update(content(value)).digest('base64'));
        assert.equal(value.ts_sign_ree, 'synthetic-ticket-sign');
        assert.equal(after.headers['bd-ticket-guard-ree-public-key'], before.headers['bd-ticket-guard-ree-public-key']);
        assert.equal(addon.handleRequest(host, login, {}, '', '').headers['bd-ticket-guard-server-cert-sn'], 'synthetic-sn');
        assert.equal(certificateRequests, 1);
        console.log('PASS: certificate arrival switches to HMAC with the same key and ticket binding');
        // CertManager stores the new server cert, but preload calls the existing
        // ecdh_key cache. It does not invalidate the already populated vector.
        const request = addon.handleRequest(host, login, {}, session, session);
        addon.handleResponse(host, login, { 'bd-ticket-guard-server-cert': [Buffer.from(rotatedPem).toString('base64')] }, '',
          request.headers, session, session, request.associated);
        const checkCached = () => {
          const current = prepare();
          assert.equal(data(current).req_sign_ree, expectedHmac(current, serverKey));
          assert.notEqual(data(current).req_sign_ree, expectedHmac(current, rotatedServerKey));
          assert.equal(data(current).ts_sign_ree, 'synthetic-ticket-sign');
          assert.equal(current.headers['bd-ticket-guard-ree-public-key'], after.headers['bd-ticket-guard-ree-public-key']);
          assert.equal(addon.handleRequest(host, login, {}, '', '').headers['bd-ticket-guard-server-cert-sn'], 'synthetic-sn');
        };
        checkCached();
        setTimeout(() => {
          checkCached();
          assert.equal(certificateRequests, 1);
          console.log('PASS: rotated certificate leaves the existing process HMAC cache unchanged, including after preload');
          process.exit(0);
        }, 500);
      };
      check();
    }, 2000);
  });
  addon.refreshSettings({ session_guard_config: { enable: true, ree_enable_symmetric: true, ree_path: [follow] }, enable_full_path_track: false });
  assert.equal(addon.startBDTicket(directory), true);
}
