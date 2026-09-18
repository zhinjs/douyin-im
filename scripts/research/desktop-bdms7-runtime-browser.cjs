// Full original/production runtime in two fresh Chromium profiles, no vendor network.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createServer } = require('node:http'), { spawn } = require('node:child_process');
const { createHash } = require('node:crypto'), assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2] || '/private/tmp/douyin-desktop-glue.frpBTm/bdms-1.0.1.7.js', 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), 'd99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
// Exercise exactly what npm ships; run pnpm build before this check.
const production = fs.readFileSync(path.join(__dirname, '../../lib/desktop/assets/bdms.js'), 'utf8');
const assetHash = createHash('sha256').update(production).digest('hex');
const bootstrap = `
  const fixture = { tick: 0, frames: [], timers: [], intervals: [], requests: [], reports: [], steps: [] };
  const nativeStringify = JSON.stringify, nativeTimeout = setTimeout;
  JSON.stringify = function(value,...rest){if(value&&typeof value==='object'&&'wID' in value)fixture.reports.push(nativeStringify(value));return nativeStringify(value,...rest);};
  const NativeDate=Date;
  window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[1789214400000+fixture.tick]));}static now(){return 1789214400000+fixture.tick;}};
  Math.random=()=>0.5;
  Object.defineProperty(performance,'now',{value:()=>fixture.tick});
  window.requestAnimationFrame=callback=>{fixture.frames.push(callback);return fixture.frames.length;};
  window.setTimeout=(callback,delay)=>{fixture.timers.push({callback,delay});return fixture.timers.length;};
  window.setInterval=(callback,delay)=>{fixture.intervals.push({callback,delay});return fixture.intervals.length;};
  const opened = new WeakMap();
  XMLHttpRequest.prototype.open=function(method,url){opened.set(this,{kind:'xhr',method,url:String(url),headers:[]});};
  XMLHttpRequest.prototype.setRequestHeader=function(...args){opened.get(this).headers.push(args);};
  XMLHttpRequest.prototype.send=function(body){fixture.requests.push({...opened.get(this),body,credentials:this.withCredentials});fixture.lastXhr=this;};
  XMLHttpRequest.prototype.getResponseHeader=function(){return this.fixtureToken||null;};
  window.fetch=async function(input,options){fixture.requests.push({kind:'fetch',url:input instanceof Request?input.url:String(input),options});return {input,options};};
  window.EventSource=class {constructor(url,options){fixture.requests.push({kind:'EventSource',url:String(url),options});}};
  navigator.sendBeacon=function(url,body){fixture.requests.push({kind:'beacon',url:String(url),body});return true;};
  window.addEventListener('error',event=>{document.getElementById('result').textContent=nativeStringify({error:event.message});});
`;
const exercise = `
  (async()=>{
    // The short production bundle can finish before Chrome attaches window geometry.
    // Wait for the real host; do not invent or normalize fingerprint dimensions.
    for(let attempt=0;outerWidth===0&&attempt<50;attempt++)await new Promise(resolve=>nativeTimeout(resolve,20));
    if(outerWidth===0)throw Error('Chrome window geometry did not initialize');
    function sample(label){fixture.steps.push({label,requests:fixture.requests.slice(),reports:fixture.reports.slice(),
      frames:fixture.frames.length,timers:fixture.timers.map(x=>x.delay),intervals:fixture.intervals.map(x=>x.delay),
      token:localStorage.getItem('xmst')});}
    sample('load');
    bdms.init({aid:339757,pageId:23420,paths:['/passport'],track:{paths:['/passport']}});sample('init');
    fixture.tick=100;
    document.dispatchEvent(new MouseEvent('mousemove',{clientX:40,clientY:70}));
    document.dispatchEvent(new KeyboardEvent('keydown'));
    const xhr=new XMLHttpRequest();xhr.open('POST','/passport/login?a=x%20y');xhr.setRequestHeader('Content-Type','application/json');xhr.send('{"hello":1}');
    sample('input and XHR');
    fixture.frames[1]();sample('behavior report');
    fixture.lastXhr.fixtureToken='synthetic-issued-token';fixture.lastXhr.dispatchEvent(new Event('load'));sample('token');
    await fetch('/passport/login?q=x%20y',{method:'POST',body:'body'});
    new EventSource('/passport/events?q=x%20y');sample('fetch and EventSource');
    await fixture.timers[0].callback();sample('device report');
    bdms.init({track:{mode:1},dump:false});sample('reinit');
    document.getElementById('result').textContent=nativeStringify({steps:fixture.steps,userAgent:navigator.userAgent});
  })().catch(error=>{document.getElementById('result').textContent=nativeStringify({error:String(error),stack:error.stack});});
`;
let mode = 'original';
const server = createServer((req, res) => {
  if (req.url !== '/') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'content-type':'text/html;charset=utf-8','content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; frame-src 'none'"});
  res.end(`<!doctype html><meta charset="utf-8"><title>Offline runtime</title><body><pre id="result"></pre><script>${bootstrap}</script><script>${mode==='original'?source:production}</script><script>${exercise}</script></body>`);
});
async function run(kind) {
  mode = kind;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-bdms-runtime-offline-'));
  return new Promise((resolve,reject) => {
    const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
      '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
      '--disable-sync','--disable-extensions','--disable-default-apps','--disable-domain-reliability','--metrics-recording-only',
      '--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--window-size=1200,800',
      '--user-data-dir='+profile,'--virtual-time-budget=10000','--dump-dom','http://127.0.0.1:'+server.address().port+'/',
    ],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
    const timer=setTimeout(()=>child.kill('SIGTERM'),25000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{
      clearTimeout(timer);
      const raw=stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
      if(code!==0||!raw){reject(Error(kind+' browser failed: '+stderr.slice(-1500)));return;}
      try{const result=JSON.parse(raw.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
        if(result.error)throw Error(kind+': '+result.error+' '+result.stack);
        resolve({result,profile});
      }catch(error){reject(error);}
    });
  });
}
server.listen(0,'127.0.0.1',async()=>{
  try{
    const original=await run('original'),production=await run('production');
    for(let index=0;index<original.result.steps.length;index++) {
      try { assert.deepEqual(production.result.steps[index],original.result.steps[index]); }
      catch { throw Error('Runtime mismatch at '+original.result.steps[index].label+'; '+
        JSON.stringify({original:original.result.steps[index],production:production.result.steps[index]}).slice(0,1800)); }
    }
    assert.equal(original.result.steps.length,8);
    console.log(JSON.stringify({checkpoints:8,completeOriginalScript:true,productionRuntime:true,packagedAsset:true,assetHash,
      vendorNetwork:false,realAccount:false,userAgent:original.result.userAgent,profiles:[original.profile,production.profile]}));
  }catch(error){console.error(error);process.exitCode=1;}
  finally{server.closeAllConnections();server.close();}
});
