const requireProductionDependency=require('./desktop-production-loader.cjs');
// Offline fixtures only. Original pinned bytecode interpreters run unchanged.
// Host tags/native-looking methods below are synthetic test branches, not SDK defaults.
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
const classifierSource = source.slice(68724,75130);
assert(classifierSource.startsWith('function n(e,r)') && classifierSource.endsWith('return t}'));
const classifiers = vm.runInNewContext(`(()=>{${classifierSource};return {browser:f,os:b,platform:v};})()`, {require:requireProductionDependency,}, {timeout:3000});

function originalBlock(position, bridge, outputSlot) {
  const start=source.lastIndexOf('function(e,r,t)',position);
  const end=source.indexOf('"',position+1)+1;
  assert(start>=0 && end>position);
  vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`, {require:requireProductionDependency,bridge}, {timeout:3000});
  assert.equal(typeof bridge[outputSlot],'function');
  return bridge[outputSlot];
}
function slots(values) {
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value]));
}
function originalState(context) {
  // Getters reproduce each block's explicit environment bridge. Output slots are writable.
  const getters = (bindings, constants={}) => {
    const bridge=slots(constants);
    for(const [key,name] of Object.entries(bindings)) Object.defineProperty(bridge,key,{get:()=>context[name]});
    return bridge;
  };
  const r=originalBlock(68393,getters({0:'window'}),1);
  const m=originalBlock(77422,getters({0:'window',1:'navigator'},{2:classifiers.browser}),3);
  const w=originalBlock(80356,getters({1:'window',2:'navigator',3:'document',4:'location',5:'history'},{0:Object}),6);
  const S=originalBlock(84402,getters({0:'document',1:'navigator',2:'PluginArray',3:'MSPluginsCollection'}),4);
  const storage=originalBlock(87745,getters({0:'navigator',1:'window'},{2:classifiers.browser}),3);
  const k=originalBlock(91415,getters({0:'navigator'},{1:classifiers.os,2:classifiers.platform}),3);
  const C=originalBlock(94491,getters({0:'location'},{2:RegExp}),1);
  const j=originalBlock(97593,getters({1:'webpackGlobal',3:'process'},{0:context.Symbol,2:Object}),4);
  const A=originalBlock(100607,getters({0:'PluginArray',1:'navigator',2:'MSPluginsCollection',3:'window'}),4);
  const ae=originalBlock(104065,getters({0:'navigator',2:'window'},{1:Object}),3);
  return {mask:originalBlock(111082,{0:r,1:m,2:w,3:S,4:storage,5:k,6:C,7:j,8:A,9:ae},10)};
}

const cache = new Map();
function productionModule(name) {
  if(cache.has(name)) return cache.get(name);
  assert(['desktop-environment-mask','desktop-environment'].includes(name),name);
  const exports={};cache.set(name,exports);
  const compiled=ts.transpileModule(readFileSync(join(__dirname,`../../src/anti-bot/${name}.ts`),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(compiled,{exports,require:(name)=>name==='./desktop-property-write.js'?requireProductionDependency(name):(path=>productionModule(path.replace(/^\.\//,'').replace(/\.js$/,'')))(name)},{timeout:3000});
  return exports;
}

function fixture() {
  const log=[],estimates=[],catches=[],requests=[];
  const tag=(value,name)=>Object.defineProperty(value,Symbol.toStringTag,{value:name,configurable:true});
  const context={
    Symbol,
    window:{screen:{},eval(){},Audio(){},innerWidth:1200,innerHeight:700,outerWidth:1200,outerHeight:800},
    navigator:tag({userAgent:'Chrome/130 Mac OS X',platform:'MacIntel',appVersion:'Desktop fixture',
      toString:Object.prototype.toString,
      storage:{estimate(){log.push('estimate');return {then(callback){estimates.push(callback);}};},
        getDirectory(){log.push('directory');return {catch(callback){catches.push(callback);}};}},
    },'Navigator'),
    document:tag({createElement(name){log.push(`create:${name}`);return {toDataURL:Object.prototype.toString};}},'HTMLDocument'),
    location:tag({href:'https://offline.invalid/login'},'Location'),history:tag({},'History'),
    PluginArray:undefined,MSPluginsCollection:undefined,webpackGlobal:undefined,process:undefined,
  };
  context.window.indexedDB={open(name){log.push(`open:${name}`);const handlers={};requests.push(handlers);return {
    addEventListener(type,callback){log.push(`listener:${type}`);handlers[type]=callback;},
  };},deleteDatabase(name){log.push(`delete:${name}`);}};
  return {context,log,estimates,catches,requests,tag};
}

let comparisons=0;
const scenarios=[];
const production=productionModule('desktop-environment-mask');
function runScenario(name, run, configure=()=>{}) {
  const execute=build=>{
    const f=fixture();configure(f);const state=build(f.context),values=[];
    const mask=()=>{try{values.push(state.mask());}catch(error){values.push({error:error.name,message:error.message});}};
    run({...f,state,values,mask});
    return {values,log:f.log,estimates:f.estimates.length,catches:f.catches.length,requests:f.requests.length};
  };
  const expected=execute(originalState),actual=execute(context=>new production.DesktopEnvironmentState(context));
  // V8 bytecode property error wording may differ; exception type and custom messages are stable.
  const normalize=value=>JSON.parse(JSON.stringify(value,(_key,item)=>item&&item.error==='TypeError'?{error:item.error}:item));
  assert.deepEqual(normalize(actual),normalize(expected),name);
  comparisons++;
  scenarios.push({name,...expected});
}
const getter=(object,key,log,value)=>Object.defineProperty(object,key,{configurable:true,get(){log.push(String(key));return typeof value==='function'?value():value;}});

runScenario('baseline getter evaluation order',({context,log,mask})=>{
  for(const object of [context.window,context.navigator,context.location]) for(const key of Object.keys(object)) {
    const value=object[key];getter(object,key,log,()=>value);
  }
  mask();
});
runScenario('top-level environment bridge getter order',({context,log,mask})=>{
  for(const key of Object.keys(context).filter(key=>key!=='Symbol')) {
    const value=context[key];getter(context,key,log,()=>value);
  }
  mask();
});
for(const key of ['window','navigator','document','location','history']) runScenario(`gate missing ${key}`,({context,mask})=>{context[key]=undefined;mask();});
for(const [key,tags] of Object.entries({navigator:['Object','Navigator'],document:['Object','Document','HTMLDocument'],location:['String','Object','Location'],history:['Object','History']})) {
  for(const tag of tags) runScenario(`gate tag ${key}:${tag}`,({context,mask,tag:setTag})=>{setTag(context[key],tag);mask();});
}
runScenario('gate reads all tags even after bad navigator',({context,log,mask})=>{
  for(const key of ['navigator','document','location','history']) getter(context[key],Symbol.toStringTag,log,()=>{log.push(`tag:${key}`);return 'Object';});mask();
});
runScenario('gate tag getter error propagates',({context,mask})=>{
  Object.defineProperty(context.navigator,Symbol.toStringTag,{get(){throw Error('tag fixture');}});mask();
});

for(const behavior of ['throw-create','throw-canvas-getter','non-function','index-zero','native-prefix','own-tostring-throw']) {
  runScenario(`S canvas ${behavior}`,({context,mask})=>{
    context.document.createElement=()=>{
      if(behavior==='throw-create') throw Error('create fixture');
      if(behavior==='throw-canvas-getter') return {get toDataURL(){throw Error('canvas fixture');}};
      const fn=()=>{};
      if(behavior==='non-function') return {toDataURL:1};
      fn.toString=()=>{if(behavior==='own-tostring-throw') throw Error('toString fixture');return behavior==='index-zero'?'[native code]':'x[native code]';};
      return {toDataURL:fn};
    };mask();
  });
}
runScenario('S late navigator getter is outside canvas catch',({context,mask})=>{Object.defineProperty(context.navigator,'toString',{get(){throw Error('navigator fixture');}});mask();});
for(const key of ['PluginArray','MSPluginsCollection']) for(const mode of ['matching','mismatch','non-constructor','throw-hasinstance']) {
  runScenario(`plugin ${key} ${mode}`,({context,mask})=>{
    context[key]=function PluginFixture(){};context.navigator.plugins=mode==='matching'?new context[key]():{};
    if(mode==='non-constructor') context[key]=3;
    if(mode==='throw-hasinstance') Object.defineProperty(context[key],Symbol.hasInstance,{value(){throw Error('hasInstance fixture');}});
    mask();
  });
}

runScenario('ae weak getters run before headless strong short circuit',({context,log,mask})=>{
  context.navigator.appVersion='HeadlessChrome';
  getter(context.navigator,'connection',log,{rtt:0});getter(context.navigator,'userAgentData',log,{brands:[],platform:''});
  for(const key of ['innerWidth','innerHeight','outerWidth','outerHeight']) getter(context.window,key,log,key.includes('Width')?800:600);
  mask();
});
runScenario('ae weak getter exception not hidden by headless',({context,mask})=>{
  context.navigator.appVersion='HeadlessChrome';Object.defineProperty(context.navigator,'connection',{get(){throw Error('weak fixture');}});mask();
});
for(const setup of ['screen','eval','appVersion','userAgent','nonstring-UA','webdriver-true','webdriver-false-own','webdriver-false-inherited','all-weak','one-weak']) {
  runScenario(`ae ${setup}`,({context,mask})=>{
    if(setup==='screen'||setup==='eval') context.window[setup]=undefined;
    if(setup==='appVersion') context.navigator.appVersion='HeadlessChrome';
    if(setup==='userAgent') context.navigator.userAgent='HeadlessChrome/130';
    if(setup==='nonstring-UA') context.navigator.userAgent=17;
    if(setup==='webdriver-true') context.navigator.webdriver=true;
    if(setup==='webdriver-false-own') context.navigator.webdriver=false;
    if(setup==='webdriver-false-inherited') Object.setPrototypeOf(context.navigator,{webdriver:false});
    if(setup==='all-weak'||setup==='one-weak') context.navigator.connection={rtt:0};
    if(setup==='all-weak') {context.navigator.userAgentData={brands:[],platform:''};context.window.innerWidth=800;context.window.innerHeight=600;}
    mask();
  });
}
for(const brands of [undefined,null,[],[{}],{length:0}]) runScenario(`ae brands ${JSON.stringify(brands)}`,({context,mask})=>{
  context.navigator.connection={rtt:0};context.navigator.userAgentData={brands,platform:''};
  context.window.innerWidth=800;context.window.innerHeight=600;mask();
});
runScenario('ae false screen short circuits all later getters',({context,mask})=>{
  context.window.screen=undefined;Object.defineProperty(context.navigator,'connection',{get(){throw Error('must not read weak');}});mask();
});
for(const value of [undefined,false,0,1,3,-1,Infinity,NaN,'2',function Canvas(){},{valueOf(){return 3;}}]) {
  runScenario(`A numeric conversion ${String(value)}`,({context,mask})=>{context.window.Audio=undefined;context.window.CanvasRenderingContext2D=value;mask();});
}
runScenario('A conversion throws propagates',({context,mask})=>{context.window.Audio=undefined;context.window.CanvasRenderingContext2D={valueOf(){throw Error('numeric fixture');}};mask();});
for(const key of ['_phantom','callPhantom','__nightmare']) runScenario(`A ${key}`,({context,mask})=>{context.window[key]={};mask();});

for(const setup of ['webpack-process','lexical-node','lexical-other','window-only','null-process','primitive-process','both-short-circuit']) {
  runScenario(`j ${setup}`,({context,mask,tag})=>{
    if(setup==='webpack-process'||setup==='both-short-circuit') context.webpackGlobal={process:tag({},'process')};
    if(setup==='lexical-node') context.process={title:'node'};
    if(setup==='lexical-other') context.process={title:'electron'};
    if(setup==='window-only') context.window.process={title:'node'};
    if(setup==='null-process') context.process=null;
    if(setup==='primitive-process') context.process='node';
    if(setup==='both-short-circuit') context.process={get title(){throw Error('must not read title');}};
    mask();
  });
}
runScenario('j null webpack global throws',({context,mask})=>{context.webpackGlobal=null;mask();});
for(const kind of ['absent','legacy-function','legacy-instance','legacy-prototype','legacy-ordinary']) {
  runScenario(`j Symbol intrinsic ${kind}`,({mask})=>{mask();mask();},({context})=>{
    function LegacySymbol() {}
    LegacySymbol.iterator='@@iterator';
    context.Symbol=kind==='absent'?undefined:LegacySymbol;
    context.process=kind==='legacy-instance'?Object.assign(new LegacySymbol(),{title:'node'}):
      kind==='legacy-prototype'?Object.assign(LegacySymbol.prototype,{title:'node'}):{title:'node'};
  });
}
runScenario('j legacy typeof branch remains selected across iterator mutation',({context,mask})=>{
  mask();context.Symbol.iterator=Symbol.iterator;context.process=Object.assign(new context.Symbol(),{title:'node'});mask();
},({context})=>{function LegacySymbol(){}LegacySymbol.iterator='@@iterator';context.Symbol=LegacySymbol;context.process={title:'node'};});
runScenario('j Symbol binding captured before first mask',({context,mask})=>{
  const captured=context.Symbol;
  context.Symbol=Symbol;context.process=Object.assign(new captured(),{title:'node'});mask();
  context.Symbol=undefined;mask();
},({context})=>{function LegacySymbol(){}LegacySymbol.iterator='@@iterator';context.Symbol=LegacySymbol;});
runScenario('j modern captured Symbol does not become legacy after replacement',({context,mask})=>{
  function LegacySymbol(){}LegacySymbol.iterator='@@iterator';context.Symbol=LegacySymbol;
  context.process=Object.assign(new LegacySymbol(),{title:'node'});mask();
});
runScenario('constructor reads only captured Symbol binding',({mask})=>{mask();},({context,log})=>{
  for(const key of Object.keys(context)) {const value=context[key];getter(context,key,log,()=>value);}
});
for(const [width,height] of [[400,300],[401,0],[0,301],[-401,-301]]) runScenario(`m Firefox delta ${width}/${height}`,({context,mask})=>{
  context.navigator.userAgent='Firefox/130 Mac OS X';context.navigator.serviceWorker={};
  context.window.outerWidth=context.window.innerWidth+width;context.window.outerHeight=context.window.innerHeight+height;mask();
});
runScenario('m reads four dimensions before OR',({context,log,mask})=>{
  context.navigator.userAgent='Firefox/130 Mac OS X';context.navigator.serviceWorker={};
  for(const [key,value] of Object.entries({outerWidth:1700,innerWidth:1200,outerHeight:800,innerHeight:700})) getter(context.window,key,log,value);
  mask();
});
for(const key of ['cefSharp','CefSharp','eoapi','eoWebBrowserDispatcher']) runScenario(`r ${key}`,({context,mask})=>{context.window[key]={};mask();});
runScenario('r bridge short circuit suppresses later getter',({context,mask})=>{
  context.window.cefSharp={};Object.defineProperty(context.window,'CefSharp',{get(){throw Error('must not read bridge');}});mask();
});
for(const href of ['file:///app','FILEanything','http://localhost/path','https://localhost/path','http://localhost.evil.example','http://127.0.0.1/','http://999.999.999.9999','https://[::1]/','https://a:b:c:d:e:f:1:2/','HTTPS://127.0.0.1/']) {
  runScenario(`C ${href}`,({context,mask})=>{context.location.href=href;mask();});
}
runScenario('C href coercion occurs per regexp',({context,log,mask})=>{
  let count=0;context.location.href={toString(){log.push('href coercion');return ++count===1?'https://offline.invalid':'http://127.0.0.1';}};mask();
});
for(const userAgent of ['Mac OS X','Windows NT 10.0','Linux','Android 13 Linux','OpenHarmony','iPhone; CPU iPhone OS 17_0 like Mac OS X','Other']) {
  for(const platform of ['Win32','Linux x86_64','Android','MacIntel','Plan9']) runScenario(`k ${userAgent}/${platform}`,({context,mask})=>{context.navigator.userAgent=userAgent;context.navigator.platform=platform;mask();});
}
runScenario('storage late callbacks change M and survive browser change',({context,mask,estimates,catches})=>{
  mask();mask();estimates[1]({quota:1});mask();estimates[0]({quota:2300000000});mask();
  context.navigator.userAgent='Version/17.0 Safari Mac OS X';mask();catches[0]({message:'out of memory'});mask();
  estimates[2]({quota:0});mask();
});
runScenario('gate false skips storage but does not cancel pending callbacks',({context,mask,estimates})=>{
  mask();const document=context.document;context.document=undefined;mask();estimates[0]({quota:1});context.document=document;mask();
});
console.log(JSON.stringify({sourceHash:hash,fixtureOnly:true,blocks:[68393,77422,80356,84402,87745,91415,94491,97593,100607,104065,111082],comparisons,scenarios},null,2));
