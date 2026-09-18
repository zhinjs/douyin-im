import { spawn } from 'node:child_process';
import { ActionVerification } from './action-verification.js';
import { verificationXhrBridgeScript } from './verification-xhr.js';
import { createVerificationRequests } from './verification-request.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ApiConnection } from '../../desktop/api-connection.js';
import { DESKTOP_APP_VERSION } from '../../desktop/constants.js';
import type { QrMfaChallenge } from '../../desktop/types.js';
import type {
  LoginVerification,
  OpenLoginVerificationOptions,
} from './login-verification.js';

const require = createRequire(import.meta.url);
const VERIFY_CENTER_SDK =
  'https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/@latest/index.js';
const VERIFY_CENTER_SDK_BACKUPS = [
  'https://lf-rc2.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/@latest/index.js',
  'https://lf-cdn-tos.bytescm.com/obj/rc-verifycenter/verifycenter/@latest/index.js',
] as const;

export interface BrowserLoginVerificationContext {
  connection: ApiConnection;
  qrMfa?: {
    challenge: QrMfaChallenge;
    resumeFields: Readonly<Record<string, unknown>>;
  };
}

/** @internal */
export async function openBrowserVerification(
  verification: LoginVerification | ActionVerification,
  context: BrowserLoginVerificationContext,
  options: OpenLoginVerificationOptions
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs 必须是正整数');
  }

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let server: Server | undefined;
    const active = new Map<IncomingMessage, { response: ServerResponse; state: RequestContext }>();
    const sessionToken = randomUUID();
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      verification.signal.removeEventListener('abort', onSettled);
      // A partial request body or hung proxy must not keep the old host alive.
      // Let the route submitting complete/cancel flush its own response.
      for (const [request, { response, state }] of active) {
        if (!state.settling && !response.writableEnded) {
          response.destroy();
          request.destroy();
        }
      }
      const settle = () => error ? reject(error) : resolve();
      if (server) server.close(settle);
      else settle();
    };
    const onSettled = () => finish(verification.signal.reason == null ? undefined : asError(verification.signal.reason));
    const timer = setTimeout(() => {
      verification.cancel('安全验证超时');
      finish(new Error('安全验证超时'));
    }, timeoutMs);
    timer.unref();
    verification.signal.addEventListener('abort', onSettled, { once: true });
    if (verification.signal.aborted) { onSettled(); return; }

    const start = async () => {
      const react = await readFile(resolveReactAsset('react', 'react.production.min.js'), { signal: verification.signal });
      const reactDom = await readFile(resolveReactAsset('react-dom', 'react-dom.production.min.js'), { signal: verification.signal });
      verification.signal.throwIfAborted();
      const prepared = context.qrMfa ? undefined : await preparePlatformVerification(verification, context.connection);
      // Preparation can finish after logout, including transports ignoring abort.
      if (finished) return;
      if (prepared && !(verification instanceof ActionVerification)) {
        process.stderr.write(`[login] 验证分流: mode=${prepared.mode} source=${verification.source} operation=${verification.operation} errorCode=${diagnosticCode(verification.errorCode)} decisionCode=${diagnosticCode(prepared.config['code'])}\n`);
      }
      server = createServer((request, response) => {
        response.setHeader('Connection', 'close');
        const requestLifetime = new AbortController();
        const signal = AbortSignal.any([verification.signal, requestLifetime.signal]);
        const state: RequestContext = { verification, context, prepared, react, reactDom, sessionToken, finish, settling: false, signal };
        active.set(request, { response, state });
        response.once('close', () => {
          active.delete(request);
          if (!response.writableEnded) requestLifetime.abort(new Error('验证页面请求已断开'));
        });
        void handleRequest(request, response, state).catch((error: unknown) => {
          if (!response.destroyed && !response.writableEnded) sendJson(response, 500, { error: asError(error).message });
        });
      });
      server.once('error', error => finish(error));
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        if (finished) { server!.close(); return; }
        const address = server!.address();
        if (typeof address !== 'object' || address === null) {
          finish(new Error('无法取得登录验证页地址'));
          return;
        }
        const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(sessionToken)}`;
        process.stderr.write(`[${verification instanceof ActionVerification ? 'action' : 'login'}] 浏览器打开: ${url}\n`);
        if (options.openBrowser !== false) openSystemBrowser(url);
      });
    };
    void start().catch(error => finish(asError(error)));
  });
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

interface PreparedPlatformVerification {
  mode: 'verify-center' | 'second-verify' | 'business-captcha';
  business?: boolean;
  rawChallenge?: string;
  config: Record<string, unknown>;
  fp: string;
  deviceId: string;
  installId: string;
  captchaScriptUrls?: readonly string[];
  scriptUrl?: string;
  verifyPortraitId?: unknown;
  verificationFun?: 'verify_center' | 'verify';
}

// Do not log raw decision/error descriptions, URLs, tickets or arbitrary values.
function diagnosticCode(value: unknown): string {
  if (value == null) return 'missing';
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^\d{1,6}$/.test(text) ? text : 'unrecognized';
}

async function preparePlatformVerification(
  verification: LoginVerification | ActionVerification,
  connection: ApiConnection
): Promise<PreparedPlatformVerification> {
  const decision = { ...verification.decision };
  let config = { ...decision };
  const verifyFrom = decision['verify_from'];
  const business = verification instanceof ActionVerification;
  // Desktop Account SDK ($u.show / ll.show) sends every login decision to the
  // official dispatcher. Its internal code switch is not a host-side allowlist.
  // Native business Passport decisions use the separate Second Verify path.
  const verifyCenter = !business || verification.source === 'bdturing';
  if (!verifyCenter && verifyFrom === 'verify_center') {
    config = { ...config, ...(await connection.packActionVerification(config, verification.signal)) };
  }
  const fp = createVerificationFingerprint(connection.getDeviceId());
  const rawUrl = typeof config['url'] === 'string' ? config['url'] : undefined;
  // Preserve the full decision; do not infer its renderer from method names or
  // require the login response to supply an executable script URL.
  if (verifyCenter) {
    const setting = await loadVerifyCenterSetting(connection, verification.signal);
    const configuredPrimary = asRecord(setting?.['js_v2'])?.['cn'];
    const configuredBackups = asRecord(setting?.['back_up_js_v2'])?.['cn'];
    const urls = [
      ...(typeof configuredPrimary === 'string' ? [configuredPrimary] : []),
      ...(Array.isArray(configuredBackups)
        ? configuredBackups.filter((value): value is string => typeof value === 'string')
        : []),
      VERIFY_CENTER_SDK,
      ...VERIFY_CENTER_SDK_BACKUPS,
    ];
    if (setting) {
      config['scene_level'] = setting['scene_level'] ?? 'p2';
    }
    return {
      mode: business ? 'business-captcha' : 'verify-center',
      business,
      ...(business ? { rawChallenge: verification.raw } : {}),
      config,
      fp,
      deviceId: connection.getDeviceId(),
      installId: connection.getInstallId(),
      captchaScriptUrls: [...new Set(urls)],
    };
  }
  if (!rawUrl) {
    // Desktop's runtime may return a verify-center decision for some legacy
    // second-verify codepaths without a concrete script URL. Fall back to the
    // dispatcher-hosted verify-center instead of aborting the login flow.
    const setting = await loadVerifyCenterSetting(connection, verification.signal);
    const configuredPrimary = asRecord(setting?.['js_v2'])?.['cn'];
    const configuredBackups = asRecord(setting?.['back_up_js_v2'])?.['cn'];
    const urls = [
      ...(typeof configuredPrimary === 'string' ? [configuredPrimary] : []),
      ...(Array.isArray(configuredBackups)
        ? configuredBackups.filter((value): value is string => typeof value === 'string')
        : []),
      VERIFY_CENTER_SDK,
      ...VERIFY_CENTER_SDK_BACKUPS,
    ];
    if (setting) {
      config['scene_level'] = setting['scene_level'] ?? 'p2';
    }
    return {
      mode: 'verify-center',
      business,
      config,
      fp,
      deviceId: connection.getDeviceId(),
      installId: connection.getInstallId(),
      captchaScriptUrls: [...new Set(urls)],
    };
  }
  const protocol = new URL(rawUrl).protocol;
  if (protocol !== 'https:') {
    throw new Error(`平台下发了不安全的登录验证脚本: ${protocol}`);
  }
  const eventParams = asRecord(config['event_params']);
  // C955 SecondVerify passes this exact concatenation to the script loader.
  // Parsing is only for the HTTPS guard: URLSearchParams would rewrite supplied
  // query values, replace an existing aid and change falsy/event value coercion.
  const scriptUrl = rawUrl + '?aid=339757&verify_reason='
    + String(eventParams?.['verify_reason'] || '')
    + '&verify_scene=' + String(eventParams?.['verify_scene'] || '');
  return {
    mode: 'second-verify',
    business,
    config,
    fp,
    deviceId: connection.getDeviceId(),
    installId: connection.getInstallId(),
    scriptUrl,
    verifyPortraitId: decision['verify_portrait_id'] || '',
    verificationFun: verifyFrom === 'verify_center' ? 'verify_center' : 'verify',
  };
}

async function loadVerifyCenterSetting(
  connection: ApiConnection,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  try {
    const query = new URLSearchParams({
      aid: '339757',
      did: connection.getDeviceId() || '0',
      iid: connection.getInstallId(),
    });
    const response = await connection.requestVerificationRaw(
      `https://vcs.zijieapi.com/vc/setting?${query}`,
      { method: 'GET', headers: { 'X-Setting-Flag': '1' }, signal },
    );
    if (!response.ok) return undefined;
    const parsed = asRecord(tryParseJson(response.rawText));
    const data = asRecord(parsed?.['data']) ?? parsed;
    return asRecord(data?.['verify']);
  } catch {
    return undefined;
  }
}

interface RequestContext {
  verification: LoginVerification | ActionVerification;
  context: BrowserLoginVerificationContext;
  prepared: PreparedPlatformVerification | undefined;
  react: Buffer;
  reactDom: Buffer;
  sessionToken: string;
  finish: (error?: Error) => void;
  settling: boolean;
  signal: AbortSignal;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: RequestContext
): Promise<void> {
  state.signal.throwIfAborted();
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.searchParams.get('token') !== state.sessionToken) {
    sendJson(response, 403, { error: '登录验证会话无效' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/') {
    sendHtml(
      response,
      state.context.qrMfa
        ? qrMfaHtml(state.verification as LoginVerification, state.sessionToken)
        : platformVerificationHtml(
            state.verification,
            state.prepared!,
            state.sessionToken
          )
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/react.js') {
    sendScript(response, state.react);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/react-dom.js') {
    sendScript(response, state.reactDom);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/request') {
    const payload = await readJsonBody(request);
    state.signal.throwIfAborted();
    const pipeline = payload['pipeline'];
    if (pipeline !== undefined && pipeline !== 'raw' && pipeline !== 'fetch' && pipeline !== 'fetchSec' && pipeline !== 'xhr') throw new Error('未知验证请求管线');
    const target = resolveVerificationUrl(payload['url'], payload['baseURL']);
    assertVerificationHost(target);
    if (target.origin === 'https://imdesktop.douyin.com'
      && !target.pathname.startsWith('/passport/') && target.pathname !== '/service/settings/v3/') {
      throw new Error('验证页面拒绝代理非验证接口');
    }
    const method = String(payload['method'] ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
      throw new Error(`登录验证不支持请求方法: ${method}`);
    }
    const headers = sanitizeProxyHeaders(asStringRecord(payload['headers']));
    const body = decodeProxyBody(payload);
    const result = await state.context.connection.requestVerificationRaw(
      target.toString(),
      {
        method,
        headers,
        signal: state.signal,
        ...(body !== undefined && method !== 'GET' && method !== 'HEAD'
          ? { body }
          : {}),
      },
      state.verification instanceof ActionVerification ? 'action' : 'login',
      pipeline,
    );
    state.signal.throwIfAborted();
    sendJson(response, 200, {
      data: tryParseJson(result.rawText),
      rawText: result.rawText,
      status: result.status,
      statusText: result.ok ? 'OK' : 'ERROR',
      headers: Object.fromEntries(
        // The owning connection already consumed these headers. server-data can
        // contain a Session ticket; never expose account guard state to scripts
        // in the manual page. Keep business challenge headers and body intact.
        [...result.headers.entries()].filter(([key]) => {
          const name = key.toLowerCase();
          return name !== 'set-cookie' && !name.startsWith('bd-ticket-guard-');
        }),
      ),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/send-code') {
    const qr = requiredQrMfa(state.context);
    const result = await state.context.connection.sendQrMfaCode(qr.challenge, state.signal);
    state.signal.throwIfAborted();
    if (!passportSucceeded(result)) {
      throw new Error(`发送扫码验证短信失败: ${passportFailure(result)}`);
    }
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/submit-code') {
    const qr = requiredQrMfa(state.context);
    const payload = await readJsonBody(request);
    state.signal.throwIfAborted();
    const code = String(payload['code'] ?? '').trim();
    if (!/^\d{4,8}$/.test(code)) throw new Error('验证码格式不正确');
    const result = await state.context.connection.validateQrMfaCode(
      qr.challenge,
      code,
      state.signal,
    );
    state.signal.throwIfAborted();
    if (!passportSucceeded(result) || !result.data['ticket']) {
      throw new Error(`扫码验证失败: ${passportFailure(result)}`);
    }
    if (state.verification instanceof ActionVerification) throw new Error('业务验证不能提交扫码登录验证码');
    state.settling = true;
    await state.verification.complete({ fields: qr.resumeFields });
    sendJson(response, 200, { ok: true });
    state.finish();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/complete') {
    const payload = await readJsonBody(request);
    state.signal.throwIfAborted();
    const resultValue = asRecord(payload['result']);
    const fields = asRecord(resultValue?.['fields'] ?? resultValue);
    const fp = resultValue?.['fp'];
    if (fp !== undefined && typeof fp !== 'string') throw new Error('验证指纹必须是字符串');
    state.settling = true;
    if (state.verification instanceof ActionVerification) {
      await state.verification.complete({ status: resultValue?.['status'] === true });
    } else await state.verification.complete({
      ...(fp ? { fp } : {}),
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
    });
    sendJson(response, 200, { ok: true });
    state.finish();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/cancel') {
    state.settling = true;
    state.verification.cancel('用户关闭了安全验证');
    sendJson(response, 200, { ok: true });
    state.finish(new Error('用户关闭了安全验证'));
    return;
  }
  response.writeHead(404);
  response.end('Not Found');
}

function platformVerificationHtml(
  verification: LoginVerification | ActionVerification,
  prepared: PreparedPlatformVerification,
  sessionToken: string
): string {
  const boot = safeJson({
    mode: prepared.mode,
    business: prepared.business ?? false,
    rawChallenge: prepared.rawChallenge,
    config: prepared.config,
    fp: prepared.fp,
    scriptUrl: prepared.scriptUrl,
    verifyPortraitId: prepared.verifyPortraitId,
    verificationFun: prepared.verificationFun,
    verificationId: verification.id,
    sessionToken,
    deviceId: prepared.deviceId,
    installId: prepared.installId,
    reactUrl: `/react.js?token=${encodeURIComponent(sessionToken)}`,
    reactDomUrl: `/react-dom.js?token=${encodeURIComponent(sessionToken)}`,
    captchaScriptUrls: prepared.captchaScriptUrls,
  });
  return pageShell(
    verification instanceof ActionVerification ? '抖音业务安全验证' : '抖音登录安全验证',
    `
    <div id="verification-status"><div class="loading">正在加载抖音安全验证…</div></div>
    <div id="app"></div>
    <script>window.__LOGIN_VERIFY__=${boot};</script>
    <script>${browserBridgeScript()}</script>
    <script>window.startDouyinVerification();</script>
  `
  );
}

function qrMfaHtml(
  verification: LoginVerification,
  sessionToken: string
): string {
  const token = safeJson(sessionToken);
  return pageShell(
    '手机短信验证',
    `
    <main class="card">
      <h1>手机短信验证</h1>
      <p>${escapeHtml(verification.description ?? '扫码登录需要验证绑定手机号')}</p>
      <button id="send">发送验证码</button>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="请输入验证码" />
      <button id="submit">验证并继续登录</button>
      <p id="status"></p>
    </main>
    <script>
      const sessionToken = ${token};
      const status = document.getElementById('status');
      const request = async (path, body = {}) => {
        const response = await fetch(path + '?token=' + encodeURIComponent(sessionToken), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || '请求失败');
        return data;
      };
      document.getElementById('send').onclick = async () => {
        try { const data = await request('/api/send-code'); status.textContent = data.data?.mobile ? '验证码已发送至 ' + data.data.mobile : '验证码已发送'; }
        catch (error) { status.textContent = error.message; }
      };
      document.getElementById('submit').onclick = async () => {
        try { status.textContent = '验证中…'; await request('/api/submit-code', {code: document.getElementById('code').value}); status.textContent = '验证通过，可以关闭此页'; }
        catch (error) { status.textContent = error.message; }
      };
    </script>
  `
  );
}

function browserBridgeScript(): string {
  return String.raw`
    (() => {
      const boot = window.__LOGIN_VERIFY__;
      let stage = '加载本地依赖';
      let completing = false;
      let verified = false;
      let failed = false;
      let renderTimer;
      const fail = () => {
        if (verified) return;
        failed = true;
        clearTimeout(renderTimer);
        const app = document.getElementById('verification-status');
        if (completing) {
          app.innerHTML = '<main class="card"><h1>尚未确认结果</h1><p>验证结果已提交，但未取得完整响应。请查看终端状态，不要重复提交验证码或重复执行原操作。</p></main>';
          return;
        }
        app.innerHTML = '<main class="card"><h1>安全验证未能完成</h1><p id="verify-error"></p><p>请检查网络连接和浏览器拦截设置，保持终端程序运行后重试。若验证已取消或失效，请从终端重新发起。</p><button id="verify-retry">重新加载验证页</button></main>';
        // Only show our stage label, never an exception URL containing challenge tokens.
        document.getElementById('verify-error').textContent = stage + '失败或超时。';
        document.getElementById('verify-retry').onclick = () => location.reload();
      };
      window.addEventListener('error', fail);
      window.addEventListener('unhandledrejection', fail);
      try { localStorage.setItem('s_v_web_id', boot.fp); } catch (_) { /* Storage can be disabled. */ }
      try { document.cookie = 's_v_web_id=' + encodeURIComponent(boot.fp) + '; path=/'; } catch (_) { /* Optional browser copy. */ }
      const bounded = (promise, milliseconds) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('verification timeout')), milliseconds);
        Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
      });
      const complete = async (result = {}) => {
        if (completing) return;
        completing = true;
        clearTimeout(renderTimer);
        stage = boot.business ? '提交验证结果并恢复操作' : '提交验证结果并恢复登录';
        try {
          await bounded((async () => {
            const response = await fetch('/api/complete?token=' + encodeURIComponent(boot.sessionToken), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({result})});
            const data = await response.json();
            if (!response.ok || data.error) throw new Error('resume failed');
          })(), 30000);
          verified = true;
          document.getElementById('verification-status').innerHTML = '<main class="card"><h1>验证通过</h1><p>' + (boot.business ? '正在继续原操作，请在终端查看操作结果。' : '正在继续登录，可以关闭此页。') + '</p></main>';
        } catch (_) { fail(); }
      };
      let secureInit;
      const getSecureFp = () => {
        const cookie = document.cookie.match(/(?:^|;\s*)s_v_web_id=([^;]*)/);
        if (cookie?.[1]) { try { return decodeURIComponent(cookie[1]); } catch (_) {} }
        try { const stored = localStorage.getItem('s_v_web_id'); if (stored) return stored; } catch (_) {}
        const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        const chars = []; chars[8] = chars[13] = chars[18] = chars[23] = '_'; chars[14] = '4';
        for (let index = 0; index < 36; index++) if (!chars[index]) {
          const random = Math.floor(Math.random() * alphabet.length);
          chars[index] = alphabet[index === 19 ? (random & 3) | 8 : random];
        }
        return 'verify_' + Date.now().toString(36) + '_' + chars.join('');
      };
      const requests = (${createVerificationRequests.toString()})({
        origin:'https://imdesktop.douyin.com',
        query:() => Object.fromEntries(new URLSearchParams(location.search)),
        initializeVerification: info => {
          secureInit ??= (async () => {
            if (!window.verifySDK) await loadScript(boot.captchaScriptUrls || ${JSON.stringify([VERIFY_CENTER_SDK, ...VERIFY_CENTER_SDK_BACKUPS])}, () => !!window.verifySDK);
            await window.verifySDK.initVerifyOptions({commonOptions:{aid:Number(info.aid) || 0,did:String(info.did || '0'),iid:String(info.iid || '0')},
              captchaOptions:{sideSlide:'disabled',lang:info.locale || window.navigator?.language || 'zh',showMode:'mask',region:'cn',app_name:info.app_name || '',h5_check_version:'4.0.5'}});
          })();
          // Source starts wrapper loading before dispatch, without awaiting UI.
          secureInit.catch(() => {});
        },
        transport: async ({url,method,headers,body,timeout}, pipeline) => {
          // Official SV's logged-in pack derives this host from window.location.
          // A loopback manual page represents Desktop, not an HTTPS loopback service.
          const target = new URL(url);
          if (target.protocol === 'https:' && !target.port && target.hostname === location.hostname &&
              target.pathname === '/passport/safe/pack_verify_ways_data/') target.hostname = 'imdesktop.douyin.com';
          let wireBody = body == null ? undefined : String(body);
          let bodyBase64;
          const multipart = body instanceof FormData;
          if (multipart || (typeof Blob !== 'undefined' && body instanceof Blob) ||
              body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
            const binary = new Response(body);
            const bytes = new Uint8Array(await binary.arrayBuffer());
            let encoded = '';
            for (let index = 0; index < bytes.length; index += 32768) encoded += String.fromCharCode(...bytes.subarray(index,index + 32768));
            bodyBase64 = btoa(encoded);
            wireBody = undefined;
            headers = {...headers};
            if (multipart) for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
            const contentType = binary.headers.get('content-type');
            if (contentType && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = contentType;
          }
          const controller = new AbortController();
          const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined;
          try {
            const response = await fetch('/api/request?token=' + encodeURIComponent(boot.sessionToken), {method:'POST',signal:controller.signal,
              headers:{'content-type':'application/json'},body:JSON.stringify({url:target.toString(),method,headers,body:wireBody,bodyBase64,pipeline})});
            const result = await response.json();
            if (!response.ok || result.error) throw result;
            return result;
          } catch (error) {
            if (controller.signal.aborted) throw {data:{message:'verification request timeout'},status:-998};
            throw error;
          } finally { clearTimeout(timer); }
        },
        verify: async challenge => {
          await secureInit;
          return new Promise((resolve,reject) => {
            let decided = false;
            let decision = {};
            try { decision = JSON.parse(challenge.verifyData); } catch (_) {}
            const close = () => { if (!decided) { decided = true; reject({...challenge.responseContext,errorHandled:true}); } };
            const resume = kind => {
              if (decided) return;
              decided = true;
              Promise.resolve().then(() => challenge.retry(kind,kind === 'captcha' ? getSecureFp() : undefined)).then(resolve,reject);
            };
            Promise.resolve(window.verifySDK.autoRender({verify_data:decision,captchaOptions:{successCb:()=>resume('captcha'),closeCb:close},
              secondVerifyWebOptions:{callBack:()=>resume('secondary'),closeCallBack:close}})).catch(reject);
          });
        },
      });
      const proxy = requests.request;
      window.$$UCALL_APIMAP = window.$$UCALL_APIMAP || {};
      window.$$UCALL_APIMAP['Request.fetch'] = requests.fetch;
      window.$$UCALL_APIMAP['Request.fetchSec'] = requests.fetchSec;
      window.$$UCALL_APIMAP.Request = requests.request;
      window.$$UC_CORE_ENV = {env:'online',container:'web',region:'CN'};
      window.$$UC_ENV_PROMISE = Promise.resolve(window.$$UC_CORE_ENV);
      window.$$UCALL_APIMAP.getEnv = () => window.$$UC_ENV_PROMISE;
      window.$$UCALL_APIMAP.getQuery = () => Object.fromEntries(new URLSearchParams(location.search));
      window.$$UCALL_APIMAP.getSettings = (params) => proxy({url:'/service/settings/v3/',params});
      const loadScript = (urls, ready) => new Promise((resolve, reject) => {
        const remaining = [...urls];
        const next = () => {
          const url = remaining.shift();
          if (!url) return reject(new Error('抖音验证 SDK 加载失败'));
          const script = document.createElement('script');
          let settled = false;
          const finish = (loaded) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            script.onload = script.onerror = null;
            if (loaded && ready()) resolve();
            else { script.remove(); next(); }
          };
          const timer = setTimeout(() => finish(false), 4000);
          script.crossOrigin = 'anonymous';
          script.src = url;
          script.onload = () => finish(true);
          script.onerror = () => finish(false);
          document.head.appendChild(script);
        };
        next();
      });
      // Desktop does not await user completion from render APIs. Observe rejection
      // without imposing a short startup deadline on an interactive challenge.
      const observeRender = (result) => Promise.resolve(result).catch(fail);
      const watchRender = () => {
        // Watch for UI, not resolution of the interactive verification Promise.
        // Ignore this page's own status/retry controls and zero-sized mounts.
        let remaining = 60;
        const check = () => {
          if (failed || completing) return;
          const rendered = [...document.querySelectorAll('iframe,input,button,[role="dialog"]')].some(element => {
            if (element.closest('#verification-status')) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          });
          if (rendered) {
            document.getElementById('verification-status').innerHTML = '<main class="card"><h1>请完成安全验证</h1><p>请在下方或弹出的平台界面完成验证。若界面异常，可重新加载此页重试。</p><button onclick="location.reload()">重新加载验证页</button></main>';
          } else if (--remaining <= 0) {
            stage = '显示平台验证界面';
            fail();
          } else renderTimer = setTimeout(check, 250);
        };
        document.getElementById('verification-status').innerHTML = '<div class="loading">正在等待平台显示验证界面…</div>';
        check();
      };
      window.startDouyinVerification = async () => {
        try {
        ${verificationXhrBridgeScript()}
        if (!window.React) await loadScript([boot.reactUrl], () => !!window.React);
        if (!window.ReactDOM) await loadScript([boot.reactDomUrl], () => !!window.ReactDOM);
        window.ucSecondVerifyReact = window.React;
        window.ucSecondVerifyReactDom = window.ReactDOM;
        stage = '加载平台验证脚本';
        const common = {aid:339757,did:boot.deviceId || '0',iid:boot.installId || '0',...(boot.config.scene_level ? {scene_level:boot.config.scene_level} : {})};
        if (boot.mode === 'business-captcha') {
          await loadScript(boot.captchaScriptUrls || [], () => typeof window.verifySDK?.initVerifyCenter === 'function');
          stage = '初始化业务验证码组件';
          const capture = window.verifySDK.initVerifyCenter({commonOptions:{aid:339757,did:common.did,iid:'0'},captchaOptions:{fp:boot.fp,showMode:'mask',successCb:()=>{}}});
          capture.onsuccess = () => complete({status:true});
          capture.onclose = () => { clearTimeout(renderTimer); return fetch('/api/cancel?token=' + encodeURIComponent(boot.sessionToken),{method:'POST'}); };
          observeRender(capture.render(boot.rawChallenge));
        } else if (boot.mode === 'verify-center') {
          await loadScript(boot.captchaScriptUrls || [], () => !!window.verifySDK);
          stage = '初始化验证码组件';
          const sdk = window.verifySDK;
          if (!sdk) throw new Error('抖音验证码 SDK 加载失败');
          // LOGIN getAccountConfig -> C321 $u.init -> Ba.get. This wrapper's
          // version/options differ from fetchSec (C955) and business capture.
          observeRender(sdk.initVerifyOptions({commonOptions:{repoId:579047,...common},captchaOptions:{sideSlide:'disabled',host:'',fp:boot.fp,app_name:'抖音聊天',lang:'zh',showMode:'mask',region:'cn',baseEM:70,h5_check_version:'4.0.12'}}));
          // C321 $u.show -> Uu/Hu reads the initialized wrapper's fp. The
          // remote getCaptchaWebId is a different, Promise-returning API.
          const success = () => complete({fp:boot.fp || getSecureFp()});
          const close = () => { clearTimeout(renderTimer); return fetch('/api/cancel?token=' + encodeURIComponent(boot.sessionToken),{method:'POST'}); };
          observeRender(sdk.autoRender({verify_data:boot.config,captchaOptions:{successCb:success,closeCb:close,errorCb:fail},secondVerifyWebOptions:{scene:'4',callBack:()=>complete({}),closeCallBack:close}}));
        } else {
        // AccountSDK assigns the original portrait before loading the remote
        // script; pack may replace config fields but does not own this global.
        window.$$account_verify_portrait_id = boot.verifyPortraitId || '';
        await loadScript([boot.scriptUrl], () => typeof window.ucWebSecondVerify === 'function');
        stage = '初始化二次验证组件';
        if (typeof window.ucWebSecondVerify !== 'function') throw new Error('抖音二次验证 SDK 加载失败');
        const callback = result => {
          if (!result || !result.status) { stage = '平台二次验证'; fail(); return; }
          return complete(boot.business ? {status:true} : {});
        };
        const deviceParams = {device_id:common.did,iid:common.iid,device_platform:${JSON.stringify(process.platform)},version_code:${JSON.stringify(DESKTOP_APP_VERSION)}};
        const generalParams = boot.business ? deviceParams : {is_new_login:'1',is_from_iesaccountsaas:1};
        const monitorTime = {startTime:Date.now(),fetchEndTime:Date.now(),scriptLoadStartTime:0,scriptLoadEndTime:Date.now(),renderStartTime:Date.now()};
        const initOptions = {aid:339757,appName:'抖音聊天',did:common.did,iid:common.iid,host:'https://sso.douyin.com',newSecondVerifyRequestHost:'https://imdesktop.douyin.com',newSecondVerifyWebOptions:deviceParams,isNewVerifyUI:true,isBoe:false,printLog:false,region:'cn',hcSwitch:false,isOversea:false,ztsdk:false,ztsdkOptions:{agid:1,enableCookieOptions:false},ssoZtsdkOptions:{enable:false},captchaOptions:{fp:boot.fp,baseEM:70},commonOptions:common,generalParams};
        // Source merges initProps then packed decision. Only local executable
        // callbacks/transport remain host-owned; JSON cannot replace functions.
        observeRender(window.ucWebSecondVerify({...initOptions,...boot.config,monitorTime,uc_account_verify_version:'1.0.29',fun:boot.verificationFun || 'verify',Request:proxy,request:proxy,verifyFinishCallback:callback,callBack:callback,closeCallBack:()=>fetch('/api/cancel?token=' + encodeURIComponent(boot.sessionToken),{method:'POST'})}));
        }
        if (!completing && !failed) watchRender();
        } catch (_) { fail(); }
      };
    })();
  `;
}

function pageShell(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f5f5;color:#161823;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center}.card{width:min(420px,calc(100vw - 32px));background:white;border-radius:16px;padding:28px;box-shadow:0 12px 48px #0001}.card h1{font-size:22px;margin:0 0 12px}.card p,.loading{color:#666}button,input{width:100%;height:44px;border-radius:8px;margin-top:12px;font:inherit}button{border:0;background:#fe2c55;color:white;font-weight:600;cursor:pointer}input{border:1px solid #ddd;padding:0 12px}#app{min-width:min(420px,calc(100vw - 32px))}
  </style></head><body>${body}</body></html>`;
}

function resolveReactAsset(
  packageName: 'react' | 'react-dom',
  file: string
): string {
  const packagePath = require.resolve(`${packageName}/package.json`);
  // Package resolution returns a filesystem path, not an escaped file URL.
  // Keep literal #/% characters and the host platform's path semantics intact.
  return join(dirname(packagePath), 'umd', file);
}

function openSystemBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : { file: 'xdg-open', args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', () => undefined);
  child.unref();
}

function resolveVerificationUrl(urlValue: unknown, baseValue: unknown): URL {
  const url = String(urlValue ?? '');
  const base = String(baseValue ?? 'https://imdesktop.douyin.com');
  return new URL(url, base);
}

function assertVerificationHost(url: URL): void {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('验证代理仅允许标准 HTTPS 地址');
  const host = url.hostname.toLowerCase();
  if (
    host === 'imdesktop.douyin.com' ||
    host === 'verify.zijieapi.com' ||
    host === 'vcs.zijieapi.com'
  )
    return;
  throw new Error(`登录验证拒绝访问未知主机: ${host}`);
}

function sanitizeProxyHeaders(headers: Record<string, string>): Record<string, string> {
  const blocked = new Set([
    'connection',
    'content-length',
    'cookie',
    'host',
    'origin',
    'proxy-authorization',
    'referer',
    'set-cookie',
    'transfer-encoding',
    'x-tt-passport-csrf-token',
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase()) && !key.toLowerCase().startsWith('bd-ticket-guard-')),
  );
}

/** Loopback JSON carries binary bytes losslessly; never decode them as UTF-8. */
function decodeProxyBody(payload: Record<string, unknown>): string | Uint8Array<ArrayBuffer> | undefined {
  const encoded = payload['bodyBase64'];
  if (encoded === undefined) return typeof payload['body'] === 'string' ? payload['body'] : undefined;
  if (payload['body'] !== undefined || typeof encoded !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('验证代理二进制请求格式错误');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('验证代理二进制请求格式错误');
  return new Uint8Array(bytes);
}

async function readJsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_048_576) throw new Error('登录验证请求过大');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(
    Buffer.concat(chunks).toString('utf8') || '{}'
  );
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('登录验证请求格式错误');
  }
  return parsed as Record<string, unknown>;
}

function requiredQrMfa(
  context: BrowserLoginVerificationContext
): NonNullable<BrowserLoginVerificationContext['qrMfa']> {
  if (!context.qrMfa) throw new Error('当前不是扫码短信验证');
  return context.qrMfa;
}

function sendJson(
  response: ServerResponse,
  status: number,
  data: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  response.end(html);
}

function sendScript(response: ServerResponse, script: Buffer): void {
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  });
  response.end(script);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    char =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!
  );
}

function createVerificationFingerprint(deviceId: string): string {
  if (deviceId) return `verify_${deviceId}`;
  return `verify_${Date.now().toString(36)}_${cryptoRandomId()}`;
}

function cryptoRandomId(): string {
  return randomUUID().replace(/-/g, '_');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => item != null)
      .map(([key, item]) => [key, String(item)])
  );
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function passportSucceeded(response: {
  message: string;
  data: { error_code?: number };
}): boolean {
  return typeof response.data.error_code === 'number'
    ? response.data.error_code === 0
    : response.message === 'success';
}

function passportFailure(response: {
  message: string;
  data: { error_code?: number; description?: string; error_str?: unknown };
}): string {
  return `code=${response.data.error_code ?? '-'} ${String(response.data.description ?? response.data.error_str ?? response.message ?? 'unknown error')}`;
}
