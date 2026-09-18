// First-party native policy differential. No network adapter or existing account state.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/bdticket-settings-oracle.cjs /path/to/bdticket.node');
if (process.argv[3] !== '--worker') {
  const directory = mkdtempSync(join(tmpdir(), 'bdticket-settings-offline-'));
  try {
    execFileSync(process.execPath, [__filename, resolve(process.argv[2]), '--worker', directory], { stdio: 'inherit', timeout: 15_000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
} else {
  const addon = require(resolve(process.argv[2]));
  addon.registerEventEmitter((event, ...args) => {
    if (event === 'pc_request_cert') args[1]({ message: 'success', data: {} }, '', { httpStatusCode: 0, message: '' });
  });
  assert.equal(addon.startBDTicket(process.argv[4]), true);
  const host = 'imdesktop.douyin.com';
  const loginPath = '/passport/web/check_qrconnect/';
  const followPath = '/aweme/v1/web/commit/follow/user/';
  const ticket = 'synthetic-session';
  function inspect(path, target = host) {
    const result = addon.handleRequest(target, path, {}, ticket, ticket);
    return {
      publicKey: !!result.headers['bd-ticket-guard-ree-public-key'],
      signed: !!result.headers['bd-ticket-guard-client-data'],
      serial: result.headers['bd-ticket-guard-server-cert-sn'],
    };
  }
  function expectPolicy(label, settings, expectedLogin, expectedFollow) {
    addon.refreshSettings(settings);
    const login = inspect(loginPath); const follow = inspect(followPath);
    assert.deepEqual(login, expectedLogin, `${label}: get ticket`);
    assert.deepEqual(follow, expectedFollow, `${label}: use ticket`);
    console.log('PASS', label);
  }
  setTimeout(() => {
    const getOnly = { publicKey: true, signed: false, serial: undefined };
    const getSymmetric = { publicKey: true, signed: false, serial: '0' };
    const noHeaders = { publicKey: false, signed: false, serial: undefined };
    const signed = { publicKey: true, signed: true, serial: undefined };
    expectPolicy('cold empty settings', {}, getOnly, noHeaders);
    const login = addon.handleRequest(host, loginPath, {}, '', '');
    addon.handleResponse(host, loginPath, { 'bd-ticket-guard-server-data': [Buffer.from(JSON.stringify({ ticket, ts_sign_ree: 'synthetic-sign' })).toString('base64')] },
      ticket, login.headers, '', '', login.associated);
    const full = { session_guard_config: { enable: true, ree_enable_symmetric: true, ree_path: [followPath] } };
    expectPolicy('full configuration', full, getSymmetric, signed);
    expectPolicy('empty session object preserves prior configuration', { session_guard_config: {} }, getSymmetric, signed);
    expectPolicy('wrong scalar field types are ignored', { session_guard_config: { enable: 'false', ree_path: 'bad', ree_enable_symmetric: 0 } }, getSymmetric, signed);
    expectPolicy('enable false replaces the session configuration', { session_guard_config: { enable: false } }, getOnly, noHeaders);
    expectPolicy('enable true without paths is not merged with old paths', { session_guard_config: { enable: true } }, getOnly, noHeaders);
    expectPolicy('explicit false symmetric keeps get-ticket but omits serial', { session_guard_config: { enable: true, ree_enable_symmetric: false, ree_path: [false, followPath, 42] } }, getOnly, signed);
    expectPolicy('exact exclusion takes priority over an allowed prefix', { session_guard_config: {
      enable: true, ree_path_prefix: ['/aweme/'], ree_exclude_path: [followPath],
    } }, getOnly, noHeaders);
    expectPolicy('prefix exclusion takes priority over an allowed exact path', { session_guard_config: {
      enable: true, ree_path: [followPath], ree_exclude_path_prefix: ['/aweme/'],
    } }, getOnly, noHeaders);
    expectPolicy('empty prefix is ignored', { session_guard_config: { enable: true, ree_path_prefix: [''] } }, getOnly, noHeaders);
    expectPolicy('config version alone replaces all functional fields', { session_guard_config: { config_version: 'v2' } }, getOnly, noHeaders);
    addon.refreshSettings(full);
    for (const candidate of [host, 'www.douyin.com', 'sso.douyin.com', 'example.com', `${host}:443`]) {
      // Pure local handleRequest; no HTTP request is made to any of these hosts.
      console.log('host classification', candidate, JSON.stringify({ login: inspect(loginPath, candidate), follow: inspect(followPath, candidate) }));
    }
    for (const path of [followPath.slice(0, -1), `${followPath}extra`, `/prefix${followPath}`, '/passport', '/passport/', '/prefix/passport/web/login/']) {
      console.log('path classification', path, JSON.stringify(inspect(path)));
    }
    process.exit(0);
  }, 2000);
}
