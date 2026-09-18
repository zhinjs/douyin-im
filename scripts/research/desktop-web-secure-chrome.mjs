// Opt-in native-browser integration, not a production login host or live-account test.
// Only a fresh temporary Chrome profile and localhost synthetic endpoints are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { once } from 'node:events';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  verify,
} from 'node:crypto';

const chrome =
  process.argv[2] ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
assert(isAbsolute(chrome), 'Pass an absolute Chrome executable path');
const asset = await readFile(
  new URL('../../lib/desktop/assets/web-secure.js', import.meta.url)
);
const profile = await mkdtemp(join(tmpdir(), 'douyin-secure-browser-'));
const serverKeys = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
function sequence(...parts) {
  const b = Buffer.concat(parts);
  return Buffer.concat([
    Buffer.from(b.length < 128 ? [48, b.length] : [48, 129, b.length]),
    b,
  ]);
}
// This unsigned synthetic v3-shaped container tests source extraction, not CA trust.
const cert =
  '-----BEGIN CERTIFICATE-----\n' +
  sequence(
    sequence(
      ...Array.from({ length: 6 }, () => Buffer.from([5, 0])),
      createPublicKey(serverKeys.publicKey).export({
        type: 'spki',
        format: 'der',
      })
    )
  ).toString('base64') +
  '\n-----END CERTIFICATE-----';
let externalBlocked = 0,
  verifiedRequests = 0,
  certificateRequests = 0;
const publicKeys = new Map();
const server = createServer(async (req, res) => {
  try {
    // Absolute-form proxy requests can never be forwarded outside this process.
    if (/^https?:/i.test(req.url || '')) {
      externalBlocked++;
      res.writeHead(403).end();
      return;
    }
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const csp = `default-src 'none'; script-src 'self'; connect-src 'self'; frame-src ${frameOrigin}; base-uri 'none'; object-src 'none'`;
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Synthetic SDK test</title><script src="/web-secure.js"></script><script src="/test.js"></script>'
      );
      return;
    }
    if (path === '/web-secure.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(asset);
      return;
    }
    if (path === '/test.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(
        'window.testReady = (' +
          browserTest.toString() +
          ')(' +
          JSON.stringify(frameOrigin) +
          '); window.testReady.catch(()=>{});'
      );
      return;
    }
    if (path === '/passport/ticket_guard/get_client_cert/') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.method, 'POST');
      assert.equal(
        Buffer.concat(chunks).toString(),
        'server_data=1,aid=339757'
      );
      certificateRequests++;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          message: 'success',
          data: { server_cert: cert, server_sn: 'synthetic-only' },
        })
      );
      return;
    }
    if (path === '/login') {
      assert.equal(req.method, 'POST');
      const raw = req.headers['bd-ticket-guard-ree-public-key'];
      assert.equal(typeof raw, 'string');
      const point = Buffer.from(raw, 'base64');
      assert.equal(point.length, 65);
      assert.equal(point[0], 4);
      const key = createPublicKey({
        format: 'jwk',
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: point.subarray(1, 33).toString('base64url'),
          y: point.subarray(33).toString('base64url'),
        },
      });
      publicKeys.set(raw, key);
      const ticket =
        'synthetic-' + createHash('sha256').update(raw).digest('hex');
      res.setHeader(
        'bd-ticket-guard-server-data',
        Buffer.from(
          JSON.stringify({
            ticket,
            ts_sign: 'ts.2.synthetic',
            client_cert: 'pub.' + raw,
          })
        ).toString('base64')
      );
      res.setHeader(
        'Set-Cookie',
        'synthetic_session=owned; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600'
      );
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === '/follow' || path === '/follow-ecdsa') {
      assert.equal(req.method, 'POST');
      const raw = req.headers['bd-ticket-guard-ree-public-key'],
        key = publicKeys.get(raw);
      assert(key, 'No synthetic login public key');
      const data = JSON.parse(
        Buffer.from(
          req.headers['bd-ticket-guard-client-data'],
          'base64'
        ).toString()
      );
      const ticket =
        'synthetic-' + createHash('sha256').update(raw).digest('hex');
      assert.equal(data.ts_sign, 'ts.2.synthetic');
      const message = `ticket=${ticket}&path=${path}&timestamp=${data.timestamp}`;
      if (path === '/follow') {
        assert.equal(req.headers['bd-ticket-guard-web-sign-type'], '1');
        const shared = diffieHellman({
          privateKey: createPrivateKey(serverKeys.privateKey),
          publicKey: key,
        });
        const derived = Buffer.from(
          hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32)
        );
        assert.equal(
          data.req_sign,
          createHmac('sha256', derived).update(message).digest('base64'),
          'Invalid native-browser HMAC'
        );
      } else {
        assert.equal(req.headers['bd-ticket-guard-web-sign-type'], '0');
        assert(
          verify(
            'sha256',
            Buffer.from(message),
            key,
            Buffer.from(data.req_sign, 'base64')
          ),
          'Invalid native-browser ECDSA'
        );
      }
      assert(
        (req.headers.cookie || '').includes('synthetic_session=owned'),
        'Native Cookie not sent'
      );
      verifiedRequests++;
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === '/cookie-check') {
      res.end(
        JSON.stringify({
          persisted: (req.headers.cookie || '').includes(
            'synthetic_session=owned'
          ),
        })
      );
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500).end(JSON.stringify({ error: error.message }));
  }
});
server.on('connect', (_req, socket) => {
  externalBlocked++;
  socket.on('error', () => {});
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
});

// A synthetic protocol peer, NOT the official x-storage HTML/implementation.
// It deliberately supports only the audited RPC subset and uses native frame storage.
const frameServer = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'self'; frame-ancestors ${origin}; base-uri 'none'`
  );
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/frame.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><title>Synthetic cross-origin storage</title><script src="/peer.js"></script>'
    );
  } else if (path === '/peer.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(
      '(' + storagePeer.toString() + ')(' + JSON.stringify(origin) + ');'
    );
  } else res.writeHead(404).end();
});

function storagePeer(parentOrigin) {
  const audit = { flights: 0, reads: 0, writes: 0, denied: 0 };
  const meta = key => {
    const raw = localStorage.getItem(key);
    return {
      value: raw === null ? undefined : JSON.parse(raw).data,
      from: raw === null ? -1 : 0,
      origin: location.origin,
    };
  };
  const send = data => parent.postMessage(data, parentOrigin);
  addEventListener('message', event => {
    // Fixture isolation is stricter than the source socket's source-identity check.
    if (event.origin !== parentOrigin || event.source !== parent) return;
    const envelope = event.data;
    if (typeof envelope === 'string' && envelope.startsWith('ACK_0_')) {
      audit.flights++;
      send('ACK_1_' + envelope);
      return;
    }
    if (envelope?.fixture === 'snapshot') {
      const keys = Object.keys(localStorage).filter(key =>
        key.startsWith(envelope.prefix)
      );
      send({
        fixture: 'snapshot-result',
        id: envelope.id,
        audit,
        keys,
        origin: location.origin,
      });
      return;
    }
    if (envelope?.protocol !== 'SERCURE') return;
    const { id, message = {} } = envelope.data || {};
    const { callObj, callName, callArgs = [] } = message;
    const reply = (promiseStatus, value, override = {}) =>
      send({
        type: 'function',
        protocol: 'SERCURE',
        data: { id, promiseStatus, message: value },
        ...override,
      });
    if (!['storage', 'config'].includes(callObj)) return;
    try {
      if (callObj === 'storage' && callName === 'getItemByKeys') {
        audit.reads++;
        const keys = callArgs[0];
        if (keys[0]?.endsWith('/fixture-gate')) {
          const poison = keys.map(() => ({
            value: 'must-not-be-imported',
            from: 0,
            origin: location.origin,
          }));
          reply('resolve', poison, { protocol: 'WRONG-PROTOCOL' });
          reply('resolve', poison, {
            data: {
              id: 'wrong-' + id,
              promiseStatus: 'resolve',
              message: poison,
            },
          });
          send({
            fixture: 'wrong-origin',
            envelope: {
              type: 'function',
              protocol: 'SERCURE',
              data: { id, promiseStatus: 'resolve', message: poison },
            },
          });
          setTimeout(() => reply('resolve', keys.map(meta)), 100);
        } else reply('resolve', keys.map(meta));
      } else if (callObj === 'storage' && callName === 'setItemByKeys') {
        const entries = callArgs[0];
        if (entries.some(([key]) => key.endsWith('/fixture-rejected'))) {
          audit.denied++;
          reply('reject', 'SyntheticStorageDenied');
          return;
        }
        for (const [key, value] of entries)
          localStorage.setItem(key, JSON.stringify({ data: value }));
        audit.writes += entries.length;
        reply(
          'resolve',
          entries.map(([key]) => meta(key))
        );
      } else if (callObj === 'storage' && callName === 'removeItem') {
        localStorage.removeItem(callArgs[0]);
        reply('resolve', undefined);
      } else if (
        callObj === 'config' &&
        ['startChecker', 'setConfig'].includes(callName)
      ) {
        reply('resolve', undefined);
      } else reply('reject', 'UnknowMessageError');
    } catch {
      reply('reject', 'SyntheticStorageError');
    }
  });
  parent.postMessage('ACK', '*');
}

// Runs unchanged in Chrome, not in Node VM; all DOM/crypto/storage/XHR/fetch APIs are native.
async function browserTest(frameOrigin) {
  const ensure = (condition, message) => {
    if (!condition) throw Error(message);
  };
  const phase = new URL(location.href).searchParams.get('phase');
  const cross = phase.startsWith('cross-');
  const prefix =
    'security-sdk/' + (cross ? 'cross-account' : 'native-account') + '/';
  if (phase === 'restore-idb' || phase === 'cross-restore') {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    ensure(
      Object.keys(localStorage).every(key => !key.startsWith(prefix)),
      'Local copy was not removed'
    );
    if (cross) {
      // Eliminate both parent backends BEFORE SDK startup: restoration must come
      // from the other origin, not from the source's silent local fallback.
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('secure-store');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('cryptvalues', 'readwrite');
          const store = tx.objectStore('cryptvalues');
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return;
            if (String(item.key).startsWith(prefix)) item.delete();
            item.continue();
          };
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }
  }
  const preexistingCookie = await (await fetch('/cookie-check')).json();
  // A synthetic server policy, seeded in the actual TCC cache. No remote TCC request.
  localStorage.setItem(
    'ztsdk_tcc_config',
    JSON.stringify({
      expire: Date.now() + 3600000,
      value: {
        ztsdk_config: {
          339757: [
            {
              aid: 339757,
              scene: 'web_protect',
              certType: 'header',
              namespace: 'web',
              providerPathList: ['/login'],
              consumerPathList: ['/follow'],
            },
          ],
        },
      },
    })
  );
  const errors = [];
  const options = {
    monitor: {
      init() {},
      setConfig() {},
      setWebId() {},
      sendSlardarEvent() {},
      sendSlardarLog() {},
      sendTeaLog() {},
    },
    onBackgroundError: error => errors.push(error.message),
  };
  const sdk = DouyinWebSecure.createSDK(options);
  if (cross) sdk.setCrossStorageURL(frameOrigin + '/frame.html');
  else sdk.setDisableCrossStorage(true);
  sdk.setEnableCache(false);
  sdk.setNamespace(cross ? 'cross-account' : 'native-account');
  DouyinWebSecure.startLogin({ aid: 339757, device_id: 'synthetic' }, options);
  // Explicitly wait for actual startup activity, not startLogin's void return.
  await new Promise(resolve => setTimeout(resolve, 0));
  await sdk.cryptoSDK.checkCryptKeys();
  ensure(await sdk.cryptoSDK.checkSigningKeys(), 'Unusable P256 keys');
  const ecdh = await sdk.cryptoSDK.initECDHKey();
  ensure(ecdh.length === 32, 'Missing real ECDH output');
  const pub = await sdk.cryptoSDK.initPubKey();
  const login = await (await fetch('/login', { method: 'POST' })).json();
  ensure(login.ok, login.error || 'Synthetic login rejected');
  const reply = await (await fetch('/follow', { method: 'POST' })).json();
  ensure(reply.ok, reply.error || 'Synthetic follow rejected');
  sdk.setEnableEcdh(false);
  // A distinct pathname avoids reusing the original path/ticket signature cache.
  const ecdsa = await (await fetch('/follow-ecdsa', { method: 'POST' })).json();
  ensure(ecdsa.ok, ecdsa.error || 'Synthetic ECDSA rejected');
  ensure(
    !document.cookie.includes('synthetic_session'),
    'HttpOnly cookie exposed to document'
  );

  // Independent native IDB read after the SDK's first-resolved multi-backend write.
  async function snapshot() {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('secure-store');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const names = [
        's_sdk_crypt_sdk',
        's_sdk_cert_key',
        's_sdk_sign_data_key/web_protect',
      ].map(key => prefix + key);
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('cryptvalues', 'readonly'),
          values = [];
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve(values);
        names.forEach((key, index) => {
          const req = tx.objectStore('cryptvalues').get(key);
          req.onsuccess = () => {
            values[index] = req.result;
          };
        });
      });
    } finally {
      db.close();
    }
  }
  const deadline = Date.now() + 5000;
  let values;
  do {
    values = await snapshot();
    if (phase === 'cross-restore' || values.every(Boolean)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  if (phase === 'cross-restore') {
    // The source remote read does not populate an empty parent backend. Requiring
    // three local records here would incorrectly mandate a production backfill.
    ensure(!values[0], 'Remote restoration unexpectedly had a parent key copy');
  } else {
    ensure(values.every(Boolean), 'Missing native IndexedDB persisted records');
    ensure(
      JSON.parse(JSON.parse(values[2]).data).ticket.startsWith('synthetic-'),
      'Wrong native IDB ticket'
    );
  }
  let frameResult;
  if (cross) {
    const frame = document.querySelector('iframe');
    ensure(
      frame && new URL(frame.src).origin === frameOrigin,
      'Wrong frame origin'
    );
    let blockedBySop = false;
    try {
      void frame.contentWindow.localStorage;
    } catch (error) {
      blockedBySop = error.name === 'SecurityError';
    }
    ensure(blockedBySop, 'No native cross-origin isolation');
    // Test-only inspection: no extra SDK public API, no replacement of handlers.
    const storage = sdk.cryptoSDK._storeSDK.store.storage;
    ensure(storage.client.isConnection, 'Iframe never connected');
    const delivered = { protocol: 0, origin: 0, id: 0 };
    const onMessage = event => {
      const data = event.data;
      if (
        event.origin === frameOrigin &&
        event.source === frame.contentWindow
      ) {
        if (data?.protocol === 'WRONG-PROTOCOL') delivered.protocol++;
        if (data?.data?.id?.startsWith('wrong-')) delivered.id++;
        if (data?.fixture === 'wrong-origin')
          window.postMessage(data.envelope, location.origin);
      } else if (
        event.source === window &&
        event.origin === location.origin &&
        data?.data?.message?.[0]?.value === 'must-not-be-imported'
      )
        delivered.origin++;
    };
    addEventListener('message', onMessage);
    try {
      const start = performance.now();
      const result = await storage.getItemByKeys([prefix + 'fixture-gate']);
      ensure(
        result[0].value === undefined && performance.now() - start >= 80,
        'Invalid RPC response fulfilled the read'
      );
      ensure(
        Object.values(delivered).every(value => value === 1),
        'Negative replies were not delivered'
      );
    } finally {
      removeEventListener('message', onMessage);
    }
    await storage.setItemByKeys([
      [prefix + 'fixture-rejected', 'synthetic-local-fallback'],
    ]);
    const fallback = await storage.getItemByKeys([prefix + 'fixture-rejected']);
    ensure(
      fallback[0].value === 'synthetic-local-fallback',
      'Source local fallback failed'
    );
    frameResult = await new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        removeEventListener('message', receive);
        reject(Error('Frame snapshot timeout'));
      }, 2000);
      function receive(event) {
        if (
          event.source !== frame.contentWindow ||
          event.origin !== frameOrigin ||
          event.data?.fixture !== 'snapshot-result' ||
          event.data.id !== id
        )
          return;
        clearTimeout(timer);
        removeEventListener('message', receive);
        resolve(event.data);
      }
      addEventListener('message', receive);
      frame.contentWindow.postMessage(
        { fixture: 'snapshot', prefix, id },
        frameOrigin
      );
    });
    ensure(
      frameResult.keys.length === 3 &&
        frameResult.keys.every(key =>
          [
            's_sdk_crypt_sdk',
            's_sdk_cert_key',
            's_sdk_sign_data_key/web_protect',
          ].includes(key.slice(prefix.length))
        ),
      'Remote records missing or rejected write was committed'
    );
    ensure(
      frameResult.audit.flights > 0 &&
        frameResult.audit.reads > 0 &&
        frameResult.audit.denied === 1,
      'Missing actual frame activity'
    );
  }
  ensure(errors.length === 0, 'Background failure: ' + errors.join('; '));
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', ecdh)),
  ]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    phase,
    pub,
    ecdhHash: digest,
    idbRecords: values.filter(Boolean).length,
    restoredCookie: preexistingCookie.persisted,
    httpOnly: true,
    ...(cross
      ? {
          remoteRecords: frameResult.keys.length,
          crossOrigin: true,
          gatesVerified: 3,
          rejectedWriteStayedLocal: true,
        }
      : {}),
  };
}

async function launch() {
  const child = spawn(
    chrome,
    [
      '--headless',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-quic',
      '--proxy-server=' + origin,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', error => resolve({ error: error.message }));
  });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Chrome debugger startup timeout')),
        15000
      );
      let text = '';
      child.stderr.on('data', chunk => {
        text = (text + chunk).slice(-10000);
        const found = text.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/
        );
        if (found) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
      void exited.then(() => {
        clearTimeout(timer);
        reject(Error('Owned Chrome exited before debugger startup'));
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Owned Chrome debugger connect timeout')),
        10000
      );
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(Error('Owned Chrome debugger connection failed'));
        },
        { once: true }
      );
    });
    let id = 0;
    const calls = new Map(),
      events = new Map();
    socket.addEventListener('close', () => {
      for (const entry of calls.values()) {
        clearTimeout(entry.timer);
        entry.reject(Error('Owned Chrome debugger closed'));
      }
      calls.clear();
    });
    socket.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const entry = calls.get(msg.id);
        if (!entry) return;
        calls.delete(msg.id);
        clearTimeout(entry.timer);
        msg.error
          ? entry.reject(Error(msg.error.message))
          : entry.resolve(msg.result);
      } else {
        const key = msg.sessionId + ':' + msg.method,
          callback = events.get(key);
        if (callback) {
          events.delete(key);
          callback(msg.params);
        }
      }
    });
    function call(method, params = {}, sessionId) {
      if (socket.readyState !== WebSocket.OPEN)
        return Promise.reject(Error('Owned Chrome debugger is not open'));
      return new Promise((resolve, reject) => {
        const requestId = ++id,
          timer = setTimeout(() => {
            calls.delete(requestId);
            reject(Error(method + ' timeout'));
          }, 20000);
        calls.set(requestId, { resolve, reject, timer });
        socket.send(
          JSON.stringify({
            id: requestId,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          })
        );
      });
    }
    const version = await call('Browser.getVersion');
    async function run(phase, browserContextId) {
      const { targetId } = await call('Target.createTarget', {
        url: 'about:blank',
        ...(browserContextId ? { browserContextId } : {}),
      });
      const { sessionId } = await call('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      await call('Page.enable', {}, sessionId);
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('Local page load timeout')),
          15000
        );
        events.set(sessionId + ':Page.loadEventFired', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      // Navigation itself can reject before the load promise is awaited.
      void loaded.catch(() => {});
      const result = await call(
        'Page.navigate',
        { url: origin + '/?phase=' + phase },
        sessionId
      );
      assert(!result.errorText, result.errorText);
      await loaded;
      const value = await call(
        'Runtime.evaluate',
        {
          expression: 'window.testReady',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId
      );
      assert(
        !value.exceptionDetails,
        value.exceptionDetails?.exception?.description ||
          value.exceptionDetails?.text
      );
      assert(value.result.value, 'No native-browser result');
      await call('Target.closeTarget', { targetId });
      return value.result.value;
    }
    return {
      call,
      run,
      version,
      async close() {
        try {
          await call('Browser.close');
        } catch {
          /* Closing can end the debugger before its response. */
        }
        socket.close();
        const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
        await exited;
        clearTimeout(timer);
        clearTimeout(killTimer);
      },
    };
  } catch (error) {
    socket?.close();
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    throw error;
  }
}

let origin, frameOrigin, active;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  frameServer.listen(0, '127.0.0.1');
  await once(frameServer, 'listening');
  frameOrigin = 'http://127.0.0.1:' + frameServer.address().port;
  active = await launch();
  const version = active.version.product;
  const first = await active.run('first');
  const { browserContextId } = await active.call(
    'Target.createBrowserContext',
    { disposeOnDetach: true }
  );
  const isolated = await active.run('isolated', browserContextId);
  assert.notEqual(first.pub, isolated.pub);
  assert.equal(first.restoredCookie, false);
  assert.equal(isolated.restoredCookie, false);
  await active.call('Target.disposeBrowserContext', { browserContextId });
  await active.close();
  active = undefined;
  active = await launch();
  const restored = await active.run('restore-idb');
  assert.equal(
    restored.pub,
    first.pub,
    'Native IDB did not restore original keys after Chrome restart'
  );
  assert.equal(
    restored.restoredCookie,
    true,
    'HttpOnly Cookie did not survive owned profile restart'
  );
  for (const item of [first, isolated, restored]) {
    const shared = diffieHellman({
      privateKey: createPrivateKey(serverKeys.privateKey),
      publicKey: publicKeys.get(item.pub),
    });
    assert.equal(
      item.ecdhHash,
      createHash('sha256')
        .update(
          Buffer.from(
            hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32)
          )
        )
        .digest('hex')
    );
  }
  assert.equal(verifiedRequests, 6);
  assert.equal(certificateRequests, 2); // Persistent cert cache restored.
  const crossFirst = await active.run('cross-first');
  await active.close();
  active = undefined;
  active = await launch();
  const crossRestored = await active.run('cross-restore');
  assert.equal(
    crossRestored.pub,
    crossFirst.pub,
    'Remote-only key restoration failed'
  );
  assert.equal(crossRestored.ecdhHash, crossFirst.ecdhHash);
  assert.equal(verifiedRequests, 10);
  console.log(
    JSON.stringify({
      result: 'PASS',
      browser: version,
      nativeIdbRecordsPerRealm: first.idbRecords,
      independentlyVerifiedRequests: verifiedRequests,
      ecdhVerified: 5,
      profileRestartRestoredKeys: true,
      isolatedContext: true,
      httpOnlyPersistence: true,
      nativeCrossOriginRecords: crossRestored.remoteRecords,
      remoteOnlyRestartRestoredKeys: true,
      invalidResponseGatesPerCrossRealm: crossRestored.gatesVerified,
      rejectedRemoteWriteStayedLocal: true,
      officialStoragePage: false,
      externalRequestsForwarded: 0,
      externalRequestsBlocked: externalBlocked,
      liveAccount: false,
    })
  );
} finally {
  if (active) await active.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  frameServer.closeAllConnections();
  await new Promise(resolve => frameServer.close(resolve));
  // Only this run's generated, synthetic profile; never an application/user profile.
  assert(
    isAbsolute(profile) &&
      profile.startsWith(join(tmpdir(), 'douyin-secure-browser-'))
  );
  await rm(profile, { recursive: true, force: true });
}
