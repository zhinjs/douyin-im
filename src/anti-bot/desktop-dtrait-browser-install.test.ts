import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  webcrypto,
  generateKeyPairSync,
  privateDecrypt,
  constants,
  createDecipheriv,
} from 'node:crypto';
import {
  installDesktopDTraitBrowser,
  type DesktopDTraitBrowserInstallRealm,
} from './desktop-dtrait-browser-install.js';
import type {
  DesktopDTraitAes,
  DesktopDTraitRsa,
} from './desktop-dtrait-crypto.js';
import type { DesktopDTraitCore } from './desktop-dtrait-bootstrap.js';
import type { DesktopDTraitBootstrap } from './desktop-dtrait-bootstrap.js';
import type { DesktopDTraitBrowserBootstrapOptions } from './desktop-dtrait-browser-bootstrap.js';
import { DESKTOP_DTRAIT_PARAMETERS_KEY } from './desktop-dtrait-parameters.js';

const require = createRequire(import.meta.url);
const { buildDesktopDTraitAsset } =
  require('../../scripts/build/browser-bundle.cjs') as {
    buildDesktopDTraitAsset(root: string): string;
  };
const { createFixture } =
  require('../../scripts/research/desktop-dtrait-browser-fixture.cjs') as {
    createFixture(mode: string): {
      realm: Record<string, unknown>;
      settle<T>(value: Promise<T>): Promise<T>;
      trace: unknown[][];
    };
  };
const { createFixture: createTransport } =
  require('../../scripts/research/desktop-dtrait-transport-fixture.cjs') as {
    createFixture(): { realm: Record<string, unknown>; trace: unknown[][] };
  };
const root = join(process.cwd(), 'src/anti-bot');
const asset = buildDesktopDTraitAsset(root);
function fixture(fallback = false) {
  const browser = createFixture('missing-capabilities'),
    transport = createTransport();
  const realm = browser.realm;
  Object.assign(realm['document'] as object, {
    cookie: 'passport_csrf_token=synthetic-csrf',
  });
  for (const name of ['XMLHttpRequest', 'Request', 'Headers', 'URL', 'fetch'])
    realm[name] = transport.realm[name];
  const stored = new Map<string, string>(),
    parameterCalls: unknown[][] = [];
  let parameterResponse: unknown = {
    message: 'error',
    data: { description: 'synthetic error' },
  };
  class ParameterXHR {
    readyState = 0;
    status = 200;
    response = '';
    onreadystatechange: (() => unknown) | null = null;
    open(...args: unknown[]) {
      parameterCalls.push(['open', ...args]);
    }
    setRequestHeader(...args: unknown[]) {
      parameterCalls.push(['header', ...args]);
    }
    addEventListener() {}
    getAllResponseHeaders() {
      return '';
    }
    send(body: unknown) {
      parameterCalls.push(['body', body]);
      queueMicrotask(() => {
        this.response = JSON.stringify(parameterResponse);
        this.readyState = 4;
        void this.onreadystatechange?.();
      });
    }
  }
  Object.assign(realm, {
    XMLHttpRequest: ParameterXHR,
    FormData: class {},
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
    crypto: webcrypto,
    TextEncoder,
    location: {
      href: 'https://example.invalid/base',
      search: fallback ? '?disableSystemCrypto=1' : '',
    },
  });
  realm['self'] = realm;
  return {
    ...browser,
    transport,
    stored,
    parameterCalls,
    setParameterResponse(value: unknown) {
      parameterResponse = value;
    },
    realm: realm as unknown as DesktopDTraitBrowserInstallRealm & {
      DTraitSDK: DesktopDTraitCore;
      DTraitUcAesEncrypt: DesktopDTraitAes;
      DTraitUcRsaEncrypt: DesktopDTraitRsa;
      DouyinDTrait: {
        createBootstrap(
          options: Pick<DesktopDTraitBrowserBootstrapOptions, 'monitor'>
        ): DesktopDTraitBootstrap;
      };
    },
  };
}
function evaluate(realm: object) {
  // Node's native TextEncoder returns a Node-realm typed array. A browser encoder
  // returns its own realm's Uint8Array, which CryptoJS checks with instanceof.
  const encoder =
    '(function(){const Native=TextEncoder;globalThis.TextEncoder=class{encode(text){return new Uint8Array(new Native().encode(text));}};})();\n';
  runInNewContext(encoder + asset, realm, {
    timeout: 3000,
    contextCodeGeneration: { strings: false, wasm: false },
  });
}

function bootstrapMonitor() {
  const receivers: unknown[] = [];
  const monitor = {
    init() {
      receivers.push(this);
    },
    setConfig() {
      receivers.push(this);
    },
    setWebId() {
      receivers.push(this);
    },
    sendSlardarEvent() {
      receivers.push(this);
    },
    sendSlardarLog() {
      receivers.push(this);
    },
    sendTeaLog() {
      receivers.push(this);
    },
  };
  return { monitor, receivers };
}
function cachedVersion(f: ReturnType<typeof fixture>, version: unknown) {
  f.stored.set(
    DESKTOP_DTRAIT_PARAMETERS_KEY,
    btoa(
      JSON.stringify({
        urlVersion: version,
        centralVersion: 'test',
        createdTime: f.realm.Date.now(),
      })
    )
  );
}

it.each([
  '9.9.9',
  'https://unverified.invalid/core.js?token=private',
  31,
  {},
  ' ',
])(
  'rejects an unsupported cached version without invoking a local core or downloading a script: %j',
  async version => {
    const f = fixture(),
      { monitor } = bootstrapMonitor();
    evaluate(f.realm);
    cachedVersion(f, version);
    const call = jest.spyOn(f.realm.DTraitSDK, 'getInstance');
    const native = f.realm.window.fetch;
    const bootstrap = f.realm.DouyinDTrait.createBootstrap({ monitor });
    await expect(f.settle(bootstrap.start({ aid: 6383 }))).rejects.toThrow(
      'Unsupported DTrait core version'
    );
    expect(call).not.toHaveBeenCalled();
    expect(f.realm.window.fetch).toBe(native);
    expect(f.parameterCalls).toEqual([]);
    expect(f.trace.some(row => row.includes('script'))).toBe(false);
  }
);

it('rechecks versions after successful startup and preserves monitor owner receivers', async () => {
  const f = fixture(),
    { monitor, receivers } = bootstrapMonitor();
  evaluate(f.realm);
  const call = jest.spyOn(f.realm.DTraitSDK, 'getInstance');
  const bootstrap = f.realm.DouyinDTrait.createBootstrap({ monitor });
  await expect(f.settle(bootstrap.start({ useBuildIn: true }))).resolves.toBe(
    true
  );
  const callbacks = call.mock.calls[0]![1]['monitor'] as {
    sendSlardarEvent(value: object): void;
    sendSlardarLog(value: object): void;
    sendTeaLog(name: string, value: object): void;
  };
  callbacks.sendSlardarEvent.call({}, { name: 'synthetic' });
  callbacks.sendSlardarLog.call({}, { content: 'synthetic' });
  callbacks.sendTeaLog.call({}, 'synthetic', {});
  bootstrap.setWebId('synthetic');
  const hooked = f.realm.window.fetch;
  cachedVersion(f, '9.9.9');
  await expect(f.settle(bootstrap.start({ aid: 6383 }))).rejects.toThrow(
    'Unsupported DTrait core version'
  );
  expect(call).toHaveBeenCalledTimes(1);
  expect(f.realm.window.fetch).toBe(hooked);
  expect(receivers.length).toBeGreaterThan(2);
  expect(receivers.every(value => value === monitor)).toBe(true);
  expect(f.parameterCalls).toEqual([]);
});

it.each([
  'lf-douyin-pc-web.douyinstatic.com',
  'lf-ucenter-web.yhgfb-cn-static.com',
])(
  'accepts only the pinned published URL for %s without script loading',
  async host => {
    const f = fixture(),
      { monitor } = bootstrapMonitor();
    evaluate(f.realm);
    const call = jest.spyOn(f.realm.DTraitSDK, 'getInstance');
    const bootstrap = f.realm.DouyinDTrait.createBootstrap({ monitor });
    await f.settle(bootstrap.start({ useBuildIn: true }));
    const params = call.mock.calls[0]![0];
    const url = `https://${host}/obj/passport-fe/ucenter_fe/@byted/uc-secure-dtrait-core/1.0.31/dist/index.umd.production.js`;
    f.stored.set(
      DESKTOP_DTRAIT_PARAMETERS_KEY,
      btoa(
        JSON.stringify({
          ...params,
          urlVersion: url,
          createdTime: f.realm.Date.now(),
        })
      )
    );
    await expect(f.settle(bootstrap.start({ aid: 6383 }))).resolves.toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]![0]).toMatchObject({
      urlVersion: url,
      dataFrom: 'local',
    });
    expect(f.parameterCalls).toEqual([]);
  }
);

it('rejects ownership replacement even when the source loader would be skipped', async () => {
  const f = fixture(),
    { monitor } = bootstrapMonitor();
  evaluate(f.realm);
  const bootstrap = f.realm.DouyinDTrait.createBootstrap({ monitor });
  const foreign = { getInstance: jest.fn() };
  f.realm.DTraitSDK = foreign;
  await expect(f.settle(bootstrap.start({ useBuildIn: true }))).rejects.toThrow(
    'ownership changed'
  );
  expect(foreign.getInstance).not.toHaveBeenCalled();
});

it('keeps source dynamic-parameter failure fallback to the builtin public parameters', async () => {
  const f = fixture(),
    { monitor } = bootstrapMonitor();
  evaluate(f.realm);
  const call = jest.spyOn(f.realm.DTraitSDK, 'getInstance');
  const bootstrap = f.realm.DouyinDTrait.createBootstrap({ monitor });
  await expect(f.settle(bootstrap.start({ aid: 6383 }))).resolves.toBe(true);
  expect(call.mock.calls[0]![0]).toMatchObject({
    urlVersion: '1.0.31',
    centralVersion: 'd0',
  });
  expect(f.parameterCalls.filter(row => row[0] === 'body')).toHaveLength(1);
  expect(f.stored.size).toBe(0);
});

it('shares bootstrap and parameter inflight state only within one browser owner', async () => {
  const f = fixture(),
    g = fixture(),
    { monitor } = bootstrapMonitor();
  evaluate(f.realm);
  evaluate(g.realm);
  const a = f.realm.DouyinDTrait.createBootstrap({ monitor });
  expect(f.realm.DouyinDTrait.createBootstrap({ monitor })).toBe(a);
  expect(g.realm.DouyinDTrait.createBootstrap({ monitor })).not.toBe(a);
  const call = jest.spyOn(f.realm.DTraitSDK, 'getInstance');
  await expect(
    f.settle(Promise.all([a.start({ aid: 6383 }), a.start({ aid: 9999 })]))
  ).resolves.toEqual([true, true]);
  expect(f.parameterCalls.filter(row => row[0] === 'body')).toHaveLength(1);
  expect(f.parameterCalls[0]![2]).toContain('aid=6383&');
  expect(call).toHaveBeenCalledTimes(2);
  expect(g.parameterCalls).toEqual([]);
});

it('builds a deterministic self-contained asset without an application chunk or Node runtime', async () => {
  expect(buildDesktopDTraitAsset(root)).toBe(asset);
  expect(asset).not.toContain('webpackChunkawemeim');
  const f = fixture(),
    native = f.realm.window.fetch;
  evaluate(f.realm);
  await f.realm.DTraitUcRsaEncrypt.initPromise;
  expect(f.realm.DTraitSDK.getInstance).toEqual(expect.any(Function));
  expect(f.realm.window.fetch).toBe(native);
  expect(f.trace).toEqual([]); // Real TextEncoder, not the trace-recording fixture encoder.
  expect(f.transport.trace).toEqual([]);
  expect(f.realm.DTraitUcAesEncrypt.supportSystemCrypto).toBe(true);
  expect(f.realm.DTraitUcAesEncrypt.cryptoJS).toBeNull();
});

it.each([false, true])(
  'decrypts the full packaged collector/core/transport header using real RSA and AES, fallback=%s',
  async fallback => {
    const f = fixture(fallback);
    evaluate(f.realm);
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    let collected!: () => void;
    const collection = new Promise<void>(resolve => {
      collected = resolve;
    });
    f.setParameterResponse({
      message: 'success',
      data: {
        'x-tt-session-dtrait-pk1': btoa(keys.publicKey),
        'x-tt-session-dtrait-pk1-version': 'test',
        'x-tt-session-dtrait-pk2': btoa(keys.publicKey),
        'x-tt-session-dtrait-pk2-version': 'edge',
        'x-tt-session-dtrait-fe-url-version': '1.0.31',
        'x-tt-session-dtrait-version': '0',
      },
    });
    const bootstrap = f.realm.DouyinDTrait.createBootstrap({
      monitor: {
        init() {},
        setConfig() {},
        sendSlardarLog() {},
        sendTeaLog() {},
        sendSlardarEvent(event: { name: string }) {
          if (event.name === 'feature_collect') collected();
        },
      },
    });
    await expect(
      f.settle(bootstrap.start({ aid: 6383, consumerPathList: ['/login'] }))
    ).resolves.toBe(true);
    expect(f.parameterCalls).toContainEqual([
      'body',
      'server_data=1&need_session_dtrait=1',
    ]);
    expect(f.parameterCalls[0]).toEqual([
      'open',
      'POST',
      '/passport/ticket_guard/get_client_cert/?aid=6383&type=trait&sdk_version=1.0.23&is_from_ttaccountsdk=1',
    ]);
    expect(
      JSON.parse(atob(f.stored.get(DESKTOP_DTRAIT_PARAMETERS_KEY)!))
    ).toMatchObject({ urlVersion: '1.0.31', centralVersion: 'test' });
    // Drain only synthetic DOM timers first. Subsequent real crypto work is awaited normally.
    await f.settle(collection);
    const init = { headers: {} as Record<string, string> };
    await f.realm.window.fetch!('/login', init);
    const [version, rsa, cipher] =
      init.headers['x-tt-session-dtrait']!.split('_');
    expect(version).toBe('test');
    const block = privateDecrypt(
      { key: keys.privateKey, padding: constants.RSA_NO_PADDING },
      Buffer.from(rsa!, 'base64')
    );
    expect(block[0]).toBe(0);
    expect(block[1]).toBe(2);
    const boundary = block.indexOf(0, 2);
    expect(boundary).toBeGreaterThanOrEqual(10);
    const key = Buffer.from(block.subarray(boundary + 1).toString(), 'hex');
    expect(key).toHaveLength(16);
    const payload = Buffer.from(cipher!, 'base64'),
      decipher = createDecipheriv('aes-128-cbc', key, payload.subarray(0, 16));
    const text = Buffer.concat([
      decipher.update(payload.subarray(16)),
      decipher.final(),
    ]).toString();
    expect(JSON.parse(text)).toMatchObject({
      path: '/login',
      sdkVersion: '1.0.31',
      dtrait: expect.any(String),
    });
    expect(JSON.parse(text).dtrait.length).toBeGreaterThan(0);
    expect(f.transport.trace.filter(row => row[0] === 'fetch')).toHaveLength(1);
    expect(f.realm.DTraitUcAesEncrypt.supportSystemCrypto).toBe(!fallback);
    if (fallback) expect(f.realm.DTraitUcAesEncrypt.cryptoJS).not.toBeNull();
  }
);

it('shares explicit installation only in its owned realm and propagates loader failure', async () => {
  const f = fixture(),
    failure = new Error('synthetic dependency failure');
  const dependencies = {
    loadCryptoJS: jest.fn().mockRejectedValue(failure),
    loadJSEncrypt: jest.fn().mockRejectedValue(failure),
    onBackgroundError: jest.fn(),
  };
  const a = installDesktopDTraitBrowser(f.realm, dependencies);
  expect(installDesktopDTraitBrowser(f.realm, dependencies)).toBe(a);
  await expect(a.crypto.rsa.initPromise).rejects.toBe(failure);
  expect(dependencies.loadJSEncrypt).toHaveBeenCalledTimes(1);
  expect(dependencies.loadCryptoJS).not.toHaveBeenCalled();
  expect(dependencies.onBackgroundError).toHaveBeenCalledWith(failure);
  const g = fixture();
  expect(installDesktopDTraitBrowser(g.realm, dependencies)).not.toBe(a);
});

it('refuses to overwrite a foreign DTrait SDK before initializing crypto', () => {
  const f = fixture();
  const foreign = { getInstance: () => true };
  f.realm.DTraitSDK = foreign;
  const dependencies = { loadCryptoJS: jest.fn(), loadJSEncrypt: jest.fn() };
  expect(() => installDesktopDTraitBrowser(f.realm, dependencies)).toThrow(
    'another browser owner'
  );
  expect(dependencies.loadJSEncrypt).not.toHaveBeenCalled();
  expect(f.realm.DTraitSDK).toBe(foreign);
});
