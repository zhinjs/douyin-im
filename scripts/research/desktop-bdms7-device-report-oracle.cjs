const requireProductionDependency=require('./desktop-production-loader.cjs');
// Final VM device sequencing vs production reporter. Collector bodies are explicit test
// collaborators here; their real production implementations have separate original-VM oracles.
const assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const compiled=ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-device-report.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(options){
  const trace=[],releases={};let aid=1,pageId=2;
  const hit=name=>{trace.push(name);if(options.fail===name)throw Error(name);};
  const idValue={msgType:1};
  const identity=options.nullIdentity?null:options.frozen?Object.freeze(idValue):new Proxy(idValue,{set(o,k,v){hit(`set:${k}`);return Reflect.set(o,k,v);}});
  const collect=name=>{hit(name);const value=name==='identity'?identity:{source:name};
    if(options.delay===name)return new Promise(resolve=>{releases[name]=()=>resolve(value);});
    if(options.reject===name)return Promise.reject(Error(name));
    return value;};
  const config={get aid(){hit('aid');return aid;},get pageId(){hit('pageId');return pageId;}};
  const environment={mask(...args){trace.push(['envArgs',args.length]);hit('env');return 13;}};
  const behavior={mask(...args){trace.push(['qArgs',args.length]);hit('q');return 14;}};
  const sender={send(...args){trace.push(['sendArgs',args.length]);hit('send');trace.push(JSON.parse(JSON.stringify(args[0])));}};
  return {trace,releases,collect,config,environment,behavior,sender,advance(){aid=3;pageId=4;}};
}
function production(f){
  const exports={};
  const modules={
    './desktop-battery.js':{collectDesktopBattery:()=>f.collect('battery')},
    './desktop-device-properties.js':{DesktopDocumentCollector:class{collect(){return f.collect('document');}}},
    './desktop-device-identity.js':{DesktopDeviceIdentityCollector:class{collect(){return f.collect('identity');}}},
    './desktop-navigator.js':{DesktopNavigatorCollector:class{collect(){return f.collect('navigator');}}},
    './desktop-plugins.js':{collectDesktopPlugins:()=>f.collect('plugins')},
    './desktop-fingerprint.js':{collectDesktopReportScreen:()=>f.collect('screen')},
    './desktop-webgl.js':{collectDesktopWebGl:()=>f.collect('webgl')},
    './desktop-window.js':{DesktopWindowCollector:class{collect(){return f.collect('window');}}},
  };
  new Function('exports','require',compiled)(exports,(name)=>name==='./desktop-property-write.js'?requireProductionDependency(name):(name=>{assert(modules[name],name);return modules[name];})(name));
  return new exports.DesktopDeviceReporter({},f.config,f.environment,f.behavior,f.sender).report;
}
function original(f){
  class XHR{open(){}send(){}addEventListener(){}setRequestHeader(){}}
  const bridge={0:Symbol,1:TypeError,2:Object,3:Array,4:String,5:Number,6:Reflect,7:ReferenceError,8:Proxy,9:Boolean,10:Error,11:isNaN,12:Promise,
    13:{},14:'1.0.1.7',15:{getItem:()=>null},16:XHR,17:URL,19:Date,23:{now:()=>0},29:()=>f.environment.mask(),32:()=>f.behavior.mask(),
    39:()=>f.collect('battery'),40:()=>f.collect('document'),41:()=>f.collect('identity'),42:()=>f.collect('navigator'),43:()=>f.collect('plugins'),44:()=>f.collect('screen'),45:()=>f.collect('webgl'),46:()=>f.collect('window'),49(){}};
  const p=226619,start=source.lastIndexOf('function(e,r,t)',p),end=source.indexOf('"',p+1)+1;
  vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});
  bridge[50]=f.config;const root=bridge[51]._v[2];root[25]=f.sender.send;
  return root[27];
}
async function run(isOriginal,options){
  const f=fixture(options),fn=isOriginal?original(f):production(f);let outcome;
  const pending=fn().then(()=>{outcome='fulfilled';},error=>{outcome={error:error.name,message:error.name==='TypeError'?'TypeError':error.message};});
  f.trace.push('returned');
  if(options.delay){for(let i=0;i<8;i++)await Promise.resolve();f.trace.push('release');f.advance();f.releases[options.delay]();}
  await pending;
  return{outcome,trace:f.trace};
}
(async()=>{
  const scenarios=[{},{delay:'battery'},{delay:'identity'},{reject:'battery'},{reject:'identity'},{frozen:true},{nullIdentity:true},
    ...['battery','document','navigator','plugins','screen','webgl','window','identity','env','q','aid','pageId','set:aid','set:pageId','send'].map(fail=>({fail}))];
  for(const scenario of scenarios)assert.deepEqual(await run(false,scenario),await run(true,scenario),JSON.stringify(scenario));
  console.log(JSON.stringify({deviceSequenceComparisons:scenarios.length,syntheticCollectors:true,network:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
