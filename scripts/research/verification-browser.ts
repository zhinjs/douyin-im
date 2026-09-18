/** Isolated real-browser contract check. No account store, credentials or external requests. */
import { createServer } from 'node:http';
import { verificationXhrBridgeScript } from '../../src/sdk/auth/verification-xhr.js';

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Verification XHR contract</title></head>
<body><h1>Isolated verification XHR contract</h1><pre id="result">running</pre>
<script>window.__LOGIN_VERIFY__={sessionToken:'fixture'};${verificationXhrBridgeScript()}</script>
<script>
const results=[];
function check(value,message){if(!value)throw Error(message);}
function request(path,options={}){return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest(),states=[];
  const timer=setTimeout(()=>reject(Error('browser case deadline')),3000);
  xhr.onreadystatechange=()=>states.push(xhr.readyState);
  const end=event=>{clearTimeout(timer);resolve({xhr,event,states});};
  xhr.onload=()=>end('load');xhr.onerror=()=>end('error');xhr.onabort=()=>end('abort');xhr.ontimeout=()=>end('timeout');
  try{xhr.open(options.method||'GET',path);xhr.withCredentials=true;
    if(options.json)xhr.responseType='json';if(options.timeout)xhr.timeout=options.timeout;
    xhr.setRequestHeader('x-fixture','native-browser');xhr.send(options.body??null);
    if(options.abort)xhr.abort();
  }catch(error){clearTimeout(timer);reject(error);}
});}
async function test(name,action){try{await action();results.push({name,status:'PASS'});}catch(error){results.push({name,status:'FAIL',reason:error.message});}}
(async()=>{
 await test('native event handlers / response states',async()=>{const r=await request('/passport/fixture/');check(r.event==='load','event '+r.event);check(r.xhr.status===200,'status');check(r.states.join(',')==='1,2,3,4','states '+r.states);check(r.xhr.getResponseHeader('X-Fixture')==='yes','header');});
 await test('responseType=json / POST body',async()=>{const r=await request('/passport/fixture/',{method:'POST',body:'code=3437',json:true});check(r.xhr.response.body==='code=3437','JSON body');check(r.xhr.response.method==='POST','method');check(r.xhr.response.header==='native-browser','request header');});
 await test('business HTTP error is load, not network error',async()=>{const r=await request('/passport/fixture/?status=403');check(r.event==='load'&&r.xhr.status===403,'business HTTP semantics');});
 await test('abort ignores late result',async()=>{const r=await request('/passport/fixture/?delay=200',{abort:true});check(r.event==='abort','abort event');await new Promise(resolve=>setTimeout(resolve,250));check(r.xhr.readyState===0,'late abort state');});
 await test('timeout is distinct from network error',async()=>{const r=await request('/passport/fixture/?delay=200',{timeout:10});check(r.event==='timeout','timeout event '+r.event);});
 await test('unrelated request stays native',async()=>{const r=await request('/native-probe');check(r.event==='load'&&r.xhr.responseText==='native-response','native fallback');});
 document.getElementById('result').textContent=JSON.stringify({passed:results.filter(x=>x.status==='PASS').length,total:results.length,results},null,2);
})();
</script></body></html>`;

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
  }
  if (req.method === 'GET' && req.url === '/native-probe') { res.end('native-response'); return; }
  if (req.method !== 'POST' || req.url !== '/api/request?token=fixture') { res.writeHead(404); res.end(); return; }
  let raw = '';
  for await (const chunk of req) { raw += String(chunk); if (raw.length > 16384) { res.writeHead(413); res.end(); return; } }
  const payload = JSON.parse(raw) as { url: string; method: string; body?: string; headers?: Record<string, string> };
  const url = new URL(payload.url);
  if (url.origin !== 'https://imdesktop.douyin.com' || url.pathname !== '/passport/fixture/') { res.writeHead(403); res.end(); return; }
  const delay = Number(url.searchParams.get('delay') ?? 0);
  if (delay) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 250)));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: Number(url.searchParams.get('status') ?? 200), statusText: 'fixture',
    headers: { 'x-fixture': 'yes' }, rawText: JSON.stringify({ method: payload.method, body: payload.body, header: payload.headers?.['x-fixture'] }) }));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') console.log(`http://127.0.0.1:${address.port}/`);
});
const stop = () => { server.closeAllConnections(); server.close(); };
setTimeout(stop, 600_000).unref();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
