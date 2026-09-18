const requireProductionDependency=require('./desktop-production-loader.cjs');
// Battery H, classifier G and document V against complete original VM blocks.
// All navigator/document objects are synthetic; no hardware, account or network access.
const assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
function block(position,bridge){const start=source.lastIndexOf('function(e,r,t)',position),end=source.indexOf('"',position+1)+1;vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});return bridge;}
function load(name){const exports={};const code=ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/',name+'.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;new Function('exports','require',code)(exports,requireProductionDependency);return exports;}
const {collectDesktopBattery}=load('desktop-battery'),{DesktopPropertyClassifier,DesktopDocumentCollector}=load('desktop-device-properties');
let batteryComparisons=0,propertyComparisons=0;
async function batteryRun(original,options={}) {
  const trace=[];let release;
  const read=(name,value)=>{trace.push(name);if(options.fail===name)throw Error(name);return value;};
  const numeric={ [Symbol.toPrimitive](hint){trace.push(`primitive:${hint}`);return 2;}};
  const values=options.empty?{}:{charging:options.falsy?false:true,chargingTime:Infinity,dischargingTime:0,level:.555};
  if(options.convert)Object.assign(values,{chargingTime:numeric,dischargingTime:numeric,level:numeric});
  if(options.symbol)values.chargingTime=Symbol('bad');if(options.bigint)values.level=1n;
  const manager=new Proxy(values,{get:(o,k)=>k==='then'?undefined:read(k,o[k])});
  const nav={get getBattery(){return read('getBattery',function(){trace.push(['callReceiver',this===nav]);if(options.fail==='call')throw Error('call');
    if(options.reject)return Promise.reject(Error('reject'));
    if(options.nullResult)return null;
    if(options.thenError)return {get then(){throw Error('then');}};
    if(options.pending)return new Promise(resolve=>{release=resolve;});
    return manager;});}};
  const math={get round(){return read('round',function(value){trace.push(['roundReceiver',this===math]);return Math.round(value);});}};
  const context={get navigator(){return read('navigator',nav);},Math:math};
  const fn=original?block(128542,{0:Symbol,1:Object,2:Error,3:TypeError,4:isNaN,5:Promise,get 6(){return context.navigator;},7:math})[8]:()=>collectDesktopBattery(context);
  const pending=fn();trace.push('returned');if(release){values.level=.75;release(manager);trace.push('released');}
  const value=await pending;
  return {value:structuredClone(value),trace};
}
function classifier(original,symbol=Symbol){if(original){const b=block(145817,{0:symbol,1:Object,2:{}});return{classify:b[3]};}return new DesktopPropertyClassifier({Symbol:symbol,Object});}
function outcome(fn){try{return{value:structuredClone(fn())};}catch(e){return{error:e.name,message:e.name==='TypeError'?'TypeError':e.message};}}
async function main(){
  const batteries=[{}, {empty:true},{falsy:true},{pending:true},{reject:true},{nullResult:true},{thenError:true},{convert:true},{symbol:true},{bigint:true},
    ...['navigator','getBattery','call','charging','chargingTime','dischargingTime','round','level'].map(fail=>({fail}))];
  for(const options of batteries){assert.deepEqual(await batteryRun(false,options),await batteryRun(true,options),JSON.stringify(options));batteryComparisons++;}
  const values=[true,false,new Boolean(true),()=>{},async()=>{},function*(){},undefined,0,NaN,Infinity,new Number(1),'','text',new String(''),[],[1],{},null,1n,Symbol('a'),Object(Symbol('b')),new Date(0),/x/,
    ...['HTMLAllCollection','Storage','Array','Number','Unknown'].map(tag=>({[Symbol.toStringTag]:tag,length:0})),
    {get [Symbol.toStringTag](){throw Error('tag');}}, {[Symbol.toStringTag]:'Array',get length(){throw Error('length');}}];
  const a=classifier(true),b=classifier(false);
  for(const value of values){assert.deepEqual(outcome(()=>b.classify({value},'value')),outcome(()=>a.classify({value},'value')));propertyComparisons++;}
  for(const target of [null,undefined,{get value(){throw Error('read');}}]){assert.deepEqual(outcome(()=>b.classify(target,'value')),outcome(()=>a.classify(target,'value')));propertyComparisons++;}
  function legacyRun(original){function SymbolShim(){};const c=classifier(original,SymbolShim);const trace=[];
    const input={get constructor(){trace.push('constructor');return SymbolShim;},[Symbol.toStringTag]:'Unknown'};
    const first=c.classify({input},'input');SymbolShim.iterator=Symbol('now-native');const second=c.classify({input},'input');return{first,second,trace};}
  assert.deepEqual(legacyRun(false),legacyRun(true));propertyComparisons++;
  function modernRun(original){function SymbolShim(){};SymbolShim.iterator=Symbol('native');const c=classifier(original,SymbolShim);
    const input={constructor:SymbolShim,[Symbol.toStringTag]:'Unknown'};const first=c.classify({input},'input');delete SymbolShim.iterator;return[first,c.classify({input},'input')];}
  assert.deepEqual(modernRun(false),modernRun(true));propertyComparisons++;
  for(const fail of [undefined,'document','all','characterSet','compatMode','documentMode','images','layers','tag','setFalse','setError','multiple','null','symbol']) {
    function run(original){const trace=[];
      const values={all:undefined,characterSet:'UTF-8',compatMode:'CSS1Compat',documentMode:undefined,images:[],layers:null};
      if(fail==='tag')values.all={get [Symbol.toStringTag](){throw Error('tag');}};
      if(fail==='symbol')values.characterSet=Symbol('bad');
      const doc=fail==='null'?null:new Proxy(values,{
        get(o,k){trace.push(k);if(fail===k||(['setFalse','setError','multiple'].includes(fail)&&k==='all')||(fail==='multiple'&&k==='images'))throw Error(k);return o[k];},
        set(o,k,value){trace.push(['set',k]);if(fail==='setError')throw Error('setError');if(fail==='setFalse')return false;return Reflect.set(o,k,value);},
      });
      const context={Symbol,Object,get document(){trace.push('document');if(fail==='document')throw Error('document');return doc;}};
      const collector=new DesktopDocumentCollector(context);
      const fn=original?block(145817,{0:Symbol,1:Object,get 2(){return context.document;}})[4]:()=>collector.collect();
      // Do not clone a returned Proxy: exceptional nested G calls can return doc itself.
      let result;
      const value=outcome(()=>{result=fn();return result===doc?values:result;});
      return{...value,returnedDocument:result===doc,trace};}
    assert.deepEqual(run(false),run(true),`document ${fail}`);propertyComparisons++;
  }
  console.log(JSON.stringify({batteryComparisons,propertyComparisons,syntheticHosts:true,network:false}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
