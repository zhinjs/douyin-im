// C321 hp vs local plugin, synthetic SDK/cookies only; no network or account data.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createHash } = require('node:crypto'), { resolve } = require('node:path'), { pathToFileURL } = require('node:url');
const source = fs.readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '5948467b5caf5e7a5d99ae65eff814d6a5c1961e293d763a1c2253a102e97919');
const raw = 'var ' + source.slice(source.indexOf('up = (function'), source.indexOf('      var vp,')) + ';globalThis.Plugin=hp;';
const compact = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'function' ? '[callback]' : item));
async function scenario(kind, Plugin, mode) {
  const calls = [], realm = {}; let failed = false;
  const sdk = Object.fromEntries(['setConfig', 'setDisableCrossStorage', 'setAgidAndHost', 'setWebId', 'start', 'startDTrait'].map(name => [name, (...args) => {
    calls.push([name, args]);
    if (mode === name + '-throw' && !failed) { failed = true; throw Error(name); }
    return name === 'start' ? Promise.resolve() : name === 'startDTrait' ? true : undefined;
  }]));
  const getCookie = name => { calls.push(['cookie', name]); return mode === 'cookie-first' ? 'first' : name.endsWith('_default') && mode !== 'cookie-empty' ? 'fallback' : ''; };
  const props = { aid: 339757 };
  if (mode === 'no-aid') delete props.aid;
  if (mode === 'disabled') Object.assign(props, { dtrait: false, ztsdkOptions: { enableCookieOptions: false, enableHeaderOptions: false }, ssoZtsdkOptions: { enable: false } });
  if (mode === 'dtrait-off') props.dtrait = false;
  if (mode === 'paths') Object.assign(props, { ztsdkOptions: { consumerPathList: ['/c'], providerPathList: ['/p'], onlyProviderPathList: ['/o'], urlRewriteRules: [['a', 'b']], disableCrossStorage: true, agid: 7 }, ssoZtsdkOptions: { consumerPathList: ['/sc'], providerPathList: ['/sp'], urlRewriteRules: [['s', 't']] } });
  if (mode === 'override') Object.assign(props, { ztsdkOptions: { aid: 8, certType: 'header', scene: 'custom', namespace: 'custom', signVersion: 9 }, ssoZtsdkOptions: { aid: 7, certType: 'cookie', scene: 'custom-sso', namespace: 'scope', onlyProviderPathList: ['/only'] } });
  if (mode === 'null-lists') props.ztsdkOptions = { consumerPathList: null, providerPathList: null, urlRewriteRules: null, onlyProviderPathList: null };
  if (mode === 'sparse') { const paths = []; paths.length = 2; paths[1] = '/c'; props.ztsdkOptions = { consumerPathList: paths }; }
  if (mode === 'callback' || mode === 'callback-throw') props.ztsdkOptions = { initCallback: () => { calls.push(['callback']); if (mode.endsWith('throw')) throw Error('callback'); } };
  Object.defineProperty(props, 'dtraitOption', { get() { calls.push(['dtraitOption']); return { aid: 999 }; } });
  let create;
  if (kind === 'raw') {
    function Base(input) { this.initProps = input; this.hasInit = false; }
    const context = vm.createContext({ P: { A: Base }, sp: { YV: sdk }, Vu: { Ri: getCookie } }); vm.runInContext(raw, context); create = () => new context.Plugin(props);
  } else create = () => new Plugin({ realm, sdk, getCookie }, props);
  const plugin = create();
  if (mode === 'mutable-defaults') { plugin.defaultConfig = { scene: 'changed', signVersion: 11 }; plugin.defaultWebConsumerPathList.push('/extra'); }
  for (let i = 0; i < 2; i++) { try { plugin.init(); } catch (error) { calls.push(['error', error.message]); } calls.push(['hasInit', plugin.hasInit]); }
  const second = create(); try { second.init(); } catch (error) { calls.push(['second-error', error.message]); } calls.push(['second-init', second.hasInit]);
  await Promise.resolve(); return compact(calls);
}
async function main() {
  const { DesktopPassportSecurePlugin } = await import(pathToFileURL(resolve('lib/anti-bot/desktop-passport-secure-plugin.js')).href);
  const modes = ['defaults', 'no-aid', 'disabled', 'dtrait-off', 'paths', 'override', 'null-lists', 'sparse', 'callback', 'callback-throw', 'cookie-first', 'cookie-empty', 'mutable-defaults', 'setConfig-throw', 'setAgidAndHost-throw', 'setWebId-throw', 'start-throw', 'startDTrait-throw'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', DesktopPassportSecurePlugin, mode), await scenario('raw', DesktopPassportSecurePlugin, mode), mode);
  console.log(`PASS ${modes.length} raw C321 hp / SDK initialization traces (synthetic dependencies, no network)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
