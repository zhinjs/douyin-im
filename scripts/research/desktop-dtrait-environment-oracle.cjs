// Original F286–290 only. Synthetic properties, no browser/device access or bundle entrypoint.
const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs'),{rawFeature}=require('./desktop-dtrait-features-oracle.cjs');
function original(bindings,hash,diagnostic){
  const d=decode(process.argv[2]),a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);
  const ctx=vm.createContext({...bindings,tt:d.strings,et:d.functions.map((f,id)=>[id>=286&&id<=290?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});
  vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',ctx);
  const scope=[diagnostic,hash];ctx.make(286,scope)();return scope[2];
}
function scenario(sdk,mode){
  const trace=[];
  const watch=(name,object)=>new Proxy(object,{get(target,key,receiver){trace.push(['get',name,String(key)]);if(mode==='throw:'+name+'.'+String(key))throw Error('property');return Reflect.get(target,key,receiver);}});
  const connection=watch('connection',{downlink:12.5,effectiveType:'4g'});
  const plugins=[{name:'One'},null,{name:'Two'}],mimeTypes=[{type:'a/b'},false,{type:'c/d'}];
  const nav={connection,language:'zh-CN',languages:['zh-CN','en-US'],plugins,mimeTypes,vendor:'Synthetic',userAgent:'Synthetic/1',deviceMemory:8,hardwareConcurrency:12,maxTouchPoints:'3.9'};
  if(mode==='absent-connection')delete nav.connection;
  if(mode==='null-connection')nav.connection=null;
  if(mode==='absent-languages')delete nav.languages;
  if(mode==='array-like') {nav.plugins={0:{name:'IGNORED'},length:1};nav.mimeTypes={0:{type:'IGNORED'},length:1};}
  if(mode==='empty-arrays'){nav.plugins=[];nav.mimeTypes=[];}
  if(mode==='null-arrays'){nav.plugins=null;nav.mimeTypes=null;}
  if(mode==='undefined-name')nav.plugins=[{}];
  if(mode==='ms-touch'){delete nav.maxTouchPoints;nav.msMaxTouchPoints='7';}
  if(mode==='no-touch')delete nav.maxTouchPoints;
  if(mode==='null-touch')nav.maxTouchPoints=null;
  if(mode==='symbol-touch')nav.maxTouchPoints=Symbol('synthetic');
  if(mode==='bad-join')nav.languages={join:1};
  let formatCount=0;
  const intl={DateTimeFormat(){trace.push(['format',this===intl]);const n=++formatCount;const format={resolvedOptions(){trace.push(['resolve',this===format]);return mode==='null-options'?null:watch('options',{locale:'locale'+n,timeZone:'zone'+n});}};return mode==='null-format'?null:format;}};
  const win={Intl:intl,Notification:watch('notification',{permission:'default'}),devicePixelRatio:2};
  if(mode==='no-intl')delete win.Intl;
  if(mode==='no-notification')delete win.Notification;
  const screen={availHeight:900,availLeft:20,availTop:30,availWidth:1400,height:1000,width:1500,colorDepth:24,pixelDepth:32};
  const bindings={navigator:watch('navigator',nav),window:watch('window',win),screen:watch('screen',screen),parseInt(value,radix){trace.push(['parseInt',value,radix]);return parseInt(value,radix);}};
  const io={encoder:new TextEncoder(),onDiagnostic:code=>trace.push(['hash-diagnostic',code]),getCryptoUtil:()=>undefined};
  const inner=sdk?sdk.createDesktopDTraitHash(io):rawFeature(process.argv[2],io).hash;
  const hash=value=>{trace.push(['hash',value===undefined?'<undefined>':value]);if(mode==='hash-throw'&&value!=='')throw Error('hash');if(mode==='all-hash-throw')throw Error('hash');return mode==='hash-zero'?0:inner(value);};
  const onDiagnostic=code=>{trace.push(['diagnostic',code]);if(mode==='diagnostic-throw')throw Error('diagnostic');};
  if(mode==='diagnostic-throw')Object.defineProperty(nav,'language',{get(){throw Error('language');}});
  let result;try{result=(sdk?sdk.createDesktopDTraitEnvironmentCollector({...bindings,hash,onDiagnostic}):original(bindings,hash,onDiagnostic))();}catch(error){result={error:error.name};}
  return {result:JSON.parse(JSON.stringify(result)),trace};
}
async function main(){
  const sdk={...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-environment.js')).href),...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-features.js')).href)};
  const modes=['normal','absent-connection','null-connection','absent-languages','array-like','empty-arrays','null-arrays','undefined-name','ms-touch','no-touch','null-touch','symbol-touch','bad-join','null-options','null-format','no-intl','no-notification','hash-throw','all-hash-throw','hash-zero','diagnostic-throw','throw:navigator.userAgent','throw:screen.width','throw:connection.effectiveType'];
  for(const mode of modes)assert.deepStrictEqual(scenario(sdk,mode),scenario(null,mode),mode);
  console.log(`PASS ${modes.length} strFeature original VM/SDK traces (synthetic realm only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
