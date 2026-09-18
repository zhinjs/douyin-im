// Actual Un/Ln + jn/dr/pr/vr source against the local container. Fake DOM/core, no script download.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createHash } = require('node:crypto'), { resolve } = require('node:path'), { pathToFileURL } = require('node:url');
const source = fs.readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const code = source.slice(source.indexOf('var or=function(t,e,r,n)'), source.indexOf(',lr=function')) + ';var ' + source.slice(88239, 89044) +
  ';var ' + source.slice(146513, source.indexOf(';var an=function', 146513)) + ';var ' + source.slice(160782, 162348) +
  'var Ln=false,' + source.slice(162479, source.indexOf(',Nn=18e6', 162479)) + ';globalThis.start=Un;';
const flush = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
const compact = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'function' ? '[function]' : item));
async function scenario(kind, sdk, mode) {
  const calls = [], scripts = [], states = []; let coreCount = 0;
  const core = { getInstance(params, options) { calls.push(['core', params, options]); coreCount++; return mode === 'core-reject' && coreCount === 1 ? Promise.reject(Error('core')) : mode === 'core-falsy' ? undefined : { synthetic: true }; } };
  const window = { DTraitSDK: mode === 'missing-core' || mode === 'builtin-load-fail' ? undefined : mode === 'module-default' ? { default: core } : core,
    DTraitUcAesEncrypt: mode === 'crypto-present', DTraitUcRsaEncrypt: mode === 'crypto-present', DTraitUcCryptoJSUtil: mode === 'crypto-present' };
  const monitor = { init: (...args) => calls.push(['monitor-init', ...args]), setConfig: value => calls.push(['config', value]), sendSlardarEvent: value => calls.push(['event', value]), sendSlardarLog: value => calls.push(['log', value]), sendTeaLog: (...args) => calls.push(['tea', ...args]) };
  const document = { createElement(tag) { calls.push(['create', tag]); return { type: '', src: '', ...(mode === 'readystatechange' ? { readyState: 'loading' } : {}) }; },
    getElementsByTagName(tag) { calls.push(['elements', tag]); return [{ appendChild(script) { calls.push(['append', script.src, Boolean(script.onload || script.onreadystatechange)]); scripts.push(script); } }]; } };
  const get = aid => { calls.push(['parameters', aid]); return mode === 'parameters-reject' ? Promise.reject(Error('parameters')) : Promise.resolve({ centralVersion: 'synthetic', urlVersion: mode === 'full-url' ? 'https://synthetic.invalid/core.js' : mode === 'http-url' ? 'http://synthetic.invalid/core.js' : mode === 'bad-version' ? 1 : mode === 'missing-version' ? undefined : '1.0.31', dataFrom: 'local' }); };
  const clock = { now: () => 100 }, performance = { now: () => 3 }, instances = { slardarInstance: { local: true }, teaInstance: { local: true } };
  let start;
  if (kind === 'raw') {
    const context = vm.createContext({ Promise, window, document, performance, Date: clock, fn: get, Yr: { init: monitor.init, _instance: { setConfig: monitor.setConfig } }, tn: monitor.sendSlardarEvent, en: monitor.sendSlardarLog, $r: monitor.sendTeaLog });
    vm.runInContext(code, context); start = input => context.start(input, instances);
  } else {
    const owner = new sdk.DesktopDTraitBootstrap({ window, document, monitor, monitorInstances: instances, performance, parameters: { Date: clock } }); owner.parameters.get = get; start = owner.start;
  }
  let options = { aid: 6383, webId: 'synthetic' };
  if (mode === 'no-aid') options = {};
  if (mode === 'string-aid') options.aid = '6383';
  if (mode === 'null-defaults') options = { aid: null, consumerPathList: null, urlRewriteRules: null, consumerHostList: null, libraGroup: null, delayCollect: null };
  if (mode === 'options') Object.assign(options, { consumerPathList: ['/path'], urlRewriteRules: [['a', 'b']], consumerHostList: ['host'], libraGroup: 'group', delayCollect: 2, reportAppLog: true });
  if (mode.startsWith('builtin')) options.useBuildIn = true;
  const invoke = input => { const state = { status: 'pending' }; void start(input).then(value => Object.assign(state, { status: 'fulfilled', value }), error => Object.assign(state, { status: 'rejected', name: error.name, ...(error.name === 'TypeError' ? {} : { message: error.message }) })); return state; };
  let consumed = 0;
  const settle = async state => {
    for (let i = 0; i < 12 && state.status === 'pending'; i++) {
      await flush(); while (consumed < scripts.length) {
        const script = scripts[consumed++];
        if (mode === 'load-fail' || mode === 'builtin-load-fail') { script.onerror(Error('script')); if (mode === 'builtin-load-fail' && consumed === 6) window.DTraitSDK = core; }
        else if (mode === 'readystatechange') { script.readyState = 'loaded'; script.onreadystatechange(); }
        else script.onload();
      }
    }
    await flush(); states.push(structuredClone(state));
  };
  const first = invoke(options), concurrent = mode === 'concurrent' ? invoke({ aid: 1 }) : undefined;
  await settle(first); if (concurrent) await settle(concurrent);
  if (['repeat', 'core-falsy', 'core-reject', 'builtin-existing'].includes(mode)) await settle(invoke(options));
  return compact({ calls, states });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-bootstrap.js')).href);
  const modes = ['default', 'no-aid', 'string-aid', 'options', 'null-defaults', 'crypto-present', 'full-url', 'http-url', 'bad-version', 'missing-version', 'parameters-reject', 'load-fail', 'missing-core', 'builtin-existing', 'builtin-load-fail', 'module-default', 'readystatechange', 'repeat', 'core-falsy', 'core-reject', 'concurrent'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', sdk, mode), mode);
  console.log(`PASS ${modes.length} raw Un/Ln/jn/dr/pr/vr / SDK bootstrap traces (synthetic DOM/core, no network)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
