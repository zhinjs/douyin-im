// Original cache / built SDK differential. Fake cookie storage is not browser acceptance evidence.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
if (!process.argv[2]) throw Error('Usage: node scripts/research/desktop-web-secure-cache-oracle.cjs /path/to/860.js');
const source = readFileSync(resolve(process.argv[2]), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const code = '"use strict";var ' + source.slice(86903, 87954) + ';var ' + source.slice(92716, 97420) + ';globalThis.Cache=xr;';
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture(hostname) {
  const cookies = new Map(), writes = [], calls = [];
  let randomCalls = 0;
  const document = { location: { hostname },
    get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
    set cookie(value) {
      writes.push(value);
      const pair = value.split(';')[0], split = pair.indexOf('='), key = pair.slice(0, split);
      if (value.includes('expires=')) cookies.delete(key); else cookies.set(key, pair.slice(split + 1));
    },
  };
  const math = Object.create(Math); math.random = () => (randomCalls++ % 16) / 16;
  return { context: { document, Math: math, Promise }, writes, cookies, calls, count: () => randomCalls };
}
async function run(factory, hostname, agId, concurrent) {
  const f = fixture(hostname), cache = factory(f.context, agId), results = [];
  const backend = { a: 'synthetic-A', b: 'synthetic-B', empty: '', missing: undefined, nil: null, zero: 0, no: false };
  let complete;
  const read = keys => {
    f.calls.push(['read', [...keys]]);
    const data = Object.fromEntries(keys.map(key => [key, backend[key]]));
    return concurrent && keys.includes('a') ? new Promise(resolve => { complete = () => resolve(data); }) : Promise.resolve(data);
  };
  const get = cache.wrapGetter(read, { packData: (data, args, summary, responses) => ({ data, args, summary, responses }) });
  if (concurrent) {
    const first = get(['a']), second = get(['a', 'b']);
    complete(); results.push(await first, await second);
  } else {
    results.push(await get(['a', 'empty', 'missing', 'nil', 'zero', 'no']));
    results.push(await get(['a', 'empty', 'missing', 'nil', 'zero', 'no']));
    const set = cache.wrapSetter((key, value) => { f.calls.push(['write', key, value]); backend[key] = value; return false; },
      { extractDataFromArgs: ([key, value]) => ({ [key]: value }) });
    results.push(set('a', { synthetic: 1 })); await flush();
    results.push(set('a', { synthetic: 1 })); await flush(); results.push(await get(['a']));
    const remove = cache.wrapUpdater(key => { f.calls.push(['delete', key]); return Promise.resolve(false); }, undefined, 'delete');
    await remove('empty'); results.push(await get(['empty']));
    await remove('a'); results.push(await get(['a']));
    f.cookies.set(`__security_mc_${agId}_a`, 'external-version'); backend.a = 'synthetic-new';
    results.push(await get(['a']));
    cache.clear(); results.push(await get(['empty']));
    cache.setDisabled(true); const raw = cache.wrapGetter((...args) => { f.calls.push(['raw', ...args]); return 3; }, {});
    results.push(raw('a', 'extra'));
  }
  await flush();
  return structuredClone({ results, calls: f.calls, writes: f.writes, cookies: [...f.cookies], randomCalls: f.count() });
}
void (async () => {
  const { DesktopWebSecureMemoryCache } = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-cache.js')).href);
  const original = (context, agId) => {
    const sandbox = vm.createContext(context); vm.runInContext(code, sandbox); return new sandbox.Cache({ agId });
  };
  let count = 0;
  for (const host of ['a.b.douyin.com', 'a.b.co.uk', '127.0.0.1', '', 'localhost', 'internal']) {
    for (const agId of [1, undefined, 'namespace']) for (const concurrent of [false, true]) {
      const native = await run(original, host, agId, concurrent);
      const sdk = await run((context, id) => new DesktopWebSecureMemoryCache(context, id), host, agId, concurrent);
      assert.deepEqual(sdk, native, `${host} / ${agId} / concurrent=${concurrent}`);
      count++;
    }
  }
  console.log(`PASS ${count} original / built SDK cache, cookie and concurrent-read traces`);
})().catch(error => { console.error(error); process.exitCode = 1; });
