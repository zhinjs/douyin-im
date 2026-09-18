const requireProductionDependency=require('./desktop-production-loader.cjs');
// Original behavior and screen VM blocks vs production collectors. No real input/network.
const assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
function block(position,bridge){const start=source.lastIndexOf('function(e,r,t)',position),end=source.indexOf('"',position+1)+1;vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});}
const modules={};
function load(name){if(modules[name])return modules[name];const exports=modules[name]={};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:(name)=>name==='./desktop-property-write.js'?requireProductionDependency(name):(name=>load(name.replace(/^\.\//,'').replace(/\.js$/,'')))(name)},{timeout:3000});return exports;}
const {DesktopBehaviorCollector}=load('desktop-behavior-collector'),screenModule=load('desktop-fingerprint');
let comparisons=0;
function runInput(original,scenario) {
  const trace=[],callbacks={},frames=[];let now=1000,perf=20,collector,bridge,reentered=false,currentEvent;
  const fail=scenario.fail;
  const get=(name,value)=>{trace.push(name);if(name===fail)throw Error(name);return value;};
  class Element{constructor(text='target',nodeName='SPAN'){
    Object.defineProperties(this,{innerText:{get:()=>get('innerText',text)},nodeName:{get:()=>get('nodeName',nodeName)}});
  }}
  const document={get visibilityState(){return get('visibilityState',scenario.visibility||'visible');},
    addEventListener(type,fn){get(`listen:${type}`,null);trace.push(['documentReceiver',this===document,arguments.length]);(callbacks[type]??=[]).push(fn);}};
  const window={get self(){return get('self',window);},get top(){return get('top',scenario.iframe?{}:window);},
    addEventListener(type,fn){get(`listen:${type}`,null);trace.push(['windowReceiver',this===window,arguments.length]);(callbacks[type]??=[]).push(fn);},
    requestAnimationFrame(fn){get('raf',null);trace.push(['rafReceiver',this===window]);frames.push(fn);}};
  const date={now(){get('date',null);trace.push(['dateReceiver',this===date]);
    if(scenario.reenter&&!reentered){reentered=true;callbacks[scenario.event]?.[0](currentEvent);}return now;}};
  const math={random(){get('random',null);trace.push(['randomReceiver',this===math]);return .5;},sqrt:Math.sqrt,pow:Math.pow};
  const context={document,window,Date:date,Math:math,performance:{now(){return get('performance',perf);}},HTMLElement:Element,
    encodeURI(text){'use strict';trace.push(['encodeReceiver',this===null]);get('encodeURI',null);return encodeURI(text);}};
  let error;
  try {
    if(original){bridge={0:Symbol,1:Object,2:TypeError,3:String,4:Number,5:Array,6:context.performance,7:window,8:date,9:Element,10:context.encodeURI,11:document,12:math};block(116126,bridge);bridge[20]();if(scenario.repeat)bridge[20]();}
    else{collector=new DesktopBehaviorCollector(context);collector.startCollection();if(scenario.repeat)collector.startCollection();}
    if(scenario.frames){for(let i=0;i<scenario.frames;i++){perf=20+(i+1)*20;frames.shift()?.(999999);}}
    const point={get clientX(){return get('clientX',1);},get clientY(){return get('clientY',2);}};
    let event=point;
    if(scenario.event?.startsWith('touch'))event={get touches(){return get('touches',scenario.emptyTouch?null:{item(index){get('item',index);return scenario.noTouch?null:point;}});},get changedTouches(){throw Error('changedTouches must not be read');}};
    if(scenario.event==='mouseover'||scenario.event==='mouseout')event={get target(){return get('target',scenario.notElement?{}:new Element(scenario.text,scenario.nodeName));}};
    if(scenario.event==='deviceorientation')event={get beta(){return get('beta',scenario.zero?0:1);},get gamma(){return get('gamma',2);},get alpha(){return get('alpha',3);}};
    currentEvent=event;
    for(let i=0;i<(scenario.events??1);i++){now=1000+i*10;callbacks[scenario.event]?.forEach(fn=>fn(event));}
  }catch(e){error=e.name==='TypeError'?'TypeError':e.message;}
  const queues=original?(bridge&&bridge[19]?[13,14,15,16,19,18,17].map(k=>bridge[k].data()):undefined):
    collector?Object.values(collector.createReportSources(()=>({}))).slice(0,7).map(view=>view.data()):undefined;
  return{trace,error,queues:queues&&JSON.parse(JSON.stringify(queues)),remainingFrames:frames.length};
}
const inputCases=[{}, {repeat:true}, {iframe:true},{fail:'listen:touchstart'}, {fail:'top'}, {fail:'raf'},
  {frames:60},{frames:59}, {event:'mousemove',events:2},{event:'mousemove',fail:'clientX'},{event:'mouseup',fail:'date'},
  ...['touchmove','touchstart','touchend'].flatMap(event=>[{event},{event,emptyTouch:true},{event,noTouch:true},{event,fail:'item'}]),
  ...['mouseover','mouseout'].flatMap(event=>[{event},{event,notElement:true},{event,nodeName:'BODY'},{event,nodeName:'HTML'},
    {event,text:''},{event,text:'\ud800'},{event,text:'12345678901234😀'},{event,fail:'target'},
    {event,fail:'nodeName'},{event,fail:'innerText'},{event,fail:'encodeURI'}]),
  {event:'keydown',events:2},{event:'visibilitychange',events:2},{event:'visibilitychange',visibility:'hidden'},
  {event:'visibilitychange',fail:'visibilityState'},
  {event:'deviceorientation',events:2},{event:'deviceorientation',zero:true},{event:'deviceorientation',zero:true,fail:'gamma'},
  ...['keydown','deviceorientation','visibilitychange'].map(event=>({event,reenter:true})),
];
for(const item of inputCases){assert.deepEqual(runInput(false,item),runInput(true,item),JSON.stringify(item));comparisons++;}

function runScreen(original,options) {
  const trace=[];let bodyReads=0,screenReads=0,offset=0;
  const get=(name,value)=>{trace.push(name);if(name===options.fail)throw Error(name);return value;};
  const screen=new Proxy({availWidth:1,availHeight:2,width:3,height:4,colorDepth:24,pixelDepth:24,
    orientation:options.noOrientation?null:new Proxy({type:options.emptyType?0:'portrait',angle:90.7},{get:(o,k)=>get(`orientation.${k}`,o[k])})},
    {get:(o,k)=>get(`screen.${k}`,o[k])});
  const body=new Proxy({clientWidth:10,clientHeight:20},{get:(o,k)=>get(`body.${k}`,o[k])});
  const window=new Proxy({innerWidth:12.7,innerHeight:-4.7,outerWidth:NaN,outerHeight:Infinity,screenX:2**32+1,screenY:0},{get(o,k){
    if(k==='screen'){screenReads++;return get('window.screen',options.noScreen?null:options.lateScreen&&screenReads>6?null:screen);}
    if(k==='pageYOffset')return get('window.pageYOffset',++offset);
    return get(`window.${k}`,o[k]);
  }});
  const document={get body(){bodyReads++;return get('document.body',options.noBody?null:options.changingBody&&bodyReads===2?null:body);}};
  let result,error;
  try{if(original){const bridge={0:Symbol,1:Object,2:String,3:TypeError,4:Number,5:window,6:document};block(181839,bridge);result=bridge[options.geometry?8:7]();}
    else result=options.geometry?screenModule.collectDesktopScreenGeometry({window,document}):screenModule.collectDesktopReportScreen({window,document});}
  catch(e){error=e.name==='TypeError'?'TypeError':e.message;}
  return{result:result&&JSON.parse(JSON.stringify(result)),error,trace};
}
const screenCases=[{}, {geometry:true}, {noBody:true}, {noOrientation:true}, {noScreen:true},{lateScreen:true},{changingBody:true},{emptyType:true},
  ...['window.innerWidth','window.pageYOffset','screen.availHeight','body.clientHeight','screen.orientation','orientation.angle'].map(fail=>({fail}))];
for(const item of screenCases){assert.deepEqual(runScreen(false,item),runScreen(true,item),JSON.stringify(item));comparisons++;}
console.log(JSON.stringify({comparisons,inputScenarios:inputCases.length,screenScenarios:screenCases.length,network:false}));
