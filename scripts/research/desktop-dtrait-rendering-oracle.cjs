// Pinned Canvas/DOM VM only, recording synthetic rendering interfaces; no browser or real pixel/device capture.
const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs'),{rawFeature}=require('./desktop-dtrait-features-oracle.cjs');
function raw(path,id,document,hash){
  const d=decode(path),a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);
  const context=vm.createContext({document,tt:d.strings,et:d.functions.map((f,n)=>[n===id||n===id+1?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});
  vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',context);const scope=[hash];context.make(id,scope)();return scope[1];
}
function scenario(kind,sdk,type,mode){
  const trace=[],io={encoder:new TextEncoder(),onDiagnostic(){},getCryptoUtil:()=>undefined};
  const hash=kind==='raw'?rawFeature(process.argv[2],io).hash:sdk.createDesktopDTraitHash(io);
  const track=value=>{trace.push(['hash',value]);if(mode==='hash-throw')throw Error('hash');return mode==='hash-zero'?0:hash(value);};
  let document,element;
  if(type==='canvas'){
    const gradient={addColorStop(...args){trace.push(['stop',...args]);if(mode==='stop-throw')throw Error('stop');}};
    const functions=Object.fromEntries(['fillRect','beginPath','arc','fill','fillText','moveTo','lineTo','stroke'].map(name=>[name,function(...args){trace.push([name,...args]);if(mode===name+'-throw')throw Error(name);} ]));
    functions.createRadialGradient=(...args)=>{trace.push(['gradient',...args]);return gradient;};
    const draw=new Proxy(functions,{set(target,key,value){trace.push(['set',key,value===gradient?'gradient':value]);target[key]=value;return true;}});
    element=new Proxy({getContext(value){trace.push(['context',value]);return mode==='no-context'?null:draw;},toDataURL(){trace.push(['dataURL']);if(mode==='data-throw')throw Error('data');return mode==='empty-url'?'':'data:image/png;base64,c3ludGhldGlj';}}, {set(target,key,value){trace.push(['canvas-set',key,value]);target[key]=value;return true;}});
    document={createElement(tag){trace.push(['create',tag]);return element;}};
  }else{
    const other={removeChild(node){trace.push(['other-remove',node===element?'original':'found']);}};
    const body={appendChild(node){trace.push(['append']);node.parentNode=body;},removeChild(node){trace.push(['remove']);if(mode==='remove-throw')throw Error('remove');node.parentNode=null;}};
    element={parentNode:null,style:new Proxy({},{set(target,key,value){trace.push(['style',key,value]);target[key]=value;return true;}}),getBoundingClientRect(){trace.push(['measure']);if(mode==='measure-throw')throw Error('measure');if(mode.startsWith('fallback'))element.parentNode=other;
      return Object.defineProperties({},Object.fromEntries(['width','height','x','y'].map((key,i)=>[key,{get(){trace.push(['read',key]);if(mode==='getter-throw')throw Error('getter');return [111.25,222.5,-33.75,44.125][i];}}])));
    }};
    Object.defineProperty(element,'id',{set(value){trace.push(['id',value]);}});
    document={body,createElement(tag){trace.push(['create',tag]);return element;},querySelector(query){trace.push(['query',query]);return mode==='fallback-missing'?null:{parentNode:mode==='fallback-null'?null:other};}};
  }
  let result;try{result=(kind==='raw'?raw(process.argv[2],type==='canvas'?207:225,document,track):type==='canvas'?sdk.createDesktopDTraitCanvasCollector({document,Math,hash:track}):sdk.createDesktopDTraitDomCollector({document,hash:track}))();}catch(error){result={error:error.name};}
  return {result:JSON.parse(JSON.stringify(result)),trace,attached:type==='dom'?element.parentNode===document.body:false};
}
async function main(){
  const sdk={...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-rendering.js')).href),...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-features.js')).href)};
  const canvas=['normal','no-context','stop-throw','fillText-throw','stroke-throw','data-throw','empty-url','hash-throw','hash-zero'];
  const dom=['normal','fallback-found','fallback-missing','fallback-null','measure-throw','remove-throw','getter-throw','hash-throw','hash-zero'];
  for(const mode of canvas)assert.deepStrictEqual(scenario('sdk',sdk,'canvas',mode),scenario('raw',sdk,'canvas',mode),'canvas '+mode);
  for(const mode of dom)assert.deepStrictEqual(scenario('sdk',sdk,'dom',mode),scenario('raw',sdk,'dom',mode),'dom '+mode);
  console.log(`PASS ${canvas.length} Canvas and ${dom.length} DOM rect original VM/SDK traces (synthetic rendering only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
