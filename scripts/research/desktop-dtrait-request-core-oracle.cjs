const assert = require('node:assert/strict'), { resolve } = require('node:path'), { pathToFileURL } = require('node:url');
const { createRawCore } = require('./desktop-dtrait-core-raw.cjs');
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const compact = value => JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error ? { name: item.name } : item));
async function scenario(kind, sdk, mode) {
  const calls = []; let now = 1_000_999, hooks;
  const monitor = { sendSlardarEvent(value) { calls.push(['event', value]); if (mode === 'monitor-throw') throw Error('metric'); }, sendTeaLog(...args) { calls.push(['tea', ...args]); }, sendSlardarLog(...args) { calls.push(['log', ...args]); } };
  const aes = { getAesKey: () => new Uint8Array(16), encryptData: async (key, text) => { calls.push(['aes', key, text]); if (mode === 'aes-fail' && text.includes('sdkVersion')) throw Error('aes'); return { cipherText: 'cipher', iv: 'unused' }; } }, rsa = { encryptData: async () => 'rsa' }, util = { uint8ArrayToHex: () => 'hex' };
  const feature = { addBoolFeature: (k,v) => calls.push(['bool',k,v]), addNumFeature: (k,v) => calls.push(['num',k,v]), addStringFeature: (k,v) => calls.push(['str',k,v]), getResult: () => ({ centralString: 'central', edgeString: 'edge' }) }, clock = { now: () => now }, performance = { now: () => 3 };
  let core;
  if (kind === 'raw') {
    ({ core } = createRawCore(process.argv[2], { globals: { Promise, Date: clock, Math, JSON, Object, Array, atob, performance, window: { DTraitUcAesEncrypt: aes, DTraitUcRsaEncrypt: rsa, DTraitUcCryptoJSUtil: util } },
      Transport: class { constructor(value) { hooks = value; } }, FeatureProtocol: class { constructor() { Object.assign(this, feature); } }, collect: async () => {}, params: { centralVersion: 'c', edgeVersion: 'e' } }));
    await flush(); core.updateMonitor(monitor); await flush();
  } else {
    core = new sdk.DesktopDTraitRequestCore({ Date: clock, performance, atob, crypto: { aes, rsa, util }, featureProtocol: feature, monitor, collect: async()=>({}), installHooks(value) { hooks = value; } }, { centralVersion: 'c', edgeVersion: 'e' }); await flush();
  }
  calls.length = 0; const config = { pathname: '/original/child', host: 'one.invalid', headers: { keep: 'value' } }, meta = { ucProxyParam: { previous: 1 } }; let result;
  try {
    if (mode === 'hook') { core.updateDTraitPath(['/prefix']); core.updateDTraitHost(['good']); result = ['/none','/prefix/x','/none','/prefix2'].map((pathname,i) => hooks.hookConfig({ pathname, host: i === 2 ? 'good.evil' : 'bad' })); }
    else if (mode === 'append') { core.updateDTraitPath(['/a']); core.updateDTraitPath(['/a']); core.updateDTraitHost(['h']); core.updateUrlRewriteRules([['a','b']]); result = [core.dTraitHooksPath,core.dTraitHooksHost,core.dTraitUrlRewriteRules]; }
    else if (mode === 'rewrite') { core.updateUrlRewriteRules([null, ['/original','/middle'], ['/middle','/final']]); result = await core.getDTraitHeader({ path: config.pathname }); }
    else if (mode.startsWith('update')) {
      const bool=Object.assign(Object.create({inherited:true}),{own:true});
      const input=mode==='update-empty'?{}:mode==='update-null'?null:{get bool(){calls.push(['get','bool']);return bool;},get num(){calls.push(['get','num']);return {n:1};},get str(){calls.push(['get','str']);return {s:2};}};
      core.dTraitPathCache.old={time:1,val:null};
      if(mode==='update-pending')core.getDTrait=()=>new Promise(()=>{});
      result=core.updateFeature(input);
    }
    else if (mode === 'edge') result = await core.getEdgeData({ path: config.pathname });
    else if (mode === 'header' || mode === 'aes-fail') result = await core.getDTraitHeader({ path: config.pathname });
    else if (mode.startsWith('error')) {
      meta.ucProxyParam.startTime = mode === 'error-zero' ? 0 : now - 12;
      result = hooks.errorRequestConfig({ config, instance: meta, errType: 'network', err: { reason: 'synthetic' } });
      // Deliberate SDK privacy divergence: raw serializes err; compare log invocation but redact its payload.
      for (const call of calls) if (call[0] === 'log') call[1].content = '[request error]: [redacted]';
    }
    else if (mode.startsWith('response')) {
      const response = { config, httpCode: 200, headers: mode === 'response-string' ? 'raw' : mode === 'response-zero' ? { 'x-tt-session-dtrait-token': 0 } : { 'x-tt-session-dtrait-token': 12, 'x-tt-logid': 'log' } };
      meta.ucProxyParam.startTime = now - 12; if (mode === 'response-quiet') config.pathname = '/passport/web/get_qrcode/';
      result = await hooks.processResponseConfig(response, meta);
    } else {
      core.collectStatus = mode !== 'not-collected';
      if (mode === 'quiet') config.pathname = '/passport/web/get_qrcode/';
      if (mode === 'null-header') core.getDTraitHeader = async () => null;
      if (mode === 'bad-header') core.getDTraitHeader = async () => ({});
      if (mode === 'generation-fail') core.getDTraitHeader = async () => { throw Error('generation'); };
      result = await hooks.processRequestConfig(config, meta);
      if (['cache', 'not-collected', 'ttl-expired', 'ttl-valid', 'cross-host'].includes(mode)) {
        now += mode === 'ttl-expired' ? 600000 : mode === 'ttl-valid' ? 599999 : 1;
        result = await hooks.processRequestConfig({ ...config, host: mode === 'cross-host' ? 'two.invalid' : config.host }, {});
      }
    }
  } catch (error) { result = { error: error.name, message: mode === 'update-null' ? undefined : error.message }; }
  await flush(); return compact({ calls, result, meta, cache: core.dTraitPathCache, token: core.dTraitToken });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-request-core.js')).href);
  const modes = ['header','edge','rewrite','aes-fail','hook','append','request','quiet','null-header','bad-header','generation-fail','cache','not-collected','ttl-expired','ttl-valid','cross-host','response','response-string','response-zero','response-quiet','error','error-zero','update','update-empty','update-null','update-pending'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk',sdk,mode),await scenario('raw',sdk,mode),mode);
  console.log(`PASS ${modes.length} pinned raw core / SDK request-state traces (original VM class, synthetic transport/collector/crypto)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
