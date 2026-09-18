// Original scheduler and aggregate VM only, supplied task registry; no browser/real collection/network.
const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs');
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function rawCollection(path,bindings){
  const d=decode(path), s=d.source;
  const begin=s.indexOf('function zt(t,e)'),end=s.indexOf('ot(127,',begin);
  const q=s.indexOf('Qt=function(t,e)'),qend=s.indexOf(';ot(102,',q);
  const a=s.indexOf('function it(t,e)'),b=s.indexOf('function ut(t)',a);
  const helper=s.indexOf('function t(t,e,r,n,o,i,a)'),helperEnd=s.indexOf('r.r(n)',helper);
  assert.ok(begin>0&&end>begin&&qend>q&&b>a&&helperEnd>helper);
  const context=vm.createContext({...bindings,tt:d.strings,et:d.functions.map((f,id)=>[id>=102&&id<=154?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});
  vm.runInContext('"use strict";'+s.slice(helper,helperEnd)+s.slice(a,b)+s.slice(begin,end)+'var '+s.slice(q,qend)+';globalThis.prepare=Zt;globalThis.make=it;globalThis.retry=Qt;globalThis.asyncWrap=e;',context);
  return {prepare:context.prepare, aggregate(plugins){
    const root=[plugins.audio,plugins.boolFeature,plugins.canvas,plugins.css,plugins.domRect,plugins.math,plugins.mediaTypes,plugins.speech,plugins.strFeature,plugins.svgRect,plugins.webGL,plugins.fonts,context.prepare];
    context.make(127,root)();
    const out=[context.asyncWrap,root[16],context.retry];context.make(102,out)();return out[3];
  }};
}
const normalize=value=>JSON.parse(JSON.stringify(value,(_key,v)=>v instanceof Error?{name:v.name,message:v.message}:v));
async function scenario(kind,sdk,mode){
  let now=100,resolvePending;const trace=[];
  const context={Date:{now:()=>now},setTimeout(callback,ms){trace.push(['timer',ms]);Promise.resolve().then(callback);return 1;}};
  const raw=kind==='raw'?rawCollection(process.argv[2],context):null;
  const prepare=(tasks,options,budget)=>raw?raw.prepare(tasks,options,budget):sdk.prepareDesktopDTraitCollection(context,tasks,options,budget);
  const options={cache:{},debug:false};
  const task=name=>()=>{trace.push(['start',name]);now+=4;return {name};};
  let tasks={a:task('a'),b:task('b')}, result;
  if(mode==='values')tasks={zero:()=>0,nil:()=>null,missing:()=>undefined};
  if(mode==='throw')tasks={a:()=>{throw Error('initial');},b:task('b')};
  if(mode==='async')tasks={a:async()=>{trace.push(['async']);return 4;},b:async()=>{throw Error('async');}};
  if(mode==='thenable')tasks={a:()=>({then(done){trace.push(['then']);done(5);}}),b:()=>Object.defineProperty({},'then',{get(){throw Error('getter');}})};
  if(mode==='phase-two'||mode==='phase-error'||mode==='twice')tasks={a:()=>{trace.push(['phase1']);now+=3;return ()=>{trace.push(['phase2']);now+=7;if(mode==='phase-error')throw Error('second');return 9;};}};
  if(mode==='pending')tasks={a:()=>{trace.push(['pending']);return new Promise(resolve=>{resolvePending=resolve;});},b:task('b')};
  if(mode==='own-only')tasks=Object.assign(Object.create({inherited:()=>{throw Error('inherited ran');}}),tasks);
  if(mode==='invalid-task')tasks={a:null};
  if(mode==='slice'||mode==='slice-last')tasks=Object.fromEntries(Array.from({length:mode==='slice-last'?1:10},(_,i)=>['t'+i,()=>{trace.push(['start',i]);now+=16;return i;}]));
  if(mode==='options')tasks={a(o){trace.push(['same-options',o===options]);o.cache.x=2;return 1;},b(o){return o.cache.x;}};
  try{
    const run=prepare(tasks,options,mode==='budget-zero'?0:undefined);trace.push(['prepared']);
    let pending=run();
    if(mode==='pending'){await flush();trace.push(['release']);now+=20;resolvePending(8);}
    result=await pending;
    if(mode==='twice'){now+=100;result=[result,await run()];}
  }catch(error){result={error:error.name};}
  return normalize({trace,result});
}
async function aggregateScenario(kind,sdk,mode){
  const trace=[];let now=1,attempts=0;
  const context={Date:{now:()=>now},setTimeout(callback){Promise.resolve().then(callback);}};
  const names=['boolFeature','strFeature','canvas','audio','css','domRect','mediaTypes','speech','svgRect','math','webGL','fonts'];
  const plugins=Object.fromEntries(names.map(name=>[name,options=>{
    trace.push(name);now++;
    assert.equal(options.debug,false);
    if(name==='boolFeature'){attempts++;return {bool_1:true};}
    if(mode==='one-error'&&name==='canvas')throw Error('single');
    if((mode==='retry'||mode==='exhaust')&&name==='canvas')return Object.defineProperty({},'str_1',{enumerable:true,get(){if(mode==='exhaust'||attempts<3)throw Error('aggregate');return 5;}});
    return {[name]:1,shared:name};
  }]));
  const local=kind==='sdk'?new sdk.DesktopDTraitCollector(context,plugins):null;
  const collect=kind==='raw'?rawCollection(process.argv[2],context).aggregate(plugins):local.collect.bind(local);
  const result=await collect();return normalize({result,trace,attempts});
}
async function main(){
  const sdk=await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-collector.js')).href);
  const modes=['default','values','throw','async','thenable','phase-two','phase-error','twice','pending','own-only','invalid-task','slice','slice-last','budget-zero','options'];
  for(const mode of modes)assert.deepStrictEqual(await scenario('sdk',sdk,mode),await scenario('raw',sdk,mode),mode);
  for(const mode of ['default','one-error','retry','exhaust'])assert.deepStrictEqual(await aggregateScenario('sdk',sdk,mode),await aggregateScenario('raw',sdk,mode),'aggregate '+mode);
  console.log(`PASS ${modes.length} scheduler traces and 4 original VM aggregate/retry comparisons (synthetic tasks only)`);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={rawCollection};
