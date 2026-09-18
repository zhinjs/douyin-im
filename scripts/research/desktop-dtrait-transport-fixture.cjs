'use strict';

// Synthetic browser boundary only. Shared by the raw-source oracle and SDK tests.
function createFixture(mode = 'normal') {
  const trace = [];
  const record = (...args) => {
    if (trace.length >= 200) throw Error('trace limit');
    trace.push(args);
  };
  class Headers {
    constructor() {
      this.values = {};
    }
    set(key, value) {
      this.values[key] = value;
      record('header-set', key, value);
    }
  }
  class Request {
    constructor() {
      this.url = '/path?x=1&x=2';
      this.method = 'POST';
      this.headers = new Headers();
    }
  }
  class XHR {
    constructor() {
      this.readyState = 0;
      this.status = 204;
      this.listeners = {};
    }
    open(...args) {
      record('open', ...args);
      return 'opened';
    }
    send(...args) {
      record('send', ...args);
      return 'sent';
    }
    setRequestHeader(...args) {
      record('xhr-header', ...args);
    }
    addEventListener(type, listener) {
      record('listen', type);
      this.listeners[type] = listener;
    }
    getAllResponseHeaders() {
      return 'X-Test: one\nX-Test: two\nX-TT-Session-DTrait-Token: ticket';
    }
  }
  let headerReads = 0;
  const response = { status: 201 };
  Object.defineProperty(response, 'headers', {
    get() {
      headerReads++;
      if (mode === 'no-headers') return undefined;
      if (mode === 'empty-headers') return {};
      if (mode === 'get-headers')
        return {
          get(key) {
            record('get', key);
            return key === 'x-tt-session-dtrait-token' ? 'ticket' : null;
          },
        };
      return {
        forEach(fn) {
          fn('ticket', 'x-tt-session-dtrait-token');
        },
      };
    },
  });
  const realm = {
    XMLHttpRequest: XHR,
    Request,
    Headers,
    URL,
    Date: { now: () => 1234 },
    location: { href: 'https://example.invalid/base' },
    fetch(input, init) {
      record(
        'fetch',
        this === realm ? 'realm' : 'custom',
        input instanceof Request ? 'Request' : input,
        init?.method,
        init?.headers
      );
      if (mode === 'native-sync') throw Error('native sync');
      if (mode === 'native-reject')
        return Promise.reject(Error('native reject'));
      return Promise.resolve(response);
    },
    console: {
      log() {
        record('diagnostic');
      },
    },
  };
  realm.window = realm;
  const snapshotConfig = c => ({
    pathname: c.pathname,
    host: c.host,
    method: c.method,
    query: c.query,
    fullUrl: c.fullUrl,
  });
  function callbacks(flags) {
    return {
      hookConfig(config) {
        record('hook', snapshotConfig(config));
        return flags;
      },
      processRequestConfig(config, meta) {
        record('request', snapshotConfig(config), meta.ucProxyParam);
        if (mode === 'prepare-sync') throw Error('prepare sync');
        if (mode === 'prepare-reject')
          return Promise.reject(Error('prepare reject'));
        return Promise.resolve({
          headers: { Signed: 'yes' },
          extras: { test: 1 },
        });
      },
      processResponseConfig(value, meta) {
        record(
          'response',
          snapshotConfig(value.config),
          value.headers,
          value.reqHeaders,
          value.extras,
          value.httpCode,
          meta.ucProxyParam
        );
        if (mode === 'response-reject')
          return Promise.reject(Error('response reject'));
        return Promise.resolve(true);
      },
      errorRequestConfig(value) {
        record('error', value.errType, value.err?.message || value.err);
      },
    };
  }
  return {
    realm,
    trace,
    record,
    callbacks,
    XHR,
    Request,
    Headers,
    response,
    headerReads: () => headerReads,
  };
}

async function runScenario(install, scenario) {
  const {
    mode = 'normal',
    flags = { needProxy: true },
    kind = 'fetch',
  } = scenario;
  const fixture = createFixture(mode);
  const { realm, record, XHR, Request, Headers } = fixture;
  const apply = install(realm, {
    onBackgroundError: e => record('background', e.message),
    onDiagnostic: () => record('diagnostic'),
  });
  apply(fixture.callbacks(flags));
  if (scenario.twice) apply(fixture.callbacks(flags));
  try {
    if (kind === 'xhr') {
      const xhr = new XHR();
      const eventKey = scenario.loadend ? 'onloadend' : 'onreadystatechange';
      xhr[eventKey] = function (...args) {
        record('user-callback', this === xhr, ...args);
        return 'user-return';
      };
      const open = ['POST', '/path?x=1&x=2'];
      if ('async' in scenario) open.push(scenario.async);
      record('open-return', xhr.open(...open));
      record('send-return', xhr.send('body'));
      for (let i = 0; i < 12; i++) await Promise.resolve();
      xhr.readyState = scenario.incomplete ? 2 : 4;
      const task = xhr[eventKey].call({}, 'event');
      record('after-callback-call');
      record('callback-return', await task);
      for (const name of Object.keys(xhr.listeners)) xhr.listeners[name](name);
    } else {
      let methodReads = 0;
      const init = { headers: { Old: 'keep' } };
      Object.defineProperty(init, 'method', {
        enumerable: true,
        get() {
          methodReads++;
          return 'DELETE';
        },
      });
      if (scenario.headers === 'array') init.headers = [['Signed', 'old']];
      if (scenario.headers === 'Headers') init.headers = new Headers();
      if (scenario.headers === 'frozen') init.headers = Object.freeze({});
      if (scenario.headers === 'primitive') init.headers = 42;
      const input = scenario.request
        ? new Request()
        : scenario.url || '/path?x=1&x=2';
      const result = await realm.fetch.call(
        scenario.customThis ? {} : realm,
        input,
        init
      );
      record(
        'fetch-return',
        result === fixture.response,
        fixture.headerReads(),
        methodReads
      );
      if (scenario.request) record('request-headers', input.headers.values);
    }
  } catch (error) {
    record('caught', error.message);
  }
  // Snapshot plain values, intentionally excluding synthetic native object identity.
  return JSON.parse(JSON.stringify(fixture.trace));
}

const scenarios = [
  { kind: 'xhr' },
  { kind: 'xhr', loadend: true },
  { kind: 'xhr', incomplete: true },
  { kind: 'xhr', async: false },
  { kind: 'xhr', async: undefined },
  { kind: 'xhr', flags: {} },
  { kind: 'xhr', flags: { onlyProxyReq: true } },
  { kind: 'xhr', flags: { needProxy: true, onlyProxyResp: true } },
  { kind: 'xhr', mode: 'response-reject' },
  { kind: 'xhr', twice: true },
  {},
  { flags: {} },
  { flags: { onlyProxyResp: true } },
  { flags: { onlyProxyReq: true } },
  { flags: { needProxy: true, onlyProxyResp: true } },
  { request: true },
  { headers: 'array' },
  { headers: 'Headers' },
  { headers: 'frozen' },
  { headers: 'primitive' },
  { customThis: true },
  { url: 'http://[' },
  { mode: 'get-headers' },
  { mode: 'no-headers' },
  { mode: 'empty-headers' },
  ...[
    'prepare-sync',
    'prepare-reject',
    'native-sync',
    'native-reject',
    'response-reject',
  ].map(mode => ({ mode })),
  { mode: 'native-reject', flags: { onlyProxyResp: true } },
  { mode: 'response-reject', flags: { onlyProxyResp: true } },
  { twice: true },
];
module.exports = { createFixture, runScenario, scenarios };
