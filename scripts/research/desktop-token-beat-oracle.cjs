// Executes only the installed token-beat scheduler with synthetic SDK/window/timers.
// No native state, account files, browser session, fetch, or HTTP adapter is used.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/research/desktop-token-beat-oracle.cjs /path/to/renderer/92/92_*.js');
const source = readFileSync(resolve(path), 'utf8');
const fingerprint = createHash('sha256').update(source).digest('hex');
assert.equal(fingerprint, 'e09879e27fb28e3a53b962a048cc51318295b6f067f1fec6a395bde2be661889',
  'Source fingerprint changed; inspect the new build before executing its scheduler');
const start = source.indexOf('var yh=function()');
const end = source.indexOf('},51686:', start);
assert(start >= 0 && end > start, 'Installed scheduler boundaries changed; re-audit the source');
const scheduler = source.slice(start, end);
assert(scheduler.includes('Oh="/passport/token/beat/web/"') && scheduler.endsWith('return e.start(),e.stop}'), 'Unexpected scheduler implementation');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(config = {}) {
  const requests = []; const configs = []; const intervals = new Map(); const timeouts = new Map();
  const listeners = new Map(); const storage = new Map();
  let sequence = 0; let loggedOut = 0; let response = () => Promise.resolve({});
  const context = vm.createContext({
    _h: class {
      constructor(options) { configs.push(plain(options)); }
      request(input) { requests.push(plain(input)); return response(input); }
    },
    window: { location: { origin: 'https://offline.invalid' },
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setInterval(callback, delay) { const id = ++sequence; intervals.set(id, { callback, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout(callback, delay) { const id = ++sequence; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
  });
  vm.runInContext(`${scheduler};globalThis.boot = Th;`, context, { timeout: 1000 });
  return {
    requests, configs, intervals, timeouts, listeners, storage,
    get loggedOut() { return loggedOut; },
    respond(callback) { response = callback; },
    start() { return context.boot({ aid: 339757, beatTimes: 600000, ...config, logoutCallBack: () => { loggedOut++; } }); },
    activity(name = 'click') { listeners.get(name)?.(); },
    tick() { for (const timer of [...intervals.values()]) timer.callback(); },
    unthrottle() { for (const [id, timer] of [...timeouts]) if (timer.delay === 10000) { timeouts.delete(id); timer.callback(); } },
  };
}

(async () => {
  const first = fixture({ requestConfig: { host: 'https://imdesktop.douyin.com', generalParams: { custom: 'fixture' } } });
  first.start(); await flush();
  assert.deepEqual(first.requests, [{ url: '/passport/token/beat/web/', params: { scene: 'boot' } }]);
  assert.deepEqual(first.configs[0].generalParams, { version: '1.2.13', custom: 'fixture' });
  assert.equal(first.configs[0].aid, 339757);
  assert.equal([...first.intervals.values()][0].delay, 600000);
  assert.deepEqual([...first.listeners.keys()], ['click', 'scroll', 'mousemove', 'beforeunload']);
  console.log('PASS boot + SDK config + 10-minute interval');

  first.tick(); await flush();
  assert.equal(first.requests.length, 1); assert.equal(first.intervals.size, 0);
  assert.equal(first.storage.get('https://offline.invalid-operation'), 'false');
  console.log('PASS idle stops without another request');

  first.activity(); await flush();
  assert.equal(first.requests.at(-1).params.scene, 'active'); assert.equal(first.intervals.size, 1);
  first.activity('mousemove'); first.tick(); await flush();
  assert.equal(first.requests.length, 2); assert.equal(first.intervals.size, 0);
  console.log('PASS idle activity resumes once; 10-second throttle suppresses other events');

  const polling = fixture(); polling.start(); polling.activity(); polling.tick(); await flush();
  assert.deepEqual(polling.requests.map(value => value.params.scene), ['boot', 'polling']);
  assert.equal(polling.storage.get('https://offline.invalid-operation'), 'false');
  polling.tick(); assert.equal(polling.intervals.size, 0);
  console.log('PASS activity during beating enables one polling interval');

  const throttled = fixture(); throttled.start(); throttled.activity(); throttled.tick();
  throttled.activity('scroll'); throttled.unthrottle(); throttled.activity('mousemove'); throttled.tick();
  await flush();
  assert.deepEqual(throttled.requests.map(value => value.params.scene), ['boot', 'polling', 'polling']);
  console.log('PASS throttle release accepts activity again');

  const revoked = fixture(); revoked.respond(() => Promise.reject({ error_code: 401 })); revoked.start(); await flush();
  assert.equal(revoked.loggedOut, 1); assert.equal(revoked.intervals.size, 0);
  assert.deepEqual([...revoked.listeners.keys()], ['beforeunload']);
  revoked.activity(); assert.equal(revoked.requests.length, 1);
  console.log('PASS numeric Passport error 401 stops and removes activity listeners');

  for (const error of [{ error_code: '401' }, { error_code: 8 }, { response: { status: 401 } }, new Error('offline')]) {
    const failed = fixture(); failed.respond(() => Promise.reject(error)); failed.start(); await flush();
    assert.equal(failed.loggedOut, 0); assert.equal(failed.intervals.size, 1); assert.equal(failed.listeners.size, 4);
    failed.tick(); assert.equal(failed.intervals.size, 0);
  }
  console.log('PASS other failures are not treated as Passport 401');

  const stopped = fixture(); const stop = stopped.start(); stop();
  assert.equal(stopped.intervals.size, 0); assert.equal(stopped.listeners.size, 4);
  stopped.activity(); await flush();
  assert.deepEqual(stopped.requests.map(value => value.params.scene), ['boot', 'active']);
  console.log('PASS returned stop does not remove activity listeners in Desktop');

  const late = fixture(); let reject;
  late.respond(() => new Promise((_resolve, fail) => { reject = fail; }));
  const stopLate = late.start(); stopLate(); reject({ error_code: 401 }); await flush();
  assert.equal(late.loggedOut, 1);
  console.log('PASS pending 401 still calls logout after stop; native has no generation guard here');

  const overlapping = fixture(); const resolves = [];
  overlapping.respond(() => new Promise(resolve => resolves.push(resolve)));
  overlapping.start(); overlapping.activity(); overlapping.tick();
  assert.equal(overlapping.requests.length, 2);
  resolves.forEach(resolve => resolve({})); await flush();
  console.log('PASS scheduler does not serialize in-flight requests');

  console.log('SOURCE sha256=' + fingerprint);
  console.log('All scheduler assertions passed; no HTTP or real-account verification performed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
