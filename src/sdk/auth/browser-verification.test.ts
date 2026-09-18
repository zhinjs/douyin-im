import { ApiConnection } from '../../desktop/api-connection.js';
import { PassportRequestError } from '../../desktop/passport-error.js';
import { openBrowserVerification } from './browser-verification.js';
import { LoginVerification, type LoginVerificationResult } from './login-verification.js';
import { ActionVerification } from './action-verification.js';
import { ActionChallengeError } from '../../http/action-challenge.js';
import type { Account } from '../account.js';
import { runInNewContext } from 'node:vm';
import { request as httpRequest } from 'node:http';

describe('browser login verification', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stops rejected business pack before opening a verification page or resuming follow', async () => {
    const connection = new ApiConnection();
    const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'error', data: {
      error_code: 2046, sms_code_key: 'fixture-secret', url: 'https://verify.example/script.js?token=fixture-secret',
    } }));
    const complete = jest.fn();
    const verification = new ActionVerification({ uid: 'fixture' } as Account, { operation: 'follow', uid: 'target' },
      new ActionChallengeError('passport-decision', '{"verify_from":"verify_center"}'),
      { open: async () => undefined, complete, cancel: () => undefined });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const error = await openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 }).catch(error => error);
      expect(error).toBeInstanceOf(PassportRequestError);
      expect(error.errorCode).toBe(2046);
      expect(error.message).not.toContain('fixture-secret');
      expect(error.message).not.toContain('脚本 URL');
      expect(write.mock.calls.flat().join('')).not.toContain('浏览器打开');
      expect(network).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
    } finally { verification.cancel('fixture ended'); }
  });

  it.each([
    ['passport', undefined], ['passport', 'p3'], ['qr-connect', undefined], ['qr-connect', 'p3'],
  ] as const)('matches Desktop login initialization for %s (scene=%s)', async (source, scene) => {
    const connection = new ApiConnection({ deviceId: '10002', installId: '10003' });
    jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue({ ...emptyVerificationResponse(),
      rawText: scene ? JSON.stringify({ data: { verify: { scene_level: scene } } }) : '{}' });
    const verification = new LoginVerification({ source, operation: 'qr-connect', decision: { code: 20000 } },
      { open: async () => undefined, complete: async () => undefined, cancel: () => undefined });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const page = await fetch(url).then(response => response.text());
      const init = jest.fn(), render = jest.fn(), wire = jest.fn();
      const browser: Record<string, unknown> = { React: {}, ReactDOM: {}, addEventListener: () => undefined,
        getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
        verifySDK: { initVerifyOptions: init, autoRender: render } };
      const status = { innerHTML: '', textContent: '' };
      const realm = { window: browser, fetch: wire, document: { cookie: '', getElementById: () => status,
        querySelectorAll: () => [{ closest: () => null, getBoundingClientRect: () => ({ width: 100, height: 100 }) }],
        createElement: () => ({ remove: () => undefined }),
        head: { appendChild: (script: { onload?: () => void }) => queueMicrotask(() => script.onload?.()) } },
      localStorage: { setItem: () => undefined }, location: { search: '', hostname: '127.0.0.1' },
      URL, URLSearchParams, FormData, TextEncoder, AbortController, setTimeout, clearTimeout };
      for (const script of inlineScripts(page).slice(0, -1)) runInNewContext(script, realm);
      await (browser['startDouyinVerification'] as () => Promise<void>)();
      // Pinned LOGIN getAccountConfig -> C321 $u.init -> Ba.get source oracle.
      expect(init).toHaveBeenCalledTimes(1);
      expect(init).toHaveBeenCalledWith({
        commonOptions: { repoId: 579047, aid: 339757, did: '10002', iid: '10003', ...(scene ? { scene_level: scene } : {}) },
        captchaOptions: { sideSlide: 'disabled', lang: 'zh', showMode: 'mask', region: 'cn', app_name: '抖音聊天',
          host: '', fp: 'verify_10002', baseEM: 70, h5_check_version: '4.0.12' },
      });
      expect(render).toHaveBeenCalledTimes(1);
      expect(wire).not.toHaveBeenCalled();
      expect(status.innerHTML).toContain('请完成安全验证');
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it.each(['captcha', 'secondary'] as const)('preserves the Desktop %s callback through the actual page and local completion route', async kind => {
    const connection = new ApiConnection();
    jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const complete = jest.fn(async () => undefined);
    const verification = new LoginVerification({ source: 'passport', operation: 'qr-connect',
      decision: { code: kind === 'captcha' ? '10000' : '20000' } },
    { open: async () => undefined, complete, cancel: () => undefined });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const page = await fetch(url).then(response => response.text());
      let finish!: () => void;
      let options!: { captchaOptions: { successCb: () => void }; secondVerifyWebOptions: { callBack: (value: unknown) => void; scene?: string } };
      const submitted = new Promise<void>(resolve => { finish = resolve; });
      const getCaptchaWebId = jest.fn().mockResolvedValue('different-sdk-fp');
      const browser: Record<string, unknown> = { React: {}, ReactDOM: {}, addEventListener: () => undefined,
        verifySDK: { initVerifyOptions: jest.fn(), getCaptchaWebId,
          autoRender: (value: typeof options) => {
            options = value;
            if (kind === 'captcha') options.captchaOptions.successCb();
            else options.secondVerifyWebOptions.callBack({ status: false, fp: 'untrusted-callback' });
          } } };
      const status = { innerHTML: '', textContent: '' };
      const requests: unknown[] = [];
      const realm = { window: browser, fetch: async (target: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        try { return await fetch(new URL(target, url), init); } finally { finish(); }
      }, document: { cookie: '', getElementById: () => status,
        createElement: () => ({ remove: () => undefined }),
        head: { appendChild: (script: { onload?: () => void }) => queueMicrotask(() => script.onload?.()) } },
      localStorage: { setItem: () => undefined }, location: { search: '', hostname: '127.0.0.1' },
      URL, URLSearchParams, FormData, TextEncoder, AbortController, setTimeout, clearTimeout };
      for (const source of inlineScripts(page).slice(0, -1)) runInNewContext(source, realm);
      await (browser['startDouyinVerification'] as () => Promise<void>)();
      await submitted;
      const boot = browser['__LOGIN_VERIFY__'] as { fp: string };
      expect(requests).toEqual([{ result: kind === 'captcha' ? { fp: boot.fp } : {} }]);
      expect(complete).toHaveBeenCalledWith(kind === 'captcha' ? expect.objectContaining({ fp: boot.fp }) : {});
      expect(getCaptchaWebId).not.toHaveBeenCalled();
      expect(options.secondVerifyWebOptions.scene).toBe('4');
      await open;
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it('rejects non-string fingerprints without settling the login challenge', async () => {
    const connection = new ApiConnection();
    jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const complete = jest.fn(async () => undefined);
    const verification = new LoginVerification({ source: 'passport', operation: 'qr-connect', decision: {} },
      { open: async () => undefined, complete, cancel: () => undefined });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const target = new URL('/api/complete', url); target.search = new URL(url).search;
      for (const fp of [{}, [], 42, true, null]) {
        const result = await fetch(target, { method: 'POST', body: JSON.stringify({ result: { fp } }) });
        expect(result.ok).toBe(false);
        expect(complete).not.toHaveBeenCalled();
        expect(verification.signal.aborted).toBe(false);
      }
      await fetch(target, { method: 'POST', body: '{"result":{}}' });
      await open;
      expect(complete).toHaveBeenCalledWith({});
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it('rejects malformed or ambiguous binary proxy bodies before dispatch', async () => {
    const connection = new ApiConnection();
    const proxy = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const verification = lifecycleFixture('login');
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      proxy.mockClear();
      const target = new URL('/api/request', url); target.search = new URL(url).search;
      for (const data of [{ bodyBase64: 1 }, { bodyBase64: 'AA' }, { bodyBase64: ' A==' },
        { bodyBase64: 'AB==' }, { body: 'conflict', bodyBase64: 'AA==' }]) {
        const result = await fetch(target, { method: 'POST', body: JSON.stringify({ url: '/passport/fixture/', method: 'POST', ...data }) });
        expect(result.ok).toBe(false);
      }
      expect(proxy).not.toHaveBeenCalled();
      expect(verification.signal.aborted).toBe(false);
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it.each(['login', 'action'] as const)('forwards direct XHR classification without accepting page credentials (%s)', async kind => {
    const connection = new ApiConnection();
    const proxy = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const verification = lifecycleFixture(kind);
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      proxy.mockClear();
      const target = new URL('/api/request', url); target.search = new URL(url).search;
      const result = await fetch(target, { method: 'POST', body: JSON.stringify({
        url: '/passport/web/validate_code/', method: 'GET', pipeline: 'xhr', headers: {
          Cookie: 'page-secret', 'x-tt-passport-csrf-token': 'page-csrf',
          'bd-ticket-guard-client-data': 'page-ticket', 'x-use-secondary-verify-sdk': '1',
        },
      }) });
      expect(result.ok).toBe(true);
      expect(proxy).toHaveBeenCalledTimes(1);
      expect(proxy).toHaveBeenCalledWith('https://imdesktop.douyin.com/passport/web/validate_code/',
        expect.objectContaining({ method: 'GET', headers: { 'x-use-secondary-verify-sdk': '1' } }), kind, 'xhr');
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it.each(['login', 'action'] as const)('rejects non-verification operations from the %s page before account dispatch', async kind => {
    const connection = new ApiConnection();
    const proxy = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const verification = lifecycleFixture(kind);
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      proxy.mockClear();
      const endpoint = new URL('/api/request', url); endpoint.search = new URL(url).search;
      for (const target of [
        '/aweme/v1/web/commit/follow/user/', '/v1/message/send',
        '/passport/../aweme/v1/web/commit/follow/user/', '/passport/%2e%2e/v1/message/send',
        '//example.invalid/passport/web/validate_code/',
      ]) {
        const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ url: target, method: 'POST' }) });
        expect(response.ok).toBe(false);
      }
      expect(proxy).not.toHaveBeenCalled();
      for (const target of ['/passport/web/validate_code/', '/service/settings/v3/']) {
        const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ url: target, method: 'GET' }) });
        expect(response.ok).toBe(true);
      }
      expect(proxy).toHaveBeenCalledTimes(2);
      expect(verification.signal.aborted).toBe(false);
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it.each(['login', 'action'] as const)('consumes and saves BDTicket headers without exposing them to the %s page', async kind => {
    const connection = new ApiConnection({ initialCookies: 'sessionid=synthetic-before' });
    const snapshots: { cookies: string; state: NonNullable<ReturnType<ApiConnection['getTicketGuardState']>> }[] = [];
    connection.enableTicketGuard(state => snapshots.push({ cookies: connection.getCookies(), state }));
    const serverData = Buffer.from(JSON.stringify({ ticket: 'synthetic-after', ts_sign_ree: 'synthetic-ree-ticket' })).toString('base64');
    const expectedBody = { message: 'success', data: { fixture: true } };
    const nativeFetch = globalThis.fetch;
    const outgoing: Headers[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = new URL(String(input));
      if (target.hostname === '127.0.0.1') return nativeFetch(input, init);
      if (target.origin === 'https://vcs.zijieapi.com' && target.pathname === '/vc/setting') return Response.json({});
      if (target.origin === 'https://imdesktop.douyin.com' && target.pathname === '/passport/ticket_guard/get_client_cert/') {
        return Response.json({ message: 'success', data: {} });
      }
      if (target.origin !== 'https://imdesktop.douyin.com' || target.pathname !== '/passport/web/validate_code/') {
        throw new Error('Unexpected fixture request');
      }
      outgoing.push(new Headers(init?.headers));
      return Response.json(expectedBody, { headers: {
        'Set-Cookie': 'sessionid=synthetic-after; Path=/; Secure',
        'Bd-Ticket-Guard-Server-Data': serverData,
        'BD-TICKET-GUARD-CLIENT-CERT': 'Y2xpZW50LWNlcnQ=',
        'bd-ticket-guard-result': '0', 'bd-ticket-guard-future-state': 'synthetic-private-state',
        'x-tt-logid': 'fixture-log', 'bdturing-verify': 'fixture-challenge',
        'x-tt-verify-passport-decision': '{"verify_from":"verify_center"}',
      } });
    });
    const verification = lifecycleFixture(kind);
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const target = new URL('/api/request', url); target.search = new URL(url).search;
      const response = await fetch(target, { method: 'POST', body: JSON.stringify({
        url: '/passport/web/validate_code/', method: 'GET', pipeline: 'xhr',
        headers: { Cookie: 'page-cookie', 'bd-ticket-guard-client-data': 'page-ticket' },
      }) });
      expect(response.ok).toBe(true);
      const result = await response.json() as { data: unknown; rawText: string; headers: Record<string, string> };
      expect(connection.hasBoundTicket()).toBe(true);
      expect(snapshots.at(-1)).toMatchObject({ cookies: 'sessionid=synthetic-after', state: {
        binding: { tsSignRee: 'synthetic-ree-ticket' }, clientCert: 'Y2xpZW50LWNlcnQ=',
      } });
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]!.get('cookie')).toBe('sessionid=synthetic-before');
      expect(outgoing[0]!.get('bd-ticket-guard-client-data')).not.toBe('page-ticket');
      expect(result.data).toEqual(expectedBody);
      expect(result.rawText).toBe(JSON.stringify(expectedBody));
      expect(result.headers).toMatchObject({ 'x-tt-logid': 'fixture-log', 'bdturing-verify': 'fixture-challenge',
        'x-tt-verify-passport-decision': '{"verify_from":"verify_center"}' });
      expect(Object.keys(result.headers).filter(key => key === 'set-cookie' || key.startsWith('bd-ticket-guard-'))).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(serverData);
      expect(verification.signal.aborted).toBe(false);
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it.each(['multipart', 'blob', 'arraybuffer', 'view'] as const)('preserves binary %s through the actual page and local proxy', async kind => {
    const connection = new ApiConnection();
    const proxy = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue({ ...emptyVerificationResponse(), rawText: '{"message":"success"}' });
    const verification = lifecycleFixture('login');
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const page = await fetch(url).then(response => response.text());
      proxy.mockClear();
      const browser: Record<string, unknown> = { addEventListener: () => undefined };
      const realm = { window: browser, fetch: (target: string, init: RequestInit) => fetch(new URL(target, url), init),
        localStorage: { setItem: () => undefined }, document: { cookie: '' }, location: { search: '', hostname: '127.0.0.1' },
        URL, URLSearchParams, FormData, Blob, Response, ArrayBuffer, Uint8Array, btoa, TextEncoder, AbortController, setTimeout, clearTimeout };
      for (const source of inlineScripts(page).slice(0, -1)) runInNewContext(source, realm);
      const registry = browser['$$UCALL_APIMAP'] as Record<string, (config: unknown) => Promise<unknown>>;
      const bytes = new Uint8Array([0, 255, 128, 195, 40, 13, 10, 65]);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const multipart = new FormData();
      multipart.append('file', blob, 'fixture.bin');
      multipart.append('label', '测试');
      const padded = new Uint8Array(bytes.length + 2); padded.set(bytes, 1);
      const body = kind === 'multipart' ? multipart : kind === 'blob' ? blob : kind === 'arraybuffer' ? bytes.buffer
        : new DataView(padded.buffer, 1, bytes.length);
      await expect(registry['Request']!({ url: '/passport/fixture/', method: 'POST', data: body })).resolves.toEqual({ message: 'success' });
      expect(proxy).toHaveBeenCalledTimes(1);
      const sent = proxy.mock.calls[0]![1];
      const response = new Response(sent.body, { headers: new Headers(sent.headers) });
      if (kind === 'multipart') {
        const form = await response.formData();
        expect(form.get('label')).toBe('测试');
        expect(new Uint8Array(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
      } else expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it.each([
    ['captcha', 'default'], ['secondary', 'default'], ['close', 'default'],
    ['secondary', 'empty'], ['secondary', 'form'],
  ] as const)('continues the page fetchSec %s/%s challenge without completing the outer verification', async (kind, variant) => {
    const connection = new ApiConnection();
    jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const verification = lifecycleFixture('action');
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const page = await fetch(url).then(response => response.text());
      const challenge = { message: 'error', data: { error_code: 2046,
        sms_code_key: variant === 'empty' ? undefined : 'source+key', verify_center_decision_conf: '{}' } };
      const success = { message: 'success', data: { fixture: true } };
      const wire = jest.fn().mockImplementation(async () => {
        const data = wire.mock.calls.length === 1 ? challenge : success;
        return { ok: true, json: async () => ({ status: 200, statusText: 'OK', headers: {}, data, rawText: JSON.stringify(data) }) };
      });
      const doc = { cookie: '' };
      const init = jest.fn();
      const browser: Record<string, unknown> = { addEventListener: () => undefined, verifySDK: {
        initVerifyOptions: init,
        autoRender: (options: { captchaOptions: { successCb: (value: unknown) => void; closeCb: () => void };
          secondVerifyWebOptions: { callBack: (value: unknown) => void } }) => {
          doc.cookie = 's_v_web_id=source-wrapper-fp';
          if (kind === 'close') options.captchaOptions.closeCb();
          else if (kind === 'captcha') { options.captchaOptions.successCb({ fp: 'ignored' }); options.captchaOptions.successCb({ fp: 'ignored-again' }); }
          else options.secondVerifyWebOptions.callBack({ status: false, ticket: 'ignored' });
        },
      } };
      const realm = { window: browser, fetch: wire, localStorage: { setItem: () => undefined }, document: doc,
        location: { search: '', hostname: '127.0.0.1' }, URL, URLSearchParams, FormData, TextEncoder, AbortController, setTimeout, clearTimeout };
      for (const source of inlineScripts(page).slice(0, -1)) runInNewContext(source, realm);
      const registry = browser['$$UCALL_APIMAP'] as Record<string, (config: unknown) => Promise<unknown>>;
      const result = registry['Request.fetchSec']!({ url: 'https://127.0.0.1/passport/safe/pack_verify_ways_data/', method: 'POST',
        data: variant === 'empty' ? undefined : variant === 'form' ? 'flag&=anonymous' : { code: '1' },
        commonParams: { aid: 339757 } });
      if (kind === 'close') { await expect(result).rejects.toMatchObject({ errorHandled: true }); expect(wire).toHaveBeenCalledTimes(1); }
      else {
        await expect(result).resolves.toEqual(success);
        expect(wire).toHaveBeenCalledTimes(2);
        const sent = JSON.parse(wire.mock.calls[1]![1].body);
        expect(new URL(sent.url).origin).toBe('https://imdesktop.douyin.com');
        expect(sent.body).toBe(variant === 'empty' ? undefined : variant === 'form'
          ? 'flag=undefined&=anonymous&sms_code_key=source%2Bkey'
          : 'mix_mode=1&code=34&fixed_mix_mode=1' + (kind === 'secondary' ? '&sms_code_key=source%2Bkey' : ''));
        expect(sent.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(new URL(sent.url).searchParams.get('fp')).toBe(kind === 'captcha' ? 'source-wrapper-fp' : null);
      }
      expect(init).toHaveBeenCalledTimes(1);
      expect(init).toHaveBeenCalledWith(expect.objectContaining({ commonOptions: { aid: 339757, did: '0', iid: '0' } }));
      expect(wire.mock.calls.every(([target]) => String(target).startsWith('/api/request?'))).toBe(true);
      expect(verification.signal.aborted).toBe(false);
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it('aborts only the disconnected page request, keeping its verification open', async () => {
    const connection = new ApiConnection();
    let release!: (value: ReturnType<typeof emptyVerificationResponse>) => void;
    let notifyStarted!: () => void;
    let notifyAborted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const aborted = new Promise<void>(resolve => { notifyAborted = resolve; });
    jest.spyOn(connection, 'requestVerificationRaw').mockImplementation(async (target, init) => {
      if (target.includes('/vc/setting')) return emptyVerificationResponse();
      init.signal?.addEventListener('abort', notifyAborted, { once: true });
      notifyStarted();
      return new Promise(resolve => { release = resolve; });
    });
    const verification = lifecycleFixture('login');
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const target = new URL('/api/request', url); target.search = new URL(url).search;
      const controller = new AbortController();
      const pending = fetch(target, { method: 'POST', signal: controller.signal, body: JSON.stringify({ url: '/passport/fixture/' }) });
      const rejected = expect(pending).rejects.toThrow();
      await started; controller.abort(); await rejected; await aborted;
      expect(verification.signal.aborted).toBe(false);
      release(emptyVerificationResponse());
      expect((await fetch(url)).ok).toBe(true);
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it('runs the actual page Request.fetch middleware and returns the Passport envelope', async () => {
    const connection = new ApiConnection();
    jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const verification = lifecycleFixture('login');
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const page = await fetch(url).then(response => response.text());
      const result = { message: 'success', data: { fixture: true } };
      const wire = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 200, statusText: 'OK', headers: {},
        data: result, rawText: JSON.stringify(result) }) });
      const browser: Record<string, unknown> = { addEventListener: () => undefined };
      const realm = { window: browser, fetch: wire, localStorage: { setItem: () => undefined },
        document: { cookie: '' }, location: { search: '', hostname: '127.0.0.1' }, URL, URLSearchParams, FormData,
        TextEncoder, AbortController, setTimeout, clearTimeout };
      for (const source of inlineScripts(page).slice(0, -1)) runInNewContext(source, realm);
      const registry = browser['$$UCALL_APIMAP'] as Record<string, (config: unknown) => Promise<unknown>>;
      const received = await registry['Request.fetch']!({ url: '/passport/example/?dup=old', method: 'POST',
        header: { 'X-Fixture': 'preserved' }, params: { dup: 'params', code: '1' }, commonParams: { dup: 'common' },
        data: { code: '1', list: [1, 2], nullable: null, label: 'a b' } });
      const sent = JSON.parse(wire.mock.calls[0]![1].body);
      expect(sent.headers['X-Fixture']).toBe('preserved');
      expect(sent.body).toBe('mix_mode=1&code=34&list=%5B1%2C2%5D&nullable=null&label=a%20b&fixed_mix_mode=1');
      expect(new URL(sent.url, 'https://imdesktop.douyin.com').searchParams.getAll('dup')).toEqual(['common']);
      expect(new URL(sent.url, 'https://imdesktop.douyin.com').searchParams.get('code')).toBe('34');
      expect(received).toEqual(result);
      expect(registry['Request']).not.toBe(registry['Request.fetch']);
      expect(registry['Request.fetch']).not.toBe(registry['Request.fetchSec']);
    } finally { verification.cancel('fixture ended'); await ended; }
  });

  it.each([false, true])('preserves Desktop business SecondVerify init options and original decision portrait (pack overrides=%s)', overrides => {
    return checkBusinessSecondVerify(overrides);
  });

  it.each([false, true])('loads the exact Desktop SecondVerify script address (packed=%s)', async packed => {
    // Expected strings also checked against the pinned C955 expression by the offline oracle.
    const cases = [
      { url: 'https://verify.example/script.js', events: {}, suffix: '?aid=339757&verify_reason=&verify_scene=' },
      { url: 'https://verify.example/script.js?token=a%20b&aid=old', events: {}, suffix: '?aid=339757&verify_reason=&verify_scene=' },
      { url: 'https://verify.example/script.js#fragment', events: {}, suffix: '?aid=339757&verify_reason=&verify_scene=' },
      { url: 'https://verify.example/script.js', events: { verify_reason: 'a b+%&x=1', verify_scene: '扫码/确认' },
        suffix: '?aid=339757&verify_reason=a b+%&x=1&verify_scene=扫码/确认' },
      { url: 'https://verify.example/script.js', events: { verify_reason: 0, verify_scene: false }, suffix: '?aid=339757&verify_reason=&verify_scene=' },
      { url: 'https://verify.example/script.js', events: { verify_reason: 42, verify_scene: ['a', 'b'] }, suffix: '?aid=339757&verify_reason=42&verify_scene=a,b' },
    ];
    for (const fixture of cases) {
      const connection = new ApiConnection();
      const config = { url: fixture.url, event_params: fixture.events };
      const pack = jest.spyOn(connection, 'packActionVerification').mockResolvedValue(config);
      const decision = packed ? { verify_from: 'verify_center', url: 'https://verify.example/old.js', event_params: { verify_reason: 'old' } } : config;
      const verification = new ActionVerification({ uid: 'fixture' } as Account, { operation: 'follow', uid: 'target' },
        new ActionChallengeError('passport-decision', JSON.stringify(decision)),
        { open: async () => undefined, complete: () => undefined, cancel: () => undefined });
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
      const ended = open.catch(() => undefined);
      const url = await waitForVerificationUrl(write);
      try {
        const page = await fetch(url).then(response => response.text());
        await assertStartup(page, 'second-script-url', fixture.url + fixture.suffix);
        expect(pack).toHaveBeenCalledTimes(packed ? 1 : 0);
      } finally { verification.cancel('fixture ended'); await ended; write.mockRestore(); }
    }
  });

  it.each(['http://verify.example/script.js', 'javascript:alert(1)', 'file:///fixture.js'])('rejects unsafe business script %s before opening a page', async url => {
    const verification = new ActionVerification({ uid: 'fixture' } as Account, { operation: 'follow', uid: 'target' },
      new ActionChallengeError('passport-decision', JSON.stringify({ url })),
      { open: async () => undefined, complete: () => undefined, cancel: () => undefined });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(openBrowserVerification(verification, { connection: new ApiConnection() }, { openBrowser: false }))
        .rejects.toThrow('不安全的登录验证脚本');
      expect(write.mock.calls.flat().join('')).not.toContain('浏览器打开');
    } finally { verification.cancel('fixture ended'); }
  });

  async function checkBusinessSecondVerify(overrides: boolean) {
    const connection = new ApiConnection({ deviceId: 'did', installId: 'iid' });
    jest.spyOn(connection, 'packActionVerification').mockResolvedValue({
      url: 'https://verify.example/script.js', verify_portrait_id: 'pack-portrait',
      ...(overrides ? { verify_from: 'direct', generalParams: { marker: 'packed' }, appName: 'packed-name' } : {}),
    });
    const verification = new ActionVerification({ uid: 'fixture' } as Account, { operation: 'follow', uid: 'target' },
      new ActionChallengeError('passport-decision', JSON.stringify({ verify_from: 'verify_center', verify_portrait_id: 'original-portrait' })),
      { open: async () => undefined, complete: () => undefined, cancel: () => undefined });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      const page = await fetch(url).then(response => response.text());
      await assertStartup(page, overrides ? 'business-second-verify-overrides' : 'business-second-verify-options');
    } finally { verification.cancel('fixture ended'); await ended; }
  }

  it.each(['login', 'action'] as const)('closes an externally completed %s page', async kind => {
    const connection = new ApiConnection();
    const proxy = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const verification = lifecycleFixture(kind);
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const url = await waitForVerificationUrl(write);
    if (verification instanceof ActionVerification) await verification.complete({ status: true });
    else await verification.complete();
    await open;
    expect(verification.signal.aborted).toBe(true);
    expect(verification.signal.reason).toBeNull();
    proxy.mockClear();
    await expect(fetch(url)).rejects.toThrow();
    expect(proxy).not.toHaveBeenCalled();
  });

  it.each(['login', 'action'] as const)('cancels %s preparation promptly and never opens a late page', async kind => {
    const connection = new ApiConnection();
    let release!: (value: ReturnType<typeof emptyVerificationResponse>) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let signal: AbortSignal | null | undefined;
    jest.spyOn(connection, 'requestVerificationRaw').mockImplementation(async (_url, init) => {
      signal = init.signal; markStarted();
      return new Promise(resolve => { release = resolve; });
    });
    const verification = lifecycleFixture(kind);
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = expect(open).rejects.toThrow('fixture logout');
    await started;
    verification.cancel('fixture logout');
    await ended;
    expect(signal?.aborted).toBe(true);
    release(emptyVerificationResponse());
    await new Promise(resolve => setImmediate(resolve));
    expect(write.mock.calls.map(([text]) => String(text)).join('')).not.toContain('浏览器打开');
  });

  it.each(['login', 'action'] as const)('aborts the in-flight %s proxy when the challenge ends', async kind => {
    const connection = new ApiConnection();
    let release!: (value: ReturnType<typeof emptyVerificationResponse>) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let signal: AbortSignal | null | undefined;
    jest.spyOn(connection, 'requestVerificationRaw').mockImplementation(async (url, init) => {
      if (new URL(url).hostname === 'vcs.zijieapi.com') return emptyVerificationResponse();
      signal = init.signal; markStarted();
      return new Promise(resolve => { release = resolve; });
    });
    const verification = lifecycleFixture(kind);
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = expect(open).rejects.toThrow('fixture logout');
    const url = await waitForVerificationUrl(write);
    const proxy = new URL('/api/request', url); proxy.search = new URL(url).search;
    const pending = fetch(proxy, { method: 'POST', body: JSON.stringify({ url: '/passport/web/send_code/', method: 'POST' }) });
    const disconnected = expect(pending).rejects.toThrow();
    await started;
    verification.cancel('fixture logout');
    await ended; await disconnected;
    expect(signal?.aborted).toBe(true);
    release(emptyVerificationResponse());
    await new Promise(resolve => setImmediate(resolve));
  });

  it('closes a partial request body without forwarding it or waiting for its upload', async () => {
    const connection = new ApiConnection();
    const proxyRequest = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue(emptyVerificationResponse());
    const verification = lifecycleFixture('login');
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = expect(open).rejects.toThrow('fixture logout');
    const url = await waitForVerificationUrl(write);
    const proxy = new URL('/api/request', url); proxy.search = new URL(url).search;
    proxyRequest.mockClear();
    const upload = httpRequest(proxy, { method: 'POST', headers: { 'Content-Length': '1000' } });
    upload.on('error', () => undefined);
    const closed = new Promise<void>(resolve => upload.once('close', resolve));
    await new Promise<void>(resolve => upload.write('{"url":', () => resolve()));
    // Allow the loopback server to enter its body reader, without finishing it.
    await new Promise(resolve => setTimeout(resolve, 20));
    verification.cancel('fixture logout');
    await ended; await closed;
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it.each(['login', 'action'] as const)('does not let a cancelled %s page dispatch another platform request', async kind => {
    const connection = new ApiConnection();
    const request = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), data: '{}', rawText: '{}',
    });
    const verification = kind === 'login'
      ? new LoginVerification({ source: 'passport', operation: 'account-info', decision: { code: '10000' } }, {
        open: async () => undefined, complete: async () => undefined, cancel: () => undefined,
      })
      : new ActionVerification({ uid: 'fixture' } as Account, { operation: 'follow', uid: 'target' },
        new ActionChallengeError('bdturing', 'fixture-challenge'), {
          open: async () => undefined, complete: () => undefined, cancel: () => undefined,
        });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    const url = await waitForVerificationUrl(write);
    try {
      request.mockClear(); verification.cancel('fixture account logged out');
      const proxy = new URL('/api/request', url); proxy.search = new URL(url).search;
      await fetch(proxy, { method: 'POST', headers: { Connection: 'close' }, body: JSON.stringify({
        url: '/passport/web/send_code/', method: 'POST', body: 'fixture=only',
      }) }).catch(() => undefined);
      expect(request).not.toHaveBeenCalled();
    } finally {
      const cancel = new URL('/api/cancel', url); cancel.search = new URL(url).search;
      await fetch(cancel, { method: 'POST', headers: { Connection: 'close' } }).catch(() => undefined);
      await ended;
    }
  });

  it.each([
    { verify_from: 'captcha', captcha: 'synthetic-sensitive-challenge', verify_ticket: 'synthetic-sensitive-ticket' },
    { verify_from: 'verify_center', detail: 'synthetic-sensitive-challenge' },
  ])('delegates URL-less login decisions to the official dispatcher ($verify_from)', async decision => {
    const connection = new ApiConnection();
    const pack = jest.spyOn(connection, 'packActionVerification').mockResolvedValue({});
    const request = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), data: '{}', rawText: '{}',
    });
    const verification = new LoginVerification({ source: 'qr-connect', operation: 'qr-connect', errorCode: 1105, decision }, {
      open: async () => undefined, complete: async () => undefined, cancel: () => undefined,
    });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    // Observe startup rejection immediately, rather than hiding it behind a URL timeout.
    const url = await Promise.race([waitForVerificationUrl(write), open.then(() => { throw new Error('Closed before startup'); })]);
    try {
      const page = await fetch(url, { headers: { Connection: 'close' } }).then(response => response.text());
      expect(page).toContain('"mode":"verify-center"');
      expect(pack).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
      expect(new URL(request.mock.calls[0]![0]).pathname).toBe('/vc/setting');
      const diagnostics = write.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(diagnostics).toContain('operation=qr-connect errorCode=1105 decisionCode=missing');
      expect(diagnostics).not.toContain('synthetic-sensitive');
      await assertStartup(page, 'raw-login-decision');
    } finally {
      const cancel = new URL('/api/cancel', url); cancel.search = new URL(url).search;
      const closed = expect(open).rejects.toThrow('用户关闭了安全验证');
      await fetch(cancel, { method: 'POST', headers: { Connection: 'close' } });
      await closed;
    }
  });

  it.each(['bdturing', 'passport-decision'] as const)('serves a distinct %s business challenge without login promotion', async source => {
    const connection = new ApiConnection({ deviceId: 'did', installId: 'iid' });
    const request = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), data: '{}', rawText: '{}',
    });
    const pack = jest.spyOn(connection, 'packActionVerification').mockResolvedValue({ url: 'https://verify.example/script.js' });
    const complete = jest.fn();
    const raw = JSON.stringify({ verify_from: 'verify_center', code: '20000', detail: 'fixture' });
    const verification = new ActionVerification({ uid: '22' } as Account, { operation: 'follow', uid: '33' },
      new ActionChallengeError(source, raw), { open: async () => undefined, complete, cancel: jest.fn() });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 10_000 });
    const url = await waitForVerificationUrl(write);
    const page = await fetch(url).then(response => response.text());
    expect(page).toContain('"business":true');
    expect(page).toContain(source === 'bdturing' ? '"mode":"business-captcha"' : '"mode":"second-verify"');
    expect(pack).toHaveBeenCalledTimes(source === 'passport-decision' ? 1 : 0);
    if (source === 'bdturing') await assertStartup(page, 'business-captcha-success');
    const proxyUrl = new URL('/api/request', url); proxyUrl.search = new URL(url).search;
    const forwarded = await fetch(proxyUrl, { method: 'POST', body: JSON.stringify({
      url: '/passport/web/validate_code/', method: 'POST', body: 'code=3437',
      headers: { Cookie: 'never', 'x-tt-passport-csrf-token': 'wrong', 'bd-ticket-guard-client-data': 'wrong' },
    }) });
    expect(forwarded.status).toBe(200);
    expect(request.mock.calls.at(-1)![1].headers).toEqual({});
    const completeUrl = new URL('/api/complete', url); completeUrl.search = new URL(url).search;
    await fetch(completeUrl, { method: 'POST', body: JSON.stringify({ result: { status: true, fields: { user_id: 'wrong' } } }) });
    await open;
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: '10000', subtype: 'slide' },
    { code: '20000', subtype: 'mobile_sms_verify' },
    { code: '30000', subtype: 'identity' },
    { code: '40000', subtype: 'live' },
  ])('serves the VerifyCenter flow for $code/$subtype without guessing from method names', async (decision) => {
    const connection = new ApiConnection({ deviceId: '3249781169', installId: '1234567890123457' });
    jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      data: JSON.stringify({
        verify: {
          scene_level: 'p2',
          js_v2: { cn: 'https://verify.example/primary.js' },
          back_up_js_v2: { cn: ['https://verify.example/backup.js'] },
        },
      }),
      rawText: JSON.stringify({
        verify: {
          scene_level: 'p2',
          js_v2: { cn: 'https://verify.example/primary.js' },
          back_up_js_v2: { cn: ['https://verify.example/backup.js'] },
        },
      }),
    });
    let completed: LoginVerificationResult | undefined;
    const verification = new LoginVerification(
      {
        source: 'passport',
        operation: 'password-login',
        errorCode: 1105,
        decision: { ...decision, detail: 'fixture-challenge' },
      },
      {
        open: async () => undefined,
        complete: async (result) => {
          completed = result;
        },
        cancel: () => undefined,
      },
    );
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const open = openBrowserVerification(
      verification,
      { connection },
      { openBrowser: false, timeoutMs: 10_000 },
    );
    const url = await waitForVerificationUrl(write);
    const page = await fetch(url).then((response) => response.text());
    expect(page).toContain('"installId":"1234567890123457"');
    expect(page).toContain('"mode":"verify-center"');
    expect(String(jest.mocked(connection.requestVerificationRaw).mock.calls[0]?.[0])).toContain('iid=1234567890123457');
    const reactUrl = new URL('/react.js', url);
    reactUrl.search = new URL(url).search;
    const reactDomUrl = new URL('/react-dom.js', url);
    reactDomUrl.search = new URL(url).search;
    const [react, reactDom] = await Promise.all([
      fetch(reactUrl).then((response) => response.text()),
      fetch(reactDomUrl).then((response) => response.text()),
    ]);

    const completeUrl = new URL('/api/complete', url);
    completeUrl.search = new URL(url).search;
    const response = await fetch(completeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: {} }),
    });
    expect(response.status).toBe(200);
    await open;

    expect(react).toContain('version="18.2.0"');
    expect(reactDom).toContain('reconcilerVersion:"18.2.0"');
    expect(page).toContain('verify_3249781169');
    expect(page.includes("window.$$UCALL_APIMAP['Request.fetchSec'] = requests.fetchSec")).toBe(true);
    for (const source of inlineScripts(page)) {
      expect(() => new Function(source)).not.toThrow();
    }
    expect(completed).toEqual({});
    for (const scenario of ['cdn-error', 'cdn-hang', 'missing-export', 'init-error', 'init-rejection', 'react-error', 'fallback', 'storage-blocked', 'second-verify', 'no-render', 'second-callback', 'second-rejected', 'second-empty', 'second-accepted']) {
      await assertStartup(page, scenario);
    }
  });
});

function emptyVerificationResponse() {
  return { ok: true, status: 200, headers: new Headers(), data: '{}', rawText: '{}' };
}

function lifecycleFixture(kind: 'login' | 'action') {
  const controller = { open: async () => undefined, complete: async () => undefined, cancel: () => undefined };
  return kind === 'login'
    ? new LoginVerification({ source: 'passport', operation: 'account-info', decision: { code: '10000' } }, controller)
    : new ActionVerification({ uid: 'fixture' } as Account, { operation: 'follow', uid: 'target' },
      new ActionChallengeError('bdturing', 'fixture-challenge'), controller);
}

async function assertStartup(page: string, scenario: string, expectedScript?: string): Promise<void> {
  const status = { innerHTML: '正在加载抖音安全验证…', textContent: '' };
  const mount = { innerHTML: 'platform mount', textContent: '' };
  const detail = { innerHTML: '', textContent: '' };
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const scripts: string[] = [];
  let visible = false;
  let renderedOptions: Record<string, unknown> | undefined;
  let portraitAtScriptLoad: unknown;
  const browser: Record<string, unknown> = {
    React: scenario === 'react-error' ? undefined : {}, ReactDOM: {}, addEventListener: () => undefined,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  };
  const render = jest.fn((options: Record<string, unknown>) => {
    renderedOptions = options;
    if (scenario === 'raw-login-decision') {
      expect(options['verify_data']).toEqual((browser['__LOGIN_VERIFY__'] as { config: unknown }).config);
      expect(options['captchaOptions']).toEqual(expect.objectContaining({ successCb: expect.any(Function), closeCb: expect.any(Function) }));
      expect(options['secondVerifyWebOptions']).toEqual(expect.objectContaining({ callBack: expect.any(Function), closeCallBack: expect.any(Function) }));
    }
    if (scenario === 'init-error') throw new Error('fixture error');
    if (scenario === 'init-rejection') return Promise.reject(new Error('fixture rejection'));
    if (scenario === 'second-callback') {
      expect(options['secondVerifyWebOptions']).toEqual(expect.objectContaining({
        callBack: expect.any(Function), closeCallBack: expect.any(Function),
      }));
    }
    if (['second-rejected', 'second-empty', 'second-accepted'].includes(scenario)) {
      const finish = options['verifyFinishCallback'] as (result?: unknown) => void;
      finish(scenario === 'second-empty' ? undefined : { status: scenario === 'second-accepted' });
    }
    visible = scenario !== 'no-render';
    // The returned Promise may wait for the human to finish. It must not keep
    // the host's initial spinner or become a startup timeout.
    return new Promise(() => undefined);
  });
  const fetchResult = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  const context = {
    fetch: fetchResult,
    window: browser,
    localStorage: { setItem: () => { if (scenario === 'storage-blocked') throw new Error('storage disabled'); } },
    location: { search: '', reload: jest.fn() }, URLSearchParams,
    document: {
      cookie: '', getElementById: (id: string) => id === 'verification-status' ? status : id === 'app' ? mount : detail,
      querySelectorAll: () => visible ? [{ closest: () => null, getBoundingClientRect: () => ({ width: 300, height: 200 }) }] : [],
      createElement: () => ({ remove: () => undefined }),
      head: { appendChild: (script: { src: string; onerror?: () => void; onload?: () => void }) => {
        scripts.push(script.src);
        portraitAtScriptLoad = browser['$$account_verify_portrait_id'];
        if (scenario === 'cdn-hang') return;
        queueMicrotask(() => {
          if (scenario === 'cdn-error' || scenario === 'react-error' || scenario === 'fallback' && scripts.length === 1) return script.onerror?.();
          if (scenario !== 'missing-export') {
            browser['verifySDK'] = { initVerifyOptions: jest.fn(), autoRender: render,
              initVerifyCenter: (options: unknown) => {
                expect(options).toMatchObject({ commonOptions: { aid: 339757, did: 'did', iid: '0' } });
                const capture = { onsuccess: undefined as undefined | ((result: unknown, kind: number) => void),
                  render: (raw: string) => {
                    expect(JSON.parse(raw)).toMatchObject({ detail: 'fixture' });
                    // Official captcha result is not {status:true}.
                    capture.onsuccess!({ code: 200, data: null, message: '验证通过' }, 1);
                  } };
                return capture;
              },
            };
            browser['ucWebSecondVerify'] = render;
          }
          script.onload?.();
        });
      } },
    },
    setTimeout: (action: () => void) => { timers.set(++timerId, action); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  for (const source of inlineScripts(page).slice(0, -1)) runInNewContext(source, context);
  if (['second-verify', 'second-rejected', 'second-empty', 'second-accepted'].includes(scenario)) {
    Object.assign(browser['__LOGIN_VERIFY__'] as object, { mode: 'second-verify', scriptUrl: 'https://verify.example/second.js' });
  }
  let settled = false;
  const task = (browser['startDouyinVerification'] as () => Promise<void>)().then(() => { settled = true; });
  for (let turn = 0; turn < 80; turn++) {
    await Promise.resolve();
    if (scenario === 'cdn-hang' || scenario === 'no-render') {
      for (const [id, action] of [...timers]) { timers.delete(id); action(); }
    }
  }
  expect({ scenario, settled }).toEqual({ scenario, settled: true });
  await task;
  if (expectedScript !== undefined) expect(scripts).toEqual([expectedScript]);
  if (scenario.startsWith('business-second-verify-')) {
    const parameters = { device_id: 'did', iid: 'iid', version_code: '1.2.1', device_platform: process.platform };
    expect(renderedOptions).toMatchObject({ host: 'https://sso.douyin.com', newSecondVerifyRequestHost: 'https://imdesktop.douyin.com',
      isBoe: false, printLog: false, isNewVerifyUI: true, newSecondVerifyWebOptions: parameters, fun: 'verify_center' });
    expect(renderedOptions!['generalParams']).toEqual(scenario.endsWith('overrides') ? { marker: 'packed' } : parameters);
    expect(renderedOptions!['appName']).toBe(scenario.endsWith('overrides') ? 'packed-name' : '抖音聊天');
    expect(renderedOptions!['getGeneralParams']).toBeUndefined();
    expect(portraitAtScriptLoad).toBe('original-portrait');
    expect(browser['$$account_verify_portrait_id']).toBe('original-portrait');
    expect(renderedOptions!['verify_portrait_id']).toBe('pack-portrait');
  }
  expect(status.innerHTML).not.toContain('正在加载抖音安全验证');
  expect(mount.innerHTML).toBe('platform mount');
  if (scenario === 'second-accepted' || scenario === 'business-captcha-success') {
    expect(status.innerHTML).toContain('验证通过');
    expect(fetchResult).toHaveBeenCalledTimes(1);
    if (scenario === 'business-captcha-success') {
      expect(JSON.parse(fetchResult.mock.calls[0]![1].body)).toEqual({ result: { status: true } });
    }
    return;
  }
  expect(fetchResult).not.toHaveBeenCalled();
  const success = ['fallback', 'storage-blocked', 'second-verify', 'second-script-url', 'second-callback', 'raw-login-decision', 'business-second-verify-options', 'business-second-verify-overrides'].includes(scenario);
  expect(status.innerHTML).toContain(success ? '请完成安全验证' : '安全验证未能完成');
  expect(status.innerHTML).toContain('重试');
  if (scenario === 'fallback') expect(scripts).toHaveLength(2);
  if (scenario === 'cdn-hang' || scenario === 'missing-export') expect(scripts).toHaveLength(5);
  expect(timers.size).toBe(0);
}

async function waitForVerificationUrl(
  write: jest.SpiedFunction<typeof process.stderr.write>,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    const match = output.match(/\[(?:login|action)\] 浏览器打开: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (match?.[1]) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('验证页未启动');
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}
