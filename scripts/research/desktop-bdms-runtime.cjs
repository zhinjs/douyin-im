// Exploration harness, not a production signer or a browser-fidelity assertion.
// All storage, timers, DOM and network sinks are synthetic and isolated from accounts.
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/research/desktop-bdms-runtime.cjs /path/to/bdms-1.0.1.7.js');
const source = readFileSync(path, 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),
  'd99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e', 'Re-audit changed source first');
const argument=(name,fallback)=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
const fixtureNowMs=Number(argument('time-ms','1789214400000'));
const fixtureAid=Number(argument('aid','339757')),fixturePageId=Number(argument('page-id','23420'));
const fixtureTrackMode=Number(argument('track-mode','0'));
for(const value of [fixtureNowMs,fixtureAid,fixturePageId]) assert(Number.isSafeInteger(value));
assert([0,1,2].includes(fixtureTrackMode));
const context = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder,
  fixtureNowMs,
  btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
  atob: value => Buffer.from(String(value), 'base64').toString('binary'),
}, process.argv.includes('--microtasks') ? { microtaskMode: 'afterEvaluate' } : {});
vm.runInContext(`
  var observed = { requests: [], xhrs: [], timers: [], listeners: [], scripts: [], logs: [], storage: [] };
  var window = globalThis, self = globalThis;
  var location = new URL('https://offline.invalid/login');
  var console = Object.fromEntries(['log','warn','error','debug','info'].map(k => [k, (...v) => observed.logs.push([k, v.map(String)])]));
  var seed = 1; Math.random = () => ((seed = seed * 48271 % 2147483647) - 1) / 2147483646;
  var OriginalDate = Date, virtualTick=0;
  Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [fixtureNowMs+virtualTick])); }
    static now() { return fixtureNowMs+virtualTick; }
  };
  var performance = { now: () => 1000+virtualTick, timeOrigin: fixtureNowMs-1000, getEntries: () => [], getEntriesByType: () => [] };
  var navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) douyinim/1.2.1 Chrome/130.0.6723.58 Electron/33.2.0-rs.21.release.main.1 Safari/537.36',
    platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN'], hardwareConcurrency: 8, deviceMemory: 8,
    maxTouchPoints: 0, cookieEnabled: true, onLine: true, plugins: [], mimeTypes: [],
    sendBeacon: (url, body) => { observed.requests.push({ kind: 'beacon', url: String(url), body }); return true; } };
  var screen = { width: 1707, height: 1067, availWidth: 1707, availHeight: 1019, colorDepth: 24, pixelDepth: 24 };
  var innerWidth=1707, innerHeight=1019, outerWidth=1707, outerHeight=1067, devicePixelRatio=2;
  function memoryStorage() {
    const data = new Map();
    return { getItem: k => { observed.storage.push(['get',String(k)]); return data.get(String(k)) ?? null; }, setItem: (k,v) => { observed.storage.push(['set',String(k),String(v)]); data.set(String(k), String(v)); },
      removeItem: k => data.delete(String(k)), clear: () => data.clear(), key: i => [...data.keys()][i] ?? null,
      get length() { return data.size; } };
  }
  var localStorage=memoryStorage(), sessionStorage=memoryStorage();
  var cookieValues = new Map();
  function addEventListener(type, callback) { observed.listeners.push({ type, callback }); }
  function removeEventListener() {}
  function queueTimer(kind, callback, delay, args) {
    observed.timers.push({ callback, delay, args, kind, due: virtualTick+Math.max(0,Number(delay)||0), cancelled:false, fired:false });
    return observed.timers.length;
  }
  function setTimeout(callback, delay, ...args) { return queueTimer('timeout',callback,delay,args); }
  function setInterval(callback, delay, ...args) { return queueTimer('interval',callback,delay,args); }
  function clearTimeout(id) { if(observed.timers[id-1]) observed.timers[id-1].cancelled=true; }
  var clearInterval=clearTimeout;
  function requestAnimationFrame(callback) { return queueTimer('raf',callback,16,[]); }
  var cancelAnimationFrame=clearTimeout;
  class Element {
    constructor(tag) { this.tagName=tag.toUpperCase(); this.style={}; this.children=[]; this.attributes={}; }
    setAttribute(k,v) { this.attributes[k]=String(v); if (k==='src') observed.scripts.push(String(v)); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    appendChild(child) { this.children.push(child); if(child.src) observed.scripts.push(child.src); return child; }
    removeChild(child) { return child; }
    addEventListener(type, callback) { observed.listeners.push({ type, callback }); }
    removeEventListener() {}
    getContext() { return null; }
    toDataURL() { return 'data:,'; }
    getBoundingClientRect() { return { x:0, y:0, width:0, height:0 }; }
  }
  var HTMLElement=Element, HTMLCanvasElement=Element, HTMLScriptElement=Element;
  var document = { head:new Element('head'), body:new Element('body'), documentElement:new Element('html'),
    readyState:'complete', visibilityState:'visible', hidden:false, referrer:'', location, URL:location.href,
    createElement: tag => tag==='a' ? new URL(location.href) : new Element(tag),
    getElementsByTagName: tag => tag==='head' ? [document.head] : [],
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    addEventListener, removeEventListener, write: s => observed.scripts.push(String(s)),
    get cookie() { return [...cookieValues].map(([k,v])=>k+'='+v).join('; '); },
    set cookie(value) { const part=String(value).split(';')[0]; const i=part.indexOf('='); if(i>=0) cookieValues.set(part.slice(0,i),part.slice(i+1)); },
  };
  class XMLHttpRequest {
    constructor() { this.headers={}; this.responseHeaders={}; this.events={}; this.readyState=0; this.status=200; this.responseText='{}'; observed.xhrs.push(this); }
    open(method,url,async=true) { Object.assign(this,{method,url:String(url),async}); this.readyState=1; }
    setRequestHeader(k,v) { this.headers[k]=String(v); }
    getResponseHeader(key) { return this.responseHeaders[key.toLowerCase()] ?? null; }
    getAllResponseHeaders() { return ''; }
    addEventListener(type, callback) { (this.events[type] ??= []).push(callback); } removeEventListener() {} abort() {}
    send(body) { observed.requests.push({kind:'xhr',method:this.method,url:this.url,headers:this.headers,body}); }
  }
  class Image extends Element { constructor() { super('img'); } set src(value) {
    observed.requests.push({kind:'image',url:String(value)});
    if(globalThis.fixtureDataImageLoad && String(value).startsWith('data:image/'))
      setTimeout(()=>{ if(typeof this.onload==='function') this.onload({target:this}); },0);
  } }
  function fetch(url, init) { observed.requests.push({kind:'fetch',url:String(url),init}); return Promise.resolve({status:200,ok:true,headers:{get:()=>null},text:async()=>'{}',json:async()=>({})}); }
`, context, { timeout: 1000 });
function run(code, label) {
  try { vm.runInContext(code, context, { timeout: 3000, filename: label }); return true; }
  catch (error) { console.log(label, error.name, error.message); process.exitCode = 1; return false; }
}
function pumpEventLoop(horizon) {
  assert(Number.isFinite(horizon));
  for(let i=0;i<1000;i++) {
    const predicate=`!t.cancelled&&!t.fired&&t.due<=${horizon}`;
    if(!vm.runInContext(`observed.timers.some(t=>${predicate})`,context)) break;
    if(!run(`{
      const timer=observed.timers.filter(t=>${predicate}).sort((a,b)=>a.due-b.due)[0];
      virtualTick=timer.due; timer.fired=timer.kind!=='interval';
      if(timer.kind==='interval') timer.due+=Math.max(1,Number(timer.delay)||0);
      if(typeof timer.callback==='function') timer.callback(...(timer.kind==='raf'?[performance.now()]:timer.args));
    }`, 'bounded-event-loop')) break;
  }
  assert.equal(vm.runInContext(`observed.timers.some(t=>!t.cancelled&&!t.fired&&t.due<=${horizon})`,context),false,
    'bounded event loop exhausted before reaching its horizon');
}
const seedToken = process.argv.find(value => value.startsWith('--seed='))?.slice(7);
if (process.argv.includes('--data-image-load')) run('globalThis.fixtureDataImageLoad=true;', 'synthetic-image-policy');
if (argument('profile','mac')==='windows') run(`
  navigator.userAgent='  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36  ';
  navigator.platform='Win32';innerWidth=1600;innerHeight=900;outerWidth=1920;outerHeight=1080;
  globalThis.screenX=-1920;globalThis.screenY=5;globalThis.pageXOffset=7;globalThis.pageYOffset=12;
  Object.assign(screen,{width:1920,height:1080,availWidth:1920,availHeight:1040});
  document.body.clientWidth=1584;document.body.clientHeight=884;
`,'synthetic-windows-profile');
if (argument('profile','mac')==='unicode') run(`navigator.userAgent+=' 测试😀';navigator.platform='MacIntel测试😀';`,'synthetic-unicode-profile');
if (argument('profile','mac')==='window-edge') run(`
  innerWidth=4294967297.9;innerHeight=-2.9;outerWidth=2147483648;outerHeight=-4294967297.9;
  screenX=-1920.7;screenY=5.9;window.pageXOffset=999;window.pageYOffset=12.9;
  screen.availWidth=1.9;screen.availHeight=-1.9;screen.width=4294967295;screen.height=4294967296;
  screen.colorDepth=24.9;screen.pixelDepth=-1.9;document.body.clientWidth=2147483648;
  document.body.clientHeight=-1.9;
`,'synthetic-window-edge-profile');
if (argument('profile','mac')==='body-null') run('document.body=null;','synthetic-no-body-profile');
if (argument('profile','mac')==='body-empty') run('delete document.body.clientWidth;delete document.body.clientHeight;','synthetic-empty-body-profile');
if (seedToken) run(`localStorage.setItem('xmst',${JSON.stringify(seedToken)});`, 'synthetic-token');
if (run(source, 'original-bdms7')) {
  console.log('exports', vm.runInContext('Object.fromEntries(Object.keys(bdms).map(k=>[k,typeof bdms[k]]))', context));
  if (process.argv.includes('--init') || process.argv.includes('--exercise') || process.argv.includes('--report-exercise') || process.argv.includes('--sign-vectors')) {
    run(`bdms.init({aid:${fixtureAid},pageId:${fixturePageId},paths:["/passport"],track:{mode:${fixtureTrackMode}}})`, 'original-init');
  }
  if (process.argv.includes('--sign-vectors')) {
    const fixedRandom=Number(process.argv.find(v=>v.startsWith('--rng='))?.slice(6)??'0');
    assert(fixedRandom>=0&&fixedRandom<1);
    const randomSequence=argument('rng-sequence',String(fixedRandom)).split(',').map(Number);
    assert(randomSequence.length>0&&randomSequence.every(value=>value>=0&&value<1));
    run(`var signatureVectors=[];
      var randomCalls=0,randomSequence=${JSON.stringify(randomSequence)};
      Math.random=()=>randomSequence[(randomCalls++)%randomSequence.length];
      for(const [method,query,body] of [
        ['GET','aid=339757&fixture=one',''],
        ['POST','aid=339757&fixture=one','token=offline-token'],
        ['POST','b=space+value&a=%E6%B5%8B%E8%AF%95%26%3D','text=%F0%9F%98%80+%E6%B5%8B%E8%AF%95'],
        ['GET','',''],
        ['POST','q=a:b,$[x]~!%20()','text=原始正文😀'],
        ['POST','q=a%3Ab%2C%24%5Bx%5D%7E%21+%28%29','text=原始正文😀'],
      ]) {
        randomCalls=0;
        const xhr=new XMLHttpRequest();xhr.open(method,'https://offline.invalid/passport/vector'+(query?'?'+query:''));
        if(method==='POST') xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
        xhr.send(method==='GET'?null:body);
        signatureVectors.push({method,query,body,userAgent:navigator.userAgent,nowMs:Date.now(),random:${fixedRandom},randomCalls,
          fingerprintContext:{
            window:{innerWidth,innerHeight,outerWidth,outerHeight,screenX:window.screenX,screenY:window.screenY,
              pageYOffset:window.pageYOffset,screen:{...screen}},
            document:{body:document.body?{clientWidth:document.body.clientWidth,clientHeight:document.body.clientHeight}:null},
            navigator:{platform:navigator.platform}
          },
          url:observed.requests.at(-1).url,
          signature:new URL(observed.requests.at(-1).url).searchParams.get('a_bogus')});
      }
    `,'constant-random-signature-vectors');
    console.log('signature-vectors',vm.runInContext('JSON.stringify(signatureVectors)',context));
  }
  if (process.argv.includes('--exercise')) {
    run(`for (const [method,url,body] of [
      ['GET','https://offline.invalid/passport/web/get_qrcode/?aid=339757&fixture=one',null],
      ['POST','https://offline.invalid/passport/web/check_qrconnect/?aid=339757','token=offline-token'],
      ['POST','https://offline.invalid/aweme/v1/web/commit/follow/user/','user_id=offline'],
      ['GET','https://offline.invalid/unmatched',null],
    ]) { const xhr=new XMLHttpRequest(); xhr.open(method,url,true); if(body) xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded'); xhr.send(body); }`, 'synthetic-xhr');
    console.log('requests', vm.runInContext('JSON.stringify(observed.requests)', context));
    const sent = JSON.parse(vm.runInContext('JSON.stringify(observed.requests.filter(r=>r.kind==="xhr"))', context));
    assert.equal(sent.length, 4);
    for (const item of sent.slice(0, 2)) {
      const url = new URL(item.url);
      assert(url.searchParams.get('a_bogus'));
      assert.equal(url.searchParams.get('msToken'), seedToken || null);
    }
    assert.equal(sent[0].body, null);
    assert.equal(sent[1].body, 'token=offline-token');
    assert.equal(sent[2].url, 'https://offline.invalid/aweme/v1/web/commit/follow/user/');
    assert.equal(sent[3].url, 'https://offline.invalid/unmatched');
    console.log('PASS original XHR path matching, body preservation and cached-or-absent token assertions');
    if (process.argv.includes('--response')) {
      run(`const completed=observed.xhrs[0]; completed.responseHeaders['x-ms-token']='rotated-fixture'; completed.readyState=4;
        for(const name of ['readystatechange','load','loadend']) {
          if(typeof completed['on'+name] === 'function') completed['on'+name]({target:completed});
          for(const callback of completed.events[name] ?? []) callback.call(completed,{target:completed});
        }
        const next=new XMLHttpRequest();next.open('GET','https://offline.invalid/passport/next');next.send(null);`, 'synthetic-response');
      console.log('after-response',vm.runInContext('JSON.stringify({request:observed.requests.at(-1),events:Object.keys(observed.xhrs[0].events)})',context));
      assert.equal(vm.runInContext('new URL(observed.requests.at(-1).url).searchParams.get("msToken")',context),seedToken||null,
        'business response must not be confused with the original report token callback');
    }
  }
  if (process.argv.includes('--timers')) {
    run('for (const timer of observed.timers.slice()) if(typeof timer.callback === "function") timer.callback(...timer.args);', 'first-timer-snapshot');
    console.log('requests-after-timers', vm.runInContext('JSON.stringify(observed.requests.map(r=>({kind:r.kind,url:r.url,method:r.method,bodyType:typeof r.body,bodyLength:r.body?.length})))', context));
  }
  if (process.argv.includes('--pump')) {
    run(`for (let i=0;i<observed.timers.length && i<100;i++) {const timer=observed.timers[i];
      if((timer.kind==='timeout'||timer.kind==='raf') && typeof timer.callback==='function') {virtualTick+=Number(timer.delay)||0;timer.callback(...timer.args);}}`, 'bounded-timer-pump');
    console.log('requests-after-pump', vm.runInContext('JSON.stringify(observed.requests.map(r=>({kind:r.kind,url:r.url,method:r.method,bodyType:typeof r.body,bodyLength:r.body?.length})))', context));
  }
  if (process.argv.includes('--event-loop')) {
    pumpEventLoop(10000);
    console.log('requests-after-event-loop',vm.runInContext('JSON.stringify(observed.requests.map(r=>({kind:r.kind,url:r.url,method:r.method,bodyType:typeof r.body,bodyLength:r.body?.length})))',context));
  }
  if (process.argv.includes('--report-exercise')) {
    const reports=JSON.parse(vm.runInContext(`JSON.stringify(observed.xhrs.filter(x=>x.url.startsWith('https://mssdk.bytedance.com/web/common')).map(x=>({
      method:x.method,url:x.url,withCredentials:x.withCredentials,headers:x.headers,events:Object.keys(x.events)
    })))`,context));
    assert.equal(reports.length,1,'original report must run before testing its response');
    assert.equal(reports[0].method,'POST');
    assert.equal(reports[0].withCredentials,true);
    assert.deepEqual(reports[0].events,['load']);
    const reportUrl=new URL(reports[0].url);
    assert.equal(reportUrl.searchParams.get('ms_appid'),'339757');
    assert.equal(reportUrl.searchParams.get('msToken'),seedToken||null);
    assert.equal(reportUrl.searchParams.has('a_bogus'),false);
    const reportBody=JSON.parse(vm.runInContext(`observed.requests.find(r=>r.kind==='xhr'&&r.url.startsWith('https://mssdk.bytedance.com/web/common')).body`,context));
    assert.deepEqual(Object.keys(reportBody),['magic','version','dataType','strData','tspFromClient','ulr']);
    assert.equal(reportBody.magic,538969122);
    assert.equal(reportBody.version,1);
    assert.equal(reportBody.dataType,8);
    assert.equal(typeof reportBody.strData,'string');
    assert(reportBody.strData.length>0);
    assert.equal(reportBody.tspFromClient,1789214403000);
    assert.equal(reportBody.ulr,0);
    console.log('report-shape',reports);
    console.log('report-body-shape',vm.runInContext(`JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(observed.requests.find(r=>r.kind==='xhr'&&r.url.startsWith('https://mssdk.bytedance.com/web/common')).body)).map(([k,v])=>[k,{type:typeof v,...(typeof v==='string'?{length:v.length}:{value:v})}])))`,context));
    run(`var reportCases=[];
      var report=observed.xhrs.find(x=>x.url.startsWith('https://mssdk.bytedance.com/web/common'));
      function syntheticReportResponse(value) {
        report.responseHeaders={}; if(value!==null) report.responseHeaders['x-ms-token']=value;
        report.readyState=4;
        for(const callback of report.events.load ?? []) callback.call(report,{target:report});
      }
      function checkNext(label) {
        const xhr=new XMLHttpRequest();xhr.open('GET','https://offline.invalid/passport/after-report');xhr.send(null);
        reportCases.push({label,token:new URL(observed.requests.at(-1).url).searchParams.get('msToken'),stored:localStorage.getItem('xmst')});
      }
      checkNext('before');
      syntheticReportResponse(null); checkNext('missing');
      syntheticReportResponse('report-token-one'); checkNext('rotated');
      syntheticReportResponse(''); checkNext('empty');
      const originalSetItem=localStorage.setItem;
      localStorage.setItem=()=>{throw new Error('synthetic storage denial');};
      syntheticReportResponse('report-token-two');
      localStorage.setItem=originalSetItem; checkNext('storage-denied');
      syntheticReportResponse('report-token-three'); checkNext('recovered');
    `,'synthetic-report-responses');
    const cases=JSON.parse(vm.runInContext('JSON.stringify(reportCases)',context));
    assert.deepEqual(cases,[
      {label:'before',token:seedToken||null,stored:seedToken||null},
      {label:'missing',token:seedToken||null,stored:seedToken||null},
      {label:'rotated',token:'report-token-one',stored:'report-token-one'},
      {label:'empty',token:'report-token-one',stored:'report-token-one'},
      {label:'storage-denied',token:'report-token-two',stored:'report-token-one'},
      {label:'recovered',token:'report-token-three',stored:'report-token-three'},
    ]);
    console.log('PASS original report response: missing, rotation, empty, storage denial, recovery',cases);
    if (process.argv.includes('--lifecycle-exercise')) {
      const pendingRaf=vm.runInContext('observed.timers.filter(t=>t.kind==="raf"&&!t.fired&&!t.cancelled).length',context);
      assert.equal(pendingRaf,seedToken?0:1,'only the empty-to-nonempty transition schedules another device report');
      pumpEventLoop(10000);
      assert.equal(vm.runInContext('observed.requests.filter(r=>r.kind==="xhr"&&r.url.startsWith("https://mssdk.bytedance.com/web/common")).length',context),seedToken?1:2);
      const listenerCount=vm.runInContext('observed.listeners.length',context);
      run('bdms.init({aid:339757,pageId:23420,paths:["/passport"]});','repeated-original-init');
      assert.equal(vm.runInContext('observed.listeners.length',context),listenerCount);
      assert.equal(vm.runInContext('observed.timers.filter(t=>t.kind==="timeout"&&t.delay===3000).length',context),1);
      assert.equal(vm.runInContext('observed.timers.filter(t=>t.kind==="interval"&&t.delay===300000).length',context),1);
      run(`for(let i=0;i<2;i++) for(const listener of observed.listeners.filter(l=>l.type==='visibilitychange')) listener.callback({type:'visibilitychange'});`,'synthetic-visibility');
      assert.equal(vm.runInContext('observed.requests.filter(r=>r.kind==="beacon").length',context),1);
      pumpEventLoop(300020);
      const lifecycleReports=JSON.parse(vm.runInContext(`JSON.stringify(observed.requests.filter(r=>r.url.startsWith('https://mssdk.bytedance.com/web/common')).map(r=>({kind:r.kind,url:r.url,time:JSON.parse(r.body).tspFromClient,ulr:JSON.parse(r.body).ulr})))`,context));
      assert.equal(lifecycleReports.length,seedToken?3:4);
      assert.equal(lifecycleReports.at(-1).kind,'xhr');
      assert.equal(lifecycleReports.at(-1).time,1789214700016);
      assert.equal(new URL(lifecycleReports.at(-1).url).searchParams.get('msToken'),'report-token-three');
      console.log('PASS first-token RAF, repeated init, visibility once and periodic report',lifecycleReports);
    }
  }
}
console.log('observed', vm.runInContext(`JSON.stringify({requestCount:observed.requests.length,
  timers:observed.timers.reduce((out,t)=>{const k=t.kind+':'+t.delay;out[k]=(out[k]||0)+1;return out;},{}),
  listeners:observed.listeners.map(x=>x.type),scripts:observed.scripts,logs:observed.logs,storage:observed.storage})`, context));
