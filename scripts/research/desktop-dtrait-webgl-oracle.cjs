// Whitelisted original WebGL VM only; synthetic pixel and driver objects, no GPU access.
const vm=require('node:vm'),assert=require('node:assert/strict');
const {resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {decode}=require('./desktop-dtrait-core-decode.cjs'),{rawFeature}=require('./desktop-dtrait-features-oracle.cjs');
function raw(bindings,hash,diagnostic){
 const d=decode(process.argv[2]),a=d.source.indexOf('function it(t,e)'),b=d.source.indexOf('function ut(t)',a);
 let allocations=0;
 const bounded=Type=>new Proxy(Type,{construct(target,args){if(++allocations>10 || (typeof args[0]==='number'&&args[0]>400000))throw Error('oracle allocation limit '+args[0]);return Reflect.construct(target,args);}});
 const ctx=vm.createContext({...bindings,Float32Array:bounded(Float32Array),Uint8Array:bounded(Uint8Array),tt:d.strings,et:d.functions.map((f,n)=>[n>=293&&n<=308?f.code:[73,0,4],f.argc,f.strict,f.trys]),nt:new Map(),rt:new Map()});
 vm.runInContext(d.source.slice(a,b)+';globalThis.make=it;',ctx);
 const scope=[hash,diagnostic];ctx.make(293,scope)();ctx.collect=scope[7];return ()=>vm.runInContext('collect()',ctx,{timeout:3000});
}
function scenario(sdk,mode){
 const trace=[];let contextCount=0;
 const document={createElement(tag){trace.push(['create',tag]);const id=++contextCount;
  const constants=Object.fromEntries(['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','ARRAY_BUFFER','FLOAT','STATIC_DRAW','COLOR_BUFFER_BIT','TRIANGLES','TRIANGLE_FAN','TRIANGLE_STRIP','RGBA','UNSIGNED_BYTE'].map((name,i)=>[name,i+1]));
  const methods={
   createShader(type){return mode==='null-shader'||(mode==='null-vertex'&&type===1)?null:'shader'+type;},
   getShaderParameter(shader){return mode!=='shader-fail'&&!(mode==='vertex-fail'&&shader==='shader1');},
   getShaderInfoLog(){return 'synthetic shader error';},createProgram(){return mode==='null-program'?null:'program';},
   getProgramParameter(){return mode!=='link-fail';},getProgramInfoLog(){return 'synthetic program error';},
   getAttribLocation(program,name){return name==='a_position'?10:11;},getUniformLocation(){return 'uniform';},createBuffer(){return 'buffer';},
   readPixels(x,y,width,height,format,type,pixels){for(let n=0;n<pixels.length;n++)pixels[n]=(n*7+id)%256;},
   getExtension(){return mode==='no-extension'?null:{UNMASKED_RENDERER_WEBGL:1001,UNMASKED_VENDOR_WEBGL:1002};},
   getParameter(key){return mode==='zero-parameter'?0:(key===1001?'renderer':'vendor')+id;},
  };
  const gl={...constants};for(const name of ['shaderSource','compileShader','deleteShader','attachShader','linkProgram','deleteProgram','useProgram','bindBuffer','vertexAttribPointer','enableVertexAttribArray','uniformMatrix3fv','clearColor','clear','bufferData','drawArrays',...Object.keys(methods)])gl[name]=function(...args){trace.push([id,name,...args.map(value=>ArrayBuffer.isView(value)?value.BYTES_PER_ELEMENT===1?{pixelLength:value.length}:Array.from(value):value)]);if(mode==='throw:'+name)throw Error(name);return methods[name]?.(...args);};
  if(mode==='no-getExtension')delete gl.getExtension;
  Object.defineProperty(gl,'__canvas',{set(value){trace.push([id,'canvas',value===canvas]);}});
  const canvas=new Proxy({getContext(name,...args){trace.push([id,'context',name,...args]);return mode==='no-context'||(mode==='fallback'&&name==='webgl2')?null:gl;}},{set(t,k,v){trace.push([id,'set',k,v]);t[k]=v;return true;}});return canvas;
 }};
 // The original interpreter itself needs Math.min; overriding the realm must retain unrelated intrinsics.
 const math=Object.assign(Object.create(Math),Object.fromEntries(['sin','cos','abs'].map(name=>[name,function(value){trace.push(['math',name,value]);return Math[name](value);}])));
 const io={encoder:new TextEncoder(),onDiagnostic:()=>{},getCryptoUtil:()=>undefined};
 const actual=sdk?sdk.createDesktopDTraitHash(io):rawFeature(process.argv[2],io).hash;
 const hash=value=>{trace.push(['hash',value]);if(mode==='hash-throw')throw Error('hash');return mode==='hash-zero'?0:actual(value);};
 const diagnostic=(code,reason)=>{trace.push(['diagnostic',code,reason]);if(mode==='diagnostic-throw')throw Error('diagnostic');};
 const bindings={document:mode==='no-document'?undefined:document,Math:math,console:{error(){diagnostic('webgl','shader');}}};
 const rawDiagnostic=(code,message)=>diagnostic(code,message==='document is undefined'?'document':message==='Failed to create WebGL context'?'context':'program');
 let result;try{result=(sdk?sdk.createDesktopDTraitWebGLCollector({...bindings,hash,onDiagnostic:diagnostic}):raw(bindings,hash,rawDiagnostic))();}catch(error){result={error:error.name};}
 const plain=value=>Array.isArray(value)?Array.from(value,plain):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,plain(item)])):value;
 return {result:JSON.parse(JSON.stringify(result)),trace:plain(trace)};
}
async function main(){const sdk={...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-webgl.js')).href),...await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-features.js')).href)};
 const modes=['normal','fallback','no-context','no-document','null-shader','null-vertex','shader-fail','vertex-fail','null-program','link-fail','no-extension','no-getExtension','zero-parameter','hash-throw','hash-zero','throw:readPixels','throw:getExtension','throw:shaderSource','throw:drawArrays'];
 for(const mode of modes){const local=scenario(sdk,mode),original=scenario(null,mode);assert.deepStrictEqual(local.result,original.result,mode+' result');assert.equal(local.trace.length,original.trace.length,mode+' trace length');for(let i=0;i<local.trace.length;i++)assert.deepStrictEqual(local.trace[i],original.trace[i],mode+' trace '+i);}
 console.log(`PASS ${modes.length} WebGL original VM/SDK traces (synthetic GPU only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
