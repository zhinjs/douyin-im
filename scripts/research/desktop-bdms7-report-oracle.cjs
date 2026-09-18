const requireProductionDependency=require('./desktop-production-loader.cjs');
// Pinned original VM, report codec and transport; entirely synthetic hosts, no network.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createHash} = require('node:crypto');
const {join} = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = readFileSync(process.argv[2] || '/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js', 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'd99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
function block(position, bridge) {
  const start=source.lastIndexOf('function(e,r,t)',position),end=source.indexOf('"',position+1)+1;
  vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});
}
const modules={};
function load(name) {
  if(modules[name])return modules[name];
  const exports=modules[name]={};
  const code=ts.transpileModule(readFileSync(join(__dirname, '../../src/anti-bot/',name+'.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(code,{exports,require:(name)=>name==='./desktop-property-write.js'?requireProductionDependency(name):(name=>name==='crypto'?require('node:crypto'):load(name.replace(/^\.\//,'').replace(/\.js$/,'')))(name)},{timeout:3000});
  return exports;
}
const {encodeDesktopReportData}=load('aBogus'),{DesktopReportSender}=load('desktop-report'),{DesktopTokenState}=load('desktop-token');
function codec(math) {
  const rc={0:String};block(199581,rc);
  const b64={0:String,1:math,2:rc[1]};block(203205,b64);
  return b64[4];
}
let codecComparisons=0,transportComparisons=0;
const inputs=['','a','ab','abc','abcd','{}','{"text":"你好😀"}','\ud800','\udfff','a\0b','é€Ā','x'.repeat(4097)];
for(const input of inputs)for(const random of input.length>4096?[0,.5,1-Number.EPSILON]:Array.from({length:256},(_,key)=>key/256)) {
  let originalDraws=0,productionDraws=0;
  const expected=codec({floor:Math.floor,random(){originalDraws++;return random;}})(input);
  const actual=encodeDesktopReportData(input,{floor:Math.floor,random(){productionDraws++;return random;}});
  assert.equal(actual,expected,JSON.stringify({input:input.slice(0,25),random}));
  assert.equal(originalDraws,1);assert.equal(productionDraws,1);codecComparisons++;
}
for(const input of [undefined,null]) {
  const execute=original=>{let draws=0,error;const math={floor:Math.floor,random(){draws++;return .5;}};
    try{(original?codec(math):value=>encodeDesktopReportData(value,math))(input);}catch(e){error=e.name;}
    return{draws,error};};
  assert.deepEqual(execute(false),execute(true));codecComparisons++;
}

function fixture(options={}) {
  const trace=[], requests=[], callbacks=[];
  let failed=false;
  class XHR {
    constructor(){trace.push('new');requests.push(this);this.listeners=[];}
    set withCredentials(value){trace.push(`credentials:${value}`);if(options.credentialsError)throw Error('credentials');}
    addEventListener(type,fn){trace.push(`captured:listener:${type}`);if(options.fail==='listener'&&!failed){failed=true;throw Error('captured');}this.listeners.push(fn);}
    open(...args){trace.push(['captured:open',...args]);if(options.fail==='open'&&!failed){failed=true;throw Error('captured');}}
    send(body){trace.push(['captured:send',body]);if(options.fail==='send'&&!failed){failed=true;throw Error('captured');}}
    getResponseHeader(name){trace.push(`header:${name}`);return 'issued';}
  }
  const context={XMLHttpRequest:XHR,URL,JSON,Date:{now(){trace.push('now');return 1234;}},
    navigator:{sendBeacon(...args){trace.push(['beacon',...args]);if(options.beaconError)throw Error('beacon');return options.beaconReturn??true;}},
    localStorage:{getItem(){trace.push('get:xmst');return options.token||null;},setItem(...args){trace.push(['set',...args]);}},
    requestAnimationFrame(fn){trace.push('raf');callbacks.push(fn);},
  };
  const math={floor:Math.floor,random(){trace.push('random');return .5;}};
  context.Math=math;
  const config={aid:339757,boe:options.boe||false,rpU:options.rpU||''};
  return{trace,requests,context,config,math};
}
function run(original,options) {
  const f=fixture(options);let send;
  if(original) {
    const stop=Error('stop');
    const bridge={13:{},14:'1.0.1.7',15:f.context.localStorage,16:f.context.XMLHttpRequest,17:URL,18:JSON,
      19:f.context.Date,20:f.context.navigator,21:f.context.requestAnimationFrame,23:{now(){throw stop;}},
      47:codec(f.math),49(){}};
    try{block(226619,bridge);assert.fail('stop not reached');}catch(e){assert.equal(e,stop);}
    Object.assign(bridge[50],f.config);send=bridge[51]._v[2][25];
  } else {
    const tokens=new DesktopTokenState(f.context);
    const sender=new DesktopReportSender(f.context,f.config,tokens,()=>{});
    send=sender.send.bind(sender);
  }
  if(options.replace) {
    const prototype=f.context.XMLHttpRequest.prototype;
    prototype.addEventListener=function(type,fn){f.trace.push(`current:listener:${type}`);if(options.currentError)throw Error('current');this.listeners.push(fn);};
    prototype.open=function(...args){f.trace.push(['current:open',...args]);};
    prototype.send=function(body){f.trace.push(['current:send',body]);};
  }
  let error;
  try{send(options.undefinedReport?undefined:{text:'你好😀'},options.beacon);if(!options.beacon)f.requests[0].listeners[0]?.();}
  catch(e){error=e.name+':'+(e instanceof TypeError||e.name==='TypeError'?'TypeError':e.message);}
  return{trace:f.trace,error};
}
const cases=[{}, {token:'cached'}, {boe:true}, {rpU:'https://custom.invalid/'}, {replace:true},
  {fail:'listener',replace:true},{fail:'open',replace:true},{fail:'send',replace:true},
  {fail:'open'}, {fail:'open',replace:true,currentError:true}, {credentialsError:true},
  {beacon:true}, {beacon:true,beaconReturn:false}, {beacon:true,beaconError:true},
  {beacon:true,credentialsError:true}, {undefinedReport:true}, {rpU:'://invalid'},
];
for(const options of cases){assert.deepEqual(run(false,options),run(true,options),JSON.stringify(options));transportComparisons++;}
console.log(JSON.stringify({codecComparisons,transportComparisons,network:false}));
