// Isolated Chromium observation, not Desktop/Electron equivalence or an account login.
// Source remains unchanged. CSP plus replaced network exits prevent vendor outbound requests.
const {readFileSync,mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const {createServer}=require('node:http');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {sign,inspectSignature}=require('./desktop-bdms7-signer.cjs');
const {BehaviorState}=require('./desktop-bdms7-behavior.cjs');
const {buildDesktopFingerprint}=require('./desktop-bdms7-fingerprint.cjs');
// Load the same production graph used by the shared runtime, including strict writes.
const browserModules=require('./desktop-browser-modules.cjs');
const environmentCode=`
  ${browserModules(['desktop-environment-mask','desktop-request-signer','desktop-behavior'])}
  const fixtureMaskModule=fixtureRequire('desktop-environment-mask');
  const fixtureRequestModule=fixtureRequire('desktop-request-signer');
  const fixtureBehaviorModule=fixtureRequire('desktop-behavior');
  const fixtureContext={
    window,navigator,document,location,history,Symbol,webpackGlobal:globalThis,Date,Math,
    PluginArray:typeof PluginArray==='undefined'?undefined:PluginArray,
    MSPluginsCollection:typeof MSPluginsCollection==='undefined'?undefined:MSPluginsCollection,
    process:typeof process==='undefined'?undefined:process,
  };
  const fixtureEnvironmentState=new fixtureMaskModule.DesktopEnvironmentState(fixtureContext);
  const fixtureRequestBehavior=new fixtureBehaviorModule.DesktopBehaviorState(performance.now());
  const fixtureRequestSigner=new fixtureRequestModule.DesktopRequestSigner(fixtureContext,
    {aid:339757,pageId:23420,track:{mode:0}},fixtureRequestBehavior);
`;
const eventPlan=[
  {type:'keydown',ts:100},{type:'keydown',ts:100},
  {type:'mousemove',ts:200,x:0,y:0},{type:'mousedown',ts:300,x:0,y:0},
  {type:'mousemove',ts:216,x:9999,y:0},{type:'mousemove',ts:340,x:1000,y:0},
  {type:'mousemove',ts:360,x:2000,y:0},{type:'mousemove',ts:380,x:2000,y:0},
  ...[400,401,402,403,404].map(ts=>({type:'keydown',ts})),
];
const source=readFileSync(process.argv[2],'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e');
assert(!/<\/script/i.test(source));
const bootstrap=`
  window.addEventListener('error',event=>{document.getElementById('result').textContent=JSON.stringify({fixtureError:event.message});});
  window.fixtureRequests=[];
  const opened=new WeakMap();
  const nativeOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url,...rest){opened.set(this,{method,url:String(url)});return nativeOpen.call(this,method,url,...rest);};
  XMLHttpRequest.prototype.send=function(body){fixtureRequests.push({...opened.get(this),body:typeof body==='string'?body:null});};
  window.fetch=()=>Promise.reject(new Error('offline fixture: fetch denied'));
  navigator.sendBeacon=()=>false;
  Math.random=()=>0.5;
  const NativeDate=Date;
  window.fixtureTick=0;
  window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[1789214400000+fixtureTick]));}static now(){return 1789214400000+fixtureTick;}};
`;
const exercise=`
  bdms.init({aid:339757,pageId:23420,paths:['/passport'],track:{mode:0}});
  ${environmentCode}
  const environmentMasks=[],productionSignatures=[];
  function sample(){const xhr=new XMLHttpRequest();xhr.open('POST','https://offline.invalid/passport/vector?q=a:b,$[x]~!%20()');xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded');xhr.send('text=offline');environmentMasks.push(fixtureEnvironmentState.mask());
    productionSignatures.push(fixtureRequestSigner.sign(new URLSearchParams('q=a:b,$[x]~!%20()').toString(),'text=offline'));}
  sample();
  for(const event of ${JSON.stringify(eventPlan)}) {
    fixtureTick=event.ts;
    document.dispatchEvent(event.type==='keydown'?new KeyboardEvent('keydown'):
      new MouseEvent(event.type,{clientX:event.x,clientY:event.y}));
    if(event.type==='keydown')fixtureRequestBehavior.recordKeydown(Date.now());
    else if(event.type==='mousemove')fixtureRequestBehavior.recordMove({ts:Date.now(),x:event.x,y:event.y});
    else fixtureRequestBehavior.recordClickStart({ts:Date.now(),x:event.x,y:event.y});
    sample();
  }
  document.getElementById('result').textContent=JSON.stringify({
    userAgent:navigator.userAgent,platform:navigator.platform,environmentMasks,productionSignatures,
    tags:[navigator,document,location,history].map(v=>Object.prototype.toString.call(v)),
    fingerprintContext:{window:{innerWidth,innerHeight,outerWidth,outerHeight,screenX,screenY,pageYOffset,
      screen:{availWidth:screen.availWidth,availHeight:screen.availHeight,width:screen.width,height:screen.height,
        colorDepth:screen.colorDepth,pixelDepth:screen.pixelDepth}},
      document:{body:{clientWidth:document.body.clientWidth,clientHeight:document.body.clientHeight}},
      navigator:{platform:navigator.platform}},
    requests:fixtureRequests.filter(r=>r.url.includes('/passport/vector'))
  });
`;
const html=`<!doctype html><meta charset="utf-8"><title>Offline BDMS state fixture</title><body><pre id="result"></pre><script>${bootstrap}</script><script>${source}</script><script>${exercise}</script></body>`;
const server=createServer((req,res)=>{
  if(req.url!=='/') {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; frame-src 'none'"});
  res.end(html);
});
server.listen(0,'127.0.0.1',()=>{
  const profile=mkdtempSync(join(tmpdir(),'douyin-bdms-offline-chrome-'));
  const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
    '--disable-sync','--disable-extensions','--disable-default-apps','--disable-domain-reliability','--metrics-recording-only',
    '--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--window-size=1200,800',
    '--user-data-dir='+profile,'--dump-dom','http://127.0.0.1:'+server.address().port+'/',
  ],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  chrome.stdout.on('data',data=>{stdout+=data;});
  chrome.stderr.on('data',data=>{stderr+=data;});
  const timer=setTimeout(()=>chrome.kill('SIGTERM'),20000);
  const finish=()=>{clearTimeout(timer);server.closeAllConnections();server.close();};
  chrome.on('error',error=>{finish();console.error(error.message);process.exitCode=1;});
  chrome.on('exit',code=>{
    finish();
    const result=stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
    if(code!==0||!result) {console.error('Chromium fixture failed',code,stderr.slice(-2000));process.exitCode=1;return;}
    const decoded=result.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
    const observation=JSON.parse(decoded);
    if(observation.fixtureError){console.error(observation.fixtureError);process.exitCode=1;return;}
    observation.fingerprint=buildDesktopFingerprint(observation.fingerprintContext);
    assert.equal(observation.requests.length,eventPlan.length+1);
    const behavior=new BehaviorState(),states=[];
    for(const [index,sent] of observation.requests.entries()) {
      if(index)behavior.accept(eventPlan[index-1]);
      const url=new URL(sent.url),signature=url.searchParams.get('a_bogus');assert(signature);
      assert.equal(signature,observation.productionSignatures[index],'full production request wrapper from actual bindings vs original XHR signature');
      const decodedState=inspectSignature(signature);
      assert.notEqual(decodedState.environmentMask,129,'real Chromium must reach a different environment branch than the minimal VM');
      assert.equal(decodedState.environmentMask,observation.environmentMasks[index],'production M from actual browser bindings vs original signed M');
      assert.equal(decodedState.behaviorMask,behavior.mask(),'independent event-state model vs original signed q at step '+index);
      url.searchParams.delete('a_bogus');
      assert.equal(sign({query:url.searchParams.toString(),body:sent.body,userAgent:observation.userAgent,
        aid:339757,pageId:23420,fingerprint:observation.fingerprint,random:()=>0.5,...decodedState,
        environmentMask:observation.environmentMasks[index],behaviorMask:behavior.mask()}),signature,'core round-trip with observed flag and independently computed M/q');
      states.push(decodedState);
    }
    delete observation.requests;
    delete observation.productionSignatures;
    observation.states=states;
    observation.passed=states.length;
    console.log(JSON.stringify(observation,null,2));
    console.log('Isolated temporary profile retained:',profile);
  });
});
