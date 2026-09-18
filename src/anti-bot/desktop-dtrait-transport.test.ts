import { createRequire } from 'node:module';
import {
  createDesktopDTraitTransportInstaller,
  parseDesktopDTraitResponseHeaders,
  type DesktopDTraitTransportRealm,
  type DesktopDTraitTransportCallbacks,
  type DesktopDTraitTransportXhr,
} from './desktop-dtrait-transport.js';

const require = createRequire(import.meta.url);
const { createFixture, runScenario } =
  require('../../scripts/research/desktop-dtrait-transport-fixture.cjs') as {
    createFixture(mode?: string): {
      realm: DesktopDTraitTransportRealm;
      trace: unknown[][];
      XHR: new () => DesktopDTraitTransportXhr;
      callbacks(flags: object): DesktopDTraitTransportCallbacks;
    };
    runScenario(
      install: typeof createDesktopDTraitTransportInstaller,
      scenario: object
    ): Promise<unknown[][]>;
  };
const run = (scenario: object = {}) =>
  runScenario(createDesktopDTraitTransportInstaller, scenario);
const named = (trace: unknown[][], name: string) =>
  trace.filter(row => row[0] === name);

it('keeps header duplicates, singleton emptiness, first colon and ordinary object semantics', () => {
  expect(
    parseDesktopDTraitResponseHeaders(
      'Broken\nX: a:b\nX: c\nContent-Type:\nContent-Type: json\nContent-Type: ignored\nSet-Cookie: a\nSet-Cookie: b'
    )
  ).toEqual({
    x: 'a:b, c',
    'content-type': 'json',
    'set-cookie': ['a', 'b'],
  });
  const result = parseDesktopDTraitResponseHeaders(
    'constructor: value\n__proto__: value'
  );
  expect(result['constructor']).toBe(String(Object) + ', value');
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.keys(result)).toEqual(['constructor']);
});

it('sends original XHR body after generated headers and runs the captured receiver callback after response processing', async () => {
  const trace = await run({ kind: 'xhr', loadend: true });
  expect(named(trace, 'send-return')).toEqual([['send-return', null]]);
  expect(named(trace, 'send')).toEqual([['send', 'body']]);
  expect(named(trace, 'xhr-header')).toEqual([['xhr-header', 'Signed', 'yes']]);
  expect(named(trace, 'user-callback')).toEqual([
    ['user-callback', true, 'event'],
  ]);
  expect(trace.findIndex(row => row[0] === 'response')).toBeLessThan(
    trace.findIndex(row => row[0] === 'user-callback')
  );
  expect(named(trace, 'response')[0]!.slice(3, 6)).toEqual([
    { Signed: 'yes' },
    { test: 1 },
    204,
  ]);
  expect(named(trace, 'error').map(row => row[1])).toEqual([
    'error',
    'abort',
    'timeout',
  ]);
});

it.each([
  { async: false },
  { async: undefined },
  { flags: { needProxy: true, onlyProxyResp: true } },
])(
  'preserves XHR direct send return and skips request preparation for %j',
  async scenario => {
    const trace = await run({ kind: 'xhr', ...scenario });
    expect(named(trace, 'send-return')).toEqual([['send-return', 'sent']]);
    expect(named(trace, 'request')).toEqual([]);
    expect(named(trace, 'response')).toHaveLength(1);
  }
);

it('does not add an await before incomplete XHR user callbacks', async () => {
  const trace = await run({ kind: 'xhr', incomplete: true });
  expect(named(trace, 'response')).toEqual([]);
  expect(trace.findIndex(row => row[0] === 'user-callback')).toBeLessThan(
    trace.findIndex(row => row[0] === 'after-callback-call')
  );
});

it.each([
  ['prepare-sync', true, 0],
  ['prepare-reject', true, 0],
  ['native-sync', true, 0],
  ['native-reject', true, 1],
  ['response-reject', true, 1],
  ['native-reject', false, 0],
  ['response-reject', false, 0],
])(
  'preserves fetch error boundary %s prepared=%s',
  async (mode, prepared, notifications) => {
    const trace = await run({
      mode,
      flags: prepared ? { needProxy: true } : { onlyProxyResp: true },
    });
    expect(named(trace, 'caught')).toHaveLength(1);
    expect(named(trace, 'error')).toHaveLength(notifications as number);
    expect(named(trace, 'fetch')).toHaveLength(
      String(mode).startsWith('prepare') ? 0 : 1
    );
  }
);

it.each([
  ['normal', 3],
  ['get-headers', 7],
  ['no-headers', 1],
  ['empty-headers', 3],
])('preserves response header getter reads for %s', async (mode, count) => {
  const trace = await run({ mode });
  expect(named(trace, 'fetch-return')[0]![2]).toBe(count);
  if (mode === 'no-headers') expect(named(trace, 'response')).toEqual([]);
  else expect(named(trace, 'response')[0]![5]).toBeNull(); // fetch never adds httpCode
});

it.each(['frozen', 'primitive'])(
  'continues native fetch on %s header mutation failure without retry',
  async headers => {
    const trace = await run({ headers });
    expect(named(trace, 'diagnostic')).toEqual([['diagnostic']]);
    expect(named(trace, 'fetch')).toHaveLength(1);
    expect(named(trace, 'error')).toHaveLength(0);
  }
);

it('prefers Request method and keeps tuple header duplicates', async () => {
  const request = await run({ request: true });
  expect(named(request, 'hook')[0]![1]).toMatchObject({
    method: 'POST',
    query: { x: '2' },
  });
  expect(named(request, 'request-headers')).toEqual([
    ['request-headers', { Signed: 'yes' }],
  ]);
  const tuples = await run({ headers: 'array' });
  expect(named(tuples, 'fetch')[0]![4]).toEqual([
    ['Signed', 'old'],
    ['Signed', 'yes'],
  ]);
});

it('observes detached XHR preparation failures without errorRequestConfig or fallback sends', async () => {
  const f = createFixture('prepare-reject'),
    background = jest.fn();
  createDesktopDTraitTransportInstaller(f.realm, {
    onBackgroundError: background,
  })(f.callbacks({ needProxy: true }));
  const xhr = new f.XHR();
  xhr.open('POST', '/path');
  expect(xhr.send('body')).toBeUndefined();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(background).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'prepare reject' })
  );
  expect(named(f.trace, 'send')).toEqual([]);
  expect(named(f.trace, 'error')).toEqual([]);
});

it('captures fetch capability at factory creation without installing automatically', () => {
  const f = createFixture(),
    native = f.realm.window.fetch!;
  delete f.realm.window.fetch;
  const install = createDesktopDTraitTransportInstaller(f.realm);
  f.realm.window.fetch = native;
  install(f.callbacks({ needProxy: true }));
  expect(f.realm.window.fetch).toBe(native);
});
