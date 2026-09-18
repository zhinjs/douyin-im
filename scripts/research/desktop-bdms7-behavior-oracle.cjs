const requireProductionDependency=require('./desktop-production-loader.cjs');
// Seven-queue values and q against the unmodified original behavior VM. No real input or network.
const assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const source=readFileSync(process.argv[2]||'/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-behavior.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{require:requireProductionDependency,exports:exportsObject},{timeout:3000});
const State=exportsObject.DesktopBehaviorState;
function fixture(original) {
  let ts=0,randomValue=.5,draws=0;
  const random=()=>{draws++;return randomValue;};
  let state,bridge,callbacks,frames;
  if(original) {
    callbacks={};frames=[];
    class Element{constructor(text){this.innerText=text;this.nodeName='SPAN';}}
    const window={requestAnimationFrame(fn){frames.push(fn);},addEventListener(type,fn){callbacks[type]=fn;}};
    window.self=window.top=window;
    const document={visibilityState:'visible',addEventListener(type,fn){callbacks[type]=fn;}};
    bridge={0:Symbol,1:Object,2:TypeError,3:String,4:Number,5:Array,6:{now:()=>ts},7:window,8:{now:()=>ts},9:Element,10:encodeURI,11:document,12:{random,sqrt:Math.sqrt,pow:Math.pow}};
    const p=116126,start=source.lastIndexOf('function(e,r,t)',p),end=source.indexOf('"',p+1)+1;
    vm.runInNewContext(`"use strict";(${source.slice(start,end)},bridge,void 0))`,{require:requireProductionDependency,bridge},{timeout:3000});
    bridge[20]();
  } else state=new State(0);
  return {
    action([kind,time,a,b,c,r]) {
      ts=time;if(r!==undefined)randomValue=r;
      const point={ts,x:a,y:b};
      if(original) {
        if(kind==='frame'){frames.shift()?.();return;}
        const types={move:'mousemove',down:'mousedown',up:'mouseup',key:'keydown',over:'mouseover',out:'mouseout',orientation:'deviceorientation',visibility:'visibilitychange'};
        let event={clientX:a,clientY:b};
        if(kind==='over'||kind==='out')event={target:new bridge[9](a)};
        if(kind==='orientation')event={beta:a,gamma:b,alpha:c};
        if(kind==='visibility')bridge[11].visibilityState=a;
        callbacks[types[kind]](event);
      } else {
        if(kind==='move')state.recordMove(point);
        else if(kind==='down')state.recordClickStart(point);
        else if(kind==='up')state.recordClickEnd(point);
        else if(kind==='key')state.recordKeydown(ts);
        else if(kind==='over'||kind==='out')state.recordHover({target:encodeURI(a.slice(0,15)),ts,mode:kind==='over'?1:0});
        else if(kind==='orientation')state.recordOrientation({...point,z:c},random);
        else if(kind==='visibility')state.recordVisibility(a,ts);
        else if(kind==='frame')state.recordFrame(ts);
      }
    },
    snapshot(){
      const value=original?{
        moves:bridge[13].data(),clickStarts:bridge[14].data(),clickEnds:bridge[15].data(),keydowns:bridge[16].data(),
        focus:bridge[17].data(),orientations:bridge[18].data(),windowStates:bridge[19].data(),
      }:state.getSnapshot();
      return{queues:JSON.parse(JSON.stringify(value)),mask:original?bridge[21]():state.mask(),draws};
    },
    report(){return original?[13,14,15,16,19,18,17].map(k=>bridge[k].data()):Object.values(state.createReportSources(()=>({}))).slice(0,7).map(view=>view.data());},
  };
}
let comparisons=0;
function sequence(actions) {
  const original=fixture(true),production=fixture(false);
  for(const action of [null,...actions]) {
    if(action){original.action(action);production.action(action);}
    assert.deepEqual(production.snapshot(),original.snapshot(),JSON.stringify(action));comparisons++;
    assert.deepEqual(JSON.parse(JSON.stringify(production.report())),JSON.parse(JSON.stringify(original.report())),`report ${JSON.stringify(action)}`);comparisons++;
  }
}
sequence([
  ['up',0,0,0],['up',16,1,1],['up',17,2,2],['up',1000,2,2],['down',1,0,0],['move',10,1,1],['key',1],
  ['out',0,'no-start'],['over',100,'old'],['over',200,'new'],['out',549,'different'],['out',550,'different'],
  ['visibility',0,'visible'],['visibility',1,'visible'],['visibility',2,'hidden'],['visibility',3,'prerender'],
  ['orientation',1,0,1,1],['orientation',2,1,1,1,.5],['orientation',105001,1,2,3,.5],['orientation',105002,1,2,3,.5],
  ['orientation',200000,1,2,3,0],['orientation',200001,1,2,3,.99],['orientation',0,1,2,3,0],
]);
sequence(Array.from({length:501},(_,i)=>[
  ['move',i*20,i,i],['down',i*20,i,i],['up',i*20,i,i],['key',i],
  ['visibility',i,i%2?'hidden':'visible'],['over',i,'hover'+i],['orientation',i*150000,1,2,3,.5],
]).flat());
sequence([...Array.from({length:61},(_,i)=>['frame',(i+1)*8]),['move',100,0,0],['move',108,1,1],['move',109,2,2],['up',100,0,0],['up',109,1,1]]);
console.log(JSON.stringify({comparisons,includesReportSnapshots:true,syntheticInput:true,network:false}));
