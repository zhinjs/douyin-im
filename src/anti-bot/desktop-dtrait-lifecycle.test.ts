import {
  DesktopDTraitRequestCore,
  createDesktopDTraitCore,
  type DesktopDTraitCoreRealmState,
  type DesktopDTraitRequestCoreContext,
} from './desktop-dtrait-request-core.js';
import { DesktopDTraitCollector } from './desktop-dtrait-collector.js';
import { createDesktopDTraitMathCollector } from './desktop-dtrait-math.js';
import {
  DesktopDTraitFeatures,
  createDesktopDTraitHash,
} from './desktop-dtrait-features.js';

const featureContext = {
  hash: () => 123,
  btoa,
  getCryptoUtil: () => ({
    bufferConcat: (values: Uint8Array[]) =>
      new Uint8Array(Buffer.concat(values)),
  }),
};

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<DesktopDTraitRequestCoreContext> = {}) {
  const monitor = {
    sendSlardarEvent: jest.fn(),
    sendSlardarLog: jest.fn(),
    sendTeaLog: jest.fn(),
  };
  const collect = jest.fn(async () => ({
    bool: { bool_1: true },
    str: { str_1: 12 },
  }));
  const background = jest.fn();
  const feature = {
    addBoolFeature: jest.fn(),
    addNumFeature: jest.fn(),
    addStringFeature: jest.fn(),
    getResult: jest.fn(() => ({ centralString: 'C', edgeString: 'E' })),
  };
  const context: DesktopDTraitRequestCoreContext = {
    Date: { now: () => 1000 },
    performance: { now: () => 12 },
    atob,
    crypto: {
      aes: {
        getAesKey: () => new Uint8Array(16),
        encryptData: async () => ({
          cipherText: 'cipher',
          iv: '',
          encryptedData: '',
        }),
      },
      rsa: { encryptData: async () => 'rsa' },
      util: { uint8ArrayToHex: () => 'hex' },
    },
    featureProtocol: feature,
    collect,
    installHooks() {},
    onBackgroundError: background,
    ...overrides,
  };
  const core = new DesktopDTraitRequestCore(context, {});
  return { core, context, monitor, collect, feature, background };
}

it('keeps initial false and does not collect until setSource; completion retains the source cache', async () => {
  const f = fixture();
  await flush();
  await expect(f.core.initPromise).resolves.toBe(false);
  expect(f.collect).not.toHaveBeenCalled();
  f.core.dTraitPathCache['old'] = { time: 1, val: null };
  expect(f.core.setSource()).toBeUndefined();
  await expect(f.core.initPromise).resolves.toBe(true);
  expect(f.core.collectStatus).toBe(true);
  expect(f.feature.addBoolFeature).toHaveBeenCalledWith('bool_1', true);
  expect(f.core.dTraitPathCache['old']).toEqual({ time: 1, val: null });
});

it('waits for the currently installed collection Promise before signing', async () => {
  const pending = deferred<Record<string, never>>(),
    f = fixture({ collect: () => pending.promise });
  await flush();
  f.core.setSource();
  let done = false;
  const header = f.core.getDTraitHeader({ path: '/login' }).then(value => {
    done = true;
    return value;
  });
  await flush();
  expect(done).toBe(false);
  pending.resolve({});
  await header;
  expect(done).toBe(true);
});

it('preserves a true collectStatus after a later failure and observes but does not swallow rejection', async () => {
  const f = fixture();
  await flush();
  f.core.setSource();
  await f.core.initPromise;
  const error = Error('collector');
  f.collect.mockRejectedValue(error);
  f.core.setSource();
  await expect(f.core.initPromise).rejects.toBe(error);
  await flush();
  expect(f.core.collectStatus).toBe(true);
  expect(f.background).toHaveBeenCalledWith(error);
});

it('reentrant calls retain both attempts, with the last Promise installed and shared completion index', async () => {
  const first = deferred<Record<string, never>>(),
    second = deferred<Record<string, never>>();
  let calls = 0;
  const f = fixture({
    collect: () => (calls++ === 0 ? first.promise : second.promise),
  });
  await flush();
  f.core.updateMonitor(f.monitor);
  f.monitor.sendSlardarEvent.mockClear();
  f.core.setSource();
  const a = f.core.initPromise;
  f.core.setSource();
  const b = f.core.initPromise;
  expect(a).not.toBe(b);
  second.resolve({});
  await b;
  first.resolve({});
  await a;
  expect(f.core.initPromise).toBe(b);
  expect(
    f.monitor.sendSlardarEvent.mock.calls.map(
      ([value]) => value.categories.index
    )
  ).toEqual([2, 2]);
});

it('shares counters/errors only when cores are explicitly placed in the same account realm', async () => {
  const realmState: DesktopDTraitCoreRealmState = {
    hookLogCount: 0,
    collectionCount: 0,
    collectionErrors: [],
  };
  const a = fixture({ realmState }),
    b = fixture({ realmState }),
    other = fixture();
  await flush();
  a.core.recordCollectionError('test-code');
  a.core.setSource();
  await a.core.initPromise;
  b.core.setSource();
  await b.core.initPromise;
  other.core.setSource();
  await other.core.initPromise;
  b.core.updateMonitor(b.monitor);
  other.core.updateMonitor(other.monitor);
  expect(realmState.collectionCount).toBe(2);
  expect(
    b.monitor.sendSlardarEvent.mock.calls.find(
      ([v]) => v.name === 'feature_collect'
    )?.[0].categories.index
  ).toBe(2);
  expect(
    other.monitor.sendSlardarEvent.mock.calls.find(
      ([v]) => v.name === 'feature_collect'
    )?.[0].categories.index
  ).toBe(1);
  expect(other.monitor.sendSlardarLog).not.toHaveBeenCalled();
});

it('uses num/bool/str for statistics, then bool/num/str for updating and inherited keys only in updates', async () => {
  const order: string[] = [];
  const source = {
    get num() {
      order.push('num');
      return {};
    },
    get bool() {
      order.push('bool');
      return Object.assign(Object.create({ inherited: true }), {
        bool_1: true,
      });
    },
    get str() {
      order.push('str');
      return {};
    },
  };
  const f = fixture({ collect: async () => source });
  await flush();
  f.core.updateMonitor(f.monitor);
  f.core.setSource();
  await f.core.initPromise;
  expect(order).toEqual(['num', 'bool', 'str', 'bool', 'num', 'str']);
  expect(f.feature.addBoolFeature.mock.calls).toEqual([
    ['bool_1', true],
    ['inherited', true],
  ]);
  expect(f.monitor.sendSlardarEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'feature_collect',
      categories: expect.objectContaining({
        total: 1,
        bool_total: 1,
        result: 1,
      }),
    })
  );
});

it('returns the original malformed source from statistics but rejects setSource on null', async () => {
  const f = fixture({ collect: async () => null! });
  await flush();
  await expect(f.core.getOnlineSourceWithLog()).resolves.toBeNull();
  f.core.setSource();
  await expect(f.core.initPromise).rejects.toThrow(TypeError);
  expect(f.core.collectStatus).toBe(false);
});

it('does not wait for detached encoding, and scheduled refresh does not recollect', async () => {
  const f = fixture();
  await flush();
  f.core.getDTrait = () => new Promise(() => {});
  f.core.setSource();
  await expect(f.core.initPromise).resolves.toBe(true);
  expect(f.core.updateFeatureScheduled()).toBeUndefined();
  await flush();
  expect(f.collect).toHaveBeenCalledTimes(1);
});

it('initial RSA completion reads the then-current initPromise rather than its initial false Promise', async () => {
  const rsa = deferred<string>(),
    collect = deferred<Record<string, never>>();
  const f = fixture({
    crypto: { rsa: { encryptData: () => rsa.promise } },
    collect: () => collect.promise,
  });
  f.core.setSource();
  rsa.resolve('rsa');
  await flush();
  expect(f.feature.getResult).not.toHaveBeenCalled();
  collect.resolve({});
  await f.core.initPromise;
  await flush();
  expect(f.feature.getResult).toHaveBeenCalledTimes(2);
});

it('queues startup telemetry and repeats historical replay without recording later live events', async () => {
  const f = fixture();
  await flush();
  f.core.sendTeaLog('early', {});
  f.core.sendSlardarLog({ content: 'early' });
  f.core.updateMonitor(f.monitor);
  expect(f.monitor.sendSlardarEvent.mock.calls.map(([v]) => v.name)).toEqual([
    'dtrait_monkey_patch_request',
    'dtrait_online_init',
  ]);
  f.core.sendSlardarEvent({
    name: 'live',
    categories: { realVersion: 'override' },
  });
  f.core.updateMonitor(f.monitor);
  expect(f.monitor.sendSlardarEvent.mock.calls.map(([v]) => v.name)).toEqual([
    'dtrait_monkey_patch_request',
    'dtrait_online_init',
    'live',
    'dtrait_monkey_patch_request',
    'dtrait_online_init',
  ]);
  expect(f.monitor.sendTeaLog).toHaveBeenCalledTimes(2);
  expect(f.monitor.sendSlardarLog).toHaveBeenCalledTimes(2);
  expect(
    f.monitor.sendSlardarEvent.mock.calls[2]?.[0].categories.realVersion
  ).toBe('override');
});

it('keeps sink return/receiver semantics and does not erase callbacks on partial updates', async () => {
  const f = fixture();
  await flush();
  const receivers: unknown[] = [];
  const monitor = {
    sendTeaLog() {
      receivers.push(this);
      return 1;
    },
    sendSlardarEvent() {
      receivers.push(this);
      return 2;
    },
    sendSlardarLog() {
      receivers.push(this);
      return 3;
    },
  };
  f.core.updateMonitor(monitor);
  receivers.length = 0;
  f.core.updateMonitor({});
  expect(f.core.sendTeaLog('x', {})).toBe(1);
  expect(f.core.sendSlardarEvent({})).toBeUndefined();
  expect(f.core.sendSlardarLog({ content: 'x' })).toBe(3);
  expect(receivers).toEqual([f.core, monitor, f.core]);
});

it('monitor replay errors propagate without rolling back installed earlier callbacks', async () => {
  const f = fixture();
  await flush();
  f.core.sendTeaLog('early', {});
  f.monitor.sendSlardarEvent.mockImplementation(() => {
    throw Error('sink');
  });
  expect(() => f.core.updateMonitor(f.monitor)).toThrow('sink');
  f.core.sendTeaLog('live', {});
  expect(f.monitor.sendTeaLog).toHaveBeenCalledTimes(2);
  expect(f.monitor.sendSlardarLog).not.toHaveBeenCalled();
});

it('failed error reporting preserves the whole queue; successful retry replaces its array', async () => {
  const realmState: DesktopDTraitCoreRealmState = {
    hookLogCount: 0,
    collectionCount: 0,
    collectionErrors: [],
  };
  const f = fixture({ realmState });
  await flush();
  f.core.updateMonitor(f.monitor);
  f.core.recordCollectionError('audio');
  const queued = realmState.collectionErrors;
  f.monitor.sendSlardarLog.mockImplementationOnce(() => {
    throw Error('sink');
  });
  f.core.setSource();
  await f.core.initPromise;
  expect(realmState.collectionErrors).toBe(queued);
  f.core.setSource();
  await f.core.initPromise;
  expect(realmState.collectionErrors).not.toBe(queued);
  expect(realmState.collectionErrors).toEqual([]);
  expect(queued).toEqual([{ name: 'audio' }]);
  expect(f.monitor.sendSlardarLog.mock.calls).toEqual([
    [{ content: '[ft err][audio]:[redacted]' }],
    [{ content: '[ft err][audio]:[redacted]' }],
  ]);
});

it('retains the unused local-source API without merging it into online collection', async () => {
  const f = fixture();
  const local = jest.fn(async () => ({}));
  f.core.updateGetLocalSource(local);
  f.core.setSource();
  await f.core.initPromise;
  expect(local).not.toHaveBeenCalled();
  expect(f.core.getLocalSource).toBe(local);
  const config = f.core.getHooksConfig();
  expect(config.dTraitHooksPath).toBe(f.core.dTraitHooksPath);
});

it('connects the actual scheduler, Math plugin and feature encoder to source updates and central request encryption', async () => {
  const hash = createDesktopDTraitHash({
    encoder: new TextEncoder(),
    onDiagnostic() {},
  });
  const featureProtocol = new DesktopDTraitFeatures(
    {
      hash,
      btoa,
      getCryptoUtil: () => ({
        bufferConcat: values => new Uint8Array(Buffer.concat(values)),
      }),
    },
    {}
  );
  // Other plugins here are explicitly synthetic, not a production browser registry.
  const empty = () => ({});
  const collector = new DesktopDTraitCollector(
    { Date, setTimeout },
    {
      boolFeature: () => ({ bool_1: true }),
      strFeature: () => ({ str_1: 123 }),
      canvas: empty,
      audio: empty,
      css: empty,
      domRect: empty,
      mediaTypes: empty,
      speech: empty,
      svgRect: empty,
      webGL: empty,
      fonts: empty,
      math: createDesktopDTraitMathCollector({ Math, hash }),
    }
  );
  const f = fixture({ featureProtocol, collect: () => collector.collect() });
  await flush();
  f.core.setSource();
  await f.core.initPromise;
  expect(f.core.centralDTrait).toBe(featureProtocol.getResult().centralString);
  expect(f.core.centralDTrait.length).toBeGreaterThan(10);
  const encrypt = jest.spyOn(f.core, 'aesEncrypt');
  await f.core.getDTraitHeader({ path: '/login' });
  expect(JSON.parse(encrypt.mock.calls[0]![1])).toMatchObject({
    dtrait: f.core.centralDTrait,
    path: '/login',
    sdkVersion: '1.0.31',
  });
});

it('entry returns literal true immediately, ignores external sourcePromise and only creates/collects once', async () => {
  const f = fixture();
  await flush();
  const installHooks = jest.fn();
  const entry = createDesktopDTraitCore({
    ...f.context,
    featureContext,
    installHooks,
    setTimeout,
  });
  const local = jest.fn();
  const options = {
    sourcePromise: new Promise(() => {}),
    getLocalSource: local,
    dTraitPath: ['/a'],
    monitor: f.monitor,
  };
  expect(entry.getInstance({ centralVersion: 'v1' }, options)).toBe(true);
  expect(installHooks).toHaveBeenCalledTimes(1);
  expect(f.collect).toHaveBeenCalledTimes(1);
  await flush();
  expect(entry.getInstance({ centralVersion: 'v2' }, options)).toBe(true);
  await flush();
  expect(installHooks).toHaveBeenCalledTimes(1);
  expect(f.collect).toHaveBeenCalledTimes(1);
  expect(local).not.toHaveBeenCalled();
  const hooks = installHooks.mock.calls[0]![0];
  const config = await hooks.processRequestConfig(
    { pathname: '/a/child', headers: {} },
    {}
  );
  expect(config.headers['x-tt-session-dtrait']).toBe('v1_rsa_cipher');
  expect(
    f.monitor.sendSlardarEvent.mock.calls.find(
      ([v]) => v.name === 'feature_collect'
    )?.[0].categories.path_len
  ).toBe(1);
});

it('entry delay converts seconds once, does not block initial requests, and does not reschedule later calls', async () => {
  const f = fixture();
  await flush();
  const installHooks = jest.fn(),
    timer = jest.fn();
  const entry = createDesktopDTraitCore({
    ...f.context,
    featureContext,
    installHooks,
    setTimeout: timer,
  });
  expect(entry.getInstance({}, { delayCollect: 2 })).toBe(true);
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 2000);
  expect(f.collect).not.toHaveBeenCalled();
  await flush();
  await expect(
    installHooks.mock.calls[0]![0].processRequestConfig(
      { pathname: '/login', headers: {} },
      {}
    )
  ).resolves.toEqual(
    expect.objectContaining({
      headers: expect.objectContaining({
        'x-tt-session-dtrait': expect.any(String),
      }),
    })
  );
  entry.getInstance({}, { delayCollect: 5 });
  expect(timer).toHaveBeenCalledTimes(1);
  timer.mock.calls[0]![0]();
  await flush();
  expect(f.collect).toHaveBeenCalledTimes(1);
});

it('entry does not recreate an installed singleton after a timer installation failure', async () => {
  const f = fixture();
  await flush();
  const hooks = jest.fn(),
    timer = jest.fn(() => {
      throw Error('timer');
    });
  const entry = createDesktopDTraitCore({
    ...f.context,
    featureContext,
    installHooks: hooks,
    setTimeout: timer,
  });
  expect(() => entry.getInstance({}, { delayCollect: 1 })).toThrow('timer');
  expect(entry.getInstance({}, {})).toBe(true);
  expect(hooks).toHaveBeenCalledTimes(1);
  expect(f.collect).not.toHaveBeenCalled();
});

it('separate entry factories own separate singletons and realm state', async () => {
  const f = fixture();
  await flush();
  const hooks = jest.fn();
  const context = {
    ...f.context,
    featureContext,
    installHooks: hooks,
    setTimeout,
  };
  const a = createDesktopDTraitCore(context),
    b = createDesktopDTraitCore(context);
  a.getInstance({}, { monitor: f.monitor });
  b.getInstance({}, { monitor: f.monitor });
  await flush();
  expect(hooks).toHaveBeenCalledTimes(2);
  expect(f.collect).toHaveBeenCalledTimes(2);
  expect(
    f.monitor.sendSlardarEvent.mock.calls
      .filter(([v]) => v.name === 'feature_collect')
      .map(([v]) => v.categories.index)
  ).toEqual([1, 1]);
});

it('entry reads source options in original order even when they are not used', async () => {
  const f = fixture();
  await flush();
  const keys: string[] = [];
  const entry = createDesktopDTraitCore({
    ...f.context,
    featureContext,
    setTimeout,
  });
  const options = Object.fromEntries([]);
  for (const key of [
    'sourcePromise',
    'dTraitPath',
    'urlRewriteRules',
    'getLocalSource',
    'dTraitHost',
    'containerSdkVersion',
    'monitor',
    'delayCollect',
    'libraGroup',
  ])
    Object.defineProperty(options, key, {
      get() {
        keys.push(key);
        return undefined;
      },
    });
  entry.getInstance({}, options);
  expect(keys).toEqual([
    'sourcePromise',
    'dTraitPath',
    'urlRewriteRules',
    'getLocalSource',
    'dTraitHost',
    'containerSdkVersion',
    'monitor',
    'delayCollect',
    'libraGroup',
  ]);
  keys.length = 0;
  entry.getInstance({}, options);
  expect(keys).toEqual([
    'sourcePromise',
    'dTraitPath',
    'urlRewriteRules',
    'getLocalSource',
    'dTraitHost',
    'containerSdkVersion',
    'monitor',
    'delayCollect',
  ]);
});
