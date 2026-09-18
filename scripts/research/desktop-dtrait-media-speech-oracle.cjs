// Only pinned media/speech VM functions with synthetic APIs and manually advanced timers.
const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs');
const {rawFeature}=require('./desktop-dtrait-features-oracle.cjs');
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function original(which,globals,hash,diagnostic){
  const d=decode(process.argv[2]),a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a),lo=which==='media'?232:253,hi=which==='media'?252:285;
  const context=vm.createContext({...globals,tt:d.strings,et:d.functions.map((f,id)=>[id>=lo&&id<=hi?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});
  vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',context);
  const scope=which==='media'?[diagnostic,hash]:[hash,diagnostic];context.make(lo,scope)();return scope[2];
}
const compact=value=>JSON.parse(JSON.stringify(value));
function trackedHash(kind,sdk,trace,mode){
  const io={encoder:new TextEncoder(),onDiagnostic(){},getCryptoUtil:()=>undefined};
  const hash=kind==='raw'?rawFeature(process.argv[2],io).hash:sdk.createDesktopDTraitHash(io);let count=0;
  return value=>{trace.push(['hash',value]);count++;if(['hash-always','event-hash','timeout-hash'].includes(mode)||mode==='hash-first'&&count===1)throw Error('hash');return hash(value);};
}
async function media(kind,sdk,mode){
  const trace=[],hash=trackedHash(kind,sdk,trace,mode);
  const check=(name,type)=>{trace.push([name,type]);if(mode===name+'-throw')throw Error(name);return mode==='all'||mode===name||mode==='selected'&&type==='video/x-matroska';};
  const globals={window: mode==='recorder'||mode==='all'||mode==='recorder-throw'?{MediaRecorder:undefined}:mode==='inherited-recorder'?Object.create({MediaRecorder:null}):{},
    document:{createElement(tag){trace.push(['create',tag]);return {canPlayType:type=>check('video',type)};}},
    Audio:class{constructor(){trace.push(['Audio']);if(mode==='audio-constructor')throw Error('constructor');}canPlayType(type){return check('audio',type);}},
    MediaSource:{isTypeSupported:type=>check('source',type)},MediaRecorder:{isTypeSupported:type=>check('recorder',type)}};
  if(mode==='missing-source')delete globals.MediaSource;
  const diag=(code)=>{trace.push(['diagnostic',code]);if(mode==='diag-throw')throw Error('diag');};
  const collect=kind==='raw'?original('media',globals,hash,diag):sdk.createDesktopDTraitMediaCollector({...globals,hash,onDiagnostic:diag});
  let result;try{result=await collect();if(mode==='repeat')result=[result,await collect()];}catch(error){result={error:error.name};}
  return compact({result,trace});
}
async function speech(kind,sdk,mode){
  const trace=[],timers=new Map();let next=0,handler,settled=false,result;
  let voices=[{voiceURI:'u1',name:'L1',lang:'en_US_X',localService:true,default:true},{voiceURI:'u1',name:'DUP',lang:'jp',localService:true},{voiceURI:'u2',name:'R',lang:'fr_FR',localService:false},{voiceURI:'u3',name:'L2',lang:'en_US_X',localService:true}];
  if(['empty','late','event-hash','timeout-hash'].includes(mode))voices=[];
  if(mode==='remote')voices=voices.filter(v=>!v.localService);
  if(mode==='defaults')voices[3].default=true;
  if(mode==='undefined-uri')voices=voices.map(({voiceURI,...v})=>v);
  if(mode==='missing-name')delete voices[0].name;
  if(mode==='missing-lang')delete voices[0].lang;
  const synthesis={getVoices(){trace.push(['voices']);if(mode==='voices-throw')throw Error('voices');return voices;},addEventListener(type,callback){trace.push(['listen',type]);if(mode==='listen-throw')throw Error('listen');handler=callback;},removeEventListener(){trace.push(['remove']);}};
  if(mode==='legacy'){delete synthesis.addEventListener;Object.defineProperty(synthesis,'onvoiceschanged',{set(fn){trace.push(['legacy']);handler=fn;}});}
  const globals={window:mode==='unsupported'?{}:{speechSynthesis:undefined},speechSynthesis:synthesis,
    setTimeout(callback,delay){const id=++next;trace.push(['set',id,delay]);timers.set(id,{callback,delay});return id;},clearTimeout(id){trace.push(['clear',id]);timers.delete(id);}};
  const hash=trackedHash(kind,sdk,trace,mode),diag=(code,reason)=>trace.push(['diagnostic',code,typeof reason==='string'?reason:'error']);
  const collect=kind==='raw'?original('speech',globals,hash,diag):sdk.createDesktopDTraitSpeechCollector({...globals,hash,onDiagnostic:diag});
  const task=collect().then(value=>{settled=true;result=value;},error=>{settled=true;result={error:error.name};});
  await flush();assert.equal(settled,false);assert.equal([...timers.values()][0].delay,50);
  const fire=id=>{const timer=timers.get(id);timers.delete(id);try{timer.callback();}catch(error){trace.push(['callback-error',error.name]);}};
  fire(1);await flush();
  if(mode==='timeout-hash'){fire(2);await flush();}
  if(mode==='event-hash'){voices=[{voiceURI:'later',name:'Late',lang:'en',localService:true}];try{handler();}catch(error){trace.push(['callback-error',error.name]);}await flush();}
  if(mode==='empty'||mode==='remote'||mode==='late'){assert.equal(settled,false);fire(2);await flush();}
  if(mode==='late'){voices=[{voiceURI:'later',name:'Late',lang:'en',localService:true}];handler();await flush();}
  if(mode==='repeat'){handler();await flush();}
  if(!settled)trace.push(['pending']);else await task;
  return compact({result,settled,trace,timers:[...timers.keys()],hasListener:typeof handler==='function'});
}
async function main(){
  const sdk={...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-media.js')).href),...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-speech.js')).href),...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-features.js')).href)};
  const mediaModes=['none','audio','video','source','recorder','all','inherited-recorder','selected','audio-throw','video-throw','source-throw','recorder-throw','missing-source','audio-constructor','hash-first','hash-always','repeat'];
  const speechModes=['normal','unsupported','empty','remote','late','repeat','legacy','defaults','undefined-uri','missing-name','missing-lang','voices-throw','listen-throw','hash-first','hash-always','event-hash','timeout-hash'];
  for(const mode of mediaModes)assert.deepStrictEqual(await media('sdk',sdk,mode),await media('raw',sdk,mode),'media '+mode);
  for(const mode of speechModes)assert.deepStrictEqual(await speech('sdk',sdk,mode),await speech('raw',sdk,mode),'speech '+mode);
  console.log(`PASS ${mediaModes.length} media and ${speechModes.length} speech original VM/SDK traces (synthetic APIs/timers; diagnostics redacted)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
