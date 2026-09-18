const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs');
const d=decode(process.argv[2]);
function raw(globals){const a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);const ctx=vm.createContext({...globals,tt:d.strings,et:d.functions.map((f,n)=>[n>=179&&n<=206?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',ctx);const scope=[(...args)=>globals.trace.push(['diagnostic',args[0]])];ctx.make(179,scope)();return scope[1];}
async function probe(mode,sdk){const trace=[],timers=new Map();let img,now=100,id=0;const other={};
 const body={appendChild(node){trace.push(['append']);if(mode==='append-throw')throw Error('append');node.parentNode=this;},removeChild(node){trace.push(['remove']);if(mode==='remove-throw')throw Error('remove');node.parentNode=null;}};
 const document={body,createElement(tag){trace.push(['create',tag]);img=new Proxy({style:new Proxy({},{set(t,k,v){trace.push(['style',k,v]);t[k]=v;return true;}})},{set(t,k,v){trace.push(['set',k,k==='src'?['source-string-index-350',v===d.strings[350]]:typeof v==='function'?'function':v]);t[k]=v;return true;}});return img;},getElementById(key){trace.push(['id',key]);return key==='image_disable'?(mode==='missing'?null:mode==='other-node'?other:img):mode==='palette'?{}:null;},getElementsByClassName(key){trace.push(['class',key]);if(mode==='automa-throw')throw Error('automa');return mode==='automa'?{length:1}:[];},createEvent(key){trace.push(['event',key]);if(mode==='touch-throw')throw Error('touch');return {};}};
 const nav=new Proxy({brave:mode==='truthy'?{}:0,cookieEnabled:mode==='truthy'?'0':false,doNotTrack:mode==='truthy'?'0':0,pdfViewerEnabled:mode==='truthy'?1:0,serviceWorker:mode==='truthy'?{}:0,webdriver:mode==='truthy'?'false':false},{get(t,k){trace.push(['nav',k]);if(mode==='nav-throw')throw Error('nav');return t[k];}});
 const globals={trace,document,navigator:nav,Date:{now(){trace.push(['now']);if(mode==='date-throw')throw Error('date');return now++;}},setTimeout(fn,ms){trace.push(['timer',ms]);timers.set(++id,fn);return id;},clearTimeout(key){trace.push(['clear',key]);timers.delete(key);},RTCPeerConnection:mode==='rtc-absent'?undefined:class{constructor(){trace.push(['rtc']);if(mode==='rtc-throw')throw Error('rtc');}close(){trace.push(['rtc-close']);}}};
 let state='pending',result,err;const collect=sdk?sdk.createDesktopDTraitBoolCollector({...globals,onDiagnostic:code=>trace.push(['diagnostic',code])}):raw(globals);collect().then(v=>{state='resolved';result=v;},e=>{state='rejected';err=e.message;});
 for(let n=0;n<8;n++)await Promise.resolve();
 try{if(mode==='timeout'||mode==='remove-throw')timers.get(1)?.();else if(mode==='error')img?.onerror?.();else if(mode==='other-node')other.onload?.();else img?.onload?.();}catch(e){trace.push(['callback-error',e.message]);}
 for(let n=0;n<12;n++)await Promise.resolve();
 if(mode==='late-load'){img.onload();for(let n=0;n<5;n++)await Promise.resolve();}
 return JSON.parse(JSON.stringify({mode,state,result,err,trace}));
}
async function main(){const sdk=await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-bool.js')).href);const modes=['normal','error','timeout','missing','other-node','automa','palette','truthy','touch-throw','rtc-throw','rtc-absent','append-throw','automa-throw','nav-throw','date-throw','remove-throw','late-load'];for(const mode of modes)assert.deepStrictEqual(await probe(mode,sdk),await probe(mode),mode);console.log('PASS '+modes.length+' boolFeature original VM/SDK traces (synthetic DOM/RTC/timers only)');}
main().catch(error=>{console.error(error);process.exitCode=1;});

