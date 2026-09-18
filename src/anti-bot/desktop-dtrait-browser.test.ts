import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  createDesktopDTraitBrowserCollector,
  createDesktopDTraitBrowserCore,
  type DesktopDTraitBrowserRealm,
  type DesktopDTraitBrowserCoreOptions,
} from './desktop-dtrait-browser.js';
import { DesktopDTraitFeatures } from './desktop-dtrait-features.js';
import type {
  DesktopDTraitFeatureValues,
  DesktopDTraitRequestCoreContext,
} from './desktop-dtrait-request-core.js';
import type { DesktopDTraitTransportRealm } from './desktop-dtrait-transport.js';

const require = createRequire(import.meta.url);
const { createFixture } =
  require('../../scripts/research/desktop-dtrait-browser-fixture.cjs') as {
    createFixture(mode?: string): {
      realm: DesktopDTraitBrowserRealm;
      trace: unknown[][];
      settle<T>(promise: Promise<T>): Promise<T>;
      remaining(): [string, string, number][];
      timers: Map<number, unknown>;
    };
  };
const cryptoUtil = {
  bufferConcat: (values: Uint8Array[]) => new Uint8Array(Buffer.concat(values)),
};

it('connects real collectors/core to the default transport, injects the header and processes the synthetic response', async () => {
  const browser = createFixture('missing-capabilities');
  const { createFixture: createTransport } =
    require('../../scripts/research/desktop-dtrait-transport-fixture.cjs') as {
      createFixture(): {
        realm: DesktopDTraitTransportRealm;
        trace: unknown[][];
      };
    };
  const transport = createTransport();
  const bindings = {
    XMLHttpRequest: transport.realm.XMLHttpRequest,
    Request: transport.realm.Request,
    Headers: transport.realm.Headers,
    URL: transport.realm.URL,
    location: transport.realm.window.location,
    fetch: transport.realm.window.fetch!,
  };
  const realm = Object.assign(browser.realm, bindings, {
    window: Object.assign(browser.realm.window, bindings),
  });
  const native = realm.window.fetch;
  const plaintext: string[] = [];
  const monitor = { sendSlardarEvent: jest.fn() };
  const core = createDesktopDTraitBrowserCore(realm, {
    crypto: {
      aes: {
        getAesKey: () => new Uint8Array(16),
        encryptData: async (_key, text) => {
          plaintext.push(text);
          return { cipherText: 'synthetic-cipher', iv: '', encryptedData: '' };
        },
      },
      rsa: { encryptData: async () => 'synthetic-rsa' },
      util: { uint8ArrayToHex: () => 'synthetic-hex' },
    },
    getCryptoUtil: () => cryptoUtil,
  });
  expect(realm.window.fetch).toBe(native);
  core.getInstance(
    { centralVersion: 'v1' },
    { dTraitPath: ['/login'], monitor }
  );
  expect(realm.window.fetch).not.toBe(native);
  const init = { headers: { Existing: 'keep' } };
  await browser.settle(realm.window.fetch!('/login', init));
  expect(init.headers).toEqual({
    Existing: 'keep',
    'x-tt-session-dtrait': 'v1_synthetic-rsa_synthetic-cipher',
  });
  expect(transport.trace.filter(row => row[0] === 'fetch')).toHaveLength(1);
  expect(
    JSON.parse(plaintext.find(text => text.includes('sdkVersion'))!)
  ).toMatchObject({
    path: '/login',
    sdkVersion: '1.0.31',
    dtrait: expect.any(String),
  });
  expect(monitor.sendSlardarEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'dtrait_response',
      categories: expect.objectContaining({ has_dTraitToken: 1 }),
    })
  );
});

it('assembles twelve real plugins without collecting or installing hooks at construction', () => {
  const f = createFixture();
  const registry = createDesktopDTraitBrowserCollector(f.realm);
  expect(f.trace).toEqual([['encoder']]);
  expect(registry.realmState).toEqual({
    hookLogCount: 0,
    collectionCount: 0,
    collectionErrors: [],
  });
  expect(f.remaining()).toEqual([]);
  expect(f.timers.size).toBe(0);
});

it('runs every real plugin, emits 10 bool/33 string fields and keeps original DOM leftovers', async () => {
  const f = createFixture(),
    registry = createDesktopDTraitBrowserCollector(f.realm);
  const result = await f.settle(registry.collector.collect());
  expect(Object.keys(result.bool!)).toHaveLength(10);
  expect(Object.keys(result.str!)).toHaveLength(33);
  expect(result.num).toEqual({});
  expect(f.trace).toContainEqual(['audio-new', 1, 5000, 44100]);
  expect(f.trace).toContainEqual(['rtc']);
  expect(f.trace).toContainEqual(['media-audio']);
  expect(f.trace).toContainEqual(['voice-listener', 'voiceschanged']);
  expect(f.trace.filter(([name]) => name === 'font-check')).toHaveLength(52);
  expect(f.trace.filter(([name]) => name === 'context')).toHaveLength(4);
  expect(f.trace.filter(([name]) => name === 'pixels')).toHaveLength(1);
  // This synthetic realm omits Notification: original str_28 hashes undefined and emits this diagnostic.
  expect(registry.realmState.collectionErrors).toEqual([
    { name: 'murmur3_len' },
  ]);
  expect(f.remaining()).toEqual([
    ['style', '', 0],
    ['div', 'pixel-emoji-container', 0],
  ]);
  expect(f.timers.size).toBe(0);
});

it('shares one hash cache inside the registry, never between account realms', async () => {
  const f = createFixture(),
    g = createFixture();
  const a = createDesktopDTraitBrowserCollector(f.realm),
    b = createDesktopDTraitBrowserCollector(g.realm);
  await f.settle(a.collector.collect());
  const before = f.trace.length;
  a.hash('distinct-test-key');
  const after = f.trace.length;
  a.hash('distinct-test-key');
  expect(after).toBe(before + 1);
  expect(f.trace.length).toBe(after);
  b.hash('distinct-test-key');
  expect(g.trace).toHaveLength(2);
  a.realmState.collectionErrors.push({ name: 'test' });
  expect(b.realmState.collectionErrors).toEqual([]);
});

it('preserves capability absence and puts redacted diagnostics into the shared queue', async () => {
  const f = createFixture('missing-capabilities'),
    registry = createDesktopDTraitBrowserCollector(f.realm);
  const result = await f.settle(registry.collector.collect());
  expect(result.bool?.['bool_9']).toBe(0);
  expect(result.bool?.['bool_10']).toBe(1);
  expect(result.str?.['str_8']).toBe(registry.hash(''));
  expect(registry.realmState.collectionErrors).toEqual(
    expect.arrayContaining([{ name: 'audio' }, { name: 'speech' }])
  );
  expect(
    registry.realmState.collectionErrors.every(
      error => Object.keys(error).join(',') === 'name'
    )
  ).toBe(true);
});

it('reads browser properties lazily, preserving native receivers rather than copied nodes or methods', async () => {
  const f = createFixture();
  let nav = f.realm.navigator,
    reads = 0;
  Object.defineProperty(f.realm, 'navigator', {
    get() {
      reads++;
      return nav;
    },
  });
  const style = f.realm.getComputedStyle;
  f.realm.getComputedStyle = function (node) {
    expect(this).toBe(f.realm);
    return style.call(this, node);
  };
  const registry = createDesktopDTraitBrowserCollector(f.realm);
  expect(reads).toBe(0);
  nav = { ...nav, userAgent: 'changed-after-assembly' };
  const result = await f.settle(registry.collector.collect());
  expect(result.str?.['str_19']).toBe(registry.hash('changed-after-assembly'));
  expect(reads).toBeGreaterThan(0);
});

it('repeated collection reuses modules/cache but reruns browser measurements and source cleanup', async () => {
  const f = createFixture(),
    registry = createDesktopDTraitBrowserCollector(f.realm);
  const a = await f.settle(registry.collector.collect()),
    b = await f.settle(registry.collector.collect());
  expect(b).toEqual(a);
  expect(f.trace.filter(([name]) => name === 'audio-new')).toHaveLength(2);
  expect(f.trace.filter(([name]) => name === 'encoder')).toHaveLength(1);
  expect(f.remaining().filter(([tag]) => tag === 'style')).toHaveLength(2);
});

it.each(['font-load', 'no-rendering', 'style-fail', 'append-fail'])(
  'keeps all source fallback/error boundaries in the complete registry: %s',
  async mode => {
    const f = createFixture(mode),
      registry = createDesktopDTraitBrowserCollector(f.realm);
    const result = await f.settle(registry.collector.collect());
    expect(result.num).toEqual({});
    expect(result.str?.['str_11']).toEqual(expect.any(Number));
    if (mode === 'font-load')
      expect(f.trace.filter(([name]) => name === 'font-load')).toHaveLength(51);
    if (mode === 'style-fail')
      expect(registry.realmState.collectionErrors).toContainEqual({
        name: 'ft',
      });
    if (mode === 'no-rendering') expect(result.str?.['str_3']).toBe('');
    if (mode === 'append-fail') expect(result.bool).toEqual({});
  }
);

it('connects the entire real registry to core startup, feature encoding, signing and diagnostic flushing', async () => {
  const expected = createFixture('missing-capabilities'),
    reference = createDesktopDTraitBrowserCollector(expected.realm);
  const values: DesktopDTraitFeatureValues = await expected.settle(
    reference.collector.collect()
  );
  const feature = new DesktopDTraitFeatures(
    { hash: reference.hash, btoa, getCryptoUtil: () => cryptoUtil },
    {}
  );
  for (const key in values.bool) feature.addBoolFeature(key, values.bool[key]);
  for (const key in values.str) feature.addStringFeature(key, values.str[key]);

  const f = createFixture('missing-capabilities');
  let hooks!: Parameters<DesktopDTraitRequestCoreContext['installHooks']>[0];
  const plaintext: string[] = [],
    monitor = { sendSlardarEvent: jest.fn(), sendSlardarLog: jest.fn() };
  const options = {
    crypto: {
      aes: {
        getAesKey: () => new Uint8Array(16),
        encryptData: async (_key, text) => {
          plaintext.push(text);
          return { cipherText: 'cipher', iv: '', encryptedData: '' };
        },
      },
      rsa: { encryptData: async () => 'rsa' },
      util: { uint8ArrayToHex: () => 'hex' },
    },
    getCryptoUtil: () => cryptoUtil,
    installHooks(value) {
      hooks = value;
    },
  } satisfies DesktopDTraitBrowserCoreOptions;
  const core = createDesktopDTraitBrowserCore(f.realm, options);
  expect(hooks).toBeUndefined();
  expect(f.trace).toEqual([['encoder']]);
  expect(
    core.getInstance(
      { centralVersion: 'v1' },
      { monitor, dTraitPath: ['/login'] }
    )
  ).toBe(true);
  const result = await f.settle(
    hooks.processRequestConfig({ pathname: '/login', headers: {} }, {})
  );
  expect(result.headers).toEqual({ 'x-tt-session-dtrait': 'v1_rsa_cipher' });
  expect(
    JSON.parse(plaintext.find(value => value.includes('sdkVersion'))!)
  ).toMatchObject({
    dtrait: feature.getResult().centralString,
    path: '/login',
    sdkVersion: '1.0.31',
  });
  expect(monitor.sendSlardarLog).toHaveBeenCalledWith({
    content: '[ft err][audio]:[redacted]',
  });
  expect(monitor.sendSlardarEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'feature_collect',
      categories: expect.objectContaining({ total: 43, index: 1, path_len: 1 }),
    })
  );
});

it('runs the complete compiled browser graph without Node shims, eval, or automatic global installation', async () => {
  const { compileBrowserModules } =
    require('../../scripts/build/browser-bundle.cjs') as {
      compileBrowserModules(root: string, entries: string[]): string;
    };
  const script = compileBrowserModules(join(process.cwd(), 'src/anti-bot'), [
    'desktop-dtrait-browser',
  ]);
  const context: { api?: typeof import('./desktop-dtrait-browser.js') } = {};
  runInNewContext(
    script + '\nglobalThis.api=load("desktop-dtrait-browser");',
    context,
    { timeout: 3000, contextCodeGeneration: { strings: false, wasm: false } }
  );
  expect(Object.keys(context)).not.toContain('DTraitSDK');
  const f = createFixture();
  const registry = context.api!.createDesktopDTraitBrowserCollector(f.realm);
  const result = await f.settle(registry.collector.collect());
  expect(Object.keys(result.str!)).toHaveLength(33);
  expect(Object.keys(result.bool!)).toHaveLength(10);
});
