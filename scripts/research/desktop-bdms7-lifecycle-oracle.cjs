const requireProductionDependency=require('./desktop-production-loader.cjs');
// Original final VM block vs production lifecycle; all hosts/collectors/transport are synthetic.
const assert=require('node:assert/strict'),vm=require('node:vm');
const {readFileSync}=require('node:fs'),{createHash}=require('node:crypto'),{join}=require('node:path'),ts=require('typescript');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const production={};
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-report-lifecycle.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{require:requireProductionDependency,exports:production},{timeout:3000});

function fixture(options) {
  const trace=[],timeouts=[],intervals=[],rafs=[],listeners=[];
  let now=1000,generation=0,failed=false;
  function hit(name,...args){trace.push([name,...args]);if(options.fail===name&&!failed){failed=true;throw Error(name);}}
  const context={performance:{now(){hit('performance');return now;}},Date:{now(){hit('date');return 10000+now;}},
    document:{addEventListener(name,fn){hit('listen',name);listeners.push(fn);}},
    setTimeout(fn,delay){'use strict';hit('timeout',delay,this===null);timeouts.push(fn);},
    setInterval(fn,delay){'use strict';hit('interval',delay,this===null);intervals.push(fn);},
    requestAnimationFrame(fn){'use strict';hit('raf',this===null);rafs.push(fn);},
  };
  const sources=Object.fromEntries(['move','click','clickEnd','keyboard','windowState','gyro','focus'].map(name=>[name,{data(){hit(name);return[{name,generation}];}}]));
  sources.screen=function(){'use strict';hit('screen',this===null);return{generation};};
  const sender={send(...args){hit('send',...JSON.parse(JSON.stringify(args)));}};
  const device=()=>hit('device'),collect=function(){'use strict';hit('collect',this===null);};
  const config={dump:options.dump??true,ddrt:3,track:{mode:Object.hasOwn(options,'mode')?options.mode:0,delay:300}};
  return{trace,context,sources,sender,device,collect,config,timeouts,intervals,rafs,listeners,advance:n=>{now=n;},generation:()=>{generation++;}};
}
function original(f) {
  class XHR{open(){}send(){}addEventListener(){}setRequestHeader(){}}
  const bridge={3:Array,13:{},14:'1.0.1.7',15:{getItem:()=>null},16:XHR,17:URL,19:f.context.Date,
    21:f.context.requestAnimationFrame,22:f.context.document,23:f.context.performance,
    26:f.context.setTimeout,27:f.context.setInterval,30:f.sources.clickEnd,31:f.sources.click,
    33:f.sources.windowState,34:f.sources.focus,35:f.sources.keyboard,36:f.collect,37:f.sources.move,
    38:f.sources.gyro,44:f.sources.screen,49(){}};
  const p=226619,start=source.lastIndexOf('function(e,r,t)',p),end=source.indexOf('"',p+1)+1;
  vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});
  bridge[50]=f.config;
  const root=bridge[51]._v[2];
  assert.equal(root[38]._v[0],9929);assert.equal(root[29]._v[0],7228);
  root[27]=f.device;root[25]=f.sender.send;
  return{start:root[38],reportBehavior:root[29]};
}
function run(isOriginal,options,actions) {
  const f=fixture(options),lifecycle=isOriginal?original(f):new production.DesktopReportLifecycle(f.context,f.config,f.sources,f.sender,f.device,f.collect);
  for(const action of actions) {
    try {
      if(typeof action==='number')f.advance(action);
      else if(action==='start')lifecycle.start();
      else if(action==='behavior')lifecycle.reportBehavior();
      else if(action==='visible')f.listeners[0]?.();
      else if(action==='frame')f.rafs.splice(0).forEach(fn=>fn(999));
      else if(action==='device')f.timeouts[0]?.();
      else if(action==='interval')f.intervals[0]?.();
      else if(action==='generation')f.generation();
      else if(action.track)Object.assign(f.config.track,action.track);
      else Object.assign(f.config,action);
    } catch(error){f.trace.push(['error',error.message]);}
  }
  return f.trace;
}
let comparisons=0;
function compare(options,actions) {assert.deepEqual(run(false,options,actions),run(true,options,actions),JSON.stringify({options,actions}));comparisons++;}
for(const mode of [0,1,2,3,'0',null])for(const dump of [true,false]) {
  compare({mode,dump},['start','start',{track:{mode:0,delay:7}},'start',{dump:true,ddrt:9},'start','device','interval','generation','frame','visible']);
}
for(const fail of ['listen','timeout','collect','interval'])compare({fail},['start','start','device','interval','frame']);
for(const fail of [undefined,'date','move','clickEnd','keyboard','screen','raf','send']) {
  compare({fail},['start','behavior','visible','frame',3999,'behavior',4000,'behavior','generation','frame','visible']);
  compare({fail},['start','visible','visible','behavior','frame',4000,'behavior','frame']);
}
compare({},['start',4000,'visible',4000,'behavior','generation','frame',500,'behavior',7000,'behavior','frame']);
compare({dump:false},['behavior','frame','start','visible',{track:{mode:1}},'start',4000,'behavior','frame']);
console.log(JSON.stringify({comparisons,network:false,syntheticCollectors:true}));
