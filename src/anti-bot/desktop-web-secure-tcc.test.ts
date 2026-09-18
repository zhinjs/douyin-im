import { DesktopWebSecureTcc } from './desktop-web-secure-tcc.js';
import { DesktopWebSecureConfiguration, classifyDesktopWebSecureRequest } from './desktop-web-secure-config.js';

const query = { tccPsm: 'ucenter.fe.ztsdk', zone: 'default', key: 'ztsdk_config' };
const cacheKey = 'ztsdk_tcc_config';
const config = { '339757': [{ aid: 339757, scene: 'login', providerPathList: ['/passport/'] }] };
const response = JSON.stringify({ data: { ztsdk_config: JSON.stringify(config) } });

function fixture(presence: unknown = true) {
  const storage = new Map<string, string>();
  const trace: unknown[][] = [];
  const requests: Xhr[] = [];
  const flags = { readError: false, writeError: false, constructError: false, openError: false, sendError: false, hold: false };
  let now = 1000;
  class Xhr {
    readyState = 0; status = 200; response: unknown = response;
    onreadystatechange: (() => void) | null = null;
    constructor() { if (flags.constructError) throw Error('construct'); requests.push(this); }
    open(...args: [string, string, boolean]) {
      trace.push(['open', ...args, this.onreadystatechange]);
      if (flags.openError) throw Error('open');
    }
    send() {
      trace.push(['send']); if (flags.sendError) throw Error('send');
      if (!flags.hold) this.finish();
    }
    finish() { this.readyState = 4; this.onreadystatechange?.(); }
  }
  const context = {
    window: { XMLHttpRequest: presence, localStorage: {
      getItem(key: string) { trace.push(['get', key]); if (flags.readError) throw Error('get'); return storage.get(key) ?? null; },
      setItem(key: string, value: string) { trace.push(['set', key, value]); if (flags.writeError) throw Error('set'); storage.set(key, value); },
    } },
    XMLHttpRequest: Xhr, Date: class { getTime() { return now; } },
  };
  return { context, loader: new DesktopWebSecureTcc(context), storage, trace, requests, flags, advance(value: number) { now = value; } };
}

async function pending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(settled).toBe(false);
}

it('uses source synchronous XHR order and stores the whole decoded data for six hours', async () => {
  const f = fixture();
  await expect(f.loader.getConfig(query)).resolves.toEqual(config);
  expect(f.trace).toEqual([
    ['get', cacheKey], ['open', 'get', 'https://lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-ucenter.fe.ztsdk-default', false, null],
    ['send'], ['set', cacheKey, JSON.stringify({ value: { ztsdk_config: config }, expire: 21_601_000 })],
  ]);
});

it.each([1000, '1000', undefined])('accepts cache at expiry equality or without numeric expiry (%s)', async expire => {
  const f = fixture();
  f.storage.set(cacheKey, JSON.stringify({ value: { ztsdk_config: config }, expire }));
  await expect(f.loader.getConfig(query)).resolves.toEqual(config);
  expect(f.requests).toHaveLength(0);
});

it('prefers fresh local storage, then reuses unexpired-in-memory data without another HTTP request', async () => {
  const f = fixture();
  await f.loader.getConfig(query);
  f.advance(30_000_000);
  await expect(f.loader.getConfig(query)).resolves.toEqual(config); // Memory has no TTL.
  expect(f.requests).toHaveLength(1);
  f.storage.set(cacheKey, JSON.stringify({ value: { ztsdk_config: { replacement: true } }, expire: 40_000_000 }));
  await expect(f.loader.getConfig(query)).resolves.toEqual({ replacement: true });
});

it('scopes memory to loader/PSM/zone but reads the same storage key before those distinctions', async () => {
  const f = fixture(); await f.loader.getConfig(query);
  await new DesktopWebSecureTcc(f.context).getConfig({ ...query, tccPsm: 'other.psm', zone: 'other' });
  expect(f.requests).toHaveLength(1); // Shared native storage key is not PSM-scoped.
  f.storage.clear();
  await f.loader.getConfig({ ...query, tccPsm: 'other.psm', zone: 'other' });
  expect(f.requests).toHaveLength(2);
  f.storage.clear();
  await new DesktopWebSecureTcc(f.context).getConfig(query);
  expect(f.requests).toHaveLength(3);
});

it.each([false, 0, '', null])('returns the entire data when the selected key is falsy (%s)', async selected => {
  const f = fixture();
  const data = { ztsdk_config: selected, other: { keep: true } };
  f.storage.set(cacheKey, JSON.stringify({ value: data, expire: 1001 }));
  await expect(f.loader.getConfig(query)).resolves.toEqual(data);
});

it('can load through storage errors and use the successful memory snapshot', async () => {
  const f = fixture(); f.flags.readError = true; f.flags.writeError = true;
  await expect(f.loader.getConfig(query)).resolves.toEqual(config);
  await expect(f.loader.getConfig(query)).resolves.toEqual(config);
  expect(f.requests).toHaveLength(1);
});

it.each(['constructError', 'openError', 'sendError'] as const)('rejects synchronous %s and permits a later caller, without automatic retry', async flag => {
  const f = fixture(); f.flags[flag] = true;
  await expect(f.loader.getConfig(query)).rejects.toThrow();
  f.flags[flag] = false;
  await expect(f.loader.getConfig(query)).resolves.toEqual(config);
});

it.each([
  ['non-200', 503, response], ['invalid-json', 200, 'bad'], ['empty-data', 200, '{"data":{}}'],
  ['missing-data', 200, '{}'], ['invalid-inner-json', 200, '{"data":{"ztsdk_config":"bad"}}'],
] as const)('keeps %s pending instead of reporting an empty successful config', async (_name, status, body) => {
  const f = fixture(); f.flags.hold = true;
  const result = f.loader.getConfig(query);
  f.requests[0]!.status = status; f.requests[0]!.response = body; f.requests[0]!.finish();
  await pending(result);
  expect(f.storage.size).toBe(0);
  expect(f.requests).toHaveLength(1);
});

it('keeps a missing browser XHR pending without constructing a fake transport', async () => {
  const f = fixture(null);
  await pending(f.loader.getConfig(query));
  expect(f.requests).toHaveLength(0);
});

it('does not deduplicate concurrent cache misses and preserves completion-order memory writes', async () => {
  const f = fixture(); f.flags.hold = true;
  const first = f.loader.getConfig(query), second = f.loader.getConfig(query);
  expect(f.requests).toHaveLength(2);
  f.requests[1]!.response = JSON.stringify({ data: { ztsdk_config: JSON.stringify({ second: true }) } });
  f.requests[1]!.finish(); await second;
  f.requests[0]!.finish(); await first;
  f.storage.clear();
  await expect(f.loader.getConfig(query)).resolves.toEqual(config);
  expect(f.requests).toHaveLength(2);
});

it('feeds decoded TCC entries into the existing ordered Web policy, not native BDTicket', async () => {
  const f = fixture();
  const policy = new DesktopWebSecureConfiguration();
  policy.setConfig({ aid: 339757, scene: 'login', certType: 'header' });
  policy.applyRemoteConfig(await f.loader.getConfig(query) as Record<string, unknown>);
  expect(classifyDesktopWebSecureRequest({ url: '/passport/login' }, policy.config, 'file:///app/login.html')).toMatchObject({ needProxy: true });
  expect(policy.config['login']).toHaveLength(2);
});
