import { DesktopWebSecureMemoryCache } from './desktop-web-secure-cache.js';

function fixture(hostname = 'a.b.douyin.com', agId: number | string | undefined = 1) {
  const cookies = new Map<string, string>(), writes: string[] = [], errors: unknown[] = [];
  let randomCalls = 0, raw: string | undefined;
  const document = { location: { hostname },
    get cookie() { return raw ?? [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
    set cookie(value: string) {
      writes.push(value); raw = undefined;
      const pair = value.split(';', 1)[0]!, split = pair.indexOf('=');
      const key = pair.slice(0, split);
      if (value.includes('expires=')) cookies.delete(key); else cookies.set(key, pair.slice(split + 1));
    },
  };
  const context = { document, Math: { random: () => (randomCalls++ % 16) / 16 }, onBackgroundError: (error: unknown) => { errors.push(error); } };
  return { cache: new DesktopWebSecureMemoryCache(context, agId), cookies, writes, errors, context,
    setRaw(value: string) { raw = value; }, randomCalls: () => randomCalls };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

it('loads only missing keys, runs extraction twice and reports hit/pending/miss summaries', async () => {
  const f = fixture(), read = jest.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, `value:${key}`])));
  const extract = jest.fn(value => value);
  const get = f.cache.wrapGetter(read, { extractDataFromResponse: extract, packData: (data, _args, summary) => ({ data, summary }) });
  await expect(get(['a'])).resolves.toMatchObject({ data: { a: 'value:a' }, summary: { total: 1, hit: 0, pending: 0, miss: 1, missKeys: ['a'] } });
  expect(extract).toHaveBeenCalledTimes(2);
  await expect(get(['a', 'b'])).resolves.toMatchObject({ data: { a: 'value:a', b: 'value:b' }, summary: { total: 2, hit: 1, pending: 0, miss: 1, missKeys: ['b'] } });
  await expect(get(['a', 'b'])).resolves.toMatchObject({ summary: { total: 2, hit: 2, pending: 0, miss: 0, missKeys: [] } });
  expect(read.mock.calls).toEqual([[['a']], [['b']]]);
});

it('shares per-key in-flight reads while fetching other keys separately', async () => {
  const f = fixture();
  let finish!: (value: Record<string, string>) => void;
  const read = jest.fn((keys: string[]) => keys.includes('a') ? new Promise<Record<string, string>>(resolve => { finish = resolve; }) : Promise.resolve({ b: 'B' }));
  const get = f.cache.wrapGetter(read, { packData: (data, _args, summary) => ({ data, summary }) });
  const first = get(['a']), second = get(['a', 'b']);
  finish({ a: 'A' });
  await expect(first).resolves.toMatchObject({ data: { a: 'A' } });
  await expect(second).resolves.toMatchObject({ data: { a: 'A', b: 'B' }, summary: { pending: 1, miss: 1, hit: 0 } });
  expect(read.mock.calls).toEqual([[['a']], [['b']]]);
});

it.each(['', undefined])('retains settled queue entries for uncached values %s, even after version-only deletion', async value => {
  const f = fixture(), read = jest.fn(async () => ({ a: value }));
  const get = f.cache.wrapGetter(read, { extractKeysFromArgs: () => ['a'], packData: (data, _args, summary) => ({ data, summary }) });
  await get();
  const remove = f.cache.wrapUpdater<[string], Promise<boolean>>(async () => true, undefined, 'delete');
  await remove('a');
  await expect(get()).resolves.toMatchObject({ data: { a: value }, summary: { hit: 0, pending: 1, miss: 0 } });
  expect(read).toHaveBeenCalledTimes(1);
  f.cache.clear(); await get(); expect(read).toHaveBeenCalledTimes(2);
});

it.each([null, false, 0])('caches %s instead of treating every falsy value as absent', async value => {
  const f = fixture(), read = jest.fn(async () => ({ a: value }));
  const get = f.cache.wrapGetter(read, { extractKeysFromArgs: () => 'a' });
  await get(); await get(); expect(read).toHaveBeenCalledTimes(1); expect(f.writes).toHaveLength(1);
});

it('adopts an existing cookie version on first load, then refetches when another context changes it', async () => {
  const f = fixture(); f.cookies.set('__security_mc_1_a', 'external-version');
  const read = jest.fn(async () => ({ a: 'old' }));
  const get = f.cache.wrapGetter(read, { extractKeysFromArgs: () => 'a' });
  await get(); expect(f.writes).toHaveLength(0);
  f.cookies.set('__security_mc_1_a', 'changed'); read.mockResolvedValue({ a: 'new' });
  await expect(get()).resolves.toEqual({ a: 'new' });
  expect(read).toHaveBeenCalledTimes(2); expect(f.writes).toHaveLength(0);
});

it('retains rejected queue entries until clear without an unhandled rejection', async () => {
  const f = fixture(), failure = new Error('synthetic storage failure');
  const read = jest.fn(async () => { throw failure; });
  const get = f.cache.wrapGetter(read, { extractKeysFromArgs: () => 'a' });
  await expect(get()).rejects.toBe(failure); await flush();
  await expect(get()).rejects.toBe(failure);
  expect(read).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([failure]);
  f.cache.clear(); await expect(get()).rejects.toBe(failure); expect(read).toHaveBeenCalledTimes(2);
});

it('returns the original setter result and updates cache after any fulfillment, but skips equal values', async () => {
  const f = fixture();
  const set = f.cache.wrapSetter<[string, unknown], boolean>(() => false, { extractDataFromArgs: ([key, value]) => ({ [key]: value }) });
  expect(set('a', { value: 1 })).toBe(false); await flush();
  expect(f.writes).toHaveLength(1); expect(f.randomCalls()).toBe(15);
  set('a', { value: 1 }); await flush(); expect(f.writes).toHaveLength(1);
  const read = jest.fn(async () => ({ a: 'unexpected' }));
  const get = f.cache.wrapGetter(read, { extractKeysFromArgs: () => 'a' });
  await expect(get()).resolves.toEqual({ a: { value: 1 } }); expect(read).not.toHaveBeenCalled();
});

it('does not cache a rejected write and observes its detached bookkeeping failure', async () => {
  const f = fixture(), failure = new Error('synthetic write failure');
  const original = Promise.reject(failure);
  const set = f.cache.wrapSetter<[string], typeof original>(() => original, { extractDataFromArgs: ([key]) => ({ [key]: 'new' }) });
  expect(set('a')).toBe(original); await expect(original).rejects.toBe(failure); await flush();
  expect(f.writes).toHaveLength(0); expect(f.errors).toEqual([failure]);
});

it('writes all three version deletions without deduplicating and lazily invalidates a stored value', async () => {
  const f = fixture('douyin.com'), read = jest.fn(async () => ({ a: 'value' }));
  const get = f.cache.wrapGetter(read, { extractKeysFromArgs: () => 'a' }); await get();
  const remove = f.cache.wrapUpdater<[string], Promise<boolean>>(async () => false, undefined, 'delete');
  await remove('a'); await flush();
  expect(f.writes.slice(1)).toEqual([
    '__security_mc_1_a=; expires=Thu, 01 Jan 1970 00:00:00 UTC; domain=douyin.com; path=/',
    '__security_mc_1_a=; expires=Thu, 01 Jan 1970 00:00:00 UTC; domain=douyin.com; path=/',
    '__security_mc_1_a=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/',
  ]);
  await get(); expect(read).toHaveBeenCalledTimes(2);
});

it('disables wrappers without altering arguments, return identity, cookies or underlying cache state', async () => {
  const f = fixture(); f.cache.setDisabled(true);
  const result = { raw: true }, read = jest.fn<typeof result, [string, string]>(() => result);
  const get = f.cache.wrapGetter(read, {});
  expect(get('a', 'extra')).toBe(result); expect(read).toHaveBeenCalledWith('a', 'extra');
  const set = f.cache.wrapSetter(read, { extractDataFromArgs: () => { throw Error('not evaluated'); } });
  expect(set('a', 'extra')).toBe(result); await flush(); expect(f.writes).toEqual([]);
});

it.each([
  ['a.b.douyin.com', 'douyin.com'], ['a.b.co.uk', 'co.uk'], ['127.0.0.1', '0.0.1'],
  ['', '.'], ['internal', '.internal'], ['localhost', 'localhost'],
])('uses native version key and domain for %s', async (host, domain) => {
  const f = fixture(host); f.context.Math.random = () => 0;
  const update = f.cache.wrapUpdater<[string], boolean>(() => true);
  expect(update('security-sdk/s_sdk_crypt_sdk')).toBe(true); await flush();
  expect(f.writes).toEqual([`__security_mc_1_sk_crypt_sdk=00000000-4000-8000; max-age=5184000; domain=${domain}; path=/`]);
});

it('propagates malformed cookie decoding from a read, without treating it as a cache miss', async () => {
  const f = fixture(), read = jest.fn(async () => ({ a: 'value' }));
  const get = f.cache.wrapGetter(read, { extractKeysFromArgs: () => 'a' }); await get();
  f.setRaw('__security_mc_1_a=%E0%A4%A');
  expect(() => get()).toThrow(URIError); expect(read).toHaveBeenCalledTimes(1);
});
