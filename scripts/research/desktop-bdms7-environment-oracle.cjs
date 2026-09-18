const requireProductionDependency=require('./desktop-production-loader.cjs');
// Offline differential oracle. The pinned vendor classifier/functions/bytecode are
// evaluated unchanged; fixtures supply browser storage, never network or accounts.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {createHash} = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

const filename = process.argv[2] || '/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js';
const raw = readFileSync(filename);
const hash = createHash('sha256').update(raw).digest('hex');
assert.equal(hash, 'd99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const source = raw.toString('utf8');
// All three tables, functions, and their original Babel iteration helpers.
const classifierSource = source.slice(68724, 75130);
assert(classifierSource.startsWith('function n(e,r)'));
assert(classifierSource.endsWith('return t}'));
const originalClassifiers = vm.runInNewContext(`(()=>{${classifierSource};return {browser:f,os:b,platform:v};})()`, {require:requireProductionDependency,}, {timeout:3000});

const production = {};
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../../src/anti-bot/desktop-environment.ts'), 'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
vm.runInNewContext(compiled, {require:requireProductionDependency,exports:production}, {timeout:3000,filename:'production-desktop-environment.js'});

function originalStorage(context) {
  const position = 87745;
  const start = source.lastIndexOf('function(e,r,t)', position);
  const end = source.indexOf('"', position + 1) + 1;
  const bridge = {0:context.navigator,1:context.window,2:originalClassifiers.browser};
  vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`, {require:requireProductionDependency,bridge}, {timeout:3000});
  assert.equal(typeof bridge[3], 'function');
  return {probe:bridge[3]};
}

let comparisons = 0;
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
const browserInputs = [
  '', 'unknown', 'HuaweiBrowser/1 Chrome/130 Edg/130 OPR/100', 'Chrome/130 Edg/130 OPR/100',
  'CrMo/3', 'CriOS/122', 'HeadlessChrome/130', 'HeadlessChrome fixture',
  'wv). Chrome/100', 'Edg/130', 'Edge/130', 'EdgiOS/30', 'EdgA/30',
  'Focus/1', 'FxiOS/5', 'Mobile VR; rv:1.0). Firefox', 'Firefox/130',
  'MSIE 8.0', '(IE 11.0', 'Trident/7 rv:11.0 like Gecko', 'IEMobile/10.0',
  'Opera Mini/1', 'Opera Mobile Version/12', 'Opera/9.0', 'OPiOS/9', 'OPR/9',
  'Version/17.0 Mobile/abc Safari', 'Version/17.0 Safari', 'Safari/605',
  'CHROME/130', 'huaweiBrowser/1 Safari',
];
const osInputs = [
  '', 'OpenHarmony Android 13 Linux', 'Android 13 HarmonyOS', 'Android-x86 9 Linux',
  'Android', 'Android 13 Linux', 'iPhone; CPU iPhone OS 17_0 like Mac OS X',
  '(iPhone; CPU)', '(iPad; Apple)', 'AppleCoreMedia/1.0 (iPad', 'iPad12,9; iOS',
  'CriOS/130 Mac OS X', 'FxiOS/20', 'Mac OS X 14_0', 'Macintosh',
  'Macintosh Haiku', 'Mac_PowerPC', 'Microsoft Windows Vista', 'Windows NT 6.2; ARM',
  'Windows NT 10.0', 'Windows NT 10.0 Xbox', 'Windows Phone OS 10', 'Windows Mobile 8',
  'Win95', 'WinNT4', 'Linux', 'linux x86_64', 'HarmonyOS',
];
const platformInputs = [
  '', 'Android MacIntel Linux Win32', 'MacIntel Linux Win32', 'Linux Win32',
  'Android', 'MacIntel', 'iPhone', 'iPad', 'iPod', 'Linux x86_64', 'Win32', 'Darwin', 'Plan9',
];
for (const [kind, inputs, name] of [
  ['browser',browserInputs,'classifyDesktopBrowser'],
  ['os',osInputs,'classifyDesktopOS'],
  ['platform',platformInputs,'classifyDesktopPlatform'],
]) {
  for (const input of [...inputs, undefined, null, 0, {toString:()=>inputs[1]}]) {
    equal(production[name](input), originalClassifiers[kind](input).name, `${kind}: ${String(input)}`);
  }
  for (const input of [Symbol('fixture'), {toString(){throw Error('coercion');}}]) {
    const result = fn => {try {fn(input); return 'returned';} catch(error) {return error.message;}};
    equal(result(production[name]), result(value=>originalClassifiers[kind](value)), `${kind}: conversion exception`);
  }
  const conversionTrace = fn => {
    let count=0;
    const input={toString(){count++;return count===1?'unknown':inputs[2];}};
    return {name:fn(input),count};
  };
  equal(conversionTrace(production[name]),conversionTrace(value=>originalClassifiers[kind](value).name),`${kind}: conversion per regex`);
}

function fixture() {
  const estimates = [], catches = [], requests = [], log = [];
  const context = {navigator:{userAgent:'Chrome/130',storage:{
    estimate(){log.push('estimate');return {then(callback){estimates.push(callback);}};},
    getDirectory(){log.push('directory');return {catch(callback){catches.push(callback);}};},
  }},window:{indexedDB:{
    open(name){log.push(`open:${name}`);const handlers={};requests.push(handlers);return {
      addEventListener(type, callback){log.push(`listener:${type}`);handlers[type]=callback;},
    };},
    deleteDatabase(name){log.push(`delete:${name}`);},
  }}};
  return {context,estimates,catches,requests,log};
}
const scenarios = [];
function scenario(name, run) {
  const invoke = build => {
    const f = fixture();
    const state = build(f.context);
    const values = [];
    const probe = () => values.push(state.probe());
    const attempt = fn => {try{fn();values.push('returned');}catch(error){values.push(error.message);}};
    run({...f,state,values,probe,attempt});
    return {values,log:f.log,estimates:f.estimates.length,catches:f.catches.length,requests:f.requests.length};
  };
  const expected = invoke(originalStorage);
  equal(invoke(context=>new production.DesktopStorageState(context)),expected,name);
  scenarios.push({name,...expected});
}

scenario('estimate repeated / out of order / exact quota boundary', ({probe,estimates})=>{
  probe();probe();
  estimates[1]({quota:1});probe();
  estimates[0]({quota:2300000000});probe();
  estimates[3]({quota:2299999999});probe();
  estimates[2]({quota:0});probe();
  estimates[4]({});probe();
});
scenario('estimate synchronous thenable updates before return', ({probe,context})=>{
  context.navigator.storage.estimate=()=>({then:callback=>callback({quota:1})});probe();
  context.navigator.storage.estimate=()=>({then:callback=>callback({quota:Infinity})});probe();
});
scenario('estimate missing or nonfunction leaves current state', ({probe,context,estimates})=>{
  probe();estimates[0]({quota:1});
  context.navigator.storage.estimate=undefined;probe();
  context.navigator.storage.estimate=1;probe();
  context.navigator.storage=undefined;probe();
});
scenario('estimate call / then / result exceptions propagate', ({probe,context,attempt,estimates})=>{
  probe();attempt(()=>estimates[0](null));
  context.navigator.storage.estimate=()=>{throw Error('estimate throws');};attempt(probe);
  context.navigator.storage.estimate=()=>({get then(){throw Error('then getter');}});attempt(probe);
});
scenario('Firefox error sticks; success deletes but does not reset', ({probe,context,requests})=>{
  context.navigator.userAgent='Firefox/130';context.navigator.serviceWorker={};
  probe();requests[0].error();probe();requests[1].success();probe();
});
scenario('Firefox missing serviceWorker skips indexedDB', ({probe,context})=>{
  context.navigator.userAgent='Firefox/130';probe();
  context.navigator.serviceWorker={};context.window.indexedDB=undefined;probe();
});
scenario('Firefox open and successful delete exceptions propagate', ({probe,context,requests,attempt})=>{
  context.navigator.userAgent='Firefox/130';context.navigator.serviceWorker={};probe();
  context.window.indexedDB.deleteDatabase=()=>{throw Error('delete throws');};attempt(()=>requests[0].success());
  context.window.indexedDB.open=()=>{throw Error('open throws');};attempt(probe);
});
scenario('Safari catch case sensitivity and sticky state', ({probe,context,catches})=>{
  context.navigator.userAgent='Version/17.0 Safari';probe();
  catches[0]({message:'Out of memory'});probe();
  catches[1]({message:'prefix out of memory suffix'});probe();
  catches[2]({message:'unrelated error'});probe();
});
scenario('Safari malformed catch and synchronous directory failures propagate', ({probe,context,catches,attempt})=>{
  context.navigator.userAgent='Version/17.0 Safari';probe();attempt(()=>catches[0]({}));
  context.navigator.storage.getDirectory=()=>{throw Error('directory throws');};attempt(probe);
});
scenario('late Chrome callback overwrites Safari state across UA change', ({probe,context,estimates,catches})=>{
  probe();context.navigator.userAgent='Version/17.0 Safari';probe();
  catches[0]({message:'out of memory'});probe();
  estimates[0]({quota:2300000000});probe();
  context.navigator.userAgent='unclassified';probe();
});
scenario('Chrome wins combined browser UA / Edge and Opera take same branch', ({probe,context})=>{
  context.navigator.userAgent='Chrome/130 Edg/130 Firefox/130';probe();
  context.navigator.userAgent='Edg/130';probe();
  context.navigator.userAgent='OPR/100';probe();
  context.navigator.userAgent='HuaweiBrowser/1 Chrome/130';probe();
});
scenario('quota coercion, repeated getter reads and state overwrite', ({probe,context,estimates,log})=>{
  for (const quota of [-1,NaN,Infinity,'1','2300000000',null,false,true]) {
    probe();estimates.at(-1)({quota});
    // Observe without creating another callback in this step.
    context.navigator.userAgent='Other';probe();context.navigator.userAgent='Chrome/130';
  }
  let reads=0;
  probe();estimates.at(-1)({get quota(){log.push('quota');return ++reads===1?1:2300000000;}});
  context.navigator.userAgent='Other';probe();
});
scenario('storage getter count, native method receiver, no rejection callback', ({probe,context,log})=>{
  const storage={estimate(){
    log.push(`estimate-this:${this===storage}`);
    const result={then(callback){
      log.push(`then-this:${this===result}`);
      log.push(`then-argc:${arguments.length}`);
      callback({quota:1});
    }};
    return result;
  }};
  Object.defineProperty(context.navigator,'storage',{get(){log.push('storage');return storage;}});
  probe();
});
scenario('Safari successful operation without catch invocation leaves false', ({probe,context})=>{
  context.navigator.userAgent='Version/17.0 Safari';
  context.navigator.storage.getDirectory=()=>({catch(){}});probe();probe();
  context.navigator.storage.getDirectory=undefined;probe();
});

function contextIsolation(build) {
  const a=fixture(),b=fixture(),first=build(a.context),second=build(b.context);
  const values=[first.probe(),second.probe()];
  a.estimates[0]({quota:1});
  values.push(first.probe(),second.probe());
  // A new source evaluation/state instance remains false even over the same host objects.
  values.push(build(a.context).probe());
  return values;
}
equal(contextIsolation(context=>new production.DesktopStorageState(context)),contextIsolation(originalStorage),'execution context state isolation');

async function promiseCase(build) {
  const f=fixture();let settle;
  f.context.navigator.storage.estimate=()=>new Promise(resolve=>{settle=resolve;});
  const state=build(f.context);const values=[state.probe()];
  settle({quota:1});
  // Actual Promise callback has not yet run; a new probe still observes false.
  values.push(state.probe());await Promise.resolve();values.push(state.probe());
  return values;
}
(async()=>{
  equal(await promiseCase(context=>new production.DesktopStorageState(context)),await promiseCase(originalStorage),'real microtask boundary');
  console.log(JSON.stringify({sourceHash:hash,classifierRange:[68724,75130],storageBlock:87745,comparisons,scenarios},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
