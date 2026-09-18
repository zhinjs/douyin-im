const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
const {installDesktopBdms}=require('./desktop-production-loader.cjs')('desktop-runtime');
assert.equal(crypto.createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
function fixture(options={},production=false){
 const trace=[],state={session:options.session,local:options.local,cookie:options.cookie||'',referer:options.previous},windowTarget={};
 function hit(label,value){trace.push(label);if(options.fail===label)throw Error(label);return value;}
 const storage=kind=>({getItem(key){return hit(kind+'.get:'+key,state[kind]);},removeItem(key){hit(kind+'.remove:'+key);state[kind]=undefined;},setItem(){throw Error('unexpected storage write');}});
 const session=storage('session'),local=storage('local');
 class XHR {open(){} send(){throw Error('network denied');} addEventListener(){} setRequestHeader(){}}
 const proto=new Proxy(XHR.prototype,{get(t,k,r){hit('xhr.get:'+String(k));return Reflect.get(t,k,r);},set(t,k,v,r){hit('xhr.set:'+String(k));return Reflect.set(t,k,v,r);}});
 function XMLHttpRequest(){throw Error('network denied');}XMLHttpRequest.prototype=proto;
 Object.defineProperties(windowTarget,{
 sessionStorage:{get(){return hit('session.binding',options.noSession?null:session);}},
 localStorage:{get(){return hit('local.binding',options.noLocal?null:local);}},
 __ac_referer:{get(){return hit('referer.get',state.referer);},set(v){hit('referer.set');state.referer=v;}},
 });
 if('bdms' in options)windowTarget.bdms=options.bdms;
 if('versions' in options)windowTarget._sdkGlueVersionMap=options.versions;
 const window=new Proxy(windowTarget,{get(t,k,r){if(['bdms','_sdkGlueVersionMap','fetch','EventSource'].includes(k))hit('window.get:'+k);return Reflect.get(t,k,r);},set(t,k,v,r){hit('window.set:'+String(k));if(options.readonly===k)return false;return Reflect.set(t,k,v,r);}});
 const document={get cookie(){return hit('cookie.get',state.cookie);},set cookie(v){hit('cookie.set');state.cookieWrite=v;},get referrer(){return hit('referrer.get',options.referrer||'');},addEventListener(){hit('document.listen');},createElement(){return {};}};
 const context={Object,Symbol,Array,String,Number,Reflect,RegExp,Boolean,TypeError,Proxy,Math,Date,JSON,window,document,navigator:{},XMLHttpRequest,URL,Request:undefined,localStorage:local,sessionStorage:session,location:{href:'https://offline.invalid/'},performance:{now(){return hit('performance.now',0);}},requestAnimationFrame(){hit('raf');},setTimeout(){hit('timeout');},setInterval(){hit('interval');}};
 for(const key of ['document','navigator','XMLHttpRequest','URL','Request','location','performance','requestAnimationFrame','setTimeout','setInterval'])windowTarget[key]=context[key];
 let error,errorKind;try{if(production)installDesktopBdms(context);else vm.runInNewContext(source,context,{timeout:3000});}catch(e){error=e.message;errorKind=e.name;}
 return {trace,state,error,errorKind,window:windowTarget,context};
}
module.exports={fixture};
let cases=0;
function snapshot(f){
 const exported=f.window.bdms;
 return {
  trace:[...f.trace],state:f.state,error:f.errorKind==='TypeError'?f.errorKind:f.error,
  versions:structuredClone(f.window._sdkGlueVersionMap),
  exportedType:typeof exported,
  exports:exported&&typeof exported==='object'?Object.keys(exported):[],
  descriptors:exported&&typeof exported==='object'?['init','getReferer'].map(key=>{
   const d=Object.getOwnPropertyDescriptor(exported,key);
   return d?{get:typeof d.get,set:typeof d.set,enumerable:d.enumerable,configurable:d.configurable}:null;
  }):[],
  esModule:exported&&exported.__esModule,tag:exported&&exported[Symbol.toStringTag],
 };
}
function run(options,check){
 const duplicate={...options};
 if(options.versions&&typeof options.versions==='object'){
  duplicate.versions=Object.create(Object.getPrototypeOf(options.versions),Object.getOwnPropertyDescriptors(options.versions));
  if(!Object.isExtensible(options.versions))Object.preventExtensions(duplicate.versions);
 }
 const f=fixture(options),actual=fixture(duplicate,true);
 // Compare the whole startup trace before scenario checks invoke private original VM functions.
 assert.deepEqual(snapshot(actual),snapshot(f),'startup differential case '+(cases+1));
 check(f);cases++;
}
const gone=f=>{assert.equal(f.state.session,undefined);assert.equal(f.state.local,undefined);assert.equal(f.state.cookieWrite,'__ac_referer=; expires=Mon, 20 Sep 2010 00:00:00 UTC; path=/;');};
run({session:'S',local:'L',cookie:'__ac_referer=C',referrer:'D'},f=>{assert.equal(f.error,undefined);assert.equal(f.state.referer,'S');assert(!f.trace.includes('local.get:__ac_referer'));assert(!f.trace.includes('cookie.get'));gone(f);});
run({session:'',local:'L',cookie:'__ac_referer=C'},f=>{assert.equal(f.state.referer,'L');assert(!f.trace.includes('cookie.get'));gone(f);});
for(const cookie of ['__ac_referer=C','a=x; __ac_referer=C','a=x& __ac_referer=C','   __ac_referer=C','__ac_referer=C;__ac_referer=D'])run({cookie},f=>{assert.equal(f.state.referer,'C');gone(f);});
for(const [cookie,expected] of [['__ac_referer=a%3Ab%2Fc','a%3Ab%2Fc'],['__ac_referer=x=y','x=y'],['__ac_referer=hello+world','hello+world'],['__ac_referer=C ', 'C '],['__ac_referer=C&D','C'],['\t__ac_referer=C','D'],['x__ac_referer=C','D'],['__ac_referer=;__ac_referer=C','D'],['__AC_REFERER=C','D'],[{},'D']])run({cookie,referrer:'D'},f=>{assert.equal(f.state.referer,expected);});
for(const field of ['session','local','cookie'])run({[field]:field==='cookie'?'__ac_referer=__ac_blank':'__ac_blank',referrer:'D',previous:'old'},f=>{assert.equal(f.state.referer,'old');assert(!f.trace.includes('referrer.get'));gone(f);});
for(const value of ['',undefined,null,0,false])run({session:value,local:value,previous:'old'},f=>{assert.equal(f.state.referer,'old');assert(f.trace.includes('referrer.get'));});
run({session:{tag:'raw'}},f=>{assert.deepEqual(f.state.referer,{tag:'raw'});});
for(const fail of ['session.binding','session.get:__ac_referer','local.binding','local.get:__ac_referer','cookie.get'])run({fail,referrer:'D',cookie:'__ac_referer=C'},f=>{assert.equal(f.error,undefined);assert.equal(f.state.referer,'D');if(fail==='session.binding'||fail==='session.get:__ac_referer')assert(!f.trace.includes('local.get:__ac_referer'));});
for(const fail of ['session.remove:__ac_referer','local.remove:__ac_referer','cookie.set'])run({fail,session:'S',local:'L'},f=>{assert.equal(f.error,undefined);assert.equal(f.state.referer,'S');if(fail==='session.remove:__ac_referer'){assert.equal(f.state.session,'S');assert.equal(f.state.local,'L');assert(!f.trace.includes('local.remove:__ac_referer'));}if(fail!=='cookie.set')assert(!f.trace.includes('cookie.set'));});
run({fail:'referrer.get'},f=>{assert.equal(f.error,'referrer.get');gone(f);assert.equal(f.window.bdms,undefined);assert(!f.trace.includes('window.get:_sdkGlueVersionMap'));});
run({fail:'referer.set',session:'S'},f=>{assert.equal(f.error,'referer.set');gone(f);assert.equal(f.window.bdms,undefined);});
for(const bdms of [{old:true},true,'old',()=>{}])run({bdms,session:'S'},f=>{assert.equal(f.window.bdms,bdms);assert.deepEqual(f.trace,['window.get:bdms']);assert.equal(f.state.session,'S');});
for(const bdms of [undefined,null,0,false,''])run({bdms},f=>{assert.equal(f.error,undefined);assert.deepEqual(Object.keys(f.window.bdms),['getReferer','init']);assert.equal(f.window._sdkGlueVersionMap.bdmsVersion,'1.0.1.7');});
run({versions:{other:'keep',bdmsVersion:'old'}},f=>{assert.deepEqual(f.window._sdkGlueVersionMap,{other:'keep',bdmsVersion:'1.0.1.7'});assert.equal(f.trace.filter(x=>x==='window.get:_sdkGlueVersionMap').length,2);});
run({versions:Object.freeze({bdmsVersion:'old'})},f=>{assert.match(f.error,/read only/);assert.equal(f.window._sdkGlueVersionMap.bdmsVersion,'old');assert.equal(f.window.bdms,undefined);});
run({versions:'old'},f=>{assert.match(f.error,/Cannot create property/);assert.equal(f.window._sdkGlueVersionMap,'old');assert.equal(f.window.bdms,undefined);});
run({readonly:'_sdkGlueVersionMap'},f=>{assert.match(f.error,/falsish/);assert.equal(f.window._sdkGlueVersionMap,undefined);assert.equal(f.window.bdms,undefined);});
run({readonly:'bdms',session:'S'},f=>{assert.equal(f.error,undefined);gone(f);assert.equal(f.window.bdms,undefined);assert(f.trace.includes('xhr.set:send'));assert.equal(f.window._sdkGlueVersionMap.bdmsVersion,'1.0.1.7');});
for(const fail of ['window.get:_sdkGlueVersionMap','window.set:_sdkGlueVersionMap','xhr.get:open','xhr.set:open','xhr.set:send','window.get:fetch','window.get:EventSource','window.set:bdms'])run({fail,session:'S'},f=>{assert.equal(f.error,fail);gone(f);assert.equal(f.window.bdms,undefined);if(!fail.includes('_sdkGlueVersionMap'))assert.equal(f.window._sdkGlueVersionMap.bdmsVersion,'1.0.1.7');});
run({},f=>{const d=Object.getOwnPropertyDescriptor(f.window.bdms,'init');assert.equal(typeof d.get,'function');assert.equal(d.enumerable,true);assert.equal(d.configurable,false);assert.equal(d.set,undefined);assert.equal(f.window.bdms.getReferer(),'');f.state.referer='later';assert.equal(f.window.bdms.getReferer(),'later');assert(!f.trace.includes('timeout'));assert(!f.trace.includes('interval'));assert(!f.trace.includes('document.listen'));});
run({},f=>{const first=f.window.bdms;f.trace.length=0;vm.runInNewContext(source,f.context,{timeout:3000});assert.equal(f.window.bdms,first);assert.deepEqual(f.trace,['window.get:bdms']);});
run({},f=>{Object.defineProperty(f.window,'onwheelx',{value:{_Ax:'old'},writable:false});assert.throws(()=>f.window.bdms.init({}),/read only|falsish/);});
run({noSession:true,noLocal:true,cookie:'__ac_referer=C'},f=>{assert.equal(f.state.referer,'C');assert(!f.trace.some(x=>x.includes('remove:')));assert(f.trace.includes('cookie.set'));});
run({fail:'window.get:bdms',session:'S'},f=>{assert.equal(f.error,'window.get:bdms');assert.deepEqual(f.trace,['window.get:bdms']);assert.equal(f.state.session,'S');});
run({},f=>{const prototype=Object.freeze({vendorSubs:'old'});Object.defineProperty(f.context.navigator,'__proto__',{value:prototype});assert.throws(()=>f.window.bdms.init._v[2][34]('q=1',''),/read only/);assert.equal(prototype.vendorSubs,'old');});
run({},f=>{const prototype=new Proxy({},{set(){return false;}});Object.defineProperty(f.context.navigator,'__proto__',{value:prototype});assert.throws(()=>f.window.bdms.init._v[2][34]('q=1',''),/falsish/);});
run({},f=>{Object.defineProperty(f.context.document,'all',{get(){throw Error('read');}});assert.throws(()=>f.window.bdms.init._v[2].p[40](),/only a getter/);});
run({},f=>{const assigned=[];Object.defineProperty(f.context.document,'all',{get(){throw Error('read');},set(v){assigned.push(v);}});Object.defineProperty(f.context.document,'characterSet',{value:'UTF-8',writable:false});assert.throws(()=>f.window.bdms.init._v[2].p[40](),/read only/);assert.deepEqual(assigned,[404]);});
console.log(JSON.stringify({startupCases:cases,productionDifferential:true,completeOriginalScript:true,network:false,realStorage:false}));
