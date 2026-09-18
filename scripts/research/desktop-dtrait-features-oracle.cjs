// Pinned original F89–101/F126 and hash A only; no entrypoint, collector, network or account IO.
const vm = require('node:vm'), assert = require('node:assert/strict');
const { resolve } = require('node:path'), { pathToFileURL } = require('node:url');
const { decode } = require('./desktop-dtrait-core-decode.cjs');
function rawFeature(path, bindings) {
  const d = decode(path), allowed = [89,90,91,92,93,94,95,96,97,98,99,100,101,126];
  const context = vm.createContext({ tt: d.strings, et: d.functions.map((f,id) => [allowed.includes(id) ? f.code : [73,0,4], f.argc, f.strict, f.trys]), nt: new Map(), rt: new Map(), Uint8Array,
    TextEncoder: class { encode(value) { return bindings.encoder.encode(value); } }, btoa,
    window: Object.defineProperty({}, 'DTraitUcCryptoJSUtil', { get: bindings.getCryptoUtil }), g: (code) => bindings.onDiagnostic(code) });
  const hashAt = d.source.indexOf('function A(t,e)'), hashEnd = d.source.indexOf('r(5348)', hashAt), vmAt = d.source.indexOf('function it(t,e)'), vmEnd = d.source.indexOf('function ut(t)');
  assert.ok(hashAt > 0 && hashEnd > hashAt && vmAt > hashEnd && vmEnd > vmAt);
  vm.runInContext('var x=new TextEncoder,w={};' + d.source.slice(hashAt,hashEnd) + d.source.slice(vmAt,vmEnd) + 'var ms={};at(et[126],undefined,[],ms);var root={0:A,1:ms[0]};at(et[89],undefined,[],root);globalThis.Feature=root[2];globalThis.hash=A;', context);
  return { Feature: context.Feature, hash: context.hash };
}
const concat = parts => { const bytes = new Uint8Array(parts.reduce((n,v)=>n+v.length,0));let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}return bytes; };
const hex = bytes => Buffer.from(bytes).toString('hex');
const normalize = value => JSON.parse(JSON.stringify(value,(_key,v)=> typeof v === 'bigint' ? 'bigint' : typeof v === 'symbol' ? 'symbol' : v));
function scenario(kind, sdk, mode) {
  const trace=[], diagnostics=[], encoder = { encode(value) { trace.push(['encode',value]);if(mode==='encode-fail') throw Error('synthetic');return new TextEncoder().encode(value); } };
  let getters=0;
  const bindings={encoder, onDiagnostic(code){diagnostics.push(code);}, getCryptoUtil(){trace.push(['util',++getters]);if(mode==='no-util'||mode==='changing-util'&&getters===2)return undefined;return {bufferConcat(parts){trace.push(['concat',parts.map(hex)]);return mode==='null-concat'?null:concat(parts);}};}};
  const raw=kind==='raw'?rawFeature(process.argv[2],bindings):null;
  const hash=raw?raw.hash:sdk.createDesktopDTraitHash(bindings);
  const make=options=>raw?new raw.Feature(options):new sdk.DesktopDTraitFeatures({...bindings,hash,btoa},options);
  let f, result;
  try {
    f=make(mode==='no-options'?undefined:mode==='unknown-version'?{version:1}:mode==='header-overflow'?{reserved:9,dTraitType:0,version:256}:{});
    if(mode==='strings'||mode==='changing-util'){f.addStringFeature('str_1',0x12345678);f.addStringFeature('str_2','abc');}
    if(mode==='bools'){f.addBoolFeature('bool_10',true);f.addBoolFeature('bool_2',false);f.addBoolFeature('bool_1',true);}
    if(mode==='unknown-version'){f.addBoolFeature('bool_1',true);f.addStringFeature('str_1',10);}
    if(mode==='unmapped'){f.addNumFeature('num_1',20);f.addNumFeature('16',20);f.addStringFeature('str_34',1);f.addBoolFeature('bool_11',true);}
    if(mode==='partial-null'||mode==='partial-undefined'){f.addStringFeature('str_1','before');f.addStringFeature('str_1',mode==='partial-null'?null:undefined);}
    if(mode==='bool-blocks')f.boolFeatures={1:true,31:true,32:true,64:true,480:false};
    if(mode==='bool-keys')f.boolFeatures={'32x':true, '-1':true, xyz:true};
    if(mode==='number-order')f.numberFeatures={20:1.9,16:-1,17:2**32+7,18:undefined,19:'abc'};
    if(mode==='bigint'||mode==='symbol')f.numberFeatures={16:mode==='bigint'?1n:Symbol('x')};
    if(mode==='coercion'){let n=0;f.numberFeatures={16:{valueOf(){trace.push(['coerce',++n]);return n;}}};}
    if(mode==='encode-fail'){f.addStringFeature('str_1','abc');f.addStringFeature('str_1','abc');}
    if(mode==='call-order')for(const method of ['getCentralStringBuffer','getEdgeStringBuffer','getNumberBuffer','getBoolBuffer']){const original=f[method];f[method]=function(){trace.push(['method',method]);return original.call(this);};}
    result=f.getResult();
  }catch(error){result={error:error.name};}
  return normalize({result,trace,diagnostics,maps:f&&[f.boolFeatures,f.numberFeatures,f.centralStringFeatures,f.edgeStringFeatures]});
}
async function main(){
  const sdk=await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-features.js')).href);
  const modes=['empty','strings','bools','unknown-version','header-overflow','unmapped','partial-null','partial-undefined','bool-blocks','bool-keys','number-order','bigint','symbol','coercion','encode-fail','call-order','changing-util','no-util','null-concat','no-options'];
  for(const mode of modes)assert.deepStrictEqual(scenario('sdk',sdk,mode),scenario('raw',sdk,mode),mode);
  const bind={encoder:new TextEncoder(),onDiagnostic(){},getCryptoUtil:()=>({bufferConcat:concat})};
  const original=rawFeature(process.argv[2],bind), hash=sdk.createDesktopDTraitHash(bind);
  const inputs=['','a','ab','abc','abcd','abcde','中文','😀','\ud800','toString','constructor','__proto__',42,null,undefined];
  let hashCases=0;
  for(const input of inputs)for(const seed of [0,1,0xffffffff]){assert.equal(hash(input,seed),original.hash(input,seed),String(input));hashCases++;}
  let state=7;
  for(let i=0;i<128;i++){
    const local=new sdk.DesktopDTraitFeatures({...bind,hash,btoa},{}), raw=new original.Feature({});
    for(let j=0;j<33;j++){state=(Math.imul(state,1664525)+1013904223)>>>0;local.addStringFeature('str_'+(j+1),state);raw.addStringFeature('str_'+(j+1),state);}
    for(let j=1;j<=10;j++){local.addBoolFeature('bool_'+j,(state>>j)&1);raw.addBoolFeature('bool_'+j,(state>>j)&1);}
    assert.deepStrictEqual(normalize(local.getResult()),normalize(raw.getResult()),'full map '+i);
  }
  console.log(`PASS ${modes.length} feature traces, ${hashCases} hash vectors, 128 full-mapping comparisons (pinned VM; no collection/network)`);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={rawFeature};
