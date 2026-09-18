// Offline response-state oracle: a fresh native database and synthetic Sessions only.
// The native certificate callback is answered locally; no account or network access.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPublicKey, verify } = require('node:crypto');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/bdticket-response-oracle.cjs /path/to/bdticket.node');
if (process.argv[3] !== '--worker') {
  const directory = mkdtempSync(join(tmpdir(), 'bdticket-response-offline-'));
  try {
    execFileSync(process.execPath, [__filename, resolve(process.argv[2]), '--worker', directory], { stdio: 'inherit', timeout: 15_000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
} else {
  const addon = require(resolve(process.argv[2]));
  const host = 'imdesktop.douyin.com';
  const login = '/passport/web/check_qrconnect/';
  const follow = '/aweme/v1/web/commit/follow/user/';
  const session = 'synthetic-session';
  addon.registerEventEmitter((event, ...args) => {
    if (event === 'pc_request_cert') args[1]({ message: 'success', data: {} }, '', { httpStatusCode: 0, message: '' });
  });
  addon.refreshSettings({ session_guard_config: { enable: true, ree_enable_symmetric: false, ree_path: [follow] } });
  assert.equal(addon.startBDTicket(process.argv[4]), true);
  function accept(body) {
    const request = addon.handleRequest(host, login, {}, session, 'synthetic-secondary');
    addon.handleResponse(host, login, {
      'bd-ticket-guard-server-data': [Buffer.from(JSON.stringify(body)).toString('base64')],
    }, session, request.headers, session, 'synthetic-secondary', request.associated);
  }
  function inspectRequest(request, error) {
    const data = JSON.parse(Buffer.from(request.headers['bd-ticket-guard-client-data'], 'base64'));
    const point = Buffer.from(request.headers['bd-ticket-guard-ree-public-key'], 'base64');
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
    assert.equal(verify('sha256', Buffer.from(`ticket=${session}&path=${follow}&timestamp=${data.timestamp}`),
      key, Buffer.from(data.req_sign_ree, 'base64')), true, 'cached Session selection');
    return { signature: data.ts_sign_ree, error: error ?? null };
  }
  function inspect() {
    const request = addon.handleRequest(host, follow, {}, session, 'synthetic-secondary');
    return inspectRequest(request, request.associated.kTicketGuardUseTicketErrorCodeKey);
  }
  setTimeout(async () => {
    const { DesktopTicketGuard } = await import(pathToFileURL(resolve(__dirname, '../../lib/desktop/ticket-guard.js')).href);
    for (const [label, body, expectedSignature] of [
      ['flat-empty', { ticket: session, ts_sign_ree: '' }, ''],
      ['flat-missing', { ticket: session }, ''],
      ['flat-number', { ticket: session, ts_sign_ree: 123 }, ''],
      ['flat-null', { ticket: session, ts_sign_ree: null }, ''],
      ['flat-boolean', { ticket: session, ts_sign_ree: true }, ''],
      ['array-empty-last', { tickets: [{ ticket: session, ts_sign_ree: 'replacement' }, { ticket: session, ts_sign_ree: '' }] }, ''],
      ['array-valid-last', { tickets: [{ ticket: session, ts_sign_ree: '' }, { ticket: session, ts_sign_ree: 'replacement' }] }, 'replacement'],
    ]) {
      accept({ ticket: session, ts_sign_ree: 'initial-signature' });
      assert.equal(inspect().signature, 'initial-signature');
      accept(body);
      const native = inspect();
      assert.deepEqual(native, { signature: expectedSignature, error: expectedSignature ? null : 4 }, label);
      const sdk = new DesktopTicketGuard();
      for (const item of [{ ticket: session, ts_sign_ree: 'initial-signature' }, body]) {
        sdk.acceptResponse(sdk.prepare(new URL(`https://${host}${login}`), session), new Headers({
          'bd-ticket-guard-server-data': Buffer.from(JSON.stringify(item)).toString('base64'),
        }), session);
      }
      for (const current of [sdk, new DesktopTicketGuard(sdk.exportState())]) {
        const request = current.prepare(new URL(`https://${host}${follow}`), session, 'synthetic-secondary', 123456, false);
        assert.deepEqual(inspectRequest(request, request.useTicketErrorCode), native, label);
        assert.equal(current.hasBinding(session), !!expectedSignature, label);
      }
      console.log('PASS native / SDK / restored SDK', label);
    }
    process.exit(0);
  }, 2000);
}
