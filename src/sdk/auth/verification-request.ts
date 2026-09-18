/** AccountSDK955 request pipelines. Kept self-contained for the manual page. */
export interface VerificationRequestConfig {
  url?: string;
  baseURL?: string;
  method?: string;
  header?: Record<string, string>;
  params?: Record<string, unknown>;
  commonParams?: Record<string, unknown>;
  data?: unknown;
  encryptFields?: readonly string[];
  needFormData?: boolean;
  timeout?: number;
  pathType?: string;
  validateStatus?: (status: number) => boolean;
  getCacheInfo?: (common?: Record<string, unknown>) => Promise<Record<string, unknown> | null | undefined>;
}

export type VerificationPipeline = 'raw' | 'fetch' | 'fetchSec';
export interface VerificationResponse {
  data: unknown;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: VerificationRequestConfig;
}
export interface VerificationRequestChallenge {
  verifyData: string;
  responseContext: VerificationResponse;
  retry(kind: 'captcha' | 'secondary', fp?: string): Promise<VerificationResponse>;
}

/** No account credentials here: the transport injects the owning connection's CSRF. */
export function createVerificationRequests(options: {
  origin: string;
  transport(request: { url: string; method: string; headers: Record<string, string>; body: unknown; timeout: number },
    pipeline: VerificationPipeline): Promise<{ rawText: string; status: number; statusText: string; headers: Record<string, string> }>;
  verify(challenge: VerificationRequestChallenge): Promise<VerificationResponse>;
  query?: () => Record<string, unknown>;
  initializeVerification?: (info: Record<string, unknown>) => void;
}) {
  let secureInfo: Record<string, unknown> | undefined;
  const encryptedFields = ['mobile', 'email', 'password', 'code', 'account', 'sms_code', 'email_code', 'type',
    'sms_type', 'ect_type', 'recaptcha_token', 'sms_code_key', 'username', 'unbind_exist', 'current_password', 'old_mobile'];
  const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object'
    ? value as Record<string, unknown> : undefined;
  const parseQuery = (text: string): Record<string, unknown> => {
    const result: Record<string, unknown> = Object.create(null);
    for (const item of text.split('&')) {
      const [key, value = ''] = item.split('=');
      if (key) result[key] = decodeURIComponent(value);
    }
    return result;
  };
  const form = (value: Record<string, unknown>) => Object.keys(value).map(key =>
    `${encodeURIComponent(key)}=${encodeURIComponent(typeof value[key] === 'object' ? JSON.stringify(value[key]) : String(value[key]))}`).join('&');
  const encrypt = (value: unknown, fields: readonly string[]): unknown => {
    if (typeof value !== 'object' || !fields.length) return value;
    const data: Record<string, unknown> = { mix_mode: 0, ...record(value) };
    let mixed = 0;
    for (const key of fields) {
      if (data[key] === undefined) continue;
      if (data[key] === null) throw new TypeError('Invalid AccountSDK encrypted field');
      // Same field codec as module83848.w; kept self-contained because this
      // function is also embedded into the manual browser verification page.
      const text = String(data[key]).replace(/[\uD800-\uDFFF]/g, '');
      data[key] = [...new TextEncoder().encode(text)].map(byte => (byte ^ 5).toString(16)).join('');
      mixed = 1;
    }
    data['mix_mode'] = data['fixed_mix_mode'] = mixed;
    return data;
  };
  const originRequest = async (input: VerificationRequestConfig, pipeline: VerificationPipeline): Promise<VerificationResponse> => {
    const config = { ...input, header: { ...input.header } };
    if (pipeline === 'fetchSec' && !secureInfo) {
      if (input.getCacheInfo) {
        secureInfo = await input.getCacheInfo(input.commonParams) || undefined;
        if (!secureInfo) {
          const query = options.query?.() || {};
          secureInfo = { aid: query['aid'], did: query['device_id'], iid: query['install_id'], app_name: query['app_name'], locale: query['locale'] };
        }
      } else {
        secureInfo = input.commonParams ? { aid: input.commonParams['aid'], did: '0', iid: '0',
          app_name: input.commonParams['app_name'], locale: input.commonParams['locale'] }
          : { did: '0', iid: '0', app_name: '', locale: 'zh' };
      }
      options.initializeVerification?.(secureInfo);
    }
    if (pipeline !== 'raw') {
      const fields = config.encryptFields ?? encryptedFields;
      if (config.data) config.data = encrypt(config.data, fields);
      if (config.params) config.params = encrypt(config.params, fields) as Record<string, unknown>;
      config.header['Accept'] ??= 'application/json, text/javascript';
      config.header['Content-Type'] ??= 'application/x-www-form-urlencoded';
      if (config.needFormData !== false && config.data !== null && typeof config.data === 'object') config.data = form(config.data as Record<string, unknown>);
      config.validateStatus ||= status => status >= 200 && status < 300;
    }
    const base = config.baseURL || options.origin;
    const inputUrl = config.url || '';
    const combined = /^([a-z][a-z\d+.-]*:)?\/\//i.test(inputUrl) ? inputUrl
      : `${base.replace(/\/+$/, '')}/${inputUrl.replace(/^\/+/, '')}`;
    const target = new URL(combined, options.origin);
    // AccountSDK's He parser keeps encoded keys and literal '+', takes the last
    // duplicate, and stringifies query arrays with commas (unlike its form Ye).
    const query = { ...parseQuery(target.search.slice(1)), ...config.params, ...config.commonParams };
    target.search = Object.keys(query).filter(Boolean).map(key => `${key}=${encodeURIComponent(String(query[key]))}`).join('&');
    const timeout = config.timeout ?? 3000;
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new RangeError('Invalid verification timeout');
    if (config.data === undefined) {
      for (const key of Object.keys(config.header)) if (key.toLowerCase() === 'content-type') delete config.header[key];
    }
    const result = await options.transport({ url: target.toString(), method: (config.method || 'GET').toUpperCase(),
      headers: config.header, body: config.data || null, timeout }, pipeline);
    if (config.validateStatus && result.status && !config.validateStatus(result.status)) {
      throw new Error(`Request failed with status code ${result.status}`);
    }
    let data: unknown = result.rawText;
    if (data) {
      try { data = JSON.parse(result.rawText); } catch { throw result.rawText; }
    }
    const response: VerificationResponse = { data, status: result.status, statusText: result.statusText, headers: result.headers, config };
    if (pipeline !== 'fetchSec') return response;
    const envelope = record(data), payload = record(envelope?.['data']);
    const decision = payload?.['verify_center_decision_conf'] || payload?.['verify_center_secondary_decision_conf']
      || envelope?.['verify_center_decision_conf'] || envelope?.['verify_center_secondary_decision_conf'];
    if (!decision) return response;
    if (typeof decision !== 'string') throw new TypeError('Invalid verification decision');
    const code = payload?.['error_code'] || envelope?.['error_code'];
    const smsKey = payload?.['sms_code_key'] || envelope?.['sms_code_key'];
    return options.verify({ responseContext: response, verifyData: decision,
      retry: (kind, fp) => {
        const retry: VerificationRequestConfig = { ...config, encryptFields: [] };
        if (kind === 'captcha') retry.params = { ...config.params, fp };
        else {
          // C955's secondary callback always assigns o.data || ''. This affects
          // the retry's Content-Type even though XHR sends falsy bodies as null.
          retry.data = config.data || '';
          if (code === 2046 && smsKey) {
            // This is not Ge.parse(query): preserve empty keys and convert an
            // absent '=' value with decodeURIComponent(undefined), as C955 does.
            if (typeof retry.data !== 'string') throw new TypeError('Invalid secondary verification form body');
            const data: Record<string, unknown> = Object.create(null);
            if (retry.data) for (const pair of retry.data.split('&')) {
              const [key, raw] = pair.split('=');
              const value = decodeURIComponent(String(raw));
              data[key!] = value;
              if (/^\{.*\}$/.test(value)) {
                try { data[key!] = JSON.parse(value); } catch { /* Preserve malformed object-looking strings. */ }
              }
            }
            retry.data = form({ ...data, sms_code_key: smsKey });
          }
        }
        // The source resumes originRequest, not public request: unwrap only once.
        return originRequest(retry, pipeline);
      },
    });
  };
  const request = async (config: VerificationRequestConfig, pipeline: VerificationPipeline): Promise<unknown> => {
    const response = await originRequest(config, pipeline);
    const body = record(response.data);
    if (config.pathType === 'sso') {
      if (body?.['message'] === 'success' || body?.['error_code'] === 0) return response.data;
      throw response.data;
    }
    if (body?.['message']) {
      if (body['message'] === 'success') return response.data;
      throw response.data;
    }
    throw response;
  };
  return {
    request: (config: VerificationRequestConfig = {}) => request(config, 'raw'),
    fetch: (config: VerificationRequestConfig = {}) => request(config, 'fetch'),
    fetchSec: (config: VerificationRequestConfig = {}) => request(config, 'fetchSec'),
  };
}
