// Differential replay of unchanged vendor source and the current production TypeScript core.
// Uses synthetic inputs only; original runtime replaces every network exit.
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const {sign}=require('./desktop-bdms7-signer.cjs');
const {buildDesktopFingerprint}=require('./desktop-bdms7-fingerprint.cjs');
const source=process.argv[2];
assert(source,'provide the pinned bdms-1.0.1.7.js resource path');
const profiles=[
  {name:'mac'}, {name:'windows'}, {name:'unicode'},
  {name:'epoch-zero',nowMs:0}, {name:'epoch-one',nowMs:1},
  {name:'window-edge'}, {name:'body-null'}, {name:'body-empty'},
];
let count=0;
for(const profile of profiles) for(const randomSequence of [[0],[0.5],[0.999999],[0.01,0.5,0.99]]) for(const mode of [0,2]) {
  const aid=mode===0?339757:12345678,pageId=mode===0?23420:987654;
  const nowMs=profile.nowMs??(profile.name==='mac'?1789214400000:1700000000123);
  const output=execFileSync(process.execPath,[path.join(__dirname,'desktop-bdms-runtime.cjs'),source,'--sign-vectors',
    '--rng-sequence='+randomSequence.join(','),'--profile='+profile.name,'--track-mode='+mode,'--aid='+aid,'--page-id='+pageId,'--time-ms='+nowMs],
    {encoding:'utf8',timeout:15000});
  const line=output.split('\n').find(l=>l.startsWith('signature-vectors '));
  assert(line,'original runtime must return actual final XHR signatures');
  const vectors=JSON.parse(line.slice('signature-vectors '.length));
  assert.equal(vectors.length,6);
  for(const vector of vectors) {
    let randomCursor=0;
    assert.equal(vector.randomCalls,3);
    const finalQuery=new URLSearchParams(vector.query);
    finalQuery.append('a_bogus',vector.signature);
    assert.equal(new URL(vector.url).search.slice(1),finalQuery.toString(),'original hook reserializes final query too');
    assert.equal(sign({...vector,query:new URLSearchParams(vector.query).toString(),aid,pageId,environmentMask:129,behaviorMask:mode===0?14:0,
      flag:3,fingerprint:buildDesktopFingerprint(vector.fingerprintContext),inkMs:nowMs-1,random:()=>randomSequence[(randomCursor++)%randomSequence.length]}),vector.signature,
      `${profile.name} mode=${mode} RNG=${randomSequence} ${vector.method} ${vector.query}`);
    assert.equal(randomCursor,3,'production random consumption');
    count++;
  }
}
console.log(`PASS ${count} exact Desktop BDMS 1.0.1.7 signature comparisons (original XHR output, synthetic profiles)`);
