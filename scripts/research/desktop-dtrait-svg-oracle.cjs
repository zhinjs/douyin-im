// Pinned SVG function, supplied DOM only. Never launches a browser or measures a real user document.
const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs');
const {rawFeature}=require('./desktop-dtrait-features-oracle.cjs');
function original(path,document,hash){
  const d=decode(path),a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);
  const context=vm.createContext({document,tt:d.strings,et:d.functions.map((f,id)=>[id===291||id===292?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});
  vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',context);
  const scope=[hash];context.make(291,scope)();return scope[1];
}
function scenario(kind,sdk,mode){
  const trace=[],nodes=[],bind={encoder:new TextEncoder(),onDiagnostic(){},getCryptoUtil:()=>undefined};
  const hash=kind==='raw'?rawFeature(process.argv[2],bind).hash:sdk.createDesktopDTraitHash(bind);
  const track=value=>{trace.push(['hash',value]);if(mode==='hash-throw')throw Error('hash');return hash(value);};
  const detached={removeChild(node){trace.push(['detached-remove',node.tag]);node.parentNode=null;}};
  const found={tag:'found',parentNode:mode==='null-parent'?null:detached};
  const document={createElementNS(namespace,tag){
    trace.push(['create',namespace,tag]);if(mode==='create-throw')throw Error('create');
    const node={tag,parentNode:null,setAttribute(k,v){trace.push(['attr',tag,k,v]);},appendChild(child){trace.push(['append',tag,child.tag]);child.parentNode=node;},getBBox(){
      trace.push(['bbox']);if(mode==='bbox-throw')throw Error('bbox');
      if(mode.startsWith('fallback')||mode==='null-parent')nodes[0].parentNode=detached;
      return Object.fromEntries(['x','y','width','height'].map((key,i)=>[key,[10.5,20.25,123.450001,67.89][i]]));
    }};
    let id='';Object.defineProperty(node,'id',{get:()=>id,set(value){trace.push(['id',value]);id=value;}});
    nodes.push(node);return node;
  },body:{appendChild(node){trace.push(['body-append',node.tag]);node.parentNode=this;},removeChild(node){trace.push(['body-remove',node.tag]);if(mode==='remove-throw')throw Error('remove');node.parentNode=null;}},
  querySelector(selector){trace.push(['query',selector]);return mode==='fallback-missing'?null:found;}};
  if(mode==='box-getter'){
    const create=document.createElementNS;
    document.createElementNS=function(...args){const node=create.apply(this,args);if(node.tag==='rect')node.getBBox=()=>Object.defineProperty({},'x',{get(){trace.push(['read-x']);throw Error('x');}});return node;};
  }
  let result;
  try{result=(kind==='raw'?original(process.argv[2],document,track):sdk.createDesktopDTraitSvgCollector({document,hash:track}))();}catch(error){result={error:error.name};}
  return {result:JSON.parse(JSON.stringify(result)),trace,attached:nodes.map(n=>n.parentNode===document.body)};
}
async function main(){
  const sdk={...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-svg.js')).href),...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-features.js')).href)};
  const modes=['normal','fallback-found','fallback-missing','null-parent','bbox-throw','create-throw','remove-throw','hash-throw','box-getter'];
  for(const mode of modes)assert.deepStrictEqual(scenario('sdk',sdk,mode),scenario('raw',sdk,mode),mode);
  console.log(`PASS ${modes.length} original SVG VM/SDK DOM and hash traces (synthetic document only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
