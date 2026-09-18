// Load the current production TypeScript core for differential tests; no second signer copy.
// This loader is a dev-only tool and does not ship in the npm module.
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const assert = require('node:assert/strict');
const moduleExports={};
const productionSource=readFileSync(join(__dirname,'../../src/anti-bot/aBogus.ts'),'utf8');
const compiled=ts.transpileModule(productionSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(compiled,{exports:moduleExports,require:name=>{
  assert.equal(name,'crypto');return require('node:crypto');
}},{timeout:3000,filename:'production-aBogus.js'});
const sign=moduleExports.generateDesktopABogus;
assert.equal(typeof sign,'function');
const S4='Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const BASE64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function rc4(key,input) {
  const state=Array.from({length:256},(_,i)=>i);
  let j=0;
  for(let i=0;i<256;i++) {
    j=(j+state[i]+key[i%key.length])&255;
    [state[i],state[j]]=[state[j],state[i]];
  }
  j=0;
  return [...input].map((value,n)=>{
    const i=(n+1)&255; j=(j+state[i])&255;
    [state[i],state[j]]=[state[j],state[i]];
    return value^state[(state[i]+state[j])&255];
  });
}
// Diagnostic decoder: extracted state is observation, not independent proof of state computation.
function inspectSignature(signature) {
  assert(/^[A-Za-z0-9+/_-]+=*$/.test(signature));
  const raw=Buffer.from([...signature].map(c=>c==='='?'=':BASE64[S4.indexOf(c)]).join(''),'base64');
  assert(raw.length>=57);
  const header=rc4([121],raw.subarray(12));
  assert.equal(header[0],44);
  const fingerprintLength=header[40]+header[41]*256;
  assert.equal(header.length,44+fingerprintLength+1);
  assert.equal(header.slice(0,44).reduce((a,b)=>a^b,0),header.at(-1));
  const numberAt=indices=>indices.reduce((value,index,byte)=>value+header[index]*256**byte,0);
  return {environmentMask:numberAt([15,4,28,23]),behaviorMask:numberAt([29,25,16,5]),flag:header[35],
    nowMs:numberAt([26,21,11,1,38,39]),inkMs:numberAt([34,33,31,30,36,37]),fingerprintLength};
}
module.exports={sign,inspectSignature};
