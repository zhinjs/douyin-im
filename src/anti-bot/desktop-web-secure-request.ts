import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';
import { classifyDesktopWebSecureRequest, type DesktopWebSecureMatch } from './desktop-web-secure-config.js';
import type { DesktopWebSecureKeys, DesktopWebSecureKeysInfo, DesktopWebSecureScene } from './desktop-web-secure-keys.js';

/** Normalized hook configuration, not a fetch Request/Headers instance. Extras contain raw private material: NEVER log them. */
export interface DesktopWebSecureRequest {
  url?: string;
  headers?: Record<string, unknown> | string;
  extras?: DesktopWebSecureKeysInfo & Record<string, unknown>;
  [key: string]: unknown;
}
export interface DesktopWebSecureRequestContext {
  readonly Date: { new(): { getTime(): number }; now(): number };
  readonly pageHref: string;
}
export interface DesktopWebSecureResponse {
  config?: DesktopWebSecureRequest;
  /** Transport-normalized keys: the source response handler does not lowercase them. */
  headers?: Record<string, unknown>;
  reqHeaders?: Record<string, unknown>;
  [key: string]: unknown;
}
interface HeaderInput {
  signType?: string; initType?: string; b64PubKey?: string | undefined; b64Cert?: string | undefined; b64Csr?: string | undefined;
  tsSign?: unknown; cert?: unknown; algoType?: string | undefined;
}
export interface DesktopWebSecureManualSignData { ticket?: unknown; ts_sign?: unknown; path?: string }
export interface DesktopWebSecureManualHeaders {
  bdTicketGuardHeaders: Record<string, unknown>;
  timeCollect: Record<string, unknown>;
  extras: { cache: string; server_data: string; algoType: string | undefined; path: string | undefined; isPubKeySign: string };
}

/** no/$n/ro: field classification only, not trust or signature verification. */
function isNewCert(cert: unknown): boolean { return !cert || typeof cert === 'string' && cert.includes('pub.'); }
function certificateHeaders(input: HeaderInput): Record<string, unknown> {
  return input.b64Cert ? { 'bd-ticket-guard-client-cert': input.b64Cert || '' } : { 'bd-ticket-guard-client-csr': input.b64Csr || '' };
}
function publicHeaders(input: HeaderInput, version = 2): Record<string, unknown> {
  return { 'bd-ticket-guard-ree-public-key': input.b64PubKey, 'bd-ticket-guard-web-version': version, 'bd-ticket-guard-web-sign-type': input.algoType === 'hmac' ? 1 : 0 };
}
function consumerHeaders(input: HeaderInput): Record<string, unknown> {
  const { signType = 'pubKey', tsSign = '' } = input;
  const version = tsSign ? (tsSign as string).slice(0, 4) : 'ts.2';
  if (signType === 'cert' || version !== 'ts.1' && version !== 'ts.2' || !isNewCert(input.cert)) return certificateHeaders(input);
  return publicHeaders(input, version === 'ts.1' ? 1 : 2);
}
const metric = (value: unknown): string => typeof value === 'number' ? value.toString() : '-99';
function reportPath(url: string | undefined): string | undefined {
  try { if (!url) return ''; if (url.startsWith('http')) return new URL(url).pathname; } catch { /* Keep source fallback. */ }
  return url;
}

/**
 * C860 uo/lo and Mn/Fn/Wn/Jn, one instance per isolated account browser realm.
 * Does not install global hooks, send requests or decide authenticated readiness.
 * Cache is intentionally path+ticket only, and must NEVER be shared across accounts.
 */
export class DesktopWebSecureRequestPipeline extends DesktopWebSecureEvents {
  private ttl: unknown = 18e6;
  private configuredTtl = false;
  private readonly signatures: Record<string, { timeout: unknown; signStr: string; ticket: unknown; algoType: string | undefined; createTime: number }> = {};
  constructor(private readonly context: DesktopWebSecureRequestContext, private readonly keys: DesktopWebSecureKeys | undefined) { super(); }

  /** Classification and processing share the supplied normalized request; caller retains the match for its response. */
  classify(request: DesktopWebSecureRequest, config: Record<string, unknown>, signType?: string, initType?: string): DesktopWebSecureMatch {
    return classifyDesktopWebSecureRequest(request, config, this.context.pageHref, signType, initType);
  }

  /** co: explicit ticket/path signing, sharing uo's realm cache. No response writeback or readiness assertion. */
  async createTicketGuardHeaders({ signData, signType = 'pubKey', certType = 'header' }: {
    signData?: DesktopWebSecureManualSignData | null | undefined;
    signType?: string;
    certType?: DesktopWebSecureScene['certType'];
  }): Promise<DesktopWebSecureManualHeaders> {
    const keys = this.keys, { ticket, ts_sign, path } = signData || {};
    const start = new this.context.Date().getTime(); let times: Record<string, unknown> = {}, algoType: string | undefined = '';
    const info = await keys?.getKeysInfoWithOrigin({ certType, scene: 'web_protect' });
    const publicKey = info?.crypt?.ec_publicKey;
    const { cert, b64Cert, b64PubKey, b64Csr, getKeysInfoTime = 0 } = info || {};
    let cache = false, signed: string | undefined, signTime = 0;
    keys?.getCookieCryptStatus(); // Source reads this even though its lost-data expression has no observable output.
    if (ticket && publicKey && path) {
      const cached = this.readSignature(path, ticket);
      if (cached) { signed = cached.signStr; algoType = cached.algoType; cache = true; }
      else {
        const timestamp = Math.floor(new this.context.Date().getTime() / 1000);
        signTime = this.context.Date.now();
        const result = await keys?.signWithKeysInfo({ sign_data: `ticket=${ticket}&path=${path}&timestamp=${timestamp}`,
          req_content: 'ticket,path,timestamp', timestamp, certType, scene: 'web_protect', keysInfo: { ...info, sign: { ticket, ts_sign } } });
        signed = result && result.result || ''; times = result && result.times || {}; algoType = result?.algoType;
        if (signed) this.writeSignature(path, ticket, signed, algoType);
      }
    }
    const output: Record<string, unknown> = { ...consumerHeaders({ tsSign: ts_sign || '', initType: 'pubKey', signType, b64PubKey, b64Cert, b64Csr, cert, algoType: algoType || undefined }),
      'bd-ticket-guard-version': 2, 'bd-ticket-guard-iteration-version': 1 };
    if (signed) output['bd-ticket-guard-client-data'] = signed;
    const end = new this.context.Date().getTime();
    return { bdTicketGuardHeaders: output, timeCollect: { duration: end - start || '0', signTime: signTime ? this.context.Date.now() - signTime : 0, getKeysInfoTime, ...times },
      extras: { cache: cache ? '1' : '0', server_data: signed ? '1' : '0', algoType, path, isPubKeySign: ((ts_sign || '') as string).slice(0, 4) } };
  }

  async prepare<T extends DesktopWebSecureRequest>(request: T, match: DesktopWebSecureMatch): Promise<T> {
    try {
      const originalHeaders = request?.headers, keys = this.keys;
      if (!originalHeaders || typeof originalHeaders === 'string') return request;
      const start = new this.context.Date().getTime(); let algoType: string | undefined = '';
      const { needProxy, consumerConfig: consumer, providerConfig: provider, pathname, hostname, signType = 'pubKey', initType = 'pubKey', onlyProxyResp = false, needReport = true } = match;
      const { scene = '', certType = 'header', signTimeout } = consumer || provider || {};
      if (!needProxy || onlyProxyResp || !keys) return request;
      let cache = false;
      const info = await keys.getKeysInfoWithOrigin({ scene, certType: certType as NonNullable<DesktopWebSecureScene['certType']> });
      const { match_md5_iframe, match_md5_local } = await keys.checkSignData(info);
      const { ec_publicKey: publicKey, ec_csr: csr } = info?.crypt || {};
      const { ticket, ts_sign, log_id = '' } = (info?.sign || {}) as NonNullable<DesktopWebSecureKeysInfo['sign']> & { log_id?: unknown };
      const { cert, b64Cert, b64PubKey, b64Csr, dataFrom, getKeysInfoTime = 0 } = info || {};
      let signed: string | undefined, lost = '0', signTime = 0;
      const cookieStatus = keys.getCookieCryptStatus(); // Read once, even when ticket exists.
      if (!ticket && !ts_sign && cookieStatus) lost = '1';
      if (ticket && publicKey && consumer && pathname) {
        if (signTimeout && !this.configuredTtl) { this.ttl = signTimeout; this.configuredTtl = true; }
        const cached = this.readSignature(pathname, ticket);
        if (cached) { signed = cached.signStr; algoType = cached.algoType; cache = true; }
        else {
          const payload = this.signingInput(request, ticket, pathname, consumer.urlRewriteRules || []);
          signTime = this.context.Date.now();
          const result = await keys.signWithKeysInfo({ ...payload, certType: certType as NonNullable<DesktopWebSecureScene['certType']>, scene, keysInfo: info, isNewCert: isNewCert(cert) });
          signed = result && result.result || ''; algoType = result?.algoType;
          if (signed) this.writeSignature(pathname, ticket, signed, algoType);
        }
      }
      const input = { tsSign: ts_sign || '', initType, signType, b64PubKey, b64Cert, b64Csr, cert, algoType: algoType || undefined };
      const headers = consumer ? consumerHeaders(input) : initType === 'cert' ? certificateHeaders(input) : publicHeaders({ b64PubKey }, 2);
      request.headers = { ...request.headers as Record<string, unknown>, ...headers, 'bd-ticket-guard-version': consumer?.signVersion || provider?.signVersion || 2, 'bd-ticket-guard-iteration-version': 1 };
      if (signed) request.headers = { ...request.headers as Record<string, unknown>, 'bd-ticket-guard-client-data': signed };
      this.emit('log', { content: signed ? 'add request data' : 'miss request data', level: signed ? 'info' : 'warn', extra: { url: pathname || '', ts_sign: ts_sign ? '[redacted]' : '', log_id } });
      const end = new this.context.Date().getTime(), { isConnection, retryCount, startTime, endTime, loadTime } = keys.getStorageStatus() || {};
      const usage = await keys.getUsage();
      if (needReport) this.emit('execute', { action: 'request', op: 'sign', duration: end > start ? end - start : 0, status: 'success',
        ctx: { cache: cache ? '1' : '0', path: pathname || '', cert: cert ? '1' : '0', pubKey: publicKey ? '1' : '0', isPubKeySign: ((ts_sign || '') as string).slice(0, 4),
          isPubKeyInit: initType === 'pubKey' ? '1' : '0', csr: csr ? '1' : '0', version: `${consumer?.signVersion || ''}` || `${provider?.signVersion || ''}` || '1',
          server: signed ? '1' : '0', crossStatus: keys.getIframeStatus() ? '1' : '0', initMatch: keys.initMatch ? '1' : '0', dataFrom: dataFrom || '-99',
          match_md5_local: match_md5_local || '-99', match_md5_iframe: match_md5_iframe || '-99', lost, isNewCert: isNewCert(cert) ? '1' : '0',
          isConnection: metric(isConnection), retryCount: metric(retryCount), algoType, usage: usage || 'unknown', hostname: hostname || '' },
        metrics: { startTime: startTime || 0, endTime: endTime || 0, loadTime: loadTime || 0, getKeysInfoTime, signTime: signTime ? this.context.Date.now() - signTime : 0 } });
      request.extras = { ...info, scene, certType, match_md5_iframe, match_md5_local, is_pubkey_ts_sign: ((ts_sign || '') as string).slice(0, 4),
        is_new_cert: isNewCert(cert) ? '1' : '0', lost, isPubKeyInit: initType === 'pubKey' ? '1' : '0' };
    } catch (error) {
      this.emit('error', { error, name: 'process request config fail' });
      // Source serializes the whole config, including cookies, keys and tickets. Intentionally redacted.
      this.emit('log', { content: 'process request config fail', extra: { content: '[redacted]' } });
      this.emit('execute', { action: 'request', op: 'sign', status: 'fail', ctx: { path: request?.url || '' } });
    }
    return request; // Source failures return the original, possibly already mutated configuration.
  }

  /** ho/po. Caller must retain the SAME match from request time; no business retry or Session commit here. */
  async complete<T extends DesktopWebSecureResponse>(response: T, match: DesktopWebSecureMatch, updateData = false): Promise<T> {
    try {
      const keys = this.keys, usage = await keys?.getUsage();
      if (!response?.config?.headers || typeof response.config.headers === 'string') {
        this.emit('execute', { action: 'response', op: 'respHandler', status: 'fail', ctx: { url: reportPath(response?.config!.url) || '' }, extras: '[redacted]' });
        this.emit('error', { error: '[redacted]', name: !response?.config?.headers ? 'response headers is empty' : 'response headers type is string' }); return response;
      }
      const extras = response.config.extras === undefined ? {} : response.config.extras;
      const { dataFrom, match_md5_local, match_md5_iframe, is_pubkey_ts_sign, is_new_cert, lost, isPubKeyInit } = extras || {};
      const { isConnection, retryCount, startTime, endTime, loadTime } = keys?.getStorageStatus() || {};
      if (response.reqHeaders?.['bd-ticket-guard-version']) this.emit('execute', { action: 'response', op: 'sign', status: 'finish',
        ctx: { url: reportPath(response.config.url) || '', crossStatus: keys?.getIframeStatus() ? '1' : '0', lost, dataFrom: dataFrom || '-99', match_md5_local, match_md5_iframe,
          initMatch: keys?.initMatch ? '1' : '0', isConnection: metric(isConnection), retryCount: metric(retryCount), is_pubkey_ts_sign, is_new_cert, isPubKeyInit, usage: usage || 'unknown' },
        metrics: { startTime: startTime || 0, endTime: endTime || 0, loadTime: loadTime || 0 }, extras: '[redacted]' });
      const start = new this.context.Date().getTime(), { needProxy, providerConfig, hostname, pathname, needReport = true } = match;
      const { scene, namespace } = providerConfig || {};
      if (needProxy && keys) {
        const server = response.headers?.['bd-ticket-guard-server-data'] || '', result = response.headers?.['bd-ticket-guard-result'] || '-99', logId = response.headers?.['x-tt-logid'] || '';
        const decoded = server && keys.b642str(server as string), parsed = decoded && JSON.parse(decoded), ticket = (parsed || {}).ticket;
        const logContext = { url: reportPath(response.config.url) || '', logId };
        if (ticket && scene && namespace) await keys.setSignValueAsync({ sign: parsed, scene, namespace: namespace as string, logCtx: logContext });
        else if (ticket && scene) keys.setSignValue({ sign: parsed, scene, logCtx: logContext });
        try { if (server && !scene) this.emit('log', { content: 'ts_sign_data lost scene', extra: { ...logContext }, level: 'info' }); } catch { /* Source isolates this log only. */ }
        const headers = this.processResponseHeaders(result, extras, response, updateData);
        const end = new this.context.Date().getTime();
        if (result && Number(result) > 0) this.emit('log', { content: 'response verify error', extra: { ...logContext }, level: 'info' });
        if (needReport) this.emit('execute', { action: 'response', op: 'init', status: 'success', duration: end > start ? end - start : 0,
          ctx: { url: pathname || '', path: pathname || '', crossStatus: keys.getIframeStatus() ? '1' : '0', lost, verify: result, dataFrom: dataFrom || '-99', match_md5_local, match_md5_iframe,
            isConnection: metric(isConnection), retryCount: metric(retryCount), initMatch: keys.initMatch ? '1' : '0', isNewCert: is_new_cert, isPubkeyTssign: is_pubkey_ts_sign,
            isPubKeyInit, isHasNewTssign: server ? '1' : '0', usage: usage || 'unknown', hostname: hostname || '', logId, ...headers },
          metrics: { startTime: startTime || 0, endTime: endTime || 0, loadTime: loadTime || 0 }, extras: '[redacted]' });
      }
    } catch (error) {
      // Source guards response, not response.config; malformed hook input can also escape this catch.
      this.emit('execute', { action: 'response', op: 'init', status: 'fail', ctx: { url: reportPath(response?.config!.url) || '' } });
      this.emit('error', { error, name: 'get sign data error in response' });
    }
    return response;
  }

  private processResponseHeaders(result: unknown, extras: DesktopWebSecureRequest['extras'], response: DesktopWebSecureResponse, updateData: boolean): Record<string, unknown> {
    try {
      const { certType, items = [] } = extras || {}, origins: Record<string, unknown> = {}, keys: string[] = [], values: unknown[] = [];
      const requestHeaders = response.reqHeaders, server = requestHeaders?.['bd-ticket-guard-client-data'] ? '1' : '0', url = response.config?.url;
      if (certType === 'header') return {};
      if (certType === 'cookie') {
        if (items && Array.isArray(items)) items.forEach(item => {
          const { key, value, from, origin } = (item || {}) as { key: string; value?: unknown; from?: unknown; origin?: unknown };
          origins[`${key.replace(/\//g, '_')}_origin`] = origin || '';
          origins[`${key.replace(/\//g, '_')}_from`] = from || '-99';
          origins[`${key.replace(/\//g, '_')}_status`] = value ? 'success' : 'success_null';
          if (value) { keys.push(key); values.push(value); }
        });
        if (result === '-99' && updateData && url) {
          // Protocol repair allowlist, NOT public creator/like/comment capability exposure.
          for (const path of ['/aweme/v1/web/commit/item/digg', '/aweme/v1/web/commit/follow/user', '/aweme/v1/web/comment/publish', '/web/api/media/aweme/create']) {
            if (url.match(new RegExp(path))) { if (keys.length) this.keys!.setKeysAndValues(keys, values); break; }
          }
        }
      }
      return { csr: requestHeaders?.['bd-ticket-guard-client-csr'] ? '1' : '0', cert: requestHeaders?.['bd-ticket-guard-client-cert'] ? '1' : '0', server,
        version: requestHeaders?.['bd-ticket-guard-version'] || '-99', iterVersion: requestHeaders?.['bd-ticket-guard-iteration-version'] || '-99', ...origins };
    } catch (error) { this.emit('error', { error, name: 'process Request Header Error' }); return {}; }
  }

  private signingInput(request: DesktopWebSecureRequest, ticket: unknown, pathname: string, rules: unknown): { req_content: string; sign_data: string; timestamp?: number } {
    try {
      const url = request?.url;
      if (!url) return { req_content: '', sign_data: '' };
      const timestamp = Math.floor(new this.context.Date().getTime() / 1000); let path: unknown = pathname;
      const list = rules as unknown[];
      if (list && list.length > 0) list.forEach(rule => {
        if (rule instanceof Array && rule.length > 1) {
          const pattern = new RegExp(rule[0]); if (url.match(pattern)) path = rule[1];
        }
      });
      return { req_content: 'ticket,path,timestamp', sign_data: `ticket=${ticket}&path=${path}&timestamp=${timestamp}`, timestamp };
    } catch (error) { this.emit('error', { error, name: 'request process sign data fail' }); return { req_content: '', sign_data: '' }; }
  }
  private readSignature(pathname: string, ticket: unknown): { signStr: string; algoType: string | undefined } | null {
    try {
      const cached = this.signatures[pathname];
      if (!cached || cached.ticket !== ticket || new this.context.Date().getTime() >= (cached.timeout as number)) return null;
      if (cached.signStr) return { signStr: cached.signStr, algoType: cached.algoType };
    } catch { /* Wn treats invalid cache entries as misses, without deletion. */ }
    return null;
  }
  private writeSignature(pathname: string, ticket: unknown, signStr: string, algoType: string | undefined): void {
    try {
      const now = new this.context.Date().getTime();
      // Deliberately preserve JS addition (a string TTL concatenates), not numeric normalization.
      this.signatures[pathname] = { timeout: now + (this.ttl as number), signStr, ticket, createTime: now, algoType };
    } catch { /* Jn ignores cache write failures. */ }
  }
}
