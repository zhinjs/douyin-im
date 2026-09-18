// Pinned original VM vs SDK lifecycle; only synthetic collector, transport, keys, timers and monitor.
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRawCore } = require('./desktop-dtrait-core-raw.cjs');
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
const plain = value =>
  JSON.parse(
    JSON.stringify(value, (_key, v) =>
      v instanceof Error ? { error: v.name } : v
    )
  );
async function scenario(sdk, mode) {
  const trace = [];
  const log = (...value) => {
    if (trace.length > 1000) throw Error('trace limit');
    trace.push(value);
  };
  let active = false,
    now = 1000,
    featureCalls = 0,
    collectionCalls = 0,
    failure = '',
    errors = [];
  const pending = [];
  const source =
    mode === 'null-source'
      ? null
      : mode === 'undefined-source'
        ? undefined
        : mode === 'empty'
          ? {}
          : {
              get num() {
                if (active) log('get', 'num');
                if (failure === 'getter') throw Error('getter');
                return mode === 'null-group' ? null : { n: 1 };
              },
              get bool() {
                if (active) log('get', 'bool');
                return Object.assign(Object.create({ inherited: true }), {
                  b: true,
                });
              },
              get str() {
                if (active) log('get', 'str');
                return { s: 123 };
              },
            };
  const collect = () => {
    ++collectionCalls;
    log('collect', collectionCalls);
    if (failure === 'collector') return Promise.reject(Error('collector'));
    if (mode === 'concurrent' || mode === 'pending')
      return new Promise(resolve => pending.push(resolve));
    return Promise.resolve(source);
  };
  const feature = {
    addBoolFeature(key, value) {
      log('bool', key, value);
      if (failure === 'update') throw Error('update');
    },
    addNumFeature(key, value) {
      log('num', key, value);
    },
    addStringFeature(key, value) {
      log('str', key, value);
    },
    getResult() {
      if (active) {
        featureCalls++;
        log('encode', featureCalls);
      }
      return { centralString: 'C', edgeString: 'E' };
    },
  };
  let core;
  const monitor = {
    sendTeaLog(...args) {
      log('tea', ...args, this === core ? 'core' : 'sink');
      return 'tea-return';
    },
    sendSlardarLog(value) {
      log(
        'log',
        { content: value.content.replace(/\]:.*/, ']:[redacted]') },
        this === core ? 'core' : 'sink'
      );
      if (failure === 'log') throw Error('log');
      return 'log-return';
    },
    sendSlardarEvent(value) {
      log('event', value, this === monitor ? 'sink' : 'other');
      if (failure === 'event') throw Error('event');
      return 'event-return';
    },
  };
  const clock = {
      now() {
        if (active) log('date');
        return now++;
      },
    },
    performance = {
      now() {
        if (active) log('performance');
        return 12;
      },
    };
  const crypto = {
    aes: {
      getAesKey: () => new Uint8Array(16),
      encryptData: async () => ({ cipherText: 'cipher', iv: '' }),
    },
    rsa: { encryptData: async () => 'rsa' },
    util: { uint8ArrayToHex: () => 'hex' },
  };
  if (sdk) {
    core = new sdk.DesktopDTraitRequestCore(
      {
        Date: clock,
        performance,
        atob,
        crypto,
        featureProtocol: feature,
        collect,
        installHooks() {},
      },
      {}
    );
  } else {
    ({ core } = createRawCore(process.argv[2], {
      globals: {
        Promise,
        Date: clock,
        performance,
        atob,
        window: {
          DTraitUcAesEncrypt: crypto.aes,
          DTraitUcRsaEncrypt: crypto.rsa,
          DTraitUcCryptoJSUtil: crypto.util,
        },
        clearTimeout() {
          log('clear');
        },
      },
      Transport: class {},
      FeatureProtocol: class {
        constructor() {
          Object.assign(this, feature);
        }
      },
      collect,
      getCollectionErrors: () => errors,
      clearCollectionErrors: () => {
        errors = [];
      },
      params: {},
    }));
  }
  await flush();
  if (!mode.startsWith('monitor')) core.updateMonitor(monitor);
  trace.length = 0;
  active = true;
  if (mode === 'getter') failure = 'getter';
  if (mode === 'collector-fail') failure = 'collector';
  if (mode === 'update-fail') failure = 'update';
  if (mode === 'stat-fail') failure = 'event';
  if (mode === 'queue-fail') failure = 'log';
  const addError = name =>
    sdk
      ? core.recordCollectionError(name)
      : errors.push({ name, err: 'synthetic secret' });
  let result;
  try {
    if (mode.startsWith('monitor')) {
      core.sendTeaLog('early', { a: 1 });
      core.sendSlardarEvent({
        name: 'early',
        categories: { realVersion: 'override' },
      });
      core.sendSlardarLog({ content: 'early' });
      if (mode === 'monitor-throw') failure = 'event';
      core.updateMonitor(monitor);
      result = [
        core.sendTeaLog('live', {}),
        core.sendSlardarEvent({ name: 'live' }),
        core.sendSlardarLog({ content: 'live' }),
      ];
      if (mode === 'monitor-repeat') core.updateMonitor(monitor);
      if (mode === 'monitor-partial') core.updateMonitor({});
    } else if (mode === 'scheduled') {
      result = core.updateFeatureScheduled();
    } else if (mode === 'local') {
      core.updateGetLocalSource(() => {
        log('local');
        return Promise.resolve({});
      });
      core.setSource();
      await core.initPromise;
      result = core.getHooksConfig();
    } else {
      addError('one');
      addError('two');
      core.dTraitPathCache.old = { time: 1, val: null };
      if (mode === 'encoding-pending')
        core.getDTrait = () => {
          log('encode-pending');
          return new Promise(() => {});
        };
      if (mode === 'direct') {
        const value = await core.getOnlineSourceWithLog();
        result = { same: value === source };
      } else {
        const returned = core.setSource();
        const first = core.initPromise;
        first.catch(() => {});
        if (mode === 'pending') {
          await flush();
          result = { returned, status: core.collectStatus };
        } else if (mode === 'concurrent') {
          core.setSource();
          const second = core.initPromise;
          second.catch(() => {});
          pending[1](source);
          await second;
          pending[0](source);
          await first;
          result = {
            different: first !== second,
            latest: core.initPromise === second,
          };
        } else {
          try {
            result = { returned, value: await first };
          } catch (error) {
            result = {
              error: error.name,
              message: ['null-source', 'undefined-source'].includes(mode)
                ? undefined
                : error.message,
            };
          }
          if (mode === 'repeat-fail') {
            failure = 'collector';
            core.setSource();
            try {
              await core.initPromise;
            } catch {
              result.secondFailed = true;
            }
          }
          if (mode === 'stat-fail' || mode === 'queue-fail') {
            failure = '';
            core.setSource();
            await core.initPromise;
          }
        }
      }
    }
  } catch (error) {
    result = { error: error.name, message: error.message };
  }
  await flush();
  return plain({
    result,
    trace,
    collectionCalls,
    status: core.collectStatus,
    central: core.centralDTrait,
    cache: core.dTraitPathCache,
  });
}
async function main() {
  const sdk = await import(
    pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-request-core.js')).href
  );
  const modes = [
    'normal',
    'empty',
    'null-source',
    'undefined-source',
    'null-group',
    'getter',
    'collector-fail',
    'update-fail',
    'stat-fail',
    'queue-fail',
    'encoding-pending',
    'repeat-fail',
    'pending',
    'concurrent',
    'direct',
    'scheduled',
    'local',
    'monitor',
    'monitor-repeat',
    'monitor-partial',
    'monitor-throw',
  ];
  for (const mode of modes) {
    const local = await scenario(sdk, mode),
      raw = await scenario(null, mode);
    assert.deepStrictEqual(local, raw, mode);
  }
  console.log(
    `PASS ${modes.length} lifecycle original VM/SDK traces (synthetic bindings only)`
  );
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
