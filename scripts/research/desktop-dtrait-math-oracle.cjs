// Original Math collector and original hash, isolated from browser collectors/account IO.
const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs');
const {rawFeature}=require('./desktop-dtrait-features-oracle.cjs');
function rawMath(path,math,hash){
  const d=decode(path),a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);
  const context=vm.createContext({Math:math,tt:d.strings,et:d.functions.map((f,id)=>[id>=227&&id<=231?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});
  vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',context);
  const scope=[hash];context.make(227,scope)();return {collect:scope[1],context};
}
function scenario(kind,sdk,mode){
  const calls=[],trace=[],math=Object.create(Math);
  if(mode.startsWith('missing:')){const [,name,value]=mode.split(':');Object.defineProperty(math,name,{value:[undefined,null,false,0,''][Number(value)],writable:true});}
  if(mode==='all-missing')for(const name of ['acos','atanh','sin','cos','tan','expm1'])Object.defineProperty(math,name,{value:undefined});
  if(mode==='truthy')Object.defineProperty(math,'acos',{value:1});
  if(mode==='receiver')for(const [i,name] of ['acos','atanh','sin','cos','tan','expm1','pow','log'].entries())Object.defineProperty(math,name,{value:function(value){'use strict';calls.push([name,value,this===undefined?'undefined':this===math?'math':'other']);return i+1;}});
  const io={encoder:new TextEncoder(),onDiagnostic(){throw Error('unexpected diagnostic');},getCryptoUtil:()=>undefined};
  const hash=kind==='raw'?rawFeature(process.argv[2],io).hash:sdk.createDesktopDTraitHash(io);
  const tracked=value=>{trace.push(value);if(mode==='hash:'+trace.length)throw Error('hash');return hash(value);};
  const ctx={Math:math,hash:tracked};
  const raw=kind==='raw'?rawMath(process.argv[2],math,tracked):null;
  const collect=raw?raw.collect:sdk.createDesktopDTraitMathCollector(ctx);
  if(mode==='capture'){ctx.Math=Object.create(Math);Object.defineProperty(ctx.Math,'acos',{value:()=>123});if(raw)raw.context.Math=ctx.Math;}
  let result;try{result=collect();}catch(error){result={error:error.name};}
  return {result:JSON.parse(JSON.stringify(result)),trace,calls};
}
async function main(){
  const sdk={...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-math.js')).href),...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-features.js')).href)};
  const modes=['native','all-missing','truthy','receiver','capture','hash:1','hash:8','hash:9','hash:10', 'missing:log:0','missing:pow:0','missing:PI:0'];
  for(const name of ['acos','atanh','sin','cos','tan','expm1'])for(let i=0;i<5;i++)modes.push(`missing:${name}:${i}`);
  for(const mode of modes)assert.deepStrictEqual(scenario('sdk',sdk,mode),scenario('raw',sdk,mode),mode);
  console.log(`PASS ${modes.length} original VM Math + original hash comparisons (actual host Math or explicit synthetic inputs; no browser/network)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
