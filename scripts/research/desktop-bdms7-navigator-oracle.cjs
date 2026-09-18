const requireProductionDependency=require('./desktop-production-loader.cjs');
// Complete original J/G/Z VM blocks versus production, synthetic hosts only.
const assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
function block(position,bridge){const start=source.lastIndexOf('function(e,r,t)',position),end=source.indexOf('"',position+1)+1;vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});return bridge;}
function load(name){const exports={};new Function('exports','require',ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,requireProductionDependency);return exports;}
const {DesktopNavigatorCollector}=load('desktop-navigator'),{DesktopPropertyClassifier}=load('desktop-device-properties'),{collectDesktopPlugins}=load('desktop-plugins'),{DesktopWindowCollector}=load('desktop-window');
const fields=['appCodeName','appMinorVersion','appName','appVersion','bluetooth','buildID','cookieEnabled','cpuClass','credentials','deviceMemory','doNotTrack','hardwareConcurrency','language','languages','maxTouchPoints','msDoNotTrack','oscpu','platform','product','productSub','requestMediaKeySystemAccess','storage','systemLanguage','touchEvent','touchstart','userLanguage','vendor','vendorSub','vibrate','webdriver'];
function navRun(original,options={}) {
  const trace=[];let floorReads=0;const thrown=Error('injected');
  const values={languages:['zh','en'],cookieEnabled:false,hardwareConcurrency:3.9,maxTouchPoints:2.8};
  if('value' in options){values.hardwareConcurrency=options.value;values.maxTouchPoints=options.value;}
  if(options.convert)values.appCodeName={ [Symbol.toPrimitive](hint){trace.push(hint);return 'name';}};
  if(options.symbol)values.appCodeName=Symbol('bad');
  if(options.tag)values.bluetooth={get [Symbol.toStringTag](){throw thrown;}};
  const navigator=new Proxy(values,{get(o,k){trace.push(['nav',k]);if(k===options.fail)throw thrown;if(options.double&&k==='hardwareConcurrency')return ++floorReads===1?2:0;return o[k];}});
  const docValues={get createEvent(){trace.push('createEvent');if(options.fail==='createEvent')throw thrown;return options.missing?undefined:function(name){trace.push(['call',this===document,name]);if(options.fail==='call')throw thrown;return null;};}};
  const document=options.nullDoc?null:new Proxy(docValues,{set(o,k,v){trace.push(['docSet',k,v]);if(options.fail==='setter')throw thrown;if(options.readonly)return false;return Reflect.set(o,k,v);}});
  if(options.fail==='setter'||options.readonly)Object.defineProperty(docValues,'createEvent',{get(){trace.push('createEvent');throw thrown;}});
  const window=new Proxy(options.touch?{ontouchstart:undefined}:{},{has(o,k){trace.push(['has',k]);if(options.fail==='has')throw thrown;return Reflect.has(o,k);}});
  const math={get floor(){trace.push('floor');if(options.fail==='floor')throw thrown;return function(n){trace.push(['floorReceiver',this===math]);if(options.fail==='floorCall')throw thrown;return Math.floor(n);};}};
  const context={get navigator(){trace.push('navigator');if(options.fail==='navigator')throw thrown;return navigator;},get document(){trace.push('document');if(options.fail==='document')throw thrown;return document;},get window(){trace.push('window');if(options.fail==='window')throw thrown;return window;},Math:math};
  const g=original?block(145817,{0:Symbol,1:Object,2:{}})[3]:new DesktopPropertyClassifier({Symbol,Object});
  const collector=original?undefined:new DesktopNavigatorCollector(context,g);
  const fn=original?block(172854,{get 0(){return context.document;},get 1(){return context.window;},get 2(){return context.navigator;},3:math,4:g})[5]:()=>collector.collect();
  let result;
  try {
    const a=fn();
    // VM function metadata is implementation-private; compare its visible report fields,
    // identity across calls, and probe result without serializing throwing document getters.
    if(typeof a==='function'){
      const props=Object.fromEntries(fields.filter(k=>Object.hasOwn(a,k)).map(k=>[k,a[k]]));
      result={kind:'function',props,same:fn()===a,probe:a()};
    }else if(a===document)result={kind:'document',props:Object.fromEntries(fields.filter(k=>Object.hasOwn(docValues,k)).map(k=>[k,docValues[k]]))};
    else result={kind:typeof a,value:structuredClone(a)};
  }catch(e){result={error:e.name,injected:e===thrown};}
  return {result,trace};
}
function pluginsRun(original,options={}){
  const trace=[];let listReads=0,pluginReads=0;
  const read=(name,value)=>{trace.push(name);if(options.fail===name)throw Error(name);return value;};
  const convert={ [Symbol.toPrimitive](hint){trace.push(['hint',hint]);return 'v';}};
  const mimes=[0,1,2].map(i=>({get type(){return read(`type${i}`,options.convert?convert:`t${i}`);},get suffixes(){return read(`suffixes${i}`,options.convert?convert:'s');}}));
  const plugin={get length(){return read('plugin.length',options.shrink?++pluginReads===1?3:1:3);},get filename(){return read('filename',options.symbol?Symbol('bad'):options.convert?convert:'f');},get item(){return read('plugin.item',function(i){trace.push(['pluginCall',i,this===plugin]);if(options.fail===`pluginCall${i}`)throw Error('item');return options.holes&&i===1?null:mimes[i];});}};
  const list={get length(){return read('list.length',options.grow?++listReads===1?1:2:2);},get item(){return read('list.item',function(i){trace.push(['listCall',i,this===list]);return options.holes&&i===0?null:plugin;});}};
  const nav={get plugins(){return read('plugins',options.empty?null:list);}};
  const context={get navigator(){return read('navigator',nav);}};
  const fn=original?block(177941,{get 0(){return context.navigator;}})[1]:()=>collectDesktopPlugins(context);
  return{result:structuredClone(fn()),trace};
}
let navigatorComparisons=0,pluginsComparisons=0;
for(const options of [{},{touch:true},{missing:true},{convert:true},{symbol:true},{tag:true},{double:true},{nullDoc:true},{readonly:true},
  ...[undefined,null,false,0,-0,'',NaN,'foo',-2.1,Infinity].map(value=>({value})),
  ...[...fields.filter(k=>!['touchEvent','touchstart'].includes(k)),'createEvent','call','has','floor','floorCall','navigator','document','window','setter'].map(fail=>({fail}))]){
  assert.deepEqual(navRun(false,options),navRun(true,options),`navigator ${JSON.stringify(options)}`);navigatorComparisons++;
}
for(const options of [{},{empty:true},{convert:true},{symbol:true},{holes:true},{grow:true},{shrink:true},
  ...['navigator','plugins','list.length','list.item','plugin.length','plugin.item','filename','type0','suffixes0','type1','suffixes1','type2','suffixes2','pluginCall1'].map(fail=>({fail}))]){
  assert.deepEqual(pluginsRun(false,options),pluginsRun(true,options),`plugins ${JSON.stringify(options)}`);pluginsComparisons++;
}
const windowFields=['ActiveXObject','BluetoothUUID','devicePixelRatio','external','Image','indexDB','isSecureContext','localStorage','location','locationbar','mozRTCPeerConnection','netscape','postMessage','sessionStorage','toolbar','webkitRequestAnimationFrame'];
function windowRun(original,options={}){
  const trace=[];let reads=0;const injected=Error('injected');
  const values={devicePixelRatio:'dpr' in options?options.dpr:1.75,location:'location' in options?options.location:{get href(){trace.push('href');if(options.fail==='href')throw injected;return options.href;}}};
  if(options.tag)values.ActiveXObject={get [Symbol.toStringTag](){throw injected;}};
  const window=options.nullWindow?null:new Proxy(values,{get(o,k){trace.push(k);if(k===options.fail)throw injected;if(options.double&&k==='devicePixelRatio')return ++reads===1?2:0;return o[k];},set(){throw Error('unexpected write');}});
  const math={get floor(){trace.push('floor');if(options.fail==='floor')throw injected;return function(n){trace.push(['floorReceiver',this===math]);if(options.fail==='floorCall')throw injected;return Math.floor(n);};}};
  const context={Math:math,get window(){trace.push('window');if(options.fail==='window')throw injected;return window;}};
  const g=original?block(145817,{0:Symbol,1:Object,2:{}})[3]:new DesktopPropertyClassifier({Symbol,Object});
  const collector=original?undefined:new DesktopWindowCollector(context,g);
  const fn=original?block(194257,{get 0(){return context.window;},1:math,2:g})[3]:()=>collector.collect();
  let result;
  try{const value=fn();result={value:{...value,location:typeof value.location==='symbol'?'symbol':value.location},hrefIdentity:value.location===options.href,windowIdentity:value===window};}
  catch(e){result={error:e.name,injected:e===injected};}
  return{result,trace};
}
let windowComparisons=0;
for(const options of [{},{double:true},{tag:true},{nullWindow:true},
  ...[undefined,null,0,-0,false,'',NaN,-1.1,'x',Symbol('dpr')].map(dpr=>({dpr})),
  ...[undefined,null,0,false,'',NaN,Symbol('href'),{},27,'file:///page'].map(href=>({href})),
  ...[undefined,null,0,false,'',NaN].map(location=>({location})),
  ...[...windowFields,'window','href','floor','floorCall'].map(fail=>({fail}))]){
  assert.deepEqual(windowRun(false,options),windowRun(true,options),`window ${JSON.stringify(options)}`);windowComparisons++;
}
const {collectDesktopWebGl}=load('desktop-webgl');
const parameters=['BLUE_BITS','DEPTH_BITS','GREEN_BITS','MAX_COMBINED_TEXTURE_IMAGE_UNITS','MAX_CUBE_MAP_TEXTURE_SIZE','MAX_FRAGMENT_UNIFORM_VECTORS','MAX_RENDERBUFFER_SIZE','MAX_TEXTURE_IMAGE_UNITS','MAX_TEXTURE_SIZE','MAX_VARYING_VECTORS','MAX_VERTEX_ATTRIBS','MAX_VERTEX_TEXTURE_IMAGE_UNITS','MAX_VERTEX_UNIFORM_VECTORS','SHADING_LANGUAGE_VERSION','STENCIL_BITS','VERSION'];
function webglRun(original,options={}){
  const trace=[];const injected=Error('injected');
  const track=(o,label)=>new Proxy(o,{get(o,k){trace.push(`${label}.${String(k)}`);if(options.fail===`${label}.${String(k)}`)throw injected;return o[k];}});
  const call=(label,receiver,args)=>{trace.push([label,receiver,args.length,...args]);if(options.fail===label)throw injected;};
  const attributes=track({antialias:'antialias' in options?options.antialias:true},'attributes');
  const aniso=track({MAX_TEXTURE_MAX_ANISOTROPY_EXT:'aniso'},'aniso'),debug=track({UNMASKED_RENDERER_WEBGL:'renderer',UNMASKED_VENDOR_WEBGL:'vendor'},'debug');
  const gl=track({...Object.fromEntries(parameters.map(k=>[k,k])),
    getContextAttributes(...args){call('attributesCall',this===gl,args);return 'attributes' in options?options.attributes:attributes;},
    getParameter(...args){call(`parameter:${args[0]}`,this===gl,args);return 'value' in options?options.value:args[0];},
    getExtension(...args){call(`extension:${args[0]}`,this===gl,args);return args[0]==='EXT_texture_filter_anisotropic'?('aniso' in options?options.aniso:aniso):('debug' in options?options.debug:debug);},
  },'gl');
  const canvas=track({getContext(...args){call('contextCall',this===canvas,args);return 'gl' in options?options.gl:gl;}},'canvas');
  const doc=track({createElement(...args){call('createCall',this===doc,args);return 'canvas' in options?options.canvas:canvas;}},'document');
  const context={get document(){trace.push('document');if(options.fail==='document')throw injected;return 'document' in options?options.document:doc;}};
  const fn=original?block(188748,{get 0(){return context.document;}})[1]:()=>collectDesktopWebGl(context);
  let result;try{const value=fn();result={value:{...value},valueIdentity:Object.entries(value).filter(([k])=>k!=='antialias').map(([k,v])=>[k,v===options.value])};}catch(e){result={error:e.name,injected:e===injected};}
  return{result,trace};
}
let webglComparisons=0;
for(const options of [{}, ...[null,undefined,false,0,'',NaN].flatMap(value=>['gl','attributes','antialias','aniso','debug'].map(key=>({[key]:value}))),
  ...[0,-0,'0',false,null,undefined,NaN,0n,{},Symbol('raw')].map(value=>({value})),
  ...[null,undefined,{}].flatMap(value=>['document','canvas'].map(key=>({[key]:value}))),
  ...['document','document.createElement','createCall','canvas.getContext','contextCall','gl.getContextAttributes','attributesCall','attributes.antialias','gl.getParameter',
    ...parameters.map(k=>`gl.${k}`),...parameters.map(k=>`parameter:${k}`),'gl.getExtension','extension:EXT_texture_filter_anisotropic','aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT','parameter:aniso','extension:WEBGL_debug_renderer_info','debug.UNMASKED_RENDERER_WEBGL','parameter:renderer','debug.UNMASKED_VENDOR_WEBGL','parameter:vendor'].map(fail=>({fail}))]){
  assert.deepEqual(webglRun(false,options),webglRun(true,options),`webgl ${String(options.fail)}`);webglComparisons++;
}
console.log(JSON.stringify({navigatorComparisons,pluginsComparisons,windowComparisons,webglComparisons,syntheticHosts:true,network:false}));
