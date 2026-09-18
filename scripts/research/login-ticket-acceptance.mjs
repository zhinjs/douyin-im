// Explicit, isolated, login-only acceptance. Build first; importing never starts a login.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID, createECDH, createPrivateKey, createPublicKey, createHash, createHmac,
  diffieHellman, hkdfSync, timingSafeEqual, verify, X509Certificate } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApiConnection } from '../../lib/desktop/api-connection.js';
import { DesktopTicketGuard } from '../../lib/desktop/ticket-guard.js';
import { AccountStore } from '../../lib/store/account-store.js';
import { AccountAuth } from '../../lib/sdk/auth/account-auth.js';
import { AccountRuntime } from '../../lib/base/runtime/account-runtime.js';

const AUTHORIZED_UID = '1150530166719210';
const FOLLOW = new URL('https://imdesktop.douyin.com/aweme/v1/web/commit/follow/user/');

/** Local serialization/signing check only: no HTTP dispatch and no assertion of server acceptance. */
export function verifyRestoredTicketSigning(connection, restored, timestamp = Math.floor(Date.now() / 1000)) {
  const state = connection.getTicketGuardState(), savedState = restored.getTicketGuardState();
  const sessions = client => [client.jar.get('sessionid') ?? '', client.jar.get('sessionid_ss') ?? ''];
  const currentSessions = sessions(connection), savedSessions = sessions(restored);
  const restoredKeyMatches = !!state && !!savedState && state.privateKey === savedState.privateKey;
  const restoredGuardStateMatches = !!state && !!savedState && isDeepStrictEqual(state, savedState);
  const restoredSessionMatches = currentSessions.some(Boolean) && isDeepStrictEqual(currentSessions, savedSessions);
  const current = verifySnapshot(state, currentSessions, connection.requiresTicket(FOLLOW.href), timestamp);
  const saved = verifySnapshot(savedState, savedSessions, restored.requiresTicket(FOLLOW.href), timestamp);
  return {
    signatureCheckScope: 'local-only', restoredKeyMatches, restoredGuardStateMatches, restoredSessionMatches,
    currentSignatureVerified: current.verified, restoredSignatureVerified: saved.verified,
    currentSignatureMode: current.mode, restoredSignatureMode: saved.mode,
    localSigningVerified: restoredKeyMatches && restoredGuardStateMatches && restoredSessionMatches && current.verified && saved.verified,
  };
}

function verifySnapshot(state, [sessionId, sessionSS], required, timestamp) {
  const failed = { verified: false, mode: 'unavailable' };
  if (!required) return { verified: false, mode: 'not-protected' };
  if (!state?.binding?.tsSignRee) return failed;
  try {
    const hash = value => createHash('sha256').update(value).digest('hex');
    const ticket = sessionId && hash(sessionId) === state.binding.sessionHash ? sessionId : sessionSS;
    if (!ticket || hash(ticket) !== state.binding.sessionHash) return failed;
    // Reconstruct from the exported effective Session policy, not an invented default.
    // This does not exercise ApiConnection's final HTTP header merge/transport seam.
    const guard = new DesktopTicketGuard(state, { bdticket_config: { session_guard_config: state.sessionConfig ?? {} } });
    const { headers } = guard.prepare(FOLLOW, sessionId, sessionSS, timestamp);
    const data = JSON.parse(Buffer.from(headers['bd-ticket-guard-client-data'] ?? '', 'base64').toString());
    if (data.req_content !== 'ticket,path,timestamp' || data.timestamp !== timestamp || data.ts_sign_ree !== state.binding.tsSignRee
      || headers['bd-ticket-guard-version'] !== '2' || typeof data.req_sign_ree !== 'string') return failed;
    const ec = createECDH('prime256v1'); ec.setPrivateKey(Buffer.from(state.privateKey, 'base64'));
    const point = ec.getPublicKey(undefined, 'uncompressed');
    if (headers['bd-ticket-guard-ree-public-key'] !== point.toString('base64')) return failed;
    const privateKey = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
      d: Buffer.from(state.privateKey, 'base64').toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
    // Independent content assembly, not the production ticketSignContent helper.
    const content = Buffer.from(`ticket=${ticket}&path=${FOLLOW.pathname}&timestamp=${timestamp}`);
    const actual = Buffer.from(data.req_sign_ree, 'base64');
    if (state.sessionConfig?.ree_enable_symmetric === true && state.serverCert) {
      if (headers['bd-ticket-guard-iteration-version'] !== '3') return failed;
      const shared = diffieHellman({ privateKey, publicKey: new X509Certificate(state.serverCert).publicKey });
      const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
      const expected = createHmac('sha256', key).update(content).digest();
      return { verified: actual.length === expected.length && timingSafeEqual(actual, expected), mode: 'hmac' };
    }
    if (headers['bd-ticket-guard-iteration-version'] !== '2') return failed;
    return { verified: verify('sha256', content, { key: createPublicKey(privateKey), dsaEncoding: 'der' }, actual), mode: 'ree' };
  } catch { return failed; } // Do not expose credentials through crypto/parser error stacks.
}

/** Uses the real login/promote/persistence code, without constructing IM or message handlers. */
export async function runLoginTicketAcceptance({ directory, connection, signal, showQr,
  openVerification = verification => verification.open(), report = () => undefined }) {
  signal.throwIfAborted();
  if (readdirSync(directory).length) throw new Error('Acceptance directory must be empty');
  const store = new AccountStore({ dataDir: directory });
  const runtime = new AccountRuntime(store, connection);
  let completed;
  let failure;
  let qrTask = Promise.resolve();
  const fail = error => { failure ??= error; auth.cancel(); };
  const unexpected = () => { throw new Error('Unexpected non-QR login action'); };
  const auth = new AccountAuth({ client: connection, store, loginMethod: 'qr' }, {
    onQrcode: info => {
      report({ phase: 'device-ready' });
      qrTask = qrTask.then(() => { signal.throwIfAborted(); return showQr(info); }).catch(fail);
    },
    onQrStatus: status => report({ phase: 'qr-status', status: status.status }),
    onSms: unexpected, onVoice: unexpected, onAccountSelection: unexpected, onSmsRequired: unexpected,
    onVerification: ({ verification }) => {
      report({ phase: 'verification', operation: verification.operation, methods: verification.methods });
      Promise.resolve().then(() => { signal.throwIfAborted(); return openVerification(verification); }).catch(fail);
    },
    onLoggedIn: account => {
      if (account.platformUid !== AUTHORIZED_UID) throw new Error('Scanned account does not match authorized account');
      completed = account;
      runtime.bindPromoted(connection, account);
    },
  });
  const cancel = () => auth.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // AccountAuth owns key persistence -> certificate startup -> device -> login.
    signal.throwIfAborted();
    await auth.beginLogin();
    await qrTask;
    if (failure) throw failure;
    signal.throwIfAborted();
    await auth.continueQrLogin();
    if (failure) throw failure;
    signal.throwIfAborted();
    if (!completed) throw new Error('QR flow ended without promoting an account');
    const saved = store.load(AUTHORIZED_UID);
    if (!saved) throw new Error('Promoted account was not persisted');
    const restored = new ApiConnection(store.toClientConfig(saved));
    const state = connection.getTicketGuardState();
    const result = { phase: 'result', uidMatches: true, sessionPresent: !!connection.jar.get('sessionid'),
      serverCertificate: !!state?.serverCert, clientCertificate: !!state?.clientCert,
      boundTicket: connection.hasBoundTicket(), restoredBoundTicket: restored.hasBoundTicket(),
      ...verifyRestoredTicketSigning(connection, restored),
      followAttempted: false, imStarted: false };
    report(result);
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
    auth.cancel();
    runtime.suspend();
    await qrTask;
  }
}

async function createQrPage(signal) {
  let png = '';
  const token = randomUUID();
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (signal.aborted || url.pathname !== `/${token}` || request.method !== 'GET') {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'" });
    response.end(`<!doctype html><meta charset="utf-8"><title>抖音隔离登录验收</title>
      <style>body{font:18px system-ui;text-align:center;padding:40px}img{width:280px}</style>
      <h1>仅用授权机器人账号扫码</h1><p>原 Session 不会覆盖；此入口不发送消息、不关注。</p>
      ${png ? `<img alt="登录二维码" src="data:image/png;base64,${png}">` : '<p>等待二维码…</p>'}`);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const close = () => { server.closeAllConnections(); server.close(); };
  signal.addEventListener('abort', close, { once: true });
  return {
    show(info) {
      signal.throwIfAborted();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(info.qrcodeBase64)) throw new Error('Invalid QR image');
      png = info.qrcodeBase64;
      console.log(JSON.stringify({ phase: 'qr', url: `http://127.0.0.1:${address.port}/${token}` }));
    },
    close() { signal.removeEventListener('abort', close); close(); },
  };
}

async function main() {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--live') {
    console.log('No login started. With the authorized user ready: node scripts/research/login-ticket-acceptance.mjs --live');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'douyin-login-acceptance-'));
  console.log(JSON.stringify({ phase: 'isolated-store', directory, containsSensitiveCredentials: true }));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Acceptance cancelled'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadline = setTimeout(stop, 600_000);
  let page;
  try {
    page = await createQrPage(controller.signal);
    const result = await runLoginTicketAcceptance({ directory, connection: new ApiConnection(), signal: controller.signal,
      showQr: info => page.show(info), report: result => console.log(JSON.stringify(result)) });
    if (!result.boundTicket || !result.restoredBoundTicket || !result.localSigningVerified) process.exitCode = 2;
  } catch (error) {
    // Never print platform bodies, cookies, certificate/key material or arbitrary error stacks.
    console.log(JSON.stringify({ phase: 'failed', errorName: error?.name || 'Error', cancelled: controller.signal.aborted }));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline); controller.abort(); page?.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    console.log(JSON.stringify({ phase: 'retained-store', directory, originalStoreUntouched: true }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
