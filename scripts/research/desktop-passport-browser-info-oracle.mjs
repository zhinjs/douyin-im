// Execute the pinned Account SDK collector/interceptor, not an emulated Desktop runtime.
// Fixtures are synthetic. No network, native module, real browser or account access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

const root = process.argv[2];
assert(root, 'Pass the extracted Desktop 1.2.1 directory');
const path = 'renderer/321/321_32eb617b8bb29d30a181.js';
const bytes = readFileSync(join(root, path));
assert.equal(createHash('sha256').update(bytes).digest('hex'),
  '5948467b5caf5e7a5d99ae65eff814d6a5c1961e293d763a1c2253a102e97919');
const source = ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function unique(parent, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(parent);
  assert.equal(found.length, 1, 'Pinned source extraction must be unique');
  return found[0];
}
const module = unique(source, node => ts.isPropertyAssignment(node) && node.name.getText(source) === '74321');
const declarations = new Map();
for (const statement of module.initializer.body.statements) {
  if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    assert(!declarations.has(declaration.name.getText(source)));
    declarations.set(declaration.name.getText(source), declaration);
  }
  else if (ts.isFunctionDeclaration(statement)) declarations.set(statement.name.text, statement);
}
const names = ['a', 'l', 'f', 'd', 'p', 'h', 'v', 'm', '_', 'y', 'g', 'w', 'O', 'E', 'S', 'x', 'C', 'I', 'k'];
const helpers = names.map(name => {
  const declaration = declarations.get(name);
  assert(declaration, `Missing collector dependency ${name}`);
  return ts.isFunctionDeclaration(declaration) ? declaration.getText(source) : `var ${declaration.getText(source)};`;
}).join('\n');
const init = unique(module, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'e.init'
  && node.right.getText(source).includes('account_sdk_source_info'));

function fixture(setup = '') {
  const context = createContext({});
  runInContext(helpers, context, { timeout: 1000 });
  runInContext(setup, context, { timeout: 1000 });
  return context;
}
const collect = context => runInContext('x({useBitReport:true})', context, { timeout: 1000 });
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;
for (const setup of ['', 'var navigator={hardwareConcurrency:4,userAgent:"Node.js/24"};']) {
  assert.deepEqual(plain(await collect(fixture(setup))), {});
  checks++;
}

// An owned fixture surface, deliberately not labelled as actual host capabilities.
const browserSetup = `
var window=globalThis;
var navigator={hardwareConcurrency:3,webdriver:false,userAgent:'fixture Electron/28',
  plugins:[],mimeTypes:[],language:'en',languages:['en'],
  permissions:{query:async({name})=>({name,state:'denied'})},
  storage:{estimate:async()=>({usage:19,quota:200000000})}};
var localStorage={fixture:'four'};
Object.defineProperties(localStorage,{
  setItem:{value:function(k,v){this[k]=String(v)}},
  getItem:{value:function(k){return this[k]??null}},
  removeItem:{value:function(k){delete this[k]}}
});
var innerHeight=101,innerWidth=202,outerHeight=303,outerWidth=404;
var HTMLMediaElement=function(){};
HTMLMediaElement.prototype.play=function play(){};
var Notification={permission:'denied'};
var location={host:'',pathname:'/fixture/login/index.html'};
var performance={timeOrigin:123.5,memory:{usedJSHeapSize:42},getEntries:()=>[
  {name:'file:///fixture/login/index.html',entryType:'navigation',serverTiming:[{name:'fixture-server'}]}],
  getEntriesByName:name=>name==='script_glue_start'?[{startTime:7}]:[{duration:8}]};
var canvases=0;
var document={createElement(type){
  if(type!=='canvas')throw new Error('Unexpected fixture element');
  canvases++;return{getContext:()=>({getExtension:()=>({UNMASKED_VENDOR_WEBGL:1,UNMASKED_RENDERER_WEBGL:2}),
    getParameter:key=>key===1?'fixture-vendor':'fixture-renderer'})};
}};
var Date={now:()=>123456};
`;
const browser = fixture(browserSetup);
const full = plain(await collect(browser));
assert.deepEqual(full, {
  hardwareConcurrency: 3, webdriver: false, chromedriver: false, shelldriver: true,
  plugins: 0, permissions: [{ name: 'notifications', state: 'denied' }],
  innerHeight: 101, innerWidth: 202, outerHeight: 303, outerWidth: 404,
  stoargeStatus: {
    indexedDB: { idb: 'undefined', indexedDB: 'undefined', IDBKeyRange: 'undefined', openDatabase: 'undefined', isSafari: false, hasFetch: false },
    localStorage: { isSupportLStorage: true, size: 4, write: true },
    storageQuotaStatus: { usage: 19, quota: 200000000, isPrivate: false },
  },
  webgl: { vendor: 'fixture-vendor', renderer: 'fixture-renderer' },
  notificationPermission: 'denied', performance: { timeOrigin: 123.5, usedJSHeapSize: 42,
    navigationTiming: { entryType: 'navigation', name: 'file:///fixture/login/index.html',
      serverTiming: 'fixture-server', guleStart: 7, guleDuration: 8 } },
  request_host: '', request_pathname: '/fixture/login/index.html',
  browser: { t: '654321', bit_protocol: 'false', bit_helper: false },
});
assert.equal(runInContext('canvases', browser), 1);
checks++;

for (const [mutation, expected] of [
  ['HTMLMediaElement=undefined;', {}],
  ['navigator.storage.estimate=async()=>{throw new Error("fixture quota unavailable")};', { ...full,
    stoargeStatus: { ...full.stoargeStatus, storageQuotaStatus: {} } }],
  ['navigator.permissions.query=()=>Promise.reject(new Error("fixture permission unavailable"));', { ...full, permissions: [] }],
  ['navigator.permissions.query=()=>{throw new Error("fixture synchronous permission failure")};', {}],
  ['performance.getEntries=()=>{throw new Error("fixture timing unavailable")};', { ...full, performance: {} }],
  ['document.createElement=()=>({getContext:()=>null});', { ...full, webgl: {} }],
]) {
  assert.deepEqual(plain(await collect(fixture(browserSetup + mutation))), expected);
  checks++;
}

// Install the original interceptor: collection is deferred and cached after await.
function interceptor(context) {
  runInContext(`var handler;var e={initProps:{browserInfo:{useBitReport:true}},
    request:{interceptors:{request:{use(value){handler=value}}}}};`, context);
  return runInContext(`(${init.right.getText(source)}).call(e)`, context);
}
const cached = fixture(browserSetup);
await interceptor(cached);
assert.equal(runInContext('canvases', cached), 0, 'init does not collect');
const first = await runInContext('handler({params:{fixture:"kept"}})', cached);
runInContext('navigator.hardwareConcurrency=9;Date.now=()=>999;location.pathname="/changed";', cached);
const second = await runInContext('handler({params:{}})', cached);
assert.equal(first.params.fixture, 'kept');
assert.equal(second.params.account_sdk_source_info, first.params.account_sdk_source_info);
assert.deepEqual(plain(runInContext('e.browserInfo', cached)), full);
checks++;

const failed = fixture('var navigator={hardwareConcurrency:4,userAgent:"Node.js/24"};');
await interceptor(failed);
const failedRequest = await runInContext('handler({params:{account_sdk_source_info:"old"}})', failed);
assert.equal(failedRequest.params.account_sdk_source_info, '7e78', 'error fallback is encoded {}, not an omitted field');
runInContext(browserSetup, failed);
await runInContext('handler({params:{}})', failed);
assert.equal(runInContext('canvases', failed), 0, 'empty object is truthy and remains cached');
assert.deepEqual(plain(runInContext('e.browserInfo', failed)), {});
checks++;

const parallel = fixture(browserSetup + 'var estimates=[];navigator.storage.estimate=()=>new Promise(resolve=>estimates.push(resolve));');
await interceptor(parallel);
const pendingFirst = runInContext('handler({params:{}})', parallel);
const pendingSecond = runInContext('handler({params:{}})', parallel);
assert.equal(runInContext('estimates.length', parallel), 2, 'collector promise is not single-flight cached');
runInContext('estimates[1]({usage:2,quota:200000000});', parallel);
await pendingSecond;
assert.equal(runInContext('e.browserInfo.stoargeStatus.storageQuotaStatus.usage', parallel), 2);
runInContext('estimates[0]({usage:1,quota:200000000});', parallel);
await pendingFirst;
assert.equal(runInContext('e.browserInfo.stoargeStatus.storageQuotaStatus.usage', parallel), 1,
  'last completed first-collection result owns the cache');
checks++;

const disabledBit = fixture(browserSetup);
assert.equal((await runInContext('x({useBitReport:false})', disabledBit)).browser.bit_protocol, '');
checks++;

console.log(`Desktop browserInfo: ${checks} original collector/interceptor cases passed. Synthetic surfaces only; no real login or browser-runtime equivalence claimed.`);
