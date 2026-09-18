const requireProductionDependency=require('./desktop-production-loader.cjs');
// Complete original .7 fetch wrapper vs production; synthetic host, no network.
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const production={};new Function('exports','require',ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-fetch-hook.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(production,requireProductionDependency);
const B=226619,start=source.lastIndexOf('function(e,r,t)',B),end=source.indexOf('"',B+1)+1;
const fields=['cache','credentials','headers','integrity','method','mode','redirect','referrer','referrerPolicy','body'];
function make(original,o){
 const trace=[],requests=[],tokens={token:o.token??'old'};let active=false,initial,options,release;
 const check=name=>{if(active&&o.fail===name)throw Error(name);};
 const deferred=new Promise(resolve=>{release=resolve;});
 const headers={get(name){trace.push(['header-get',name]);check('header-get');return o.contentType??'text/plain';}};
 class Request {
  constructor(url,init={}){
   if(active){trace.push(['newRequest',url,Object.keys(init),fields.map(k=>k==='headers'?init[k]===headers:init[k])]);check('newRequest');}
   this._url=url;this._fields={cache:'default',credentials:'same-origin',headers,integrity:'',method:'POST',mode:'cors',redirect:'follow',referrer:'about:client',referrerPolicy:'',body:null,...init};
   requests.push(this);
  }
  get url(){trace.push(['get','url']);check('url');return this._url;}
  clone(){trace.push(['clone']);check('clone');return{text(){trace.push(['text']);check('text');return o.defer?deferred:o.reject?Promise.reject(Error('text-reject')):Promise.resolve(o.text??'source-body');}};}
 }
 for(const field of fields)Object.defineProperty(Request.prototype,field,{get(){trace.push(['get',field]);check(field);return this._fields[field];}});
 const native=function(input,init){'use strict';trace.push(['fetch',this===null,arguments.length,input===initial,input instanceof URL?'url':input instanceof Request?'request':typeof input,input instanceof URL?input.href:input instanceof Request?input._url:input,init===options,init===null?null:init===undefined?'undefined':{...init}]);check('fetch');return Promise.resolve('response');};
 const target={};let current=o.absent?null:native;
 Object.defineProperty(target,'fetch',{configurable:true,get(){trace.push(['fetch-get']);return current;},set(value){trace.push(['fetch-set']);if(!o.readonly)current=value;}});
 const loc={get href(){trace.push(['base']);check('base');return 'https://fixture.invalid/base/';}};
 const context={window:target,URL,Request,location:loc};
 const collaborators={
  matchesSigning:function(path){'use strict';trace.push(['match',this===null,path]);check('match');return !o.miss;},
  matchesBehavior:function(path){'use strict';trace.push(['track',this===null,path]);check('track');return !!o.track;},
  sign:function(query,body,contentType){'use strict';trace.push(['sign',this===null,arguments.length,query,body,contentType]);check('sign');return 'signed';},
  reportBehavior:function(){'use strict';trace.push(['report',this===null]);check('report');if(o.rotate)tokens.token='rotated';},
 };
 let install;
 if(original){
  class Xhr{open(){}send(){}addEventListener(){}setRequestHeader(){}}
  const bridge={0:Symbol,1:TypeError,2:Object,3:Array,4:String,5:Number,6:Reflect,7:ReferenceError,8:Proxy,9:Boolean,10:Error,11:isNaN,12:Promise,
   13:target,14:'1.0.1.7',15:{getItem:()=>tokens.token},16:Xhr,17:URL,18:JSON,19:Date,20:{},21(){},22:{},23:{now:()=>0},24:Request,25:loc,28:RegExp,49(){}};
  vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});
  const root=bridge[51]._v[2];root[32]=collaborators.matchesSigning;root[33]=collaborators.matchesBehavior;root[34]=collaborators.sign;
  root[29]=function(){Reflect.apply(collaborators.reportBehavior,null,[]);root[24].inner=tokens.token;};
  install=()=>root[36]();
 }else{install=()=>production.installDesktopFetchHook(context,tokens,collaborators);install();}
 const installTrace=trace.splice(0);
 if(o.twice)install();
 if(o.absent)return{installTrace,trace,absent:current===null};
 initial=o.kind==='request'?new Request(o.url||'https://fixture.invalid/hit?x=a%20b',{
  body:o.requestBody?'stream':null,method:o.method??'POST',...(o.headersNull?{headers:null}:{})
 }):o.kind==='url'?new URL(o.url||'https://fixture.invalid/hit?x=a%20b'):o.url||'/hit?x=a%20b';
 options=o.nullInit?null:o.explicitUndefined?undefined:{...(o.init||{})};
 if(o.frozen)Object.freeze(options);
 active=true;trace.length=0;
 let promise,syncError;
 try{promise=Reflect.apply(current,{notWindow:true},o.omitInit?[initial]:[initial,options,'ignored']);}catch(e){syncError=e.name+':'+e.message;}
 const before=structuredClone(trace);
 if(o.defer){if(o.lateBody&&options)options.body='late-body';release(o.text??'source-body');}
 return{installTrace,trace,before,promise,syncError,options,initial};
}
async function run(original,o){
 const f=make(original,o);if(f.absent)return f;
 let result,error;try{result=await f.promise;}catch(e){error={name:e.name,message:e.name==='TypeError'?'TypeError':e.message};}
 return structuredClone({install:f.installTrace,before:f.before,trace:f.trace,result,error,syncError:f.syncError,options:f.options,
  inputUrl:f.initial instanceof URL?f.initial.href:undefined});
}
let comparisons=0;
async function compare(o){const a=await run(true,o),b=await run(false,o);assert.deepEqual(b,a,JSON.stringify(o));comparisons++;}
(async()=>{
 for(const kind of ['string','url','request']){
  for(const token of ['', 'old'])for(const miss of [false,true])await compare({kind,token,miss,track:true});
  for(const url of ['https://fixture.invalid/hit?msToken=&a_bogus=old','https://fixture.invalid/hit?x=a%20b&x=~'])await compare({kind,url,token:''});
  for(const opt of [{nullInit:true},{omitInit:true},{explicitUndefined:true},{init:{body:''}},{init:{body:0}},{init:{body:'override'}},{twice:true}])await compare({kind,...opt});
 }
 for(const method of ['GET','get','POST',''])for(const text of ['', 'source-body'])for(const requestBody of [false,true])await compare({kind:'request',method,text,requestBody});
 for(const contentType of ['','multipart/form-data; boundary=abc','text/plain'])await compare({kind:'request',contentType,init:{body:'override'}});
 for(const o of [{defer:true},{defer:true,lateBody:true},{reject:true},{headersNull:true},{frozen:true},{frozen:true,method:'GET',text:''}])await compare({kind:'request',...o});
 for(const kind of ['string','request'])for(const fail of ['base','match','track','report','sign','fetch'])await compare({kind,fail,track:true});
 for(const fail of ['url','clone','text','headers','header-get',...fields,'newRequest'])await compare({kind:'request',fail});
 for(const o of [{absent:true},{readonly:true},{rotate:true,track:true},{kind:'string',url:'http://['}])await compare(o);
 console.log(JSON.stringify({fetchComparisons:comparisons,network:false,syntheticHost:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
