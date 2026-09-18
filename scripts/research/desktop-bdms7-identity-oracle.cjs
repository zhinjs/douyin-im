const requireProductionDependency=require('./desktop-production-loader.cjs');
// Complete original Q VM versus production, including load/nap and shared field order.
const assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
function original(bridge){const p=152040,start=source.lastIndexOf('function(e,r,t)',p),end=source.indexOf('"',p+1)+1;vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});return bridge[14];}
const compiled={};new Function('exports','require',ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-device-identity.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(compiled,requireProductionDependency);
async function run(isOriginal,options={}){
  const trace=[],images=[],stores=[new Map(),new Map()];let checks=0,navReads=0;
  const injected=Error('injected');
  const read=(key,value)=>{trace.push(key);if(options.fail===key)throw injected;return value;};
  const track=(o,label)=>new Proxy(o,{get(o,k){return read(`${label}.${String(k)}`,o[k]);}});
  const fonts=track({check(font){trace.push(['font',this===fonts,font]);if(options.fail==='check')throw injected;return options.allFonts||checks++%2===0;}},'fonts');
  const canvasContext=track({drawImage(...args){trace.push(['draw',this===canvasContext,args[0]===images[0],...args.slice(1)]);if(options.fail==='draw')throw injected;},getImageData(...args){trace.push(['pixels',this===canvasContext,...args]);if(options.fail==='pixels')throw injected;return track({data:track({3:'alpha' in options?options.alpha:0},'data')},'pixels');}},'canvasContext');
  const canvas=track({getContext(name){trace.push(['getContext',this===canvas,name]);if(options.fail==='getContext')throw injected;return options.noCanvasContext?null:canvasContext;}},'canvas');
  const document=track({documentMode:options.ie,fonts:options.noFonts?null:fonts,createElement(name){trace.push(['createElement',this===document,name]);if(options.fail==='createElement')throw injected;return canvas;}},'document');
  const evalObject=track({toString(){trace.push(['evalToString',this===evalObject]);if(options.fail==='evalToString')throw injected;return '[native eval]';}},'eval');
  const window=track({opr:options.opera,InstallTrigger:options.firefox?null:undefined,chrome:options.noChrome?null:track({edgeNurturingPrivate:options.edge},'chrome'),ApplePaySession:options.safari,eval:evalObject},'window');
  const storage=(index)=>{const label=index?'sessionStorage':'localStorage';const obj=track({setItem(k,v){trace.push([`${label}.set`,this===obj,k,v]);if(options.fail===`${label}.set`)throw injected;stores[index].set(k,v);},removeItem(k){trace.push([`${label}.remove`,this===obj,k]);if(options.fail===`${label}.remove`)throw injected;stores[index].delete(k);}},label);return obj;};
  const localStorage=storage(0),sessionStorage=storage(1);
  const permission=track({query({name}){trace.push(['query',this===permission,name]);if(options.fail===`query:${name}`)throw injected;
    if(options.badThen)return {};
    if(options.reject)return Promise.reject(options.reject);
    return Promise.resolve(track({state:options.state||'granted'},'permission'));}},'permissions');
  const navigator=track({get permissions(){if(options.fail==='laterPermissions'&&navReads++>0)throw injected;return options.noPermissions?null:permission;}},'navigator');
  class Image { constructor(){read('ImageConstructor');const value=new Proxy(this,{set(o,k,v){trace.push(['imageSet',k]);if(options.fail===`image.${String(k)}`)throw injected;return Reflect.set(o,k,v);}});images.push(value);return value;} }
  class HostDate { constructor(){read('DateConstructor');} static now(){return read('Date.now',1000);} getTimezoneOffset(){return read('Date.offset',options.offset??-330);} }
  const math={get floor(){return read('Math.floor',function(value){trace.push(['floor',this===math,value]);return Math.floor(value);});}};
  const context={get window(){return read('window',window);},get document(){return read('document',document);},get Image(){return read('Image',Image);},get localStorage(){return read('localStorage',localStorage);},get sessionStorage(){return read('sessionStorage',sessionStorage);},get navigator(){return read('navigator',navigator);},Date:HostDate,Math:math};
  const fn=isOriginal?original({0:Symbol,1:Object,2:Error,3:TypeError,4:isNaN,5:Promise,get 6(){return context.window;},get 7(){return context.document;},get 8(){return context.Image;},get 9(){return context.localStorage;},get 10(){return context.sessionStorage;},get 11(){return context.navigator;},12:HostDate,13:math}):()=>new compiled.DesktopDeviceIdentityCollector(context).collect();
  let result;const pending=fn().then(value=>{result={value:{...value}};},error=>{result={error:error.name,injected:error===injected};});
  trace.push('returned');
  if(images.length&&!options.pending&&typeof images[0][options.imageError?'onerror':'onload']==='function'){
    trace.push('event');images[0][options.imageError?'onerror':'onload']();
  }
  if(options.pending){for(let i=0;i<8;i++)await Promise.resolve();return{result:result||'pending',trace,stores:stores.map(s=>[...s])};}
  await pending;
  return {result,trace,stores:stores.map(s=>[...s])};
}
(async()=>{
  const options=[{}, {allFonts:true},{noFonts:true},{noPermissions:true},{noChrome:true},{imageError:true},{noCanvasContext:true},{pending:true},
    ...[0,'0',null,undefined,255].map(alpha=>({alpha})),...['denied','prompt','other'].map(state=>({state})),
    ...[0,60,90,-90].map(offset=>({offset})),...[{message:'is not a valid enum value of type PermissionName'},{message:'x is not a valid enum value of type PermissionName'},{message:'other'},{}].map(reject=>({reject})),{badThen:true},
    ...['window','window.opr','window.InstallTrigger','window.chrome','chrome.edgeNurturingPrivate','document','document.documentMode','window.ApplePaySession','document.fonts','fonts.check','check','Image','ImageConstructor','image.onload','image.onerror','image.src','document.createElement','createElement','canvas.getContext','getContext','canvasContext.drawImage','draw','canvasContext.getImageData','pixels','pixels.data','data.3','localStorage','localStorage.setItem','localStorage.set','localStorage.removeItem','localStorage.remove','sessionStorage','sessionStorage.set','sessionStorage.remove','navigator','navigator.permissions','laterPermissions','permissions.query','query:camera','permission.state','window.eval','eval.toString','evalToString','Date.now','Math.floor','DateConstructor','Date.offset'].map(fail=>({fail}))];
  for(let bits=0;bits<32;bits++)options.push({opera:!!(bits&1),firefox:!!(bits&2),edge:!!(bits&4),ie:!!(bits&8),safari:!!(bits&16)});
  for(const option of options)assert.deepEqual(await run(false,option),await run(true,option),JSON.stringify(option));
  console.log(JSON.stringify({identityComparisons:options.length,syntheticHosts:true,network:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
