// Source-version-pinned, offline native differential; synthetic Sessions and fresh temp stores only.
// The only native network adapter callback is answered locally with an empty successful fixture.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

if (!process.argv[2]) throw new Error('Usage: node scripts/research/bdticket-binding-policy-oracle.cjs /path/to/bdticket.node');
const binary = resolve(process.argv[2]);
assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'),
  'd0827881d497e808c2568f00154efb58674095f98d547dc26a1156622907eed2', 'audited native build');

if (process.argv[3] !== '--worker') {
  for (const scenario of ['missing', 'disabled', 'enabled']) {
    const directory = mkdtempSync(join(tmpdir(), 'bdticket-binding-policy-offline-'));
    try {
      execFileSync(process.execPath, [__filename, binary, '--worker', directory, scenario],
        { stdio: 'inherit', timeout: 15_000 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
} else {
  const scenario = process.argv[5];
  const addon = require(binary);
  const host = 'imdesktop.douyin.com';
  const loginPath = '/passport/web/check_qrconnect/';
  const followPath = '/aweme/v1/web/commit/follow/user/';
  const session = 'synthetic-policy-session';
  const signature = 'synthetic-policy-signature';
  const settings = scenario === 'missing' ? {} : { session_guard_config: { enable: scenario === 'enabled' } };
  addon.registerEventEmitter((event, ...args) => {
    if (event === 'pc_request_cert') args[1]({ message: 'success', data: {} }, '', { httpStatusCode: 0, message: '' });
  });
  addon.refreshSettings(settings);
  assert.equal(addon.startBDTicket(process.argv[4]), true);
  setTimeout(async () => {
    try {
      addon.refreshSettings(settings);
      const request = addon.handleRequest(host, loginPath, {}, session, session);
      console.log(`OBSERVE ${scenario}: header names=${Object.keys(request.headers).join(',')}; associated names=${Object.keys(request.associated).join(',')}`);
      assert.ok(request.headers['bd-ticket-guard-ree-public-key'], `${scenario}: get-ticket public key stays present`);
      assert.equal(!!request.associated.kTicketGuardEnableSessionGetTicketKey, scenario === 'enabled',
        `${scenario}: native request Session-binding policy`);
      const encoded = Buffer.from(JSON.stringify({ ticket: session, ts_sign_ree: signature })).toString('base64');
      addon.handleResponse(host, loginPath, { 'bd-ticket-guard-server-data': [encoded] },
        session, request.headers, session, session, request.associated);
      // Enable use-ticket only after response handling to observe the stored signature independently.
      addon.refreshSettings({ session_guard_config: { enable: true, ree_path: [followPath] } });
      const follow = addon.handleRequest(host, followPath, {}, session, session);
      const data = JSON.parse(Buffer.from(follow.headers['bd-ticket-guard-client-data'], 'base64').toString('utf8'));
      const nativeBound = data.ts_sign_ree === signature;
      assert.equal(nativeBound, scenario === 'enabled', `${scenario}: native binding result`);
      const { DesktopTicketGuard } = await import(pathToFileURL(resolve(__dirname, '../../lib/desktop/ticket-guard.js')).href);
      // A truthy empty bdticket_config mirrors native cold empty settings, not Main's fallback defaults.
      const guard = new DesktopTicketGuard(undefined, { bdticket_config: settings });
      const local = guard.prepare(new URL(`https://${host}${loginPath}`), session, session);
      assert.ok(local.headers['bd-ticket-guard-ree-public-key'], `${scenario}: SDK get-ticket public key stays present`);
      guard.acceptResponse(local, new Headers({ 'bd-ticket-guard-server-data': encoded }), session);
      assert.equal(guard.hasBinding(session), nativeBound, `${scenario}: SDK/native Session-binding parity`);
      console.log(`PASS ${scenario}: public key present; Session binding ${nativeBound ? 'accepted' : 'ignored'}`);
      process.exit(0);
    } catch (error) { console.error(error); process.exit(1); }
  }, 2000);
}
