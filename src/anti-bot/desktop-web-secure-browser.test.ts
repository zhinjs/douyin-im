import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  verify,
  webcrypto,
} from 'node:crypto';
import type { DesktopWebSecureSdk } from './desktop-web-secure-sdk.js';
import type { DesktopWebSecureBrowserOptions } from './desktop-web-secure-browser.js';
import type { DesktopLoginWebSecureConfig } from './desktop-web-secure-browser.js';

const require = createRequire(import.meta.url);
const { buildDesktopWebSecureAsset } =
  require('../../scripts/build/browser-bundle.cjs') as {
    buildDesktopWebSecureAsset(root: string): string;
  };
const { createFixture } =
  require('../../scripts/research/desktop-dtrait-browser-fixture.cjs') as {
    createFixture(mode: string): {
      realm: Record<string, unknown>;
      trace: unknown[][];
    };
  };
const asset = buildDesktopWebSecureAsset(join(process.cwd(), 'src/anti-bot'));
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

// Only native environment surfaces are synthetic. The asset runs actual TCC,
// certificate, storage, Keys and transport implementations with real WebCrypto.
function fixture() {
  const f = createFixture('missing-capabilities'),
    realm = f.realm;
  const stored = new Map<string, string>(),
    cookies = new Map<string, string>();
  const xhrs: Xhr[] = [],
    requests: { url: unknown; headers: Record<string, unknown> }[] = [];
  const background = jest.fn(),
    timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0,
    serverHeader = '',
    certResponse: unknown = {
      message: 'error',
      data: { description: 'synthetic certificate error' },
    };
  let tccResponse: unknown = {
    data: {
      ztsdk_config: JSON.stringify({
        1128: [{ aid: 1128, scene: 'remote-source' }],
      }),
    },
  };
  class Xhr {
    readyState = 0;
    status = 200;
    response = '';
    onreadystatechange: (() => void) | null = null;
    args: unknown[] = [];
    headers: Record<string, string> = {};
    body: unknown;
    constructor() {
      xhrs.push(this);
    }
    open(...args: unknown[]) {
      this.args = args;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    getAllResponseHeaders() {
      return '';
    }
    send(body?: unknown) {
      this.body = body;
      const url = String(this.args[1]);
      if (!url.includes('tcc-v2-data-') && !url.includes('/get_client_cert/'))
        throw Error('unexpected synthetic endpoint');
      this.response = JSON.stringify(
        url.includes('tcc-v2-data-') ? tccResponse : certResponse
      );
      this.readyState = 4;
      this.onreadystatechange?.();
    }
  }
  const nativeFetch = async (
    url: unknown,
    init?: { headers?: Record<string, unknown> }
  ) => {
    requests.push({ url, headers: { ...init?.headers } });
    return {
      headers: new Headers(
        url === '/login' && serverHeader
          ? { 'bd-ticket-guard-server-data': serverHeader }
          : {}
      ),
    };
  };
  const location = {
    href: 'https://synthetic.invalid/login',
    origin: 'https://synthetic.invalid',
    hostname: 'synthetic.invalid',
    search: '',
  };
  const document = realm['document'] as Record<string, unknown>;
  Object.assign(document, {
    location,
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  });
  Object.defineProperty(document, 'cookie', {
    get: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    set: (value: string) => {
      const [pair] = value.split(';'),
        at = pair!.indexOf('=');
      cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    },
  });
  const localStorage = {
    get length() {
      return stored.size;
    },
    key: (index: number) => [...stored.keys()][index] ?? null,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
    removeItem: (key: string) => {
      stored.delete(key);
    },
  };
  Object.assign(realm, {
    self: realm,
    parent: realm,
    XMLHttpRequest: Xhr,
    FormData: class {},
    Request,
    Headers,
    URL,
    fetch: nativeFetch,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Date,
    location,
    localStorage,
    // An unavailable IDB is intentional here, not a mocked successful database.
    indexedDB: undefined,
    webkitIndexedDB: undefined,
    mozIndexedDB: undefined,
    OIndexedDB: undefined,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    postMessage: jest.fn(),
    setTimeout(callback: () => void, delay: number) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  function evaluate() {
    runInNewContext(
      '(function(){const Native=TextEncoder;globalThis.TextEncoder=class{encode(text){return new Uint8Array(new Native().encode(text));}};})();\n' +
        asset,
      realm,
      {
        timeout: 5000,
        contextCodeGeneration: { strings: false, wasm: false },
      }
    );
  }
  type BrowserOptions = Pick<
    DesktopWebSecureBrowserOptions,
    'monitor' | 'onBackgroundError' | 'telemetry'
  >;
  const owner = realm as unknown as {
    securitySDK?: DesktopWebSecureSdk;
    DouyinWebSecure: {
      createSDK(options: BrowserOptions): DesktopWebSecureSdk;
      startLogin(
        config: DesktopLoginWebSecureConfig,
        options: BrowserOptions
      ): void;
    };
    fetch: typeof nativeFetch;
  };
  const monitor = {
    init() {},
    setConfig() {},
    setWebId() {},
    sendSlardarEvent() {},
    sendSlardarLog() {},
    sendTeaLog() {},
  };
  function sdk(namespace = 'synthetic-account') {
    const sdk = owner.DouyinWebSecure.createSDK({
      monitor,
      onBackgroundError: background,
    });
    // A documented source option, not a replacement Store. Iframe mode is tested separately.
    sdk.setDisableCrossStorage(true);
    sdk.setEnableCache(false);
    sdk.setNamespace(namespace);
    sdk.setConfig({
      aid: 1128,
      scene: 'web_protect',
      namespace: 'header-scope',
      providerPathList: ['/login'],
      consumerPathList: ['/follow'],
    });
    return sdk;
  }
  return {
    ...f,
    owner,
    evaluate,
    sdk,
    stored,
    cookies,
    document,
    localStorage,
    xhrs,
    requests,
    background,
    timers,
    nativeFetch,
    startLogin(
      config: DesktopLoginWebSecureConfig,
      extra: Partial<BrowserOptions> = {}
    ) {
      return owner.DouyinWebSecure.startLogin(config, {
        monitor,
        onBackgroundError: background,
        ...extra,
      });
    },
    setTicket(value: object) {
      serverHeader = Buffer.from(JSON.stringify(value)).toString('base64');
    },
    setCertificate(value: unknown) {
      certResponse = value;
    },
    setTcc(value: unknown) {
      tccResponse = value;
    },
  };
}

it('ships a closed same-realm graph and installs hooks only at explicit factory creation', () => {
  const f = fixture(),
    globalFetch = globalThis.fetch;
  f.evaluate();
  expect(f.owner.fetch).toBe(f.nativeFetch);
  expect(f.xhrs).toEqual([]);
  const sdk = f.sdk(),
    hooked = f.owner.fetch;
  expect(hooked).not.toBe(f.nativeFetch);
  expect(f.owner.securitySDK).toBe(sdk);
  expect(f.sdk()).toBe(sdk);
  expect(f.owner.fetch).toBe(hooked);
  expect(globalThis.fetch).toBe(globalFetch);
  expect(f.xhrs).toEqual([]);
  expect(() => f.evaluate()).toThrow(
    'already belongs to another browser owner'
  );
});

it('uses actual TCC and local storage to persist a provider ticket and generate a verifiable consumer signature', async () => {
  const f = fixture();
  f.evaluate();
  const sdk = f.sdk();
  sdk.setEnableEcdh(false);
  const errors: string[] = [];
  sdk.pipeline.on('error', value => {
    const event = value as { name: string; error?: Error };
    errors.push(`${event.name}: ${event.error?.message}`);
  });
  await sdk.start();
  await sdk.cryptoSDK.checkCryptKeys();
  expect(await sdk.cryptoSDK.checkSigningKeys()).toBe(true);
  expect(f.xhrs[0]!.args).toEqual([
    'get',
    'https://lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-ucenter.fe.ztsdk-default',
    false,
  ]);
  expect(sdk.config['remote-source']).toHaveLength(1);
  expect(f.stored.has('ztsdk_tcc_config')).toBe(true);
  const info = await sdk.cryptoSDK.getKeysInfoWithOrigin({
    certType: 'header',
    scene: 'web_protect',
  });
  f.setTicket({
    ticket: 'synthetic-ticket',
    ts_sign: 'ts.2.synthetic',
    client_cert: `pub.${info.b64PubKey}`,
  });
  await f.owner.fetch('/login', { headers: {} });
  await f.owner.fetch('/follow', { headers: {} });
  expect(errors).toEqual([]);
  expect(
    (
      await sdk.cryptoSDK.getKeysInfoWithOrigin({
        certType: 'header',
        scene: 'web_protect',
      })
    ).sign?.ticket
  ).toBe('synthetic-ticket');
  expect(f.requests[0]!.headers['bd-ticket-guard-ree-public-key']).toBe(
    info.b64PubKey
  );
  const data = JSON.parse(
    Buffer.from(
      f.requests[1]!.headers['bd-ticket-guard-client-data'] as string,
      'base64'
    ).toString()
  );
  const pair = await sdk.cryptoSDK.cryptoSDK!.getKeys();
  expect(
    verify(
      'sha256',
      Buffer.from(
        `ticket=synthetic-ticket&path=/follow&timestamp=${data.timestamp}`
      ),
      pair.publicKey as string,
      Buffer.from(data.req_sign, 'base64')
    )
  ).toBe(true);
  expect(
    f.stored.has(
      'security-sdk/synthetic-account/s_sdk_sign_data_key/web_protect'
    )
  ).toBe(true);
  expect(f.background).not.toHaveBeenCalled();
});

function sequence(...parts: Buffer[]) {
  const body = Buffer.concat(parts);
  return Buffer.concat([
    Buffer.from(
      body.length < 128 ? [0x30, body.length] : [0x30, 0x81, body.length]
    ),
    body,
  ]);
}
function certificate(publicKey: string) {
  // Unsigned synthetic container: source extraction must not imply CA validation.
  const tbs = sequence(
    ...Array.from({ length: 6 }, () => Buffer.from([5, 0])),
    createPublicKey(publicKey).export({ type: 'spki', format: 'der' })
  );
  return `-----BEGIN CERTIFICATE-----\n${sequence(tbs).toString('base64')}\n-----END CERTIFICATE-----`;
}

it('retrieves the server certificate through the owned XHR and really derives ECDH/HKDF', async () => {
  const f = fixture();
  f.evaluate();
  const sdk = f.sdk();
  const server = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const cert = certificate(server.publicKey);
  f.setCertificate({
    message: 'success',
    data: { server_cert: cert, server_sn: 'synthetic-sn' },
  });
  await sdk.start();
  const key = await sdk.cryptoSDK.initECDHKey();
  const local = await sdk.cryptoSDK.cryptoSDK!.getKeys();
  const shared = diffieHellman({
    privateKey: createPrivateKey(local.privateKey as string),
    publicKey: createPublicKey(server.publicKey),
  });
  expect(Buffer.from(key)).toEqual(
    Buffer.from(
      hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32)
    )
  );
  const request = f.xhrs.find(xhr =>
    String(xhr.args[1]).includes('/get_client_cert/')
  )!;
  expect(request.args).toEqual([
    'POST',
    '/passport/ticket_guard/get_client_cert/?aid=1128&is_from_ttaccountsdk=1',
  ]);
  expect(request.body).toBe('server_data=1,aid=1128');
  expect(
    JSON.parse(f.stored.get('security-sdk/s_sdk_server_cert_key')!).cert
  ).toBe(cert);
  expect(f.background).not.toHaveBeenCalled();
});

it('keeps two realm owners and their stored keys independent', async () => {
  const a = fixture(),
    b = fixture();
  a.evaluate();
  b.evaluate();
  const sa = a.sdk('a'),
    sb = b.sdk('b');
  sa.setEnableEcdh(false);
  sb.setEnableEcdh(false);
  await Promise.all([sa.start(), sb.start()]);
  expect(await sa.cryptoSDK.initPubKey()).not.toBe(
    await sb.cryptoSDK.initPubKey()
  );
  expect(
    [...a.stored.keys()].some(key => key.startsWith('security-sdk/b/'))
  ).toBe(false);
  expect(
    [...b.stored.keys()].some(key => key.startsWith('security-sdk/a/'))
  ).toBe(false);
});

it('does not turn an empty TCC response into successful SDK startup', async () => {
  const f = fixture();
  f.evaluate();
  const sdk = f.sdk();
  sdk.setEnableEcdh(false);
  f.setTcc({ data: {} });
  let done = false;
  void sdk.start().then(() => {
    done = true;
  });
  await sdk.cryptoSDK.checkCryptKeys();
  await flush();
  expect(done).toBe(false);
  expect(f.stored.has('ztsdk_tcc_config')).toBe(false);
});

it('propagates a certificate error instead of inventing an ECDH key', async () => {
  const f = fixture();
  f.evaluate();
  const sdk = f.sdk();
  sdk.setEnableEcdh(false);
  await expect(sdk.cryptoSDK.initECDHKey()).rejects.toThrow(
    'synthetic certificate error'
  );
  expect(f.stored.has('security-sdk/s_sdk_server_cert_key')).toBe(false);
});

it('restores actual persisted keys in a fresh same-account realm without regenerating them', async () => {
  const first = fixture();
  first.evaluate();
  const original = first.sdk();
  original.setEnableEcdh(false);
  await original.start();
  const before = await original.cryptoSDK.initPubKey();
  await flush();
  const next = fixture();
  for (const [key, value] of first.stored) next.stored.set(key, value);
  next.evaluate();
  const restored = next.sdk();
  restored.setEnableEcdh(false);
  await restored.start();
  expect(await restored.cryptoSDK.initPubKey()).toBe(before);
  expect(await restored.cryptoSDK.checkSigningKeys()).toBe(true);
  expect(next.xhrs).toEqual([]); // TCC cache is reused by the actual TCC owner too.
});

it('reads the certificate storage getter lazily and preserves its failure', async () => {
  const f = fixture();
  f.evaluate();
  const sdk = f.sdk();
  sdk.setEnableEcdh(false);
  await sdk.cryptoSDK.checkCryptKeys();
  // Install in the evaluated realm: Node's contextified sandbox can suppress an
  // exception from an accessor later defined on the outer sandbox object.
  runInNewContext(
    "Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('synthetic storage denied'); } });",
    f.realm
  );
  await expect(sdk.cryptoSDK.initECDHKey()).rejects.toThrow(
    'synthetic storage denied'
  );
  expect(f.xhrs).toEqual([]);
});

it('rejects a valid response when certificate persistence fails instead of declaring ECDH ready', async () => {
  const f = fixture();
  f.evaluate();
  const sdk = f.sdk();
  sdk.setEnableEcdh(false);
  await sdk.cryptoSDK.checkCryptKeys();
  const set = f.localStorage.setItem;
  f.localStorage.setItem = (key, value) => {
    if (key === 'security-sdk/s_sdk_server_cert_key')
      throw Error('synthetic quota');
    set(key, value);
  };
  f.setCertificate({
    message: 'success',
    data: { server_cert: 'synthetic-unparsed-cert', server_sn: 'synthetic-sn' },
  });
  await expect(sdk.cryptoSDK.initECDHKey()).rejects.toThrow('synthetic quota');
  expect(f.stored.has('security-sdk/s_sdk_server_cert_key')).toBe(false);
});

it('initializes the real Desktop login scene asynchronously with live device ID, not hp defaults', async () => {
  const f = fixture();
  f.evaluate();
  const config = { aid: 339757, device_id: 'before-load' };
  const telemetry = {
    setContext: jest.fn(),
    dot: jest.fn(),
    log: jest.fn(),
    throw: jest.fn(),
  };
  expect(f.startLogin(config, { telemetry })).toBeUndefined();
  expect(f.owner.securitySDK).toBeUndefined();
  expect(f.owner.fetch).toBe(f.nativeFetch);
  config.device_id = 'synthetic-device';
  await flush();
  const sdk = f.owner.securitySDK!;
  expect(sdk.config).toEqual({
    login: [{ aid: 339757, scene: 'login', certType: 'header' }],
  });
  expect(sdk.webid).toBe('synthetic-device');
  expect(telemetry.setContext).toHaveBeenCalledWith({
    containerType: 'sdk',
    containerVersion: '3.2.5',
  });
  expect(f.realm['$SECURE_VERSION']).toBe('3.3.5');
  expect(f.xhrs).toHaveLength(1);
  expect(f.xhrs[0]!.args[1]).toContain('tcc-v2-data-');
  expect(f.requests).toEqual([]);
  // No inferred provider route: unsolicited ticket headers aren't imported.
  f.setTicket({ ticket: 'synthetic-unmatched', ts_sign: 'synthetic' });
  await f.owner.fetch('/login');
  await f.owner.fetch('/follow');
  expect(f.requests.map(item => item.headers)).toEqual([{}, {}]);
  expect(
    [...f.stored.keys()].some(key => key.includes('s_sdk_sign_data_key'))
  ).toBe(false);
  expect(f.background).not.toHaveBeenCalled();
});

it('allows repeated panel initialization on the same captured SDK, without hp single-init suppression', async () => {
  const f = fixture();
  f.evaluate();
  f.startLogin({ aid: 339757 });
  await flush();
  const sdk = f.owner.securitySDK,
    fetch = f.owner.fetch;
  expect(sdk!.webid).toBe('');
  f.startLogin({ aid: 339757, device_id: 'next-device' });
  await flush();
  expect(f.owner.securitySDK).toBe(sdk);
  expect(f.owner.fetch).toBe(fetch);
  expect(sdk!.config['login']).toHaveLength(2);
  expect(sdk!.webid).toBe('next-device');
  expect(f.xhrs).toHaveLength(1); // Actual TCC cache, not a suppressed second start.
});

it('accepts login policies only from the actual TCC result instead of inventing fixed consumer paths', async () => {
  const f = fixture();
  f.evaluate();
  const policy = {
    aid: 339757,
    scene: 'server-selected',
    consumerPathList: ['/synthetic-policy'],
  };
  f.setTcc({ data: { ztsdk_config: JSON.stringify({ 339757: [policy] }) } });
  f.startLogin({ aid: 339757, device_id: 'synthetic' });
  await flush();
  expect(f.owner.securitySDK!.config['server-selected']).toEqual([policy]);
  expect(f.owner.securitySDK!.config['web_protect']).toBeUndefined();
  expect(f.owner.securitySDK!.config['sso']).toBeUndefined();
});

it('rejects a foreign global before SDK construction and observes detached login startup failures', async () => {
  const f = fixture();
  f.evaluate();
  const foreign = { foreign: true };
  f.realm['securitySDK'] = foreign;
  expect(() => f.sdk()).toThrow('already belongs to another browser owner');
  f.startLogin({ aid: 339757 });
  await flush();
  expect(f.realm['securitySDK']).toBe(foreign);
  expect(f.owner.fetch).toBe(f.nativeFetch);
  expect(f.xhrs).toEqual([]);
  expect(f.background).toHaveBeenCalledTimes(1);
});

it('does not quietly keep using an owner after another script replaces its global', async () => {
  const f = fixture();
  f.evaluate();
  const owned = f.sdk();
  f.realm['securitySDK'] = {};
  expect(() => f.sdk()).toThrow('ownership changed');
  f.startLogin({ aid: 339757 });
  await flush();
  expect(owned.config['login']).toBeUndefined();
  expect(f.xhrs).toEqual([]);
  expect(f.background).toHaveBeenCalledTimes(1);
});

it('reports a configuration getter exception without continuing to WebId or start', async () => {
  const f = fixture();
  f.evaluate();
  f.startLogin({
    get aid(): number {
      throw Error('synthetic config failure');
    },
  });
  await flush();
  expect(f.owner.securitySDK!.config).toEqual({});
  expect(f.owner.securitySDK!.webid).toBeUndefined();
  expect(f.xhrs).toEqual([]);
  expect(f.background).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'synthetic config failure' })
  );
});
