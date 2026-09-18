// All twelve original collector functions + original scheduler/hash vs assembled SDK, synthetic realm only.
const vm = require('node:vm'),
  assert = require('node:assert/strict');
const { resolve } = require('node:path'),
  { pathToFileURL } = require('node:url');
const { decode } = require('./desktop-dtrait-core-decode.cjs');
const { rawFeature } = require('./desktop-dtrait-features-oracle.cjs');
const { rawCollection } = require('./desktop-dtrait-collector-oracle.cjs');
const { createFixture } = require('./desktop-dtrait-browser-fixture.cjs');
const path = process.argv[2],
  d = decode(path);
function original(realm, diagnostic) {
  const hash = rawFeature(path, {
    encoder: new realm.TextEncoder(),
    onDiagnostic: diagnostic,
  }).hash;
  const ctx = vm.createContext({
    ...realm,
    console: { error: () => diagnostic('font-detection') },
    tt: d.strings,
    et: d.functions.map((f, i) => [
      i >= 155 && i <= 365 ? f.code : [73, 0, 4],
      f.argc,
      f.strict,
      f.trys,
    ]),
    nt: new Map(),
    rt: new Map(),
  });
  const start = d.source.indexOf('function it(t,e)'),
    end = d.source.indexOf('function ut(t)', start);
  vm.runInContext(d.source.slice(start, end) + ';globalThis.make=it;', ctx, {
    timeout: 3000,
  });
  const build = (id, scope, slot) => {
    ctx.scope = scope;
    ctx.id = id;
    vm.runInContext('make(id, scope)()', ctx, { timeout: 3000 });
    return scope[slot];
  };
  const plugins = {
    boolFeature: build(179, [diagnostic], 1),
    strFeature: build(286, [diagnostic, hash], 2),
    canvas: build(207, [hash], 1),
    audio: build(155, [hash, diagnostic], 2),
    css: build(209, [hash, diagnostic], 2),
    domRect: build(225, [hash], 1),
    mediaTypes: build(232, [diagnostic, hash], 2),
    speech: build(253, [hash, diagnostic], 2),
    svgRect: build(291, [hash], 1),
    math: build(227, [hash], 1),
    webGL: build(293, [hash, diagnostic], 7),
    fonts: build(309, [diagnostic, hash], 4),
  };
  return rawCollection(path, {
    Date: realm.Date,
    setTimeout: realm.setTimeout,
  }).aggregate(plugins);
}
const plain = value => JSON.parse(JSON.stringify(value));
async function scenario(sdk, mode) {
  const f = createFixture(mode),
    errors = [];
  const local = sdk ? sdk.createDesktopDTraitBrowserCollector(f.realm) : null;
  const collect = local
    ? () => local.collector.collect()
    : original(f.realm, name => errors.push({ name }));
  const first = await f.settle(collect());
  const second = mode === 'repeat' ? await f.settle(collect()) : undefined;
  return plain({
    first,
    second,
    trace: f.trace,
    errors: local ? local.realmState.collectionErrors : errors,
    remaining: f.remaining(),
    timers: f.timers.size,
  });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/protocol.js')).href);
  const modes = [
    'normal',
    'font-load',
    'no-rendering',
    'missing-capabilities',
    'style-fail',
    'append-fail',
    'repeat',
  ];
  for (const mode of modes) {
    const a = await scenario(sdk, mode),
      b = await scenario(null, mode);
    assert.deepStrictEqual(a.first, b.first, mode + ' features');
    assert.deepStrictEqual(a.second, b.second, mode + ' repeat features');
    assert.deepStrictEqual(a.errors, b.errors, mode + ' errors');
    assert.deepStrictEqual(a.remaining, b.remaining, mode + ' DOM');
    assert.equal(a.timers, b.timers, mode + ' timers');
    assert.equal(a.trace.length, b.trace.length, mode + ' trace length');
    for (let i = 0; i < a.trace.length; i++)
      assert.deepStrictEqual(a.trace[i], b.trace[i], mode + ' trace ' + i);
  }
  console.log(
    `PASS ${modes.length} full twelve-plugin original VM/scheduler/hash vs SDK registry comparisons (synthetic realm)`
  );
}
if (require.main === module)
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { scenario };
