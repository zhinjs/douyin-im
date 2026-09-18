// F87/F88 and real SDK feature codec with entirely synthetic browser/crypto/collector bindings.
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRawCore } = require('./desktop-dtrait-core-raw.cjs');
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const plain = value => JSON.parse(JSON.stringify(value));
async function scenario(sdk, raw, mode) {
  const trace = [],
    timers = [];
  let hooks, rejectCollect, resolveCollect;
  const log = (...v) => {
    if (trace.length > 1000) throw Error('trace limit');
    trace.push(v);
  };
  const crypto = {
    aes: {
      getAesKey() {
        log('key');
        return new Uint8Array(16);
      },
      encryptData: async (key, text) => {
        log('encrypt', key, text);
        return { cipherText: 'cipher', iv: '' };
      },
    },
    rsa: {
      encryptData: async (key, text) => {
        log('rsa', key, text);
        return 'rsa';
      },
    },
    util: {
      uint8ArrayToHex() {
        log('hex');
        return 'hex';
      },
    },
  };
  const featureContext = {
    hash: () => 123,
    btoa,
    getCryptoUtil: () => ({
      bufferConcat: values => new Uint8Array(Buffer.concat(values)),
    }),
  };
  const collect = () => {
    log('collect');
    if (mode === 'pending')
      return new Promise((a, b) => {
        resolveCollect = a;
        rejectCollect = b;
      });
    return Promise.resolve({
      bool: { bool_1: true },
      num: {},
      str: { str_1: 123 },
    });
  };
  const timer = (fn, delay) => {
    log('timer', delay);
    if (mode === 'timer-throw') throw Error('timer');
    timers.push(fn);
  };
  let monitorFailed = false;
  const monitor = {
    sendTeaLog(...v) {
      log('tea', ...v);
    },
    sendSlardarEvent(v) {
      log('event', v);
      if (mode === 'monitor-throw' && !monitorFailed) {
        monitorFailed = true;
        throw Error('monitor');
      }
    },
    sendSlardarLog(v) {
      log('log', v);
    },
  };
  const Date = { now: () => 1000 },
    performance = { now: () => 12 };
  let entry;
  if (raw) {
    const { Core } = createRawCore(process.argv[2], {
      construct: false,
      globals: {
        Promise,
        Date,
        performance,
        atob,
        setTimeout: timer,
        clearTimeout() {
          log('clear');
        },
        window: {
          DTraitUcAesEncrypt: crypto.aes,
          DTraitUcRsaEncrypt: crypto.rsa,
          DTraitUcCryptoJSUtil: crypto.util,
        },
      },
      Transport: class {
        constructor(value) {
          log('hooks');
          hooks = value;
        }
      },
      FeatureProtocol: class extends sdk.DesktopDTraitFeatures {
        constructor(options) {
          super(featureContext, options);
        }
      },
      collect,
      getCollectionErrors: () => [],
      clearCollectionErrors() {},
      params: {},
    });
    entry = Core;
  } else
    entry = sdk.createDesktopDTraitCore({
      Date,
      performance,
      atob,
      crypto,
      featureContext,
      collect,
      setTimeout: timer,
      installHooks(value) {
        log('hooks');
        hooks = value;
      },
    });
  const options = {};
  const values = {
    sourcePromise: Promise.resolve({ fake: true }),
    dTraitPath: mode === 'null-options' ? null : ['/a'],
    urlRewriteRules: [['/a', '/b']],
    getLocalSource: () => {
      throw Error('unused local source');
    },
    dTraitHost: ['host'],
    containerSdkVersion: 'outer',
    monitor: mode === 'no-monitor' ? undefined : monitor,
    delayCollect:
      mode.startsWith('delay') || mode === 'timer-throw'
        ? mode === 'delay-negative'
          ? -1
          : 2
        : 0,
    libraGroup: 'test',
  };
  for (const key of Object.keys(values))
    Object.defineProperty(options, key, {
      enumerable: true,
      get() {
        log('option', key);
        return values[key];
      },
    });
  let result, config;
  try {
    result = entry.getInstance(
      { centralVersion: 'v1', edgeVersion: 'e' },
      options
    );
    await flush();
    if (mode === 'repeat') {
      entry.getInstance({ centralVersion: 'v2' }, options);
      await flush();
    }
    if (mode === 'delay' || mode === 'delay-negative') {
      timers[0]();
      await flush();
    }
    if (mode === 'pending') {
      log('after-pending-return', result);
      resolveCollect({});
      await flush();
    }
    if (mode === 'monitor-throw' || mode === 'timer-throw')
      throw Error('expected earlier failure');
    config = await hooks.processRequestConfig(
      { pathname: '/a/child', headers: {} },
      {}
    );
  } catch (error) {
    result = { error: error.name, message: error.message };
  }
  // Keep reference to reject function to make the pending setup explicit without generating a detached raw rejection.
  void rejectCollect;
  await flush();
  return plain({ trace, result, config });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/protocol.js')).href);
  const modes = [
    'normal',
    'repeat',
    'delay',
    'delay-negative',
    'delay-not-fired',
    'pending',
    'no-monitor',
    'null-options',
    'monitor-throw',
    'timer-throw',
  ];
  for (const mode of modes)
    assert.deepStrictEqual(
      await scenario(sdk, false, mode),
      await scenario(sdk, true, mode),
      mode
    );
  console.log(
    `PASS ${modes.length} entry original VM/SDK traces (synthetic bindings only)`
  );
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
