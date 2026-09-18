const requireProductionDependency=require('./desktop-production-loader.cjs');
// Offline original-bytecode differential fixture; no network or account state.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createHash} = require('node:crypto');
const {join} = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = readFileSync(process.argv[2] || '/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js', 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'd99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
const position = 226619, start = source.lastIndexOf('function(e,r,t)', position), end = source.indexOf('"', position + 1) + 1;
const production = {};
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, '../../src/anti-bot/desktop-token.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {require:requireProductionDependency,exports: production}, {timeout: 3000});

function fixture(options = {}) {
  const trace = [], callbacks = [], requests = [];
  const context = {
    localStorage: {
      getItem(key) { trace.push(`get:${key}`); if (options.readError) throw Error('read'); return options.initial ?? null; },
      setItem(key, value) { trace.push(`set:${key}:${value}`); if (options.writeError) throw Error('write'); },
    },
    requestAnimationFrame(callback) { 'use strict'; trace.push(`raf:nullReceiver=${this === null}`); if (options.rafError) throw Error('raf'); callbacks.push(callback); },
  };
  class XHR {
    constructor() { requests.push(this); this.listeners = {}; }
    open(...args) { this.openArgs = args; }
    send(body) { this.body = body; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    setRequestHeader() {}
    getResponseHeader(name) { trace.push(`header:${name}`); if (this.headerError) throw Error('header'); return this.token; }
  }
  return {context, trace, callbacks, requests, XHR};
}
function original(f) {
  const stop = new Error('stop before hook installation and scheduling');
  const bridge = {
    3:Array, 13:{}, 14:'1.0.1.7', 15:f.context.localStorage, 16:f.XHR,
    17:URL, 18:JSON, 19:{now:()=>1000}, 21:f.context.requestAnimationFrame,
    23:{now(){throw stop;}}, 25:{href:'https://local.invalid/login/index.html'},
    47:value=>value, 49(){},
  };
  try {vm.runInNewContext(`"use strict";(${source.slice(start, end)},bridge,void 0))`, {require:requireProductionDependency,bridge}, {timeout:3000}); assert.fail('stop not reached');}
  catch(error) {assert.equal(error, stop);}
  const root = bridge[51]._v[2];
  assert.equal(root[25]._v[0], 6067);
  return {root, bridge, get token(){return root[24].inner;}, report(token, headerError) {
    root[25]({}); // Original report with deterministic strData collaborator, no transport.
    const xhr = f.requests.at(-1); xhr.token = token; xhr.headerError = headerError;
    xhr.listeners.load();
  }};
}
let comparisons = 0;
function equal(a,b,label) {assert.deepEqual(a,b,label); comparisons++;}
for (const options of [{}, {initial:'cached'}, {readError:true}, {writeError:true}, {rafError:true}, {readError:true,writeError:true}]) {
  function run(isOriginal) {
    const f=fixture(options), state=isOriginal ? original(f) : new production.DesktopTokenState(f.context);
    const snapshots=[];
    for (const [token, headerError] of [['first',false],['second',false],['',false],[null,false],['bad',true]]) {
      let error;
      try {
        if (isOriginal) state.report(token,headerError);
        else state.onReportLoad({getResponseHeader(name){f.trace.push(`header:${name}`);if(headerError)throw Error('header');return token;}},()=>{});
      } catch(e) {error=e.message;}
      snapshots.push({token:state.token, error, rafCount:f.callbacks.length});
    }
    return {trace:f.trace,snapshots};
  }
  equal(run(false),run(true),`token sequence ${JSON.stringify(options)}`);
}

const urls = [
  '../passport?q=a%20b&x=~#hash', '/passport?msToken=', '/passport?msToken=a&msToken=b',
  '/passport?a_bogus=', '/passport?a_bogus=a&a_bogus=b', '/passport?msToken=&a_bogus=',
  '/passport?q=a%20b&x=~&a_bogus=', '/passport?mstoken=x&A_BOGUS=y',
];
for (const url of urls) for (const token of ['', 'cached+']) for (const asObject of [false,true]) for (const stringBody of [false,true]) {
  function run(isOriginal) {
    const input = asObject ? new URL(url,'https://local.invalid/login/index.html') : url;
    const body = stringBody ? 'raw=body' : {raw:true}, calls=[];
    const signer={sign(...args){calls.push(args);return 'signed+/=';}};
    let result;
    if (isOriginal) {
      const f=fixture({initial:token}), state=original(f);
      state.bridge[50].paths={include:[/passport/],exclude:[]};
      // Replace only the signing collaborator; preserve original hook bytecode.
      state.root[34]=signer.sign;
      state.root[35]();
      const xhr=new f.XHR(); xhr.open('POST',input,true); xhr.setRequestHeader('Content-Type','multipart/form-data'); xhr.send(body);
      result=xhr.openArgs[1]; assert.equal(xhr.body,body); assert.equal(xhr.bdmsInvokeList,undefined);
      assert.equal(xhr.listeners.load,undefined,'business XHR has no report token handler');
    } else result=production.signDesktopXhrUrl({URL,location:{href:'https://local.invalid/login/index.html'}},input,body,{token},signer);
    return {url:String(result),sameObject:asObject && result===input,calls};
  }
  equal(run(false),run(true),`XHR ${url} token=${token} object=${asObject}`);
}
console.log(JSON.stringify({comparisons, tokenSequences:6, xhrComparisons:64, network:false, cryptographicOracle:false}));
