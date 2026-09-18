const requireProductionDependency=require('./desktop-production-loader.cjs');
const ts=require('typescript'),{join}=require('node:path');
let useProduction=false;
const {readFileSync}=require('node:fs'),{createHash}=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const B=226619,start=source.lastIndexOf('function(e,r,t)',B),end=source.indexOf('"',B+1)+1;
const production={};new Function('exports','require',ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-eventsource-hook.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(production,requireProductionDependency);
function make(options={}) {
 const trace=[],loc={href:'https://fixture.invalid/base/'};
 function NativeES(...args){trace.push(['native',...args]);this.args=args;options.native?.(this);}
 NativeES.OPEN=1;NativeES.prototype.close=function(){};
 const window={EventSource:NativeES};
 if('ES' in options)window.EventSource=options.ES;
 if(options.readonly)Object.defineProperty(window,'EventSource',{writable:false});
 let esGets=0;
 if(options.getter)Object.defineProperty(window,'EventSource',{get(){trace.push(['get-es',++esGets]);return options.getter(esGets,NativeES);},set(value){trace.push(['set-es']);Object.defineProperty(window,'EventSource',{value,writable:true,configurable:true});},configurable:true});
 class XHR {open(){}send(){}setRequestHeader(){}addEventListener(){}}
 const bridge={0:Symbol,1:TypeError,2:Object,3:Array,4:String,5:Number,6:options.reflect===false?undefined:Reflect,7:ReferenceError,8:Proxy,9:Boolean,10:Error,11:isNaN,12:Promise,13:window,15:{getItem(){return options.token??'old';}},16:XHR,17:URL,18:JSON,19:Date,20:{},21(){},23:{now:()=>0},25:loc,28:RegExp,47:x=>x,49(){}};
 let root;
 if(useProduction){
  root={24:{inner:options.token??'old'}};
  root[37]=()=>production.installDesktopEventSourceHook({window,URL,location:loc,Object,Reflect:bridge[6],Proxy,Boolean,TypeError},
   {get token(){return root[24].inner;}},{
    matchesSigning:path=>Reflect.apply(root[32],null,[path]),
    matchesBehavior:path=>Reflect.apply(root[33],null,[path]),
    sign:(query,body)=>Reflect.apply(root[34],null,[query,body]),
    reportBehavior:()=>Reflect.apply(root[29],null,[]),
   });
  root[37]();
 }else{
  vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});
  root=bridge[51]._v[2];
 }
 root[32]=function(path){'use strict';trace.push(['match',this===null,path]);return options.match?options.match(path):path.startsWith('/hit');};
 root[33]=function(path){'use strict';trace.push(['track',this===null,path]);return !!options.track;};
 root[34]=function(query,body){'use strict';trace.push(['sign',this===null,query,body,arguments.length]);options.sign?.();return 'synthetic';};
 root[29]=function(){'use strict';trace.push(['report',this===null,arguments.length]);options.report?.();};
 return {trace,loc,window,root,bridge,NativeES};
}
let checks=0,observations=[];function eq(a,b,label){assert.deepEqual(a,b,label);observations.push(JSON.stringify(a,(_,v)=>typeof v==='function'?'[function]':v));checks++;}function throws(fn,error){assert.throws(fn,error);checks++;}
const names=f=>f.trace.map(x=>x[0]);
function runSuite(){
{
 const f=make({track:true}),ES=f.window.EventSource,opt={withCredentials:true};
 eq(Object.getPrototypeOf(ES),f.NativeES);eq(Object.getPrototypeOf(ES.prototype),f.NativeES.prototype);eq(ES.OPEN,1);eq(Object.hasOwn(ES,'OPEN'),false);
 eq(Object.getOwnPropertyDescriptor(ES,'prototype').writable,false);
 eq(Object.getOwnPropertyDescriptor(ES,'handleUrl').enumerable,false);eq(Object.getOwnPropertyDescriptor(ES,'handleUrl').writable,true);eq(Object.getOwnPropertyDescriptor(ES,'handleUrl').configurable,true);
 const instance=new ES('/hit?x=%20&a_bogus=existing',opt,'ignored');
 eq(instance instanceof ES,true);eq(instance instanceof f.NativeES,true);eq(instance.args.length,2);eq(instance.args[1],opt);eq(instance.args[0] instanceof URL,true);
 eq(instance.args[0].href,'https://fixture.invalid/hit?x=+&a_bogus=existing&msToken=old&a_bogus=synthetic');
 eq(names(f),['match','track','report','sign','native']);eq(f.trace[3].slice(0,3),['sign',true,'x=+&a_bogus=existing&msToken=old']);eq(f.trace[3][4],2);eq(Object.keys(f.trace[3][3]),[]);
 throws(()=>ES('/hit'),/Cannot call a class as a function/);eq(names(f),['match','track','report','sign','native']);
 const own=Object.create(ES.prototype);eq(ES.call(own,'/miss').args[0],'/miss');
}
{
 const f=make(),ES=f.window.EventSource;
 eq(new ES('/miss').args[0],'/miss');eq(new ES('/miss').args[1],undefined);eq(names(f),['match','native','match','native']);
 const url=new URL('https://fixture.invalid/miss');eq(new ES(url).args[0],url);
 throws(()=>new ES('http://['),TypeError);eq(names(f).at(-1),'native');
 const url2=new URL('https://fixture.invalid/hit?msToken=&a_bogus=');eq(ES.handleUrl(url2),url2);eq(url2.searchParams.getAll('a_bogus'),['','synthetic']);eq(url2.searchParams.get('msToken'),'');
 const old=ES.handleUrl;ES.handleUrl=()=>'/substituted';eq(new ES('/hit').args[0],'/substituted');ES.handleUrl=old;
 class Child extends ES{}const child=new Child('/miss');eq(child instanceof Child,true);eq(child instanceof ES,true);
}
for(const input of [undefined,null,0,'x',{}]){const f=make({ES:input});eq(f.window.EventSource,input);eq(f.root[37](),undefined);}
{
 throws(()=>make({readonly:true}),e=>e.name==='TypeError');
}
{
 const f=make({getter:(n,C)=>C});eq(f.trace.slice(0,3),[['get-es',1],['get-es',2],['set-es']]);
}
throws(()=>make({getter:(n,C)=>n===1?C:{}}),/Super expression must either be null or a function/);
{
 const f=make({track:true});const initial=f.window.EventSource;f.root[37]();const outer=f.window.EventSource;
 eq(Object.getPrototypeOf(outer),initial);const instance=new outer('/hit');eq(instance instanceof outer,true);eq(instance instanceof initial,true);
 eq(names(f),['match','track','report','sign','match','track','report','sign','native']);eq(instance.args[0].searchParams.getAll('a_bogus'),['synthetic','synthetic']);
}
{
 const f=make({token:''});new f.window.EventSource('/hit?x=%20');eq(f.trace.find(x=>x[0]==='sign')[2],'x=%20');eq(f.trace.at(-1)[1].search,'?x=+&a_bogus=synthetic');
}
for(const stage of ['match','report','sign','native']){
 const options={track:true,[stage](){throw Error(stage);}},f=make(options),url=new URL('https://fixture.invalid/hit');
 throws(()=>new f.window.EventSource(url),new RegExp(stage));eq(url.searchParams.has('msToken'),stage==='sign'||stage==='native');eq(url.searchParams.has('a_bogus'),stage==='native');
}
{
 const f=make({reflect:false}),ES=f.window.EventSource;const instance=new ES('/hit');eq(instance instanceof ES,true);eq(instance instanceof f.NativeES,true);eq(instance.args.length,2);
}
{
 const f=make(),ES=f.window.EventSource;let reads=0;Object.defineProperty(f.loc,'href',{get(){reads++;return 'https://fixture.invalid/changed/';}});
 const url=new URL('https://fixture.invalid/miss');eq(ES.handleUrl(url),url);eq(reads,1);
 const detached=ES.handleUrl;eq(detached('/miss'),'/miss');eq(reads,2);
 class Child extends ES{}Child.handleUrl=()=>'/child-override';eq(new Child('/miss').args[0],'/miss');
 eq(new ES('/miss').close,f.NativeES.prototype.close);
 Object.defineProperty(f.loc,'href',{get(){throw Error('location-href');}});throws(()=>ES.handleUrl(url),/location-href/);
}
{
 const f=make({track:true});f.root[29]=()=>{f.trace.push(['report']);f.root[24].inner='fresh';};
 new f.window.EventSource('/hit');eq(f.trace.find(x=>x[0]==='sign')[2],'msToken=fresh');
 let gets=0;Object.defineProperty(f.root[24],'inner',{get(){gets++;return gets===1?'first':'second';},configurable:true});
 f.root[33]=()=>false;new f.window.EventSource('/hit');eq(gets,2);eq(f.trace.filter(x=>x[0]==='sign').at(-1)[2],'msToken=second');
}
{
 const f=make({track:true}),url=new URL('https://fixture.invalid/hit');f.root[29]=()=>{url.pathname='/changed';url.search='?mutated=1';};
 new f.window.EventSource(url);eq(f.trace.find(x=>x[0]==='sign')[2],'mutated=1&msToken=old');eq(f.trace.at(-1)[1],url);
}
{
 const f=make({track:true}),url=new URL('https://fixture.invalid/hit');f.root[33]=()=>{throw Error('track');};
 throws(()=>new f.window.EventSource(url),/track/);eq(url.search,'');eq(names(f),['match']);
}
{
 const f=make({ES:class NativeClass{constructor(...args){this.args=args;}}}),ES=f.window.EventSource;
 eq(new ES('/miss').args.length,2);throws(()=>make({ES:()=>{}}),TypeError);
}
}
runSuite();const original=observations;observations=[];useProduction=true;runSuite();assert.deepEqual(observations,original);
console.log(JSON.stringify({sharedAssertionsPerImplementation:checks/2,matchingObservations:observations.length,network:false,sourceSHA256:createHash('sha256').update(source).digest('hex')}));
