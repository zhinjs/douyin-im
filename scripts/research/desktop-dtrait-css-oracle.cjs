const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs');
const d=decode(process.argv[2]);
function probe(mode,sdk){
 const trace=[],hashInputs=[],nodes=[];
 const proto={};Object.defineProperties(proto,{constructor:{value:function CSSStyleDeclaration(){}},inherited:{value:1},[Symbol.toStringTag]:{value:'SyntheticCSSStyleDeclaration'}});
 const style=Object.create(proto);Object.assign(style,{'0':'background-color','1':'--custom','2':'-webkit-transform','3':'borderTop','--own':'value',backgroundColor:'rgb(1,2,3)',WebkitTransform:'none',borderTop:'0',borderLeft:'0',fontSize:'12px',fontFamily:'synthetic'});
 if(mode==='aliases'){Object.assign(style,{'4':'a-b','5':'c-d','6':'OneTwo','7':'NextThing','8':'constructor'});for(const key of ['aB','CD','one-two','next-thing'])Object.defineProperty(style,key,{value:'hidden'});}
 const document={body:{append(node){trace.push(['append']);if(mode==='append-throw')throw Error('append');nodes.push(node);node.parentNode=this;},removeChild(node){trace.push(['remove']);if(mode==='remove-throw')throw Error('remove');node.parentNode=null;}},createElement(tag){trace.push(['create',tag]);return {setAttribute(k,v){trace.push(['attr',k,v]);this.style=v;}};}};
 const getComputedStyle=node=>{trace.push(['computed',node===document.body?'body':node.style]);if(node===document.body){if(mode==='body-throw')throw Error('body');return mode==='prototype-mismatch'?{}:style;}if(mode==='color-throw')throw Error('color');return new Proxy({backgroundColor:`computed:${node.style}`,fontSize:'12px',fontFamily:'Fake Font'},{get(t,k){trace.push(['get',k]);if(mode==='font-getter-throw'&&k==='fontSize')throw Error('font');return t[k];}});};
 const hash=input=>{hashInputs.push(input);if(mode==='hash-throw')throw Error('hash');return 'H'+hashInputs.length;};
 const a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);
 const context=vm.createContext({document,getComputedStyle,tt:d.strings,et:d.functions.map((f,id)=>[id>=209&&id<=224?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});
 vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',context);
 const scope=[hash,(...args)=>trace.push(['diagnostic',...args])];context.make(209,scope)();
 const result=(sdk?sdk.createDesktopDTraitCssCollector({document,getComputedStyle,hash,onDiagnostic:(...args)=>trace.push(['diagnostic',...args])}):scope[2])();
 return {result:Object.fromEntries(Object.keys(result).map(k=>[k,result[k]??'<undefined>'])),hashInputs,trace,attached:nodes.filter(n=>n.parentNode).length};
}
async function main(){
const sdk=await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-css.js')).href);
for(const mode of ['normal','aliases','body-throw','prototype-mismatch','append-throw','color-throw','font-getter-throw','remove-throw','hash-throw']){
 const r=probe(mode);assert.deepStrictEqual(probe(mode,sdk),r,mode);
 if(mode==='normal'){assert.deepEqual(r.result,{str_1:'H2',str_4:'H1',str_5:'H3',str_6:'H4'});assert.equal(r.trace.filter(x=>x[0]==='attr').length,44);assert.equal(r.attached,0);}
 if(['color-throw','font-getter-throw','remove-throw'].includes(mode))assert.equal(r.attached,1);
 if(mode==='body-throw')assert.equal(r.result.str_1,'<undefined>');
 if(mode==='aliases')assert.ok(r.hashInputs[0].endsWith(',aB,CD,one-two,next-thing'));
}

console.log('PASS 9 CSS original VM/SDK synthetic DOM/style traces');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

