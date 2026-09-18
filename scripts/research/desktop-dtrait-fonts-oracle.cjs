// Entire Fonts public path from the pinned VM, synthetic DOM/FontFace only. No installed-font access.
const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs'),{rawFeature}=require('./desktop-dtrait-features-oracle.cjs');
const d=decode(process.argv[2]);
function raw(bindings,hash,diagnostic){
 const ctx=vm.createContext({...bindings,tt:d.strings,et:d.functions.map((f,n)=>[n>=309&&n<=365?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map(),scope:[diagnostic,hash]});
 const a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);
 vm.runInContext(d.source.slice(a,b)+';it(309,scope)();',ctx,{timeout:3000});
 return ()=>vm.runInContext('scope[4]()',ctx,{timeout:3000});
}
async function scenario(sdk,mode){
 const trace=[];let next=0,steps=0,randomCount=0;
 const record=(...args)=>{if(++steps>3000)throw Error('oracle operation limit');trace.push(args);};
 const make=tag=>{
  const node={tag,key:++next,children:[],parentNode:null,id:'',className:'',textContent:null,
   setAttribute(name,value){record(this.key,'attr',name,value);this[name]=value;},
   appendChild(child){record(this.key,'append',child.key);if(mode==='append-throw'&&tag==='body')throw Error('append');insert(this,child);return child;},
   removeChild(child){record(this.key,'remove',child.key);if(mode==='remove-throw')throw Error('remove');const i=this.children.indexOf(child);if(i<0)throw Error('missing child');this.children.splice(i,1);child.parentNode=null;return child;},
   replaceChild(child,old){record(this.key,'replace',child.key,old.key);const i=this.children.indexOf(old);if(i<0)throw Error('missing old');this.children.splice(i,1);old.parentNode=null;if(child.tag==='fragment'){const nodes=[...child.children];child.children=[];this.children.splice(i,0,...nodes);nodes.forEach(n=>n.parentNode=this);}else{this.children.splice(i,0,child);child.parentNode=this;}return old;},
  };
  Object.defineProperty(node,'firstChild',{get(){record(node.key,'first');return node.children[0]??null;}});
  for(const name of ['id','className','textContent']){let value=node[name];Object.defineProperty(node,name,{get(){return value;},set(v){record(node.key,'set',name,v);value=v;}});}
  return node;
 };
 function insert(parent,child){if(child.tag==='fragment'){for(const n of child.children){parent.children.push(n);n.parentNode=parent;}child.children=[];}else{parent.children.push(child);child.parentNode=parent;}}
 const body=make('body');
 const walk=node=>node.children.flatMap(child=>[child,...walk(child)]);
 const selected=['Cambria Math','Lucida Console','Nirmala UI','Leelawadee UI','Ink Free','Segoe Fluent Icons'];
 const document={body,createElement(tag){record('create',tag);return make(tag);},createDocumentFragment(){record('fragment');return make('fragment');},
  getElementById(id){record('id',id);return mode==='missing-root'?null:walk(body).find(n=>n.id===id)??null;},
  querySelectorAll(selector){record('query',selector);return mode==='empty-nodes'?[]:walk(body).filter(n=>n.className==='pixel-emoji');},
  fonts:{check(font){record('check',font);if(mode==='check-throw')throw Error('check');if(mode.startsWith('load')||mode==='construct-throw')return true;return selected.some(name=>font==='0px "'+name+'"');}},
 };
 let measure=0;
 const getComputedStyle=node=>{record('measure',node.key);if(mode==='measure-throw')throw Error('measure');const index=measure++;return {get inlineSize(){record('inline',index);return mode==='nan-size'?'auto':(100+index%3)+'px';},get blockSize(){record('block',index);return (200+index%2)+'px';}};};
 class FontFace{constructor(family,source){record('font',family,source);if(mode==='construct-throw')throw Error('font');this.family=family;}
  load(){record('load',this.family);if(mode==='load-throw')throw Error('load');if(mode==='load-undefined')return Promise.resolve(undefined);if(mode==='load-reject'||!selected.includes(this.family))return Promise.reject(Error('font unavailable'));return Promise.resolve(this);}
 }
 const math=Object.assign(Object.create(Math),{random(){record('random');return randomCount++%2===0?0.25:0.125;}});
 const navigator={get platform(){record('platform');if(mode==='platform-throw')throw Error('platform');return 'Synthetic';}};
 const window={gc(){record('gc');if(mode==='gc-throw')throw Error('gc');}};
 const io={encoder:new TextEncoder(),onDiagnostic:()=>{},getCryptoUtil:()=>undefined};
 const inner=sdk?sdk.createDesktopDTraitHash(io):rawFeature(process.argv[2],io).hash;
 const hash=value=>{record('hash',value);if(mode==='hash-throw'&&value!=='')throw Error('hash');return mode==='hash-zero'?0:inner(value);};
 const diagnostic=code=>{record('diagnostic',code);};
 const bindings={document,getComputedStyle,FontFace,Math:math,navigator,window,parseFloat(value){record('parse',value);return parseFloat(value);},console:{error(){diagnostic('font-detection');}}};
 let result;try{result=await(sdk?sdk.createDesktopDTraitFontsCollector({...bindings,hash,onDiagnostic:diagnostic}):raw(bindings,hash,diagnostic))();}catch(error){result={error:error.message};}
 const plain=value=>Array.isArray(value)?Array.from(value,plain):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,plain(v)])):value;
 return {result:plain(result),trace:plain(trace),remaining:walk(body).map(n=>[n.tag,n.id,n.children.length])};
}
async function main(){const sdk={...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-fonts.js')).href),...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-features.js')).href)};
 const modes=['normal','load','load-reject','load-undefined','construct-throw','load-throw','check-throw','append-throw','measure-throw','platform-throw','hash-throw','hash-zero','remove-throw','gc-throw','missing-root','empty-nodes','nan-size'];
 for(const mode of modes){const local=await scenario(sdk,mode),original=await scenario(null,mode);assert.deepStrictEqual(local.result,original.result,mode+' result');assert.deepStrictEqual(local.remaining,original.remaining,mode+' remaining DOM');assert.equal(local.trace.length,original.trace.length,mode+' trace length');for(let i=0;i<local.trace.length;i++)assert.deepStrictEqual(local.trace[i],original.trace[i],mode+' trace '+i);}
 console.log(`PASS ${modes.length} Fonts original VM/SDK traces (synthetic DOM/fonts only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
