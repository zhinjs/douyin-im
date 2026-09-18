const requireProductionDependency=require('./desktop-production-loader.cjs');
// Original complete final VM init/matchers vs production config; no hooks on a real host.
const assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const compiled={};new Function('exports','require',ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-config.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(compiled,requireProductionDependency);
function fixture(isOriginal,options={}){
  const trace=[];const target={};
  const window=new Proxy(target,{get(o,k){if(k==='onwheelx'){trace.push('markerGet');if(options.fail==='markerGet')throw Error('markerGet');}return o[k];},set(o,k,v){if(k==='onwheelx'){trace.push('markerSet');if(options.fail==='markerSet')throw Error('markerSet');if(options.markerReadonly)return false;}return Reflect.set(o,k,v);}});
  function Regex(pattern){trace.push(['regex',String(pattern)]);return new RegExp(pattern);}
  const Obj=new Proxy(Object,{get(o,k){if(k==='defineProperty')return function(...args){trace.push(['define',args[1],args[2]]);if(options.fail==='define')throw Error('define');return Object.defineProperty(...args);};return o[k];}});
  const start=function(){'use strict';trace.push(['start',this===null]);if(options.fail==='start')throw Error('start');};
  const context={window,Array,Object:Obj,RegExp:Regex,Symbol,TypeError};
  let init,match,behavior,config;
  if(isOriginal){
    class XHR{open(){}send(){}addEventListener(){}setRequestHeader(){}}
    const bridge={0:Symbol,1:TypeError,2:Obj,3:Array,4:String,5:Number,6:Reflect,7:ReferenceError,8:Proxy,9:Boolean,10:Error,11:isNaN,12:Promise,
      13:window,14:'1.0.1.7',15:{getItem:()=>null},16:XHR,17:URL,19:Date,23:{now:()=>0},28:Regex,49(){}};
    const p=226619,startIndex=source.lastIndexOf('function(e,r,t)',p),end=source.indexOf('"',p+1)+1;
    vm.runInNewContext(`"use strict";(${source.slice(startIndex,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});
    init=bridge[51];const root=init._v[2];root[38]=start;match=root[32];behavior=root[33];config=bridge[50];
  }else{const c=new compiled.DesktopBdmsConfiguration(context,start);init=x=>c.init(x);match=x=>c.matchesSigning(x);behavior=x=>c.matchesBehavior(x);config=c.config;}
  trace.length=0;
  if(options.frozen)Object.freeze(config);
  if(options.markerReadonly&&options.existingMarker)target.onwheelx={_Ax:'existing'};
  return{trace,target,init,match,behavior,config};
}
function snapshot(f){const c=f.config;const regexes=a=>Array.from(a,p=>p instanceof RegExp?[p.source,p.flags,p.lastIndex]:p);
  return{aid:c.aid,pageId:c.pageId,boe:c.boe,ddrt:c.ddrt,dump:c.dump,rpU:c.rpU,paths:{include:regexes(c.paths.include),exclude:regexes(c.paths.exclude)},track:{mode:c.track.mode,delay:c.track.delay,paths:regexes(c.track.paths)},marker:f.target.onwheelx?Object.getOwnPropertyDescriptor(f.target.onwheelx,'_Ax'):undefined};}
function run(isOriginal,options,actions){const f=fixture(isOriginal,options),states=[];
  for(const action of actions){let result;
    try{if(action.path!==undefined){result=[f.match(action.path),f.behavior(action.path)];}
      else {const input=typeof action.input==='function'?action.input(f):action.input;f.init(input);}}
    catch(e){result={error:e.name,message:e.name==='TypeError'?'TypeError':e.message};}
    states.push({result,state:snapshot(f)});
  }return{trace:f.trace,states};}
let comparisons=0;
function compare(options,actions){assert.deepEqual(structuredClone(run(false,options,actions)),structuredClone(run(true,options,actions)));comparisons++;}
compare({},[{input:{}},{input:{aid:3,pageId:4,boe:true,ddrt:7,dump:false,rpU:'x',paths:['/passport'],track:{mode:0,delay:9,paths:['/login']}}},{input:{aid:5,pageId:6}},{path:'/passport/login'}]);
for(const value of [0,-1,NaN,'0',null,false,undefined,2])compare({},[{input:{aid:value,pageId:value,boe:value,ddrt:value,dump:value,rpU:value,track:{mode:value,delay:value,paths:['a']}}},{input:{}},{path:'a'}]);
for(const paths of [['a','['],{include:['a'],exclude:['[']},'bad',{},[],{include:['a'],exclude:['b']}])compare({},[{input:{aid:5,paths}},{input:{paths:['c']}},{path:'a'},{path:'b'},{path:'c'}]);
compare({},[{input:{paths:{include:[/a/g],exclude:[/b/g]},track:{paths:[/a/g]}}},...['a','a','b','ba','a','b'].map(path=>({path}))]);
for(const fail of ['markerSet','markerGet','define','start'])compare({fail},[{input:{aid:1,paths:['a']}},{input:{paths:['b']}}]);
for(const option of [{frozen:true},{markerReadonly:true},{markerReadonly:true,existingMarker:true}])compare(option,[{input:{aid:1,paths:['a'],track:{paths:['b']}}},{input:{}}]);
for(const fail of ['aid','pageId','boe','ddrt','dump','rpU','paths','track'])compare({},[{input:()=>new Proxy({paths:['a']},{get(o,k){if(k===fail)throw Error(fail);return o[k];}})}]);
compare({},[{input:()=>{const paths=[];paths.length=2;paths[1]='a';return{paths};}},{path:'a'}]);
compare({},[{input:()=>{const mapped=[/a/];mapped[Symbol.iterator]=function*(){yield /wrong/;};return{paths:{include:{map:()=>mapped}}};}},{path:'a'}]);
// A custom include.map result exercises the source's Babel iterable conversion.
for(const make of [()=>new Set([/a/]),()=>new Uint8Array([1,2]),()=>null,()=>({})])compare({},[{input:()=>({paths:{include:{map:make}}})},{path:'a'}]);
console.log(JSON.stringify({configComparisons:comparisons,syntheticHost:true,network:false}));
