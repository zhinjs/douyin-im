const requireProductionDependency=require('./desktop-production-loader.cjs');
const {readFileSync}=require('node:fs');
const ts=require('typescript'),{join}=require('node:path');
const cache={};
function production(file){
 if(cache[file])return cache[file]; const exports={};cache[file]=exports;
 const input=readFileSync(join(__dirname,'../../src/anti-bot/',file+'.ts'),'utf8');
 new Function('exports','require',ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,(name)=>name==='./desktop-property-write.js'?requireProductionDependency(name):(name=>production(name.replace('./','').replace('.js','')))(name));
 return exports;
}
const {installDesktopXhrHook}=production('desktop-xhr-hook');
let useProduction=false;
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict'),vm=require('node:vm');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const B=226619,start=source.lastIndexOf('function(e,r,t)',B),end=source.indexOf('"',B+1)+1;
function make(options={}) {
 const trace=[],loc={href:'https://fixture.invalid/base/'};let xhr;
 class XHR {
  open(...args){trace.push(['open',this===xhr,...args]);options.open?.(this);return 'open-return';}
  setRequestHeader(...args){trace.push(['header',this===xhr,...args]);options.header?.(this);return 'header-return';}
  send(...args){trace.push(['send',this===xhr,...args]);options.send?.(this);return 'send-return';}
  abort(...args){trace.push(['abort',this===xhr,...args]);return 'abort-return';}
  addEventListener(){}
 }
 const originals={open:XHR.prototype.open,header:XHR.prototype.setRequestHeader,send:XHR.prototype.send,abort:XHR.prototype.abort};
 if(options.capture)for(const name of ['open','send','setRequestHeader','addEventListener']) {
  let value=XHR.prototype[name];
  Object.defineProperty(XHR.prototype,name,{configurable:true,get(){trace.push(['get-method',name]);return value;},set(next){trace.push(['set-method',name]);value=next;}});
 }
 const bridge={3:Array,13:{},15:{getItem(){return 'old';}},16:XHR,17:URL,18:JSON,19:Date,20:{},21(){},23:{now:()=>0},25:loc,28:RegExp,47:x=>x,49(){}};
 let root;
 if(useProduction){
  // Match module-initialization report capture before the hook; no report is sent.
  void XHR.prototype.open;void XHR.prototype.send;void XHR.prototype.addEventListener;
  root={};bridge[50]={aid:0};
  const context={XMLHttpRequest:XHR,Array,URL,location:loc};
  root[35]=()=>installDesktopXhrHook(context,{token:'old'},{
   matchesSigning:function(path){return Reflect.apply(root[32],null,[path]);},
   matchesBehavior:function(path){return Reflect.apply(root[33],null,[path]);},
   sign:function(query,body){return Reflect.apply(root[34],null,[query,body]);},
   reportBehavior:function(){return Reflect.apply(root[29],null,[]);}
  });
  root[35]();
 }else{
  vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});
  root=bridge[51]._v[2];
 }
 root[32]=function(path){'use strict';trace.push(['match',this===null,path]);return options.match?options.match(path):path.startsWith('/hit');};
 root[33]=function(path){'use strict';trace.push(['track',this===null,path]);return !!options.track;};
 root[34]=function(query,body){'use strict';trace.push(['sign',this===null,query,body,arguments.length]);options.sign?.(xhr);return 'synthetic';};
 root[29]=function(){'use strict';trace.push(['report',this===null,arguments.length]);options.report?.(xhr);};
 xhr=new XHR();
 return {trace,xhr,XHR,root,bridge,loc,originals};
}
let checks=0, observations=[];function eq(a,b,label){assert.deepEqual(a,b,label);observations.push(JSON.stringify(a,(_,v)=>typeof v==='function'?'[function]':v));checks++;}
function throws(fn,msg){assert.throws(fn,msg);checks++;}
const names=f=>f.trace.map(x=>x[0]);
function runSuite(){
{
 const f=make({capture:true});
 eq(f.trace,[['get-method','open'],['get-method','send'],['get-method','addEventListener'],['get-method','open'],['get-method','send'],['get-method','setRequestHeader'],['set-method','open'],['set-method','setRequestHeader'],['set-method','send']]);
}
{
 const f=make({track:true});eq(f.bridge[50].aid,0);eq(f.XHR.prototype.abort,f.originals.abort);
 eq(f.xhr.open('POST','/hit',false,'user','pass','extra'),undefined);
 eq(f.xhr.setRequestHeader('x','y','extra'),undefined);eq(names(f),['match']);
 eq(f.xhr.bdmsInvokeList[0].func,f.originals.open);eq(Array.from(f.xhr.bdmsInvokeList[0].args),['POST','/hit',false,'user','pass','extra']);
 eq(f.xhr.send('body','ignored'),undefined);eq(names(f),['match','sign','open','header','track','report','send']);
 eq(f.trace[1],['sign',true,'msToken=old','body',2]);eq(f.trace.at(-1),['send',true,'body']);eq(Object.hasOwn(f.xhr,'bdmsInvokeList'),false);
}
{
 const f=make();eq(f.xhr.open('GET','/miss'),undefined);eq(f.xhr.setRequestHeader('x','y'),undefined);eq(f.xhr.send(),undefined);
 eq(names(f),['match','open','header','send']);eq(f.trace.at(-1),['send',true,undefined]);
}
{
 const f=make();f.xhr.open('GET','/hit');f.xhr.setRequestHeader('x','y');eq(f.xhr.abort('extra'),'abort-return');
 eq(f.xhr.bdmsInvokeList.length,2);f.xhr.send('after-abort');eq(names(f),['match','abort','sign','open','header','track','send']);
 f.xhr.send('again');eq(f.trace.at(-1),['send',true,'again']);eq(names(f).filter(x=>x==='sign').length,1);
}
{
 const f=make();f.xhr.open('GET','/hit');f.xhr.setRequestHeader('x','y');f.xhr.open('POST','/miss');f.xhr.send('new');
 eq(names(f),['match','match','open','send']);eq(Object.hasOwn(f.xhr,'bdmsInvokeList'),false);
}
{
 const f=make();f.xhr.open('GET','/hit');throws(()=>f.xhr.open('GET','http://['),TypeError);eq(Object.hasOwn(f.xhr,'bdmsInvokeList'),false);
 f.xhr.send('after-bad-open');eq(names(f),['match','send']);
}
{
 const f=make();const url=new URL('https://fixture.invalid/hit');f.xhr.open('GET',url);url.pathname='/now-miss';f.xhr.send();
 eq(f.trace.find(x=>x[0]==='track')[2],'/now-miss');eq(f.trace.find(x=>x[0]==='open')[3],url);eq(names(f).filter(x=>x==='match').length,1);
}
{
 const f=make({match:()=>true});f.xhr.open('GET','relative');f.loc.href='https://changed.invalid/later/';f.xhr.send();
 eq(f.trace.find(x=>x[0]==='open')[3],'https://changed.invalid/later/relative?msToken=old&a_bogus=synthetic');
}
for(const stage of ['sign','open','header','report','send']) {
 const f=make({track:true,[stage](){throw Error(stage);}});const url=new URL('https://fixture.invalid/hit');f.xhr.open('POST',url);f.xhr.setRequestHeader('x','y');
 throws(()=>f.xhr.send('body'),new RegExp(stage));eq(Object.hasOwn(f.xhr,'bdmsInvokeList'),stage!=='send');eq(url.searchParams.has('a_bogus'),stage!=='sign');
}
{
 let first=true;const f=make({header(){if(first){first=false;throw Error('once');}}});f.xhr.open('POST','/hit');f.xhr.setRequestHeader('x','y');
 throws(()=>f.xhr.send('first'),/once/);f.xhr.send('second');eq(names(f),['match','sign','open','header','open','header','track','send']);eq(f.trace.at(-1),['send',true,'second']);
}
{
 const f=make({open(xhr){xhr.setRequestHeader('during-open','value');}});f.xhr.open('POST','/hit');f.xhr.setRequestHeader('original','value');f.xhr.send('body');
 eq(names(f),['match','sign','open','header','track','send']);eq(f.trace.find(x=>x[0]==='header').slice(2),['original','value']);
}
{
 const f=make({open(xhr){xhr.bdmsInvokeList[1].args[1]='changed';}});f.xhr.open('POST','/hit');f.xhr.setRequestHeader('x','original');f.xhr.send();
 eq(f.trace.find(x=>x[0]==='header').slice(2),['x','changed']);
}
{
 const f=make({track:true,report(xhr){xhr.setRequestHeader('during-report','lost');}});f.xhr.open('POST','/hit');f.xhr.send();
 eq(names(f),['match','sign','open','track','report','send']);eq(Object.hasOwn(f.xhr,'bdmsInvokeList'),false);
}
{
 const f=make();Object.defineProperty(f.xhr,'bdmsInvokeList',{value:[{func:f.originals.open,args:['GET','/hit-old']}],configurable:false,writable:true});
 throws(()=>f.xhr.open('POST','/miss'),e=>e.name==='TypeError');eq(f.xhr.bdmsInvokeList.length,1);
 throws(()=>f.xhr.send(),e=>e.name==='TypeError');
 eq(names(f),['sign','open','track']);eq(Object.hasOwn(f.xhr,'bdmsInvokeList'),true);
}
{
 const f=make();f.root[35]();f.xhr.open('POST','/hit');f.xhr.send('body');
 eq(names(f),['match','sign','match','track','send']);eq(names(f).includes('open'),false);
}
{
 const f=make();f.originals.open.apply=function(receiver,args){f.trace.push(['custom-apply',receiver===f.xhr,...args]);};
 f.xhr.open('POST','/hit');f.xhr.send();eq(names(f),['match','sign','custom-apply','track','send']);
}
}
runSuite();const original=observations;observations=[];useProduction=true;runSuite();
assert.deepEqual(observations,original);
console.log(JSON.stringify({sharedAssertionsPerImplementation:checks/2,matchingObservations:observations.length,network:false,sourceSHA256:createHash('sha256').update(source).digest('hex')}));
