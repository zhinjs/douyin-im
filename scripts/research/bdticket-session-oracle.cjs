// Offline native Cookie/ticket selection. Only fresh temporary state and synthetic Sessions.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createPublicKey, verify } = require('node:crypto');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/bdticket-session-oracle.cjs /path/to/bdticket.node');
if (process.argv[3] !== '--worker') {
  const directory = mkdtempSync(join(tmpdir(), 'bdticket-session-offline-'));
  try {
    execFileSync(process.execPath, [__filename, resolve(process.argv[2]), '--worker', directory], { stdio: 'inherit', timeout: 15_000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
} else {
  const addon = require(resolve(process.argv[2]));
  const host = 'imdesktop.douyin.com';
  const login = '/passport/web/check_qrconnect/';
  const follow = '/aweme/v1/web/commit/follow/user/';
  addon.registerEventEmitter((event, ...args) => {
    if (event === 'pc_request_cert') args[1]({ message: 'success', data: {} }, '', { httpStatusCode: 0, message: '' });
  });
  addon.refreshSettings({ session_guard_config: { enable: true, ree_enable_symmetric: false, ree_path: [follow] } });
  assert.equal(addon.startBDTicket(process.argv[4]), true);
  const expectedSelection = {
    'unbound-both': ['sessionid_ss'], 'unbound-sid': ['sessionid_ss', 'empty'],
    'unbound-ss': ['sessionid', 'empty'], 'unbound-empty': [],
    'sid-match': ['sessionid'], 'both-match': ['sessionid', 'sessionid_ss'],
    'ss-match': ['sessionid_ss'], 'ss-only-match': ['sessionid_ss'],
    'neither-match': ['sessionid_ss'], 'sid-only-mismatch': ['sessionid_ss', 'empty'],
    'ss-only-mismatch': ['sessionid_ss'], 'bound-empty': [],
  };
  function inspect(label, sid, ss) {
    const result = addon.handleRequest(host, follow, {}, sid, ss);
    const encoded = result.headers['bd-ticket-guard-client-data'];
    let selected = []; let ticketSignature = 'absent';
    if (encoded) {
      const data = JSON.parse(Buffer.from(encoded, 'base64'));
      const point = Buffer.from(result.headers['bd-ticket-guard-ree-public-key'], 'base64');
      const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
      for (const [name, value] of [['sessionid', sid], ['sessionid_ss', ss], ['empty', '']]) {
        const content = `ticket=${value}&path=${follow}&timestamp=${data.timestamp}`;
        if (verify('sha256', Buffer.from(content), publicKey, Buffer.from(data.req_sign_ree, 'base64'))) selected.push(name);
      }
      assert.ok(selected.length, 'signature must match one synthetic Cookie candidate');
      ticketSignature = data.ts_sign_ree === 'synthetic-binding' ? 'bound' : data.ts_sign_ree === '' ? 'empty' : 'unexpected';
      assert.notEqual(ticketSignature, 'unexpected');
    }
    const row = { label, signed: !!encoded, selected, ticketSignature,
      error: result.associated.kTicketGuardUseTicketErrorCodeKey ?? null };
    assert.deepEqual(selected, expectedSelection[label], label);
    assert.equal(row.signed, !!(sid || ss), label);
    assert.equal(ticketSignature, !row.signed ? 'absent' : label.startsWith('unbound-') ? 'empty' : 'bound', label);
    assert.equal(row.error, row.signed && label.startsWith('unbound-') ? 4 : null, label);
    console.log('PASS', label);
    return row;
  }
  setTimeout(() => {
    for (const [label, sid, ss] of [
      ['unbound-both', 'sid-only', 'ss-only'], ['unbound-sid', 'sid-only', ''],
      ['unbound-ss', '', 'ss-only'], ['unbound-empty', '', ''],
    ]) inspect(label, sid, ss);
    const request = addon.handleRequest(host, login, {}, '', '');
    addon.handleResponse(host, login, { 'bd-ticket-guard-server-data': [Buffer.from(JSON.stringify({
      ticket: 'bound-session', ts_sign_ree: 'synthetic-binding',
    })).toString('base64')] }, 'bound-session', request.headers, '', '', request.associated);
    for (const [label, sid, ss] of [
      ['sid-match', 'bound-session', 'other-ss'], ['both-match', 'bound-session', 'bound-session'],
      ['ss-match', 'other-sid', 'bound-session'], ['ss-only-match', '', 'bound-session'],
      ['neither-match', 'other-sid', 'other-ss'], ['sid-only-mismatch', 'other-sid', ''],
      ['ss-only-mismatch', '', 'other-ss'], ['bound-empty', '', ''],
    ]) inspect(label, sid, ss);
    process.exit(0);
  }, 2000);
}
