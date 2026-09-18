const requireProductionDependency=require('./desktop-production-loader.cjs');
// Offline original-interpreter fixture. No network, accounts, or source/bytecode patches.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createHash} = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
const {join} = require('node:path');
const source = readFileSync(process.argv[2] || '/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js', 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'd99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');

function evaluateBlock(position, bridge) {
  const start = source.lastIndexOf('function(e,r,t)', position);
  const end = source.indexOf('"', position + 1) + 1;
  return vm.runInNewContext(`"use strict";(${source.slice(start, end)},bridge,void 0))`, {require:requireProductionDependency,bridge}, {timeout:3000});
}

function originalWrapper(context) {
  const stop = new Error('fixture stops unrelated module initialization');
  const bridge = {
    19:context.Date, 20:context.navigator, 28:RegExp,
    29:context.environmentMask, 32:context.behaviorMask, 48:context.core,
    49(){throw stop;}, 50:context.state,
  };
  try {evaluateBlock(226619, bridge);assert.fail('fixture stop not reached');} catch(error) {assert.equal(error, stop);}
  // The original VM's function objects expose their captured lexical frame.
  // Root PC10880 exports ye before PC10888 calls Ie; slot34 is the request wrapper.
  const wrapper = bridge[51]._v[2][34];
  assert.equal(wrapper._v[0], 7594);
  return wrapper;
}

const wrapperJs=ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-request-signer.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
function productionWrapper(context) {
  const exports={};
  const dependencies={
    './aBogus.js':{generateDesktopABogusWithRuntime(input){return context.core(0,input.environmentMask,input.behaviorMask,input.query,input.body,input.userAgent);}},
    './desktop-environment-mask.js':{DesktopEnvironmentState:class{mask(){return context.environmentMask();}}},
    './desktop-behavior.js':{}, './desktop-fingerprint.js':{},
  };
  vm.runInNewContext(wrapperJs,{exports,require:(name)=>name==='./desktop-property-write.js'?requireProductionDependency(name):(name=>{assert(name in dependencies,name);return dependencies[name];})(name)},{timeout:3000});
  const signer=new exports.DesktopRequestSigner(context,context.state,{mask:context.behaviorMask});
  return signer.sign.bind(signer);
}

let checks = 0;
function equal(actual, expected, label) {assert.deepEqual(actual, expected, label);checks++;}
function fixture(options={}) {
  const trace=[];
  const proto={};
  const navigator=Object.create(proto);
  Object.defineProperty(navigator, '__proto__', {get(){trace.push('navigator.__proto__');return proto;}});
  Object.defineProperty(navigator, 'userAgent', {get(){trace.push('navigator.userAgent');return options.ua ?? ' fixture UA ';}});
  const context={navigator, Date:{now(){trace.push('Date.now');return 1000;}},
    environmentMask(){trace.push('M');return 521;},
    behaviorMask(){trace.push('q');return 14;},
    state:{get track(){trace.push('track');return {get mode(){trace.push('mode');return options.mode ?? 0;}};}},
    core(...args){trace.push('core');return args;},
  };
  return {context,trace,proto,navigator};
}
const cases = [
  {name:'string without content type',body:'a=1',expected:'a=1'},
  {name:'form',body:'a=1',type:'application/x-www-form-urlencoded',expected:'a=1'},
  {name:'multipart substring',body:'a=1',type:'prefixmultipart/form-datasuffix',expected:''},
  {name:'multipart case-sensitive',body:'a=1',type:'MULTIPART/FORM-DATA',expected:'a=1'},
  {name:'empty content type',body:'a=1',type:'',expected:'a=1'},
  {name:'non-string body',body:{value:1},type:12,expected:''},
  {name:'undefined body',expected:''},
  {name:'boxed string body',body:new String('a=1'),expected:''},
  {name:'Baidu suffix',body:'',ua:'baiduboxapp fixture EasyBrowserWebCore=0xabcdef123',expectedUA:'baiduboxapp fixture'},
  {name:'Baidu suffix must end',body:'',ua:'baiduboxapp fixture WebCore=0xabcdef123 ',expectedUA:'baiduboxapp fixture WebCore=0xabcdef123 '},
  {name:'Baidu lowercase w',body:'',ua:'baiduboxapp fixture webCore=0xabcdef123',expectedUA:'baiduboxapp fixture'},
  {name:'Baidu uppercase hex retained',body:'',ua:'baiduboxapp fixture WebCore=0xABCDEF123',expectedUA:'baiduboxapp fixture WebCore=0xABCDEF123'},
  {name:'Alipay first match only',body:'',ua:'AlipayClient ChannelId(12) ChannelId(34)',expectedUA:'AlipayClient ChannelId(34)'},
  {name:'both UA rules ordered',body:'',ua:'AlipayClient ChannelId(12) baiduboxapp EasyBrowserWebCore=0xabcdef123',expectedUA:'AlipayClient baiduboxapp'},
  {name:'UA markers case-sensitive',body:'',ua:'BaiduBoxApp Alipayclient ChannelId(12) WebCore=0xabcdef123',expectedUA:'BaiduBoxApp Alipayclient ChannelId(12) WebCore=0xabcdef123'},
];
for(const item of cases) {
  const f=fixture(item);
  equal(Array.from(originalWrapper(f.context)('q=a',item.body,item.type)), [0,521,14,'q=a',item.expected ?? '',item.expectedUA ?? ' fixture UA '], item.name);
  equal(f.trace, ['Date.now','navigator.__proto__','M','track','mode','q','navigator.userAgent','core'], `${item.name}: evaluation order`);
  equal(f.proto.vendorSubs.ink,999,`${item.name}: prototype ink`);
  const p=fixture(item);
  equal(Array.from(productionWrapper(p.context)('q=a',item.body,item.type)),Array.from(originalWrapper(fixture(item).context)('q=a',item.body,item.type)),`${item.name}: production wrapper arguments`);
  equal(p.trace,f.trace,`${item.name}: production wrapper order`);
}
for(const mode of [1,2,'0',null,false,undefined]) {
  const f=fixture();
  f.context.state={track:{mode}};
  equal(originalWrapper(f.context)('q','')[2],0,`mode ${String(mode)} uses strict zero`);
  equal(f.trace.includes('q'),false,'nonzero does not evaluate q');
}
{
  const f=fixture();
  Object.defineProperty(f.proto,'vendorSubs',{value:{ink:25},writable:false});
  assert.throws(()=>originalWrapper(f.context)('q',''),e=>e.name==='TypeError');checks++;
  assert.throws(()=>productionWrapper(f.context)('q',''),e=>e.name==='TypeError');checks++;
  equal(f.proto.vendorSubs.ink,25,'strict write rejects before changing the readonly value');
}
{
  const f=fixture();
  f.navigator.vendorSubs={ink:5};
  originalWrapper(f.context)('q','');
  equal(f.navigator.vendorSubs.ink,5,'own property shadows written prototype');
  equal(f.proto.vendorSubs.ink,999,'shadow does not prevent prototype write');
}
{
  const f=fixture();
  Object.defineProperty(f.proto,'vendorSubs',{set(value){f.trace.push(`setter:${value.ink}:${this===f.proto}`);}});
  originalWrapper(f.context)('q','');
  equal(f.trace.slice(0,4),['Date.now','navigator.__proto__','setter:999:true','M'],'prototype setter receiver and order');
}
{
  const f=fixture();
  Object.defineProperty(f.proto,'vendorSubs',{set(){throw Error('setter failure');}});
  assert.throws(()=>originalWrapper(f.context)('q',''),/setter failure/);checks++;
  equal(f.trace,['Date.now','navigator.__proto__'],'assignment exception precedes M');
}
{
  const f=fixture();
  const type={indexOf(){f.trace.push('contentType.indexOf');return '-1';}};
  equal(originalWrapper(f.context)('q','body',type)[4],'body','multipart uses loose != -1');
  equal(f.trace.indexOf('contentType.indexOf')<f.trace.indexOf('navigator.userAgent'),true,'body normalization before UA');
}

for(const [name,configure] of [
  ['non-writable',f=>Object.defineProperty(f.proto,'vendorSubs',{value:{ink:5},writable:false})],
  ['non-extensible',f=>Object.preventExtensions(f.proto)],
  ['shadowed',f=>{f.navigator.vendorSubs={ink:5};}],
  ['setter throws',f=>Object.defineProperty(f.proto,'vendorSubs',{set(){throw Error('setter failure');}})],
  ['setter receiver',f=>Object.defineProperty(f.proto,'vendorSubs',{set(value){f.trace.push(`setter:${value.ink}:${this===f.proto}`);}})],
  ['loose content type',()=>{}],
]) {
  const run=build=>{
    const f=fixture();configure(f);let result;
    try {result=Array.from(build(f.context)('q','body',name==='loose content type'?{indexOf:()=>'-1'}:undefined));}
    // Native strict-write diagnostics differ by engine; retain explicit setter errors.
    catch(error){result={error:error.name,...(error.name==='TypeError'?{}:{message:error.message})};}
    return {result,trace:f.trace,ownInk:f.navigator.vendorSubs?.ink,prototypeInk:f.proto.vendorSubs?.ink};
  };
  equal(run(productionWrapper),run(originalWrapper),`production wrapper boundary: ${name}`);
}

// Exercise the original core with deterministic digest/codec collaborators. This
// isolates its reads/coercions and header selection; it is NOT a crypto oracle.
function originalCoreFixture(wheelFactory) {
  const trace=[];let payload;
  const wheel=wheelFactory?.(trace);
  const window={get onwheelx(){trace.push('onwheelx');return wheel;}};
  const navigator={
    get vendorSubs(){trace.push('navigator.vendorSubs');return {get ink(){trace.push('ink');return 999;}};},
    get platform(){trace.push('platform');return 'MacIntel';},
  };
  const bridge={0:Symbol,1:TypeError,2:Object,3:Array,4:String,5:Number,
    6:{random(){trace.push('random');return .5;}},7:window,
    8:{now(){trace.push('Date.now');return 1001;}},9:navigator,10:'1.0.1.7',
    11(){trace.push('Y');return {width:100};},
    12(value){return value;},
    13(key,value){if(key==='y')payload=value;return value;},
    14:class{constructor(){trace.push('SM3.new');}sum(value){trace.push(typeof value==='string'?`SM3:${value}`:'SM3:array');return Array(32).fill(1);}},
    15:{get pageId(){trace.push('pageId');return 23420;},get aid(){trace.push('aid');return 339757;}},17:RegExp,
  };
  evaluateBlock(213130,bridge);
  bridge[16](0,521,14,'q','body',' UA ');
  return {trace,flag:payload.charCodeAt(35)};
}
for(const [name,factory,flag,reads] of [
  ['absent',()=>undefined,11,1],
  ['falsy Ax',()=>({_Ax:0}),11,2],
  ['writable Ax',()=>({_Ax:1}),12,3],
  ['non-writable Ax',()=>Object.defineProperty({},'_Ax',{value:1,writable:false}),3,3],
  ['inherited Ax',()=>Object.create({_Ax:1}),12,3],
  ['accessor Ax',trace=>Object.defineProperty({},'_Ax',{get(){trace.push('_Ax getter');return 1;}}),12,3],
]) {
  const result=originalCoreFixture(factory);
  equal(result.flag,flag,`${name}: flag`);
  equal(result.trace.filter(x=>x==='onwheelx').length,reads,`${name}: repeated onwheelx reads`);
  const t=result.trace;
  equal(t.indexOf('Date.now')<t.indexOf('SM3:qcus') && t.indexOf('SM3:array')<t.indexOf('navigator.vendorSubs') && t.indexOf('ink')<t.indexOf('pageId') && t.indexOf('pageId')<t.indexOf('aid') && t.indexOf('aid')<t.indexOf('Y') && t.indexOf('Y')<t.indexOf('platform') && t.indexOf('platform')<t.indexOf('random'),true,`${name}: core order`);
}
console.log(JSON.stringify({checks,sourceHash:'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e',coreTrace:originalCoreFixture(()=>({_Ax:1})).trace,scope:'original wrapper/core control flow; stubbed crypto collaborators; no network or account'},null,2));
