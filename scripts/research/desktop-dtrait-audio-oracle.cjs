const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs');
const d=decode(process.argv[2]);
async function scenario(mode,sdk){
 const trace=[];let audio,cb,settled='pending',result,callbackError,returnTouched=0;
 const fail=where=>{trace.push([where]);if(mode===where)throw Error(where);};
 const param=name=>Object.defineProperty({},'value',{set(v){trace.push([name,v]);if(mode===name)throw Error(name);}});
 class OfflineAudioContext{
  constructor(...args){trace.push(['new',...args]);if(mode==='constructor')throw Error('constructor');audio=this;this.destination={kind:'destination'};}
  get state(){throw Error('state must not be read');}
  createAnalyser(){fail('createAnalyser');return {frequencyBinCount:mode==='first100'?102:4,fftSize:3,kind:'analyser',getFloatFrequencyData(a){fail('frequency');if(mode==='first100'){a.fill(-1);a[100]=-20;a[101]=30;return;}a.set(mode==='nan'? [NaN,0,0,0]:mode==='zero'?[0,0,0,0]:[-1.25,2.5,-3.75,4]);},getFloatTimeDomainData(a){fail('time');a.set(mode==='zero'?[0,0,0]:[-0.5,0.25,-0.125]);}};}
  createOscillator(){fail('createOscillator');return {set type(v){trace.push(['type',v]);},frequency:param('frequency-value'),connect(n){trace.push(['oscillator-connect',n.kind]);},start(v){trace.push(['start',v]);}};}
  createDynamicsCompressor(){fail('createDynamicsCompressor');return {kind:'compressor',threshold:param('threshold'),knee:param('knee'),attack:param('attack'),connect(n){trace.push(['compressor-connect',n.kind]);}};}
  startRendering(){fail('startRendering');if(mode==='complete-before-handler'){trace.push(['has-handler',typeof cb]);if(cb)cb({});}return Object.defineProperty({},'then',{get(){returnTouched++;throw Error('then');}});}
  set oncomplete(fn){fail('oncomplete-set');cb=fn;}
 }
 const globals={Date:{now(){fail('now');return 123;}},OfflineAudioContext:mode==='missing'?undefined:OfflineAudioContext,tt:d.strings,et:d.functions.map((f,id)=>[id>=155&&id<=178?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map(),setTimeout(){throw Error('unexpected timer');}};
 const context=vm.createContext(globals),a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);
 vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',context);
 const scope=[v=>{trace.push(['hash',v]);if(mode==='hash'||mode==='fallback-hash')throw Error('hash');return 'H('+v+')';},(...args)=>{trace.push(['diagnostic',args[0]]);if(mode==='diagnostic')throw Error('diagnostic');}];
 if(mode==='diagnostic'||mode==='fallback-hash')globals.OfflineAudioContext=undefined;
 context.make(155,scope)();(sdk?sdk.createDesktopDTraitAudioCollector({...globals,Math,hash:scope[0],onDiagnostic:scope[1]}):scope[2])().then(v=>{settled='resolved';result=v;},e=>{settled='rejected';result=e.message;});
 if(cb&&!['no-complete','complete-before-handler'].includes(mode)){
  const event={renderedBuffer:{getChannelData(i){trace.push(['channel',i]);if(mode==='channel')throw Error('channel');return mode==='zero'?[]:[1,1,2,NaN,NaN,-0,0];}}};
  try{cb(event);if(mode==='repeat')cb(event);}catch(e){callbackError=e.message;}
 }
 for(let i=0;i<8;i++)await Promise.resolve();
 return {mode,settled,result:result&&JSON.parse(JSON.stringify(result)),callbackError,returnTouched,trace};
}
async function main(){
 const sdk=await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-audio.js')).href);
 const modes=['normal','zero','nan','missing','constructor','frequency-value','startRendering','oncomplete-set','frequency','time','channel','hash','no-complete','complete-before-handler','repeat','now','diagnostic','fallback-hash','first100'];
 for(const mode of modes){const x=await scenario(mode);assert.deepStrictEqual(await scenario(mode,sdk),x,mode);assert.equal(x.returnTouched,0);if(['frequency','time','channel','hash','no-complete','complete-before-handler'].includes(mode))assert.equal(x.settled,'pending');}
console.log('PASS '+modes.length+' Audio original VM/SDK traces (synthetic offline audio only)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

