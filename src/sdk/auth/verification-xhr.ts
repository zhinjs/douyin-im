/** Browser-only bridge for official SecondVerify's direct reqwest/XHR calls.
 * No account credentials cross into this script. The backend owns Cookie/CSRF.
 */
export function verificationXhrBridgeScript(): string {
  return `(() => {
    const NativeXHR = window.XMLHttpRequest;
    if (!NativeXHR) return;
    const bridges = new WeakMap();
    const origin = 'https://imdesktop.douyin.com';
    class VerificationXHR extends NativeXHR {
      open(method, input, async = true, user, password) {
        const previous = bridges.get(this);
        if (previous) { previous.active = false; clearTimeout(previous.timer); previous.controller?.abort(); }
        const target = new URL(String(input), origin);
        const localPassport = /^\\/passport\\//.test(String(input));
        const desktopPassport = target.origin === origin && target.pathname.startsWith('/passport/');
        if (!desktopPassport || (!localPassport && !/^https:\\/\\//.test(String(input)))) {
          if (previous) throw new Error('Cannot reuse verification XHR for another origin');
          return super.open(method, input, async, user, password);
        }
        if (!async || user || password) throw new Error('Unsupported verification XHR mode');
        const state = { method:String(method).toUpperCase(), url:target.toString(), headers:{}, readyState:1,
          status:0, statusText:'', text:'', responseHeaders:{}, active:false, timer:undefined, controller:undefined };
        bridges.set(this, state);
        for (const key of ['readyState','status','statusText']) Object.defineProperty(this,key,{configurable:true,get:()=>bridges.get(this)[key]});
        Object.defineProperty(this,'responseText',{configurable:true,get:()=>bridges.get(this).text});
        Object.defineProperty(this,'responseURL',{configurable:true,get:()=>bridges.get(this).url});
        Object.defineProperty(this,'response',{configurable:true,get:()=>{
          const current = bridges.get(this);
          if (this.responseType === 'json') { try { return JSON.parse(current.text); } catch { return null; } }
          return current.text;
        }});
        this.dispatchEvent(new Event('readystatechange'));
      }
      setRequestHeader(key, value) {
        const state = bridges.get(this);
        if (!state) return super.setRequestHeader(key, value);
        if (state.readyState !== 1 || state.active) throw new Error('Invalid verification XHR state');
        const name = String(key).toLowerCase();
        state.headers[name] = state.headers[name] ? state.headers[name] + ', ' + value : String(value);
      }
      getResponseHeader(key) {
        const state = bridges.get(this);
        if (!state) return super.getResponseHeader(key);
        return state.readyState < 2 ? null : state.responseHeaders[String(key).toLowerCase()] ?? null;
      }
      getAllResponseHeaders() {
        const state = bridges.get(this);
        if (!state) return super.getAllResponseHeaders();
        return Object.entries(state.responseHeaders).map(([k,v])=>k+': '+v).join('\\r\\n');
      }
      send(body = null) {
        const state = bridges.get(this);
        if (!state) return super.send(body);
        if (state.readyState !== 1 || state.active) throw new Error('Invalid verification XHR state');
        if (body !== null && typeof body !== 'string' && !(body instanceof URLSearchParams)) throw new Error('Unsupported verification body');
        state.controller = new AbortController(); state.active = true;
        const finish = event => {
          if (!state.active) return;
          state.active = false; clearTimeout(state.timer); state.readyState = 4;
          this.dispatchEvent(new Event('readystatechange'));
          this.dispatchEvent(new Event(event)); this.dispatchEvent(new Event('loadend'));
        };
        state.finish = finish;
        if (this.timeout > 0) state.timer = setTimeout(()=>{state.controller.abort();finish('timeout');},this.timeout);
        this.dispatchEvent(new Event('loadstart'));
        fetch('/api/request?token=' + encodeURIComponent(window.__LOGIN_VERIFY__.sessionToken), {
          method:'POST',headers:{'content-type':'application/json'},signal:state.controller.signal,
          body:JSON.stringify({url:state.url,method:state.method,headers:state.headers,pipeline:'xhr',...(body === null ? {} : {body:String(body)})})
        }).then(async response=>{
          const result = await response.json();
          if (!state.active) return;
          if (!response.ok || result.error) { finish('error'); return; }
          state.status = result.status; state.statusText = result.statusText;
          state.responseHeaders = Object.fromEntries(Object.entries(result.headers || {}).map(([k,v])=>[k.toLowerCase(),v]));
          state.readyState = 2; this.dispatchEvent(new Event('readystatechange'));
          if (!state.active) return;
          state.text = result.rawText ?? JSON.stringify(result.data);
          state.readyState = 3; this.dispatchEvent(new Event('readystatechange'));
          finish('load');
        }).catch(()=>finish('error'));
      }
      abort() {
        const state = bridges.get(this);
        if (!state) return super.abort();
        state.controller?.abort(); state.finish?.('abort'); state.readyState = 0;
      }
    }
    window.XMLHttpRequest = VerificationXHR;
  })();`;
}
