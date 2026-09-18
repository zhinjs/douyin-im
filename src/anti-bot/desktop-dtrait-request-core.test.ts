import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  webcrypto,
} from 'node:crypto';
import {
  DesktopDTraitAes,
  createDesktopDTraitCryptoUtil,
} from './desktop-dtrait-crypto.js';
import {
  DesktopDTraitFeatures,
  createDesktopDTraitHash,
} from './desktop-dtrait-features.js';
import {
  DesktopDTraitRequestCore,
  type DesktopDTraitRequestCoreContext,
  type DesktopDTraitRequestMeta,
} from './desktop-dtrait-request-core.js';
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
function fixture() {
  let now = 1_000_999;
  const aes = {
    getAesKey: () => new Uint8Array(16),
    encryptData: jest.fn(async (key: string, text: string) => {
      void key;
      void text;
      return {
        cipherText: 'cipher',
        encryptedData: 'unused',
        iv: 'unused',
      };
    }),
  };
  const monitor = {
      sendSlardarEvent: jest.fn(),
      sendTeaLog: jest.fn(),
      sendSlardarLog: jest.fn(),
    },
    background = jest.fn();
  const context: DesktopDTraitRequestCoreContext = {
    Date: { now: () => now },
    performance: { now: () => 3 },
    atob,
    crypto: {
      aes,
      rsa: { encryptData: async () => 'rsa' },
      util: { uint8ArrayToHex: () => 'hex' },
    },
    featureProtocol: {
      addBoolFeature: jest.fn(),
      addNumFeature: jest.fn(),
      addStringFeature: jest.fn(),
      getResult: () => ({ centralString: 'central', edgeString: 'edge' }),
    },
    monitor,
    collect: async () => ({}),
    installHooks() {},
    onBackgroundError: background,
  };
  const core = new DesktopDTraitRequestCore(context, {
    centralVersion: 'c',
    edgeVersion: 'e',
  });
  return {
    core,
    context,
    aes,
    monitor,
    background,
    now(value: number) {
      now = value;
    },
  };
}

it('generates central header with whole-path cascading rewrites and source plaintext fields', async () => {
  const f = fixture();
  await flush();
  f.core.updateUrlRewriteRules([
    null,
    ['/original', '/middle'],
    ['/middle', '/final'],
  ]);
  expect(await f.core.getDTraitHeader({ path: '/original/child' })).toEqual({
    'x-tt-session-dtrait': 'c_rsa_cipher',
  });
  expect(f.aes.encryptData).toHaveBeenCalledWith(
    'hex',
    JSON.stringify({
      dtrait: 'central',
      timestamp: 1000,
      sdkVersion: '1.0.31',
      path: '/final',
    })
  );
  expect(f.aes.encryptData).toHaveBeenCalledWith(
    'hex',
    JSON.stringify({ dtrait: 'edge', timestamp: 1000, path: '/original/child' })
  );
});

it('preserves unused edge Promise string rather than adding an extra outbound header', async () => {
  const f = fixture();
  await flush();
  expect(await f.core.getEdgeData({ path: '/' })).toBe('e__[object Promise]');
  expect(Object.keys((await f.core.getDTraitHeader({ path: '/' }))!)).toEqual([
    'x-tt-session-dtrait',
  ]);
});

it('awaits source readiness, but no extra authenticated-ready state is invented', async () => {
  const f = fixture();
  await flush();
  let finish!: () => void;
  f.core.initPromise = new Promise(resolve => {
    finish = () => resolve(true);
  });
  const result = f.core.getDTraitHeader({ path: '/' });
  await flush();
  expect(f.aes.encryptData).not.toHaveBeenCalled();
  finish();
  await result;
  expect(f.core.collectStatus).toBe(false);
});

it('prefix matching uses host OR path; repeated updates append without deduplication', () => {
  const f = fixture();
  f.core.updateDTraitHost(['good']);
  f.core.updateDTraitPath(['/prefix']);
  f.core.updateDTraitPath(['/prefix']);
  expect(f.core.hookConfig({ pathname: '/none', host: 'good.evil' })).toEqual({
    needProxy: true,
  });
  expect(f.core.hookConfig({ pathname: '/prefix2', host: 'other' })).toEqual({
    needProxy: true,
  });
  expect(f.core.hookConfig({ pathname: '/none' })).toEqual({
    needProxy: false,
  });
  expect(f.core.dTraitHooksPath).toEqual(['/prefix', '/prefix']);
});

it('updates source groups in order, includes inherited enumerable keys, and preserves cache', async () => {
  const f = fixture();
  await flush();
  const calls: string[] = [],
    protocol = f.context.featureProtocol;
  for (const name of [
    'addBoolFeature',
    'addNumFeature',
    'addStringFeature',
  ] as const)
    jest.spyOn(protocol, name).mockImplementation((...args) => {
      calls.push(`${name}:${args[0]}`);
    });
  const bool = Object.assign(Object.create({ inherited: true }), { own: true });
  f.core.dTraitPathCache['old'] = { time: 1, val: null };
  const result = f.core.updateFeature({
    get bool() {
      calls.push('get:bool');
      return bool;
    },
    get num() {
      calls.push('get:num');
      return { n: 1 };
    },
    get str() {
      calls.push('get:str');
      return { s: 2 };
    },
  });
  expect(result).toBeUndefined();
  expect(calls).toEqual([
    'get:bool',
    'get:num',
    'get:str',
    'addBoolFeature:own',
    'addBoolFeature:inherited',
    'addNumFeature:n',
    'addStringFeature:s',
  ]);
  expect(f.core.dTraitPathCache['old']).toEqual({ time: 1, val: null });
  expect(f.core.collectStatus).toBe(false);
});

it('does not await or return the source update encoding promise', async () => {
  const f = fixture();
  await flush();
  f.core.getDTrait = jest.fn(() => new Promise(() => {}));
  expect(f.core.updateFeature({})).toBeUndefined();
  expect(f.core.getDTrait).toHaveBeenCalledTimes(1);
});

it('observes detached getResult rejection but propagates synchronous feature-update errors', async () => {
  const f = fixture();
  await flush();
  jest.spyOn(f.context.featureProtocol, 'getResult').mockImplementation(() => {
    throw Error('encode');
  });
  expect(() => f.core.updateFeature({})).not.toThrow();
  await flush();
  expect(f.background).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'encode' })
  );
  jest
    .spyOn(f.context.featureProtocol, 'addStringFeature')
    .mockImplementation(() => {
      throw Error('add');
    });
  expect(() => f.core.updateFeature({ str: { str_1: null } })).toThrow('add');
});

it('only the first three hook checks emit hook metrics', async () => {
  const f = fixture();
  await flush();
  f.monitor.sendSlardarEvent.mockClear();
  for (let i = 0; i < 5; i++) f.core.hookConfig({ pathname: '/x' });
  expect(f.monitor.sendSlardarEvent).toHaveBeenCalledTimes(3);
});

it.each([0, 1000000])(
  'reports request failure duration for startTime=%d without logging credentials',
  async startTime => {
    const f = fixture();
    await flush();
    f.monitor.sendSlardarEvent.mockClear();
    f.core.errorRequestConfig({
      config: { pathname: '/x', host: 'test.invalid' },
      err: { headers: { cookie: 'secret-cookie' }, token: 'secret-token' },
      instance: { ucProxyParam: { startTime } },
      errType: 'network',
    });
    expect(f.monitor.sendSlardarEvent).toHaveBeenCalledWith({
      name: 'dtrait_request_error',
      metrics: { count: 1, duration: startTime ? 999 : 0 },
      categories: {
        realVersion: '1.0.31',
        pathname: '/x',
        host: 'test.invalid',
        errType: 'network',
      },
    });
    expect(f.monitor.sendSlardarLog).toHaveBeenCalledWith({
      content: '[request error]: [redacted]',
    });
  }
);

it('ignores failure telemetry errors without trying the next log sink', async () => {
  const f = fixture();
  await flush();
  f.monitor.sendSlardarEvent.mockImplementation(() => {
    throw Error('monitor');
  });
  expect(() =>
    f.core.errorRequestConfig({
      config: { pathname: '/x' },
      err: Error('request'),
    })
  ).not.toThrow();
  expect(f.monitor.sendSlardarLog).not.toHaveBeenCalled();
});

it.each([false, true])(
  'only collected=%s writes path cache; host is not part of the cache key',
  async collected => {
    const f = fixture();
    await flush();
    f.core.collectStatus = collected;
    await f.core.processRequestConfig({ pathname: '/x', host: 'one' }, {});
    await f.core.processRequestConfig({ pathname: '/x', host: 'two' }, {});
    expect(f.aes.encryptData).toHaveBeenCalledTimes(collected ? 2 : 4);
  }
);

it.each([599999, 600000])(
  'cache TTL has strict boundary at %d ms',
  async elapsed => {
    const f = fixture();
    await flush();
    f.core.collectStatus = true;
    await f.core.processRequestConfig({ pathname: '/x' }, {});
    f.now(1_000_999 + elapsed);
    await f.core.processRequestConfig({ pathname: '/x' }, {});
    expect(f.aes.encryptData).toHaveBeenCalledTimes(elapsed < 600000 ? 2 : 4);
  }
);

it('merges generated headers over caller fields and preserves existing metadata fields', async () => {
  const f = fixture();
  await flush();
  const meta: DesktopDTraitRequestMeta = { ucProxyParam: { existing: 1 } },
    config = {
      pathname: '/x',
      headers: { keep: 'value', 'x-tt-session-dtrait': 'old' },
    };
  expect(await f.core.processRequestConfig(config, meta)).toBe(config);
  expect(config.headers).toEqual({
    keep: 'value',
    'x-tt-session-dtrait': 'c_rsa_cipher',
  });
  expect(meta.ucProxyParam).toEqual({ existing: 1, startTime: 1_000_999 });
});

it('quiet paths suppress only metrics/metadata, not signing', async () => {
  const f = fixture();
  await flush();
  f.monitor.sendSlardarEvent.mockClear();
  const meta = {};
  const result = await f.core.processRequestConfig(
    { pathname: '/passport/web/get_qrcode/' },
    meta
  );
  expect(result.headers).toHaveProperty('x-tt-session-dtrait');
  expect(meta).toEqual({});
  expect(f.monitor.sendSlardarEvent).not.toHaveBeenCalled();
});

it('finally returns config after generation failure while explicit header generation still rejects', async () => {
  const f = fixture();
  await flush();
  jest.spyOn(f.core, 'getDTraitHeader').mockRejectedValue(Error('generation'));
  const config = { pathname: '/x', headers: { keep: 'value' } };
  await expect(f.core.processRequestConfig(config, {})).resolves.toBe(config);
  await expect(f.core.getDTraitHeader({ path: '/x' })).rejects.toThrow(
    'generation'
  );
  expect(config.headers).toEqual({ keep: 'value' });
});

it('telemetry failure does not discard a generated header in the finally branch', async () => {
  const f = fixture();
  await flush();
  f.monitor.sendSlardarEvent.mockImplementation(() => {
    throw Error('metric');
  });
  expect(
    (await f.core.processRequestConfig({ pathname: '/x' }, {})).headers
  ).toHaveProperty('x-tt-session-dtrait');
});

it('response token is memory-only, falsey token does not clear it, and no outbound token header appears', async () => {
  const f = fixture();
  await flush();
  await f.core.processResponseConfig({
    config: { pathname: '/x' },
    headers: { 'x-tt-session-dtrait-token': 12 },
  });
  expect(f.core.dTraitToken).toBe('12');
  await f.core.processResponseConfig({
    config: { pathname: '/x' },
    headers: { 'x-tt-session-dtrait-token': 0 },
  });
  expect(f.core.dTraitToken).toBe('12');
  expect(await f.core.getDTraitHeader({ path: '/x' })).not.toHaveProperty(
    'x-tt-session-dtrait-token'
  );
});

it('token update precedes telemetry failure, and string response headers are ignored', async () => {
  const f = fixture();
  await flush();
  f.monitor.sendTeaLog.mockImplementation(() => {
    throw Error('metric');
  });
  await expect(
    f.core.processResponseConfig({
      config: { pathname: '/x' },
      headers: { 'x-tt-session-dtrait-token': 'token' },
    })
  ).resolves.toBe(true);
  await f.core.processResponseConfig({
    config: { pathname: '/x' },
    headers: 'x-tt-session-dtrait-token: other',
  });
  expect(f.core.dTraitToken).toBe('token');
});

it('observes the unused edge AES rejection without pretending a ciphertext was produced', async () => {
  const f = fixture();
  await flush();
  f.aes.encryptData.mockRejectedValue(Error('edge'));
  expect(await f.core.getEdgeData({ path: '/' })).toBe('e__[object Promise]');
  await flush();
  expect(f.background).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'edge' })
  );
});

it('real local RSA/AES decrypts the generated central header into source JSON', async () => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const cryptoContext = {
    window: { crypto: webcrypto },
    crypto: webcrypto,
    location: { search: '' },
    Math,
    TextEncoder,
    atob,
    btoa,
    loadCryptoJS: async (): Promise<never> => {
      throw Error('unexpected fallback');
    },
    loadJSEncrypt: async () => ({ default: null }),
  };
  const util = createDesktopDTraitCryptoUtil(cryptoContext);
  const featureProtocol = new DesktopDTraitFeatures(
    {
      hash: createDesktopDTraitHash({
        encoder: new TextEncoder(),
        onDiagnostic() {},
      }),
      getCryptoUtil: () => util,
      btoa,
    },
    {}
  );
  featureProtocol.addBoolFeature('bool_1', true);
  featureProtocol.addStringFeature('str_1', 42);
  const f = fixture(),
    core = new DesktopDTraitRequestCore(
      {
        ...f.context,
        featureProtocol,
        crypto: {
          aes: new DesktopDTraitAes(cryptoContext),
          util,
          rsa: {
            encryptData: async (publicKey, text) =>
              publicEncrypt(
                { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
                Buffer.from(text)
              ).toString('base64'),
          },
        },
      },
      { centralVersion: 'c', centralRsaPub: btoa(keys.publicKey) }
    );
  await flush();
  core.updateFeature({ bool: { bool_2: true }, str: { str_2: 1 } });
  const header = (await core.getDTraitHeader({ path: '/passport/login' }))![
    'x-tt-session-dtrait'
  ]!;
  const [version, wrapped, ciphertext] = header.split('_');
  expect(version).toBe('c');
  const rsaBlock = privateDecrypt(
    { key: keys.privateKey, padding: constants.RSA_NO_PADDING },
    Buffer.from(wrapped!, 'base64')
  );
  expect(rsaBlock.subarray(0, 2)).toEqual(Buffer.from([0, 2]));
  const hexKey = rsaBlock.subarray(rsaBlock.indexOf(0, 2) + 1).toString();
  const body = Buffer.from(ciphertext!, 'base64'),
    decipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from(hexKey, 'hex'),
      body.subarray(0, 16)
    );
  expect(
    JSON.parse(
      Buffer.concat([
        decipher.update(body.subarray(16)),
        decipher.final(),
      ]).toString()
    )
  ).toEqual({
    dtrait: Buffer.from('200000000006200000002a2100000001', 'hex').toString(
      'base64'
    ),
    timestamp: 1000,
    sdkVersion: '1.0.31',
    path: '/passport/login',
  });
});
