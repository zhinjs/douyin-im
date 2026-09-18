// Complete installed bundle versus production assembly, synthetic host only.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), ts = require('typescript');
const { installDesktopBdms } = require('./desktop-production-loader.cjs')('desktop-runtime');
const source = fs.readFileSync(process.argv[2] || '/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js', 'utf8');
const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
assert.equal(sourceHash, 'd99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');

// Reuse the actual integration-test host, without evaluating Jest or replacing algorithms.
const testSource = fs.readFileSync('src/anti-bot/desktop-runtime.test.ts', 'utf8');
const ast = ts.createSourceFile('fixture.ts', testSource, ts.ScriptTarget.Latest, true);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['fixture', 'drain'].includes(node.name?.text));
assert.equal(declarations.length, 2);
const compiled = ts.transpileModule(declarations.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const hostFactory = new Function(compiled + '\nreturn {fixture,drain};')();
const clone = value => structuredClone(value);

function make(production, sharedStorage) {
  const f = hostFactory.fixture(sharedStorage);
  f.requests = [];
  f.window.fetch = async (input, options) => {
    f.requests.push({ kind: 'fetch', url: String(input instanceof Request ? input.url : input), options });
    return { input, options };
  };
  f.window.EventSource = class {
    constructor(url, options) { this.url = url; f.requests.push({ kind: 'EventSource', url: String(url), options }); }
  };
  f.context.navigator.sendBeacon = (url, body) => { f.requests.push({ kind: 'beacon', url, body }); return true; };
  f.context.Math = Object.assign(Object.create(Math), f.context.Math);
  f.context.JSON = Object.assign(Object.create(JSON), f.context.JSON);
  // Each supplied binding belongs to this synthetic host, including window.location.
  Object.assign(f.window, f.context);
  if (production) installDesktopBdms(f.context);
  else vm.runInNewContext(source, f.context, { timeout: 3000 });
  return f;
}

function snapshot(f) {
  return clone({
    trace: f.trace, reports: f.reports, requests: f.requests,
    images: f.images.map(x => ({ src: x.src, load: typeof x.onload, error: typeof x.onerror })),
    xhrs: f.xhrs.map(x => ({ url: x.url, body: x.body, withCredentials: x.withCredentials })),
    storage: [...f.saved], frames: f.frames.length,
    timeouts: f.timeouts.map(x => x.delay), intervals: f.intervals.map(x => x.delay),
    listeners: [...f.listeners].map(([name, list]) => [name, list.length]),
  });
}

let steps = 0, scenarios = 0;
async function scenario(name, action) {
  const original = make(false), production = make(true);
  const equal = label => { assert.deepEqual(snapshot(production), snapshot(original), name + ': ' + label); steps++; };
  equal('load');
  await action(original, production, equal);
  scenarios++;
}

(async () => {
  await scenario('mode0', async (a, b, equal) => {
    for (const f of [a, b]) f.window.bdms.init({ aid: 339757, pageId: 23420, paths: ['/passport'], track: { paths: ['/passport'] } });
    equal('init');
    for (const f of [a, b]) {
      f.listeners.get('mousemove')[0]({ clientX: 4, clientY: 7 });
      f.clock.now = 1020; f.listeners.get('keydown')[0]({});
      const xhr = new f.Xhr(); xhr.open('POST', '/passport/login?a=x%20y'); xhr.setRequestHeader('Content-Type', 'application/json'); xhr.send('{"hello":1}');
    }
    equal('input and signed XHR');
    for (const f of [a, b]) { await f.frames[1](); await hostFactory.drain(); }
    equal('behavior report');
    for (const f of [a, b]) { const report = f.xhrs.at(-1); report.responseToken = 'issued-by-fixture'; report.load(); }
    equal('token response');
    for (const f of [a, b]) {
      await f.window.fetch('/passport/login?q=x%20y', { method: 'POST', body: 'fetch-body' });
      new f.window.EventSource('/passport/events?q=x%20y');
    }
    equal('fetch and EventSource after token');
    const pending = [];
    for (const f of [a, b]) { pending.push(f.timeouts[0].callback()); await hostFactory.drain(); }
    equal('device awaiting image');
    assert.equal(a.images.length, 1); assert.equal(b.images.length, 1);
    for (const f of [a, b]) f.images[0].onload();
    await Promise.all(pending); await hostFactory.drain();
    equal('complete device report');
  });
  for (const mode of [0, 1, 2, 3]) await scenario('mode ' + mode + ' lifecycle', async (a, b, equal) => {
    for (const f of [a, b]) f.window.bdms.init({ aid: 339757, pageId: 23420, paths: ['.*'], track: { mode } });
    equal('init');
    for (const f of [a, b]) {
      f.clock.now = 1200;
      const xhr = new f.Xhr(); xhr.open('GET', '/passport/login'); xhr.send();
      const response = await f.window.fetch(new Request('https://fixture.invalid/passport/form', { method: 'POST', body: 'a=1' }), { body: 'override' });
      assert.equal(await response.input.clone().text(), 'a=1');
    }
    equal('XHR and Request branch');
    for (const f of [a, b]) for (const callback of f.listeners.get('visibilitychange')) callback();
    equal('visibility report');
    for (const f of [a, b]) for (const callback of f.listeners.get('visibilitychange')) callback();
    equal('visibility once');
    for (const f of [a, b]) {
      f.window.bdms.init({ track: { mode: 0, delay: 17, paths: ['/passport'] } });
      f.window.bdms.init({ track: { mode: 2 }, dump: false });
    }
    equal('mode transitions retain shared state');
  });
  // Conditional origin-sharing model, not an Electron storage-policy assertion.
  const contexts = [];
  for (const production of [false, true]) {
    const shared = new Map([['xmst', 'initial']]);
    const initialize = () => {
      const f = make(production, shared);
      f.window.bdms.init({ aid: 339757, pageId: 23420, paths: ['/passport'], track: { mode: 1 } });
      return f;
    };
    const first = initialize(), preloaded = initialize();
    const token = async f => {
      await f.window.fetch('/passport/login');
      return new URL(f.requests.at(-1).url).searchParams.get('msToken');
    };
    shared.set('xmst', 'later');
    first.context.document.cookie = 'msToken=cookie-only';
    first.window.bdms.init({ paths: ['/passport'], track: { mode: 1 } });
    const results = [await token(first), await token(preloaded)];
    const reloaded = initialize(); results.push(await token(reloaded));
    shared.clear(); results.push(await token(first), await token(reloaded));
    const cleared = initialize(); results.push(await token(cleared));
    assert.deepEqual(results, ['initial', 'initial', 'later', 'initial', 'later', null]);
    contexts.push([first, preloaded, reloaded, cleared]);
  }
  for (let i = 0; i < contexts[0].length; i++) {
    assert.deepEqual(snapshot(contexts[1][i]), snapshot(contexts[0][i]), `shared storage context ${i}`);
    steps++;
  }
  scenarios++;
  console.log(JSON.stringify({ scenarios, steps, sourceHash, completeOriginalScript: true, stubbedAlgorithms: false, network: false, realStorage: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
