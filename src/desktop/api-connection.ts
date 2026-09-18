import { randomBytes, randomUUID } from 'crypto';
import { activateDesktopDevice, readDesktopHardware, registerDesktopDevice, type DesktopHardware } from './device-registration.js';
import { getLogger } from '../logger.js';
import { guidDeviceId } from '../store/device-id.js';
import { generateJumpbyteABogus } from '../anti-bot/aBogus.js';
import { CookieJar } from '../http/cookie-jar.js';
import type { HttpResponse } from '../http/types.js';
import { parseJsonResponse } from '../http/response.js';
import {
  encodeBrowserInfo,
  mixModeEncode,
  mixModeEncodeMobile,
  mixModeEncodeSendCodeType,
} from '../passport/index.js';
import {
  DESKTOP_APP_VERSION,
  DESKTOP_LOGIN_USER_AGENT,
  QR_DEFAULT_BODY,
} from './constants.js';
import { desktopLoginBrowserInfo } from './default-browser-info.js';
import {
  encodeFormBody,
  randomBizTraceId,
  resumePassportQuery,
  signPassportQuery,
  type SignPassportExtras,
} from './passport-query.js';
import type {
  CheckQrconnectResponse,
  GetQrcodeResponse,
  PassportApiResponse,
  PassportLoginOptions,
  PassportTokenBeatScene,
  QrCodeInfo,
  QrMfaChallenge,
} from './types.js';
import type { SessionProbeResult } from '../store/types.js';
import {
  buildPassportAidSign,
  passportNoonUtcTs,
} from '../passport/signQs.js';
import { DesktopTicketGuard, desktopCertificateRequest, type DesktopTicketGuardState } from './ticket-guard.js';
import { encodeActionVerificationPack } from './second-verify.js';
import { desktopSettingsUrl, parseDesktopSettings, readDesktopSettings, type DesktopApplicationSettings } from './settings.js';
import { PassportRequestError } from './passport-error.js';


export interface ApiConnectionOptions {
  /** @internal Account-scoped state; never import another account's key/ticket. */
  desktopTicketGuard?: DesktopTicketGuardState;
  /** @internal Account-scoped cache for the immutable BDTicket startup settings snapshot. */
  desktopSettingsDirectory?: string;
  /** Default request deadline, 30 seconds. An explicit RequestInit.signal takes precedence. */
  requestTimeoutMs?: number;
  userAgent?: string;
  /** 浏览器复制的 Cookie，或上一轮 Session */
  initialCookies?: string;
  accountSdkSourceInfo?: string;
  /** 未提供 accountSdkSourceInfo 时编码旧兼容模板；不代表已采集当前宿主 browserInfo。 */
  useDefaultBrowserInfo?: boolean;
  /** Explicit signing-token override, not a Cookie or a captured BDMS xmst context. */
  msToken?: string;
  /** 手动覆盖；设置后不再本地计算 a_bogus */
  aBogus?: string;
  /** 默认 true：有 userAgent 且未手动传 a_bogus 时自动计算 */
  enableABogus?: boolean;
  screenFingerprint?: string;
  bizTraceId?: string;
  deviceId?: string;
  installId?: string;
  guid?: string;
  screenWidth?: number | string;
  screenHeight?: number | string;
  verifyPortrait?: string;
}

export class ApiConnection {
  #ticketGuard: DesktopTicketGuard | undefined;
  #persistTicketGuard: ((state: DesktopTicketGuardState) => void) | undefined;
  #certificateTask: Promise<void> | undefined;
  #ticketStateDirty = false;
  #authenticationEpoch = 0;
  #tokenBeatTraceId: string | undefined;
  readonly #qrcodeRetries = new WeakMap<PassportRequestError, { epoch: number; query: Record<string, string> }>();
  readonly #passportRetries = new WeakMap<PassportApiResponse | CheckQrconnectResponse, {
    epoch: number; path: string; query: Record<string, string>; bodyWire?: string;
  }>();
  readonly #ticketSettings: DesktopApplicationSettings | undefined;
  readonly jar: CookieJar;
  private readonly requestTimeoutMs: number;
  private readonly userAgent: string;
  private accountSdkSourceInfo: string;
  private readonly defaultBrowserInfo: boolean;
  private aBogus: string | undefined;
  #signingToken: string | undefined;
  private readonly verifyPortrait: string;
  private readonly enableABogus: boolean;
  private readonly screenFingerprint: string | undefined;
  private bizTraceId: string;
  private deviceId: string;
  private installId: string;
  private deviceInitialization?: Promise<{ deviceId: string; installId: string }>;
  private deviceTimer?: ReturnType<typeof setTimeout>;
  private deviceUpdate?: (device: { deviceId: string; installId: string }) => void;
  private deviceStateDirty = false;
  private readonly guid: string;
  private readonly screenWidth: number;
  private readonly screenHeight: number;

  constructor(config: ApiConnectionOptions = {}) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 2_147_483_647) {
      throw new RangeError('requestTimeoutMs must be an integer between 1 and 2147483647');
    }
    this.installId = config.installId ?? '0';
    this.guid = config.guid?.trim() || randomUUID().replaceAll('-', '');
    this.deviceId = config.deviceId ?? '0';
    const screen = screenSizeFromFingerprint(config.screenFingerprint);
    this.screenWidth = positiveInteger(config.screenWidth, screen?.width ?? 1728, 'screenWidth');
    this.screenHeight = positiveInteger(config.screenHeight, screen?.height ?? 1117, 'screenHeight');
    this.jar = new CookieJar(config.initialCookies);
    this.userAgent = config.userAgent ?? DESKTOP_LOGIN_USER_AGENT;
    const useDefaultBrowser =
      config.useDefaultBrowserInfo ?? !config.accountSdkSourceInfo;
    this.defaultBrowserInfo = useDefaultBrowser && !config.accountSdkSourceInfo;
    this.accountSdkSourceInfo =
      config.accountSdkSourceInfo ??
      (useDefaultBrowser
        ? encodeBrowserInfo(desktopLoginBrowserInfo(this.deviceId))
        : '');
    this.#signingToken = config.msToken;
    this.aBogus = config.aBogus;
    this.enableABogus = config.enableABogus ?? true;
    this.screenFingerprint = config.screenFingerprint;
    this.verifyPortrait = config.verifyPortrait ?? `${randomUUID()}.login`;
    this.bizTraceId = config.bizTraceId ?? randomBizTraceId();
    this.#ticketSettings = config.desktopSettingsDirectory
      ? readDesktopSettings(config.desktopSettingsDirectory, this.getApplicationSettingsUrl()) : undefined;
    if (config.desktopTicketGuard) this.#ticketGuard = new DesktopTicketGuard(config.desktopTicketGuard, this.#ticketSettings);
  }

  getCookies(): string {
    return this.jar.toHeader();
  }

  /** @internal Retire in-flight authentication updates, not keys or delivery outcomes. */
  invalidateAuthenticationResponses(): void {
    this.#authenticationEpoch++;
    this.#tokenBeatTraceId = undefined;
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    delete this.deviceTimer;
    delete this.deviceInitialization;
    delete this.deviceUpdate;
  }

  /** Install account persistence before publishing a public key in login requests. */
  enableTicketGuard(persist: (state: DesktopTicketGuardState) => void): void {
    const guard = this.#ticketGuard ?? new DesktopTicketGuard(undefined, this.#ticketSettings);
    persist(guard.exportState());
    this.#ticketGuard = guard;
    this.#persistTicketGuard = persist;
    this.#ticketStateDirty = false;
  }

  /** @internal Start the device-only certificate loader at login/restore startup. */
  startTicketGuard(): void {
    if (!this.#ticketGuard || !this.#persistTicketGuard) {
      throw new Error('启动验证证书前必须先保存账号密钥');
    }
    if (this.#ticketStateDirty) this.persistTicketState();
    this.initializeTicketCertificate();
  }

  /** @internal Sensitive persistence snapshot, never a logging/diagnostic value. */
  getTicketGuardState(): DesktopTicketGuardState | undefined {
    return this.#ticketGuard?.exportState();
  }

  hasBoundTicket(): boolean {
    return !!this.#ticketGuard && (this.#ticketGuard.hasBinding(this.jar.get('sessionid') ?? '')
      || this.#ticketGuard.hasBinding(this.jar.get('sessionid_ss') ?? ''));
  }

  /** @internal Business preflight must respect the startup Session guard policy. */
  requiresTicket(url: string): boolean {
    return this.#ticketGuard?.requiresTicket(new URL(url)) ?? true;
  }

  /** A failed write blocks subsequent account dispatch until the same current snapshot can be saved. */
  private persistTicketState(): void {
    if (!this.#ticketGuard) return;
    this.#ticketStateDirty = true;
    this.#persistTicketGuard?.(this.#ticketGuard.exportState());
    this.#ticketStateDirty = false;
  }

  private initializeTicketCertificate(): void {
    this.#certificateTask ??= (async () => {
      if (!this.#ticketGuard || !this.#ticketGuard.needsCertificate()) return;
      const request = desktopCertificateRequest(this.deviceId, this.installId);
      let data: unknown;
      try {
        const response = await fetch(request.url, {
          ...request.init, redirect: 'error', signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 10_000)),
        });
        if (!response.ok) throw new Error('Certificate HTTP failure');
        data = await response.json();
        this.#ticketStateDirty = true;
        this.#ticketGuard.acceptCertificateResponse(data);
      } catch {
        // Native can continue with REE ECDSA when ECDH has no server cert.
        getLogger('Desktop:TicketGuard').warn('服务端证书更新未获确认，保留已有证书或使用 REE 签名；不代表票据已绑定');
      }
      // Save background/partial updates even without another business request.
      // A failed save leaves the dispatch barrier dirty, not an unhandled rejection
      // or a reason to repeat certificate retrieval/the previous account operation.
      if (this.#ticketStateDirty) {
        try { this.persistTicketState(); }
        catch {
          getLogger('Desktop:TicketGuard').error('认证状态保存失败，后续账号请求将等待保存恢复；不会自动重发业务动作');
        }
      }
    })();
  }

  /** Explicit in-memory signing override; never writes Cookie or Session storage. */
  setMsToken(value: string): void {
    this.#signingToken = value;
  }

  setABogus(value: string): void {
    this.aBogus = value;
  }

  getUserAgent(): string {
    return this.userAgent;
  }

  /** Explicit signing override, not the msToken Cookie (available through jar). */
  getMsToken(): string | undefined {
    return this.#signingToken;
  }

  getAccountSdkSourceInfo(): string {
    return this.accountSdkSourceInfo;
  }

  getBizTraceId(): string {
    return this.bizTraceId;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getInstallId(): string {
    return this.installId;
  }

  /** Application configuration identity; distinct from authenticated user privacy settings. */
  getApplicationSettingsUrl(): string {
    return desktopSettingsUrl(this.deviceId, this.installId, process.platform === 'darwin' ? '20002' : '0');
  }

  async getApplicationSettings(signal?: AbortSignal): Promise<DesktopApplicationSettings | undefined> {
    if (this.deviceId === '0') return undefined;
    const deadline = AbortSignal.timeout(this.requestTimeoutMs);
    const response = await fetch(this.getApplicationSettingsUrl(), { method: 'GET',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    // SettingsMgr uses plain fetch: no Cookie, passport signing or BDTicket binding here.
    if (!response.ok) throw new Error(`Desktop application settings HTTP ${response.status}`);
    return parseDesktopSettings(await response.json());
  }

  /** @internal Replace the current pending/restored account's persistence owner. */
  setDeviceUpdateHandler(handler: (device: { deviceId: string; installId: string }) => void): void {
    this.deviceUpdate = handler;
  }

  /** @internal Desktop app-ready: cold registration blocks; a cached DID refreshes after 60 seconds. */
  startDeviceLifecycle(): Promise<{ deviceId: string; installId: string }> {
    if (!this.deviceId || this.deviceId === '0') return this.initializeDevice();
    if (!this.deviceInitialization && !this.deviceTimer) {
      this.deviceTimer = setTimeout(() => {
        delete this.deviceTimer;
        void this.initializeDevice().catch(() => {
          getLogger('Desktop:Device').warn('设备刷新未完成；已保留当前账号，不重建 IM 连接');
        });
      }, 60_000);
      this.deviceTimer.unref();
    }
    return Promise.resolve({ deviceId: this.deviceId, installId: this.installId });
  }

  /** Register once per active lifecycle, sharing concurrent callers. */
  initializeDevice(): Promise<{ deviceId: string; installId: string }> {
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    delete this.deviceTimer;
    this.deviceInitialization ??= this.registerDevice();
    return this.deviceInitialization;
  }

  private persistDeviceState(): void {
    if (!this.deviceUpdate) throw new Error('设备身份尚未绑定持久化账号');
    this.deviceUpdate({ deviceId: this.deviceId, installId: this.installId });
    this.deviceStateDirty = false;
  }

  private async registerDevice(): Promise<{ deviceId: string; installId: string }> {
    const logger = getLogger('Desktop:Device');
    const epoch = this.#authenticationEpoch;
    const ensureActive = (): void => {
      if (epoch !== this.#authenticationEpoch) throw new Error('设备注册已取消');
    };
    let hardware: DesktopHardware | undefined;
    try {
      hardware = await readDesktopHardware();
      ensureActive();
      const registered = await registerDesktopDevice(hardware, { deviceId: this.deviceId, installId: this.installId });
      ensureActive();
      this.deviceId = registered.deviceId;
      this.installId = registered.installId;
    } catch {
      ensureActive();
      // Desktop keeps an existing DID; only an absent identity falls back to GUID hash.
      if (!this.deviceId || this.deviceId === '0') {
        this.deviceId = guidDeviceId(this.guid);
      }
      logger.warn('设备注册未获确认，保留现有设备身份；下次启动重试');
    }
    // Desktop updates consumers and attempts activation after registration's
    // success OR failure/fallback branch. Do not keep browserInfo's initial 0.
    if (this.defaultBrowserInfo) this.accountSdkSourceInfo = encodeBrowserInfo(desktopLoginBrowserInfo(this.deviceId));
    if (this.deviceUpdate) {
      this.deviceStateDirty = true;
      this.persistDeviceState();
    }
    ensureActive();
    if (hardware && this.deviceId !== '0') {
      try {
        await activateDesktopDevice(hardware, { deviceId: this.deviceId, installId: this.installId });
      } catch {
        logger.warn('设备激活未获确认，保留当前设备身份；下次启动重试');
      }
    }
    ensureActive();
    return { deviceId: this.deviceId, installId: this.installId };
  }

  getGuid(): string {
    return this.guid;
  }

  getScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  /** 区分有效、明确失效和网络/协议异常；异常不能被误判为 Cookie 过期。 */
  async probeSession(
    signal?: AbortSignal,
    onVerification?: (response: PassportApiResponse) => Promise<PassportLoginOptions | undefined>,
  ): Promise<SessionProbeResult> {
    signal?.throwIfAborted();
    try {
      let accountInfo = await this.getPassportAccountInfo(signal);
      signal?.throwIfAborted();
      while (accountInfo.message !== 'success' && onVerification) {
        const options = await onVerification(accountInfo);
        signal?.throwIfAborted();
        if (!options) break;
        accountInfo = await this.getPassportAccountInfo(signal, { ...options, retry: accountInfo });
        signal?.throwIfAborted();
      }
      if (accountInfo.message !== 'success') {
        const code = accountInfo.data?.error_code;
        return {
          status: 'error',
          reason: `Passport account check rejected session (code=${Number.isSafeInteger(code) ? code : 'unknown'})`,
        };
      }
      // Passport identity is not necessarily the Douyin IM UID. Resolve the
      // latter with the same post-response Cookie snapshot before store commit.
      const response = await this.getSelfProfile(signal);
      signal?.throwIfAborted();
      const statusCode = Number(response['status_code']);
      const user = asRecord(response['user']);
      const uid = numericIdentity(user?.['uid'] ?? user?.['user_id_str'] ?? user?.['user_id']);
      if (uid && statusCode === 0) {
        const screenName = stringValue(user?.['nickname'] ?? user?.['screen_name'] ?? user?.['name']);
        return { status: 'alive', uid, ...(screenName ? { screenName } : {}), reason: 'ok' };
      }
      if (statusCode === 8 || statusCode === 9) {
        return { status: 'expired', reason: `self profile rejected session (status=${statusCode})` };
      }
      return {
        status: 'error',
        reason: stringValue(response['status_msg'] ?? response['message']) || 'self profile response missing user',
      };
    } catch (error) {
      signal?.throwIfAborted();
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** POST `/passport/web/send_code/` — `mix_mode=1` */
  async sendCode(
    mobileDigits: string,
    options: PassportLoginOptions = {},
  ): Promise<PassportApiResponse> {
    const body: Record<string, string> = {
      is6Digits: '1',
      mix_mode: '1',
      mobile: mixModeEncodeMobile(mobileDigits),
      type: mixModeEncodeSendCodeType(),
      fixed_mix_mode: '1',
    };
    appendVerificationFields(body, options);
    return this.passportFormPost('/passport/web/send_code/', body, options);
  }

  /** POST `/passport/web/send_voice_code/` — 短信收不到时请求语音验证码。 */
  async sendVoiceCode(
    mobileDigits: string,
    options: PassportLoginOptions = {},
  ): Promise<PassportApiResponse> {
    const body: Record<string, string> = {
      is6Digits: '1',
      mix_mode: '1',
      mobile: mixModeEncodeMobile(mobileDigits),
      type: mixModeEncodeSendCodeType(),
      fixed_mix_mode: '1',
    };
    appendVerificationFields(body, options);
    return this.passportFormPost('/passport/web/send_voice_code/', body, options);
  }

  /** POST `/passport/web/sms_login/` */
  async smsLogin(
    mobileDigits: string,
    code: string,
    options: PassportLoginOptions = {},
  ): Promise<PassportApiResponse> {
    const body: Record<string, string> = {
      ...(options.subAccount ? { safe_mobile_register_to_login: 'true' } : {}),
      service: 'https://www.douyin.com',
      mix_mode: '1',
      mobile: mixModeEncodeMobile(mobileDigits),
      code: mixModeEncode(code),
      fixed_mix_mode: '1',
    };
    appendSubAccountSelection(body, options);
    body['login_only'] = 'true';
    appendVerificationFields(body, options);
    return this.passportFormPost('/passport/web/sms_login/', body, options);
  }

  /** POST `/passport/web/user/login/` — 账号字段名为 `account` */
  async userLogin(
    mobileDigits: string,
    password: string,
    options: PassportLoginOptions = {},
  ): Promise<PassportApiResponse> {
    const body: Record<string, string> = {
      ...(options.subAccount ? { safe_mobile_register_to_login: 'true' } : {}),
      need_check_base_info: 'true',
      service: 'https://www.douyin.com',
      account_type: '0',
      mix_mode: '1',
      account: mixModeEncodeMobile(mobileDigits),
      password: mixModeEncode(password),
      fixed_mix_mode: '1',
    };
    appendSubAccountSelection(body, options);
    appendVerificationFields(body, options);
    return this.passportFormPost('/passport/web/user/login/', body, options);
  }

  /**
   * POST `/ttwid/check/` — 引导链一步；失败不阻断 QR（部分环境可跳过）。
   */
  async ttwidCheck(): Promise<HttpResponse<unknown>> {
    const body = JSON.stringify({
      aid: 339757,
      service: 'imdesktop.douyin.com',
      unionHost: 'https://ttwid.bytedance.com',
      host: 'https://imdesktop.douyin.com',
      union: false,
      needFid: false,
      fid: '',
      migrate_priority: 0,
    });
    return this.requestRaw('https://imdesktop.douyin.com/ttwid/check/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  /** GET `/passport/web/get_qrcode/`; optional retry must originate from this connection. */
  async getQrcode(retry?: { error: PassportRequestError; fp?: string }): Promise<QrCodeInfo> {
    const epoch = this.#authenticationEpoch;
    const previous = retry ? this.#qrcodeRetries.get(retry.error) : undefined;
    if (retry && (!previous || previous.epoch !== epoch)) throw new Error('二维码验证请求已失效或不属于当前连接');
    const baseQuery = this.desktopPassportBaseQuery({
      next: 'https://www.douyin.com',
      need_logo: 'false',
      need_short_url: 'false',
    });
    const { search, query } = previous
      ? resumePassportQuery(previous.query, retry?.fp, this.signExtras())
      : signPassportQuery(baseQuery, {}, this.signExtras());
    const res = await this.requestJson<GetQrcodeResponse>(
      `https://imdesktop.douyin.com/passport/web/get_qrcode/?${search}`,
      { method: 'GET' },
    );
    const d = res.data.data;
    if (res.data.message !== 'success') {
      const error = new PassportRequestError('/passport/web/get_qrcode/', asRecord(d) ?? {});
      // Axios params do not contain the token/ABogus added later by BDMS's XHR hook.
      const signedParams = { ...query };
      delete signedParams['msToken']; delete signedParams['a_bogus'];
      this.#qrcodeRetries.set(error, { epoch, query: signedParams });
      throw error;
    }
    if (typeof d?.qrcode !== 'string' || !d.qrcode || typeof d.token !== 'string' || !d.token) {
      throw new Error('get_qrcode response missing qrcode or token');
    }
    const info: QrCodeInfo = {
      token: d.token,
      qrcodeBase64: d.qrcode,
      expireTime: d.expire_time,
    };
    if (d.qrcode_index_url) {
      info.qrcodeIndexUrl = d.qrcode_index_url;
    }
    return info;
  }

  /** POST `/passport/web/check_qrconnect/` */
  async checkQrconnect(
    token: string,
    bodyOverrides?: Partial<typeof QR_DEFAULT_BODY>,
    options: PassportLoginOptions = {},
  ): Promise<CheckQrconnectResponse> {
    const body: Record<string, string> = {
      need_logo: QR_DEFAULT_BODY.need_logo,
      need_short_url: QR_DEFAULT_BODY.need_short_url,
      is_frontier: QR_DEFAULT_BODY.is_frontier,
      token,
      is_new_login: QR_DEFAULT_BODY.is_new_login,
      next: QR_DEFAULT_BODY.next,
      ...bodyOverrides,
    };
    appendVerificationFields(body, options);
    return this.passportFormPost<CheckQrconnectResponse>('/passport/web/check_qrconnect/', body, options);
  }

  /** Business SecondVerify uses a raw pack request, not the normal login middleware. */
  async packActionVerification(decision: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = 'https://imdesktop.douyin.com/passport/safe/pack_verify_ways_data/';
    const csrf = this.accountSdkCsrfToken();
    const response = await this.requestRaw(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/javascript',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(csrf ? { 'x-tt-passport-csrf-token': csrf } : {}),
      },
      body: encodeActionVerificationPack(decision, this.deviceId, this.installId),
      ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) } : {}),
    }, false);
    const result = parseJsonResponse<Record<string, unknown>>(response, url);
    // C955 Request.fetch projects Passport by outer message first. Inner
    // error_code is configuration data here, not a second success predicate.
    if (result['message'] !== 'success') throw new PassportRequestError(url, asRecord(result['data']) ?? result);
    return asRecord(result['data']) ?? result;
  }

  private accountSdkCsrfToken(): string {
    // C955 Ze/pt: legacy unescape (not URI/UTF-8 decoding), then primary/fallback
    // selection. Decode only this header view; never rewrite persisted Cookie.
    return unescape(this.jar.get('passport_csrf_token') || '')
      || unescape(this.jar.get('passport_csrf_token_default') || '');
  }

  /** @internal 验证脚本专用请求，避免向验证中心泄漏 Desktop Cookie 或 Passport 请求头。 */
  async requestVerificationRaw(
    url: string,
    init: RequestInit,
    context: 'login' | 'action' = 'login',
    pipeline?: 'raw' | 'fetch' | 'fetchSec' | 'xhr',
  ): Promise<HttpResponse<string>> {
    const desktop = new URL(url).origin === 'https://imdesktop.douyin.com';
    const headers = new Headers(init.headers);
    if (desktop && pipeline !== 'raw') {
      const csrf = pipeline === 'fetch' || pipeline === 'fetchSec'
        ? this.accountSdkCsrfToken()
        : this.jar.get('passport_csrf_token') || this.jar.get('passport_csrf_token_default') || '';
      // AccountSDK pt only writes a truthy token; normal Passport keeps its own contract.
      if (csrf || pipeline === undefined || pipeline === 'xhr') headers.set('x-tt-passport-csrf-token', csrf);
    }
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(this.requestTimeoutMs)]) : undefined;
    const { response: res, data: rawText } = await this.fetchResponse(url,
      { ...init, ...(signal ? { signal } : {}), headers: Object.fromEntries(headers) },
      // Official SV's direct reqwest/XHR has its own headers, not the normal
      // AccountSDK login signing middleware. Cookie/BDTicket remain in fetchResponse.
      desktop && context === 'login' && pipeline === undefined, response => response.text(), desktop);
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      data: rawText,
      rawText,
    };
  }

  /** 旧式扫码 MFA 短信请求；来源为 jumpbyte lite 分支，非已核对的安装版 normal 中间件。 */
  async sendQrMfaCode(challenge: QrMfaChallenge, signal?: AbortSignal): Promise<PassportApiResponse> {
    return this.desktopLitePassportFormPost(
      '/passport/web/send_code/',
      this.qrMfaBody(challenge, { is6Digits: '1' }),
      signal,
    );
  }

  /** 校验扫码登录 MFA 短信验证码。 */
  async validateQrMfaCode(
    challenge: QrMfaChallenge,
    code: string,
    signal?: AbortSignal,
  ): Promise<PassportApiResponse> {
    return this.desktopLitePassportFormPost(
      '/passport/web/validate_code/',
      this.qrMfaBody(challenge, { code: mixModeEncode(code) }),
      signal,
    );
  }

  /** Desktop AuthManager.checkLogin → Account SDK getUserInfo; not the IM profile endpoint. */
  async getPassportAccountInfo(signal?: AbortSignal, options: PassportLoginOptions = {}): Promise<PassportApiResponse> {
    return this.passportGet('/passport/account/info/v2/', 'account-info', {}, signal, options);
  }

  /** One Desktop tokenBeat request; scheduling/activity ownership is deliberately separate. */
  async sendPassportTokenBeat(scene: PassportTokenBeatScene, signal?: AbortSignal, options: PassportLoginOptions = {}): Promise<PassportApiResponse> {
    signal?.throwIfAborted();
    if (scene !== 'boot' && scene !== 'active' && scene !== 'polling') {
      throw new TypeError('Unsupported Passport tokenBeat scene');
    }
    return this.passportGet('/passport/token/beat/web/', 'token-beat', { scene }, signal, options);
  }

  private async passportGet(
    path: string,
    scope: 'account-info' | 'token-beat',
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    options: PassportLoginOptions,
  ): Promise<PassportApiResponse> {
    signal?.throwIfAborted();
    const epoch = this.#authenticationEpoch;
    const previous = options.retry ? this.#passportRetries.get(options.retry) : undefined;
    if (options.retry && (!previous || previous.epoch !== epoch || previous.path !== path
      || Object.entries(params).some(([key, value]) => previous.query[key] !== value))) {
      throw new Error('Passport 验证请求已失效或不属于当前连接及接口');
    }
    const { search, query } = previous
      ? resumePassportQuery(previous.query, options.fp, this.signExtras())
      : signPassportQuery(this.desktopPassportBaseQuery(params, scope), {}, this.signExtras());
    const response = await this.requestJson<PassportApiResponse>(
      `https://imdesktop.douyin.com${path}?${search}`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
    if (response.data.message !== 'success') {
      const signedParams = { ...query };
      delete signedParams['msToken']; delete signedParams['a_bogus'];
      this.#passportRetries.set(response.data, { epoch, path, query: signedParams });
    }
    // Keep business errors/challenges and numeric/string error codes intact.
    return response.data;
  }

  /** Renderer `fetchSelfProfile` 使用的当前账号资料与 Session 状态接口。 */
  async getSelfProfile(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      aid: '339757',
      version_name: DESKTOP_APP_VERSION,
      version_code: DESKTOP_APP_VERSION,
      device_platform: process.platform,
      screen_width: String(this.screenWidth),
      screen_height: String(this.screenHeight),
      browser_language: 'zh-CN',
      browser_platform: process.platform === 'win32' ? 'Win32' : 'MacIntel',
      browser_name: 'Mozilla',
      browser_version: this.userAgent.replace(/^Mozilla\//, ''),
      browser_online: 'true',
      cookie_enabled: 'true',
      device_id: this.deviceId,
      did: this.deviceId,
      iid: this.installId,
      awemeim_guid: this.guid,
      channel: process.platform === 'darwin' ? '20002' : '0',
    });
    const url = `https://imdesktop.douyin.com/aweme/v1/web/user/profile/self/?${params}`;
    const res = await this.requestRaw(url, { method: 'GET', ...(signal ? { signal } : {}) }, true);
    return parseJsonResponse<Record<string, unknown>>(res, url);
  }

  signExtrasForPath(body?: Record<string, string>): SignPassportExtras {
    return this.signExtras(body);
  }

  private async passportFormPost<T extends PassportApiResponse | CheckQrconnectResponse = PassportApiResponse>(
    path: string,
    body: Record<string, string>,
    options: PassportLoginOptions = {},
  ): Promise<T> {
    const epoch = this.#authenticationEpoch;
    const previous = options.retry ? this.#passportRetries.get(options.retry) : undefined;
    if (options.retry && (!previous || previous.epoch !== epoch || previous.path !== path)) {
      throw new Error('Passport 验证请求已失效或不属于当前连接及接口');
    }
    let bodyWire = previous?.bodyWire ?? encodeFormBody(body);
    if (previous && options.verificationFields && Object.keys(options.verificationFields).length) {
      // C321 $u.show uses module83848 yJ, which splits without decoding.
      // qD then encodes the retained wire values again when adding requestData.
      const originalBody = Object.fromEntries(bodyWire.split('&').map(pair => {
        const [key = '', value = ''] = pair.split('=');
        return [key, value];
      }));
      appendVerificationFields(originalBody, options);
      bodyWire = encodeFormBody(originalBody);
    }
    const extras = { ...this.signExtras(), bodyWire };
    const { search, query } = previous
      ? resumePassportQuery(previous.query, options.fp, extras)
      : signPassportQuery(this.desktopPassportBaseQuery({ ...(options.fp ? { fp: options.fp } : {}) }), body, extras);
    const res = await this.requestJson<T>(
      `https://imdesktop.douyin.com${path}?${search}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyWire,
      },
    );
    if (res.data.message !== 'success') {
      const signedParams = { ...query };
      delete signedParams['msToken'];
      delete signedParams['a_bogus'];
      this.#passportRetries.set(res.data, { epoch, path, query: signedParams, bodyWire });
    }
    return res.data;
  }

  private signExtras(body?: Record<string, string>): SignPassportExtras {
    // BDMS 1.0.1.7 owns xmst outside the Cookie jar. Until its context is wired
    // here, only an explicit override is available; Cookie reception/restoration
    // must not manufacture a signing token or a fresh random substitute.
    const msToken = this.getMsToken();
    const out: SignPassportExtras = {
      userAgent: this.userAgent,
      enableABogus: this.enableABogus,
      bodyWire: body ? encodeFormBody(body) : '',
      aBogusVariant: 'jumpbyte-desktop',
    };
    if (this.screenFingerprint) {
      out.screenFingerprint = this.screenFingerprint;
    }
    if (msToken) {
      out.msToken = msToken;
    }
    if (this.aBogus) {
      out.aBogus = this.aBogus;
      out.enableABogus = false;
    }
    return out;
  }

  /** Normal SDK ordering differs between login wrapper, getUserInfo and tokenBeat. */
  private desktopPassportBaseQuery(
    extra: Record<string, string> = {},
    scope: 'login' | 'account-info' | 'token-beat' = 'login',
  ): Record<string, string> {
    return {
      passport_jssdk_version: '2.4.12',
      passport_jssdk_type: 'normal',
      is_from_ttaccountsdk: '1',
      aid: '339757',
      language: 'zh',
      ts: passportNoonUtcTs(),
      ...(scope === 'login' ? {
        ...(extra['next'] ? { next: extra['next'] } : {}),
        ...(extra['need_logo'] ? { need_logo: extra['need_logo'] } : {}),
        ...(extra['need_short_url'] ? { need_short_url: extra['need_short_url'] } : {}),
        ...(extra['fp'] ? { fp: extra['fp'] } : {}),
        is_new_login: '1', is_from_iesaccountsaas: '1',
      } : scope === 'account-info' ? { is_from_iesaccountsaas: '1' } : { scene: extra['scene']! }),
      account_sdk_source: 'web',
      account_sdk_source_info: this.accountSdkSourceInfo,
      p_js_v: '2.4.12',
      p_js_t: 'pro',
      p_zt: '3.3.5',
      p_ver: '1.0.29',
      request_host: 'file://',
      p_bd: '1.0.1.7',
      // Login wrapper retains its SDK; getUserInfo's convenience wrapper creates
      // a new one each call; tokenBeat owns a separate long-lived SDK instance.
      biz_trace_id: scope === 'login' ? this.bizTraceId
        : scope === 'account-info' ? randomBizTraceId()
          : (this.#tokenBeatTraceId ??= randomBizTraceId()),
      ...(scope === 'account-info' ? { is_new_login: '1' } : {}),
      ...(scope === 'token-beat' ? { version: '1.2.13' } : {}),
      device_id: this.deviceId,
      iid: this.installId,
      version_code: DESKTOP_APP_VERSION,
      device_platform: 'PC',
    };
  }

  private desktopLitePassportBaseQuery(): Record<string, string> {
    return {
      passport_jssdk_version: '5.1.2',
      passport_jssdk_type: 'lite',
      is_from_ttaccountsdk: '1',
      aid: '339757',
      ts: passportNoonUtcTs(),
      language: 'zh',
      account_app_language: 'zh',
      is_new_login: '1',
      is_from_iesaccountsaas: '1',
      biz_trace_id: randomDesktopHex(8),
      new_authn_sdk_version: '1.0.0.421-web',
      device_id: this.deviceId,
      iid: this.installId,
      version_code: DESKTOP_APP_VERSION,
      device_platform: 'PC',
    };
  }

  private qrMfaBody(
    challenge: QrMfaChallenge,
    extra: Record<string, string>,
  ): Record<string, string> {
    const biz = challenge.biz_params ?? {};
    const common = challenge.common_params ?? {};
    const value = (source: Record<string, unknown>, key: string, fallback = ''): string => {
      const candidate = source[key];
      return candidate == null || candidate === '' ? fallback : String(candidate);
    };
    return {
      mix_mode: '1',
      type: '3737',
      encrypt_uid: challenge.encrypt_uid ?? '',
      verify_ticket: '',
      copywriting_key: value(common, 'copywriting_key', 'qr_connect'),
      ies_safety_diversion_tag: value(common, 'ies_safety_diversion_tag', 'mfa'),
      new_verify_flow: value(common, 'new_verify_flow'),
      std_verify_flow_id: value(biz, 'std_verify_flow_id', value(common, 'std_verify_flow_id')),
      std_verify_scene: value(biz, 'std_verify_scene', 'account_login'),
      std_verify_template: value(biz, 'std_verify_template', 'ato'),
      std_verify_token: value(biz, 'std_verify_token', value(common, 'std_verify_token')),
      std_verify_type: value(biz, 'std_verify_type', 'MFA'),
      std_verify_way: 'mobile_sms_verify',
      ...extra,
      aid: '339757',
      new_authn_sdk_version: '1.0.0.421-web',
    };
  }

  private async desktopLitePassportFormPost(
    path: string,
    body: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<PassportApiResponse> {
    const query = this.desktopLitePassportBaseQuery();
    query['msToken'] = randomMsToken();
    const bodyWire = encodeDesktopLitePassportParams(body);
    const queryWire = encodeDesktopLitePassportParams(query);
    const aBogusOptions: Parameters<typeof generateJumpbyteABogus>[0] = {
      userAgent: this.userAgent,
      query: queryWire,
      body: bodyWire,
    };
    const aBogus = generateJumpbyteABogus(aBogusOptions);
    const url = `https://imdesktop.douyin.com${path}?${queryWire}&a_bogus=${encodeURIComponent(aBogus)}`;
    const res = await this.requestJson<PassportApiResponse>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyWire,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    return res.data;
  }

  private passportHeaders(requestUrl: string): Record<string, string> {
    const parsedUrl = new URL(requestUrl);
    if (parsedUrl.origin === 'https://imdesktop.douyin.com') {
      const { pathname } = parsedUrl;
      if (pathname === '/ttwid/check/') {
        return {};
      }
      const baseHeaders = {
        Accept: 'application/json, text/plain, */*',
      };
      // Renderer business APIs use the common Axios client plus Session Guard;
      // Passport-only headers are injected by the login SDK, not by nativePost.
      if (!pathname.startsWith('/passport/')) return baseHeaders;
      const normalSdk = parsedUrl.searchParams.get('passport_jssdk_type') === 'normal';
      const primaryCsrf = this.jar.get('passport_csrf_token');
      const fallbackCsrf = this.jar.get('passport_csrf_token_default');
      const traceId = parsedUrl.searchParams.get('biz_trace_id') || randomDesktopHex(8);
      // Normal SDK jl signs with today's UTC noon even when an original query
      // ts wins the params merge during verification replay. Do not re-sign qs/sign.
      const aidSignTs = normalSdk ? passportNoonUtcTs() : parsedUrl.searchParams.get('ts') || passportNoonUtcTs();
      return {
        ...baseHeaders,
        ...(normalSdk ? { Accept: 'application/json, text/javascript' } : {}),
        'x-tt-passport-aid-sign': buildPassportAidSign({
          aid: '339757',
          path: pathname,
          ts: aidSignTs,
        }),
        'x-tt-passport-csrf-token': normalSdk
          ? primaryCsrf || fallbackCsrf || ''
          : primaryCsrf ?? fallbackCsrf ?? '',
        'x-tt-passport-trace-id': traceId,
        // Beat module51092 owns an independent, initially empty portrait (oh).
        // Never copy the login SDK's generated portrait into its request.
        ...(pathname === '/passport/token/beat/web/' ? {} : { 'x-tt-passport-verify-portrait': this.verifyPortrait }),
      };
    }
    return {};
  }

  private async fetchResponse<T>(
    url: string,
    init: RequestInit,
    passportHeaders: boolean,
    consume: (response: Response) => Promise<T>,
    includeAccountCookies = true,
  ): Promise<{ response: Response; data: T }> {
    init.signal?.throwIfAborted();
    const authenticationEpoch = this.#authenticationEpoch;
    if (includeAccountCookies && this.deviceStateDirty) this.persistDeviceState();
    const target = new URL(url);
    const guard = includeAccountCookies && target.protocol === 'https:' && target.hostname === 'imdesktop.douyin.com'
      ? this.#ticketGuard : undefined;
    if (includeAccountCookies && this.#ticketStateDirty) this.persistTicketState();
    if (guard) {
      // Desktop signs from the current certificate snapshot; it does not await
      // the certificate HTTP callback. The local private key was saved on enable.
      this.initializeTicketCertificate();
    }
    const guardedRequest = guard?.prepare(target, this.jar.get('sessionid') ?? '', this.jar.get('sessionid_ss') ?? '');
    const cookie = includeAccountCookies ? this.jar.toHeader() : '';
    const headers = mergeRequestHeaders(
      { 'User-Agent': this.userAgent },
      passportHeaders ? this.passportHeaders(url) : undefined,
      init.headers,
      // Main onBeforeSendHeaders overwrites renderer Referer before BDTicket,
      // regardless of Passport middleware or guard availability. Certificate
      // loading uses its own plain fetch and intentionally bypasses this hook.
      target.origin === 'https://imdesktop.douyin.com' ? { Referer: 'https://imdesktop.douyin.com' } : undefined,
      guardedRequest?.headers,
      cookie ? { Cookie: cookie } : undefined,
    );

    const signal = init.signal ?? AbortSignal.timeout(this.requestTimeoutMs);
    const res = await fetch(url, {
      ...init, headers, signal,
      // A signature is bound to one pathname. Redirects need a fresh interception.
      ...(guardedRequest && Object.keys(guardedRequest.headers).length ? { redirect: 'manual' as const } : {}),
    });
    // Even a transport that completes concurrently with cancellation must not
    // publish this verification's late cookies/tickets into the account.
    signal.throwIfAborted();
    // Cookie reception is independent of native onCompleted. Preserve headers
    // already accepted by the active owner even if subsequent body I/O fails.
    if (authenticationEpoch === this.#authenticationEpoch && includeAccountCookies) this.absorbSetCookie(res.headers);
    // Desktop dispatches native handleResponse from onCompleted, not from
    // onHeadersReceived. A truncated/failed body must not issue a local binding.
    // Consume once, retaining the original response metadata and binary bytes.
    let data: T;
    try {
      data = await consume(res);
    } catch (error) {
      if (!signal.aborted && authenticationEpoch === this.#authenticationEpoch
        && this.#ticketGuard && includeAccountCookies && cookie !== this.jar.toHeader()) this.persistTicketState();
      throw error;
    }
    signal.throwIfAborted();
    // Logout/rebinding may happen while HTTP is in flight. Return the actual
    // business response, but never import its old Cookie/token/certificate into
    // a new login. Device-only background certificate loading is independent.
    if (authenticationEpoch !== this.#authenticationEpoch) return { response: res, data };
    let guardChanged = false;
    if (guard && guardedRequest) {
      const sessionCookie = res.headers.getSetCookie().find(value => value.startsWith('sessionid='));
      // Desktop onCompleted extracts split('=')[1], not the complete Cookie value.
      // Keep this guard-only candidate separate from CookieJar's lossless value.
      const newSession = sessionCookie?.split(';')[0]?.split('=')[1] ?? '';
      try {
        guardChanged = guard.acceptResponse(guardedRequest, res.headers, newSession);
      } catch {
        // Desktop's onCompleted isolates handleResponse errors. Binding/client
        // cert may already be updated before a malformed server cert is rejected.
        guardChanged = true;
        getLogger('Desktop:TicketGuard').warn('响应证书更新未获确认，保留已接收的认证状态；业务响应仍交给调用方判断');
      }
    }
    // Desktop's business response hooks do not convert x-ms-token to Cookie.
    // BDMS owns that header only on its report XHR (DesktopTokenState), with
    // separate xmst storage. Actual Set-Cookie was already handled above.
    // Verification and business responses may rotate cookies without issuing a
    // new guard ticket. Persist the complete pair, not just guard changes.
    if (this.#ticketGuard && includeAccountCookies && (guardChanged || cookie !== this.jar.toHeader())) {
      this.persistTicketState();
    }
    return { response: res, data };
  }

  async requestBytes(url: string, init: RequestInit, passportHeaders = false): Promise<{ ok: boolean; status: number; headers: Headers; data: Uint8Array }> {
    const { response: res, data } = await this.fetchResponse(url, init, passportHeaders, response => response.arrayBuffer());
    return { ok: res.ok, status: res.status, headers: res.headers, data: new Uint8Array(data) };
  }

  async requestRaw(url: string, init: RequestInit, passportHeaders = false): Promise<HttpResponse<string>> {
    const { response: res, data: rawText } = await this.fetchResponse(url, init, passportHeaders, response => response.text());
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      data: rawText,
      rawText,
    };
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
  ): Promise<HttpResponse<T>> {
    const res = await this.requestRaw(url, init, true);
    const data = parseJsonResponse<T>(res, url);
    return { ...res, data };
  }

  private absorbSetCookie(headers: Headers): void {
    const list =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : collectSetCookieFallback(headers);
    for (const line of list) {
      this.jar.mergeSetCookie(line);
    }
  }
}

function collectSetCookieFallback(headers: Headers): string[] {
  const raw = (headers as Headers & { raw?: () => Record<string, string[]> })
    .raw?.();
  if (!raw?.['set-cookie']) {
    const single = headers.get('set-cookie');
    return single ? [single] : [];
  }
  return raw['set-cookie'];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return value == null ? '' : String(value);
}

function numericIdentity(value: unknown): string | undefined {
  const text = stringValue(value);
  return /^\d+$/.test(text) && text !== '0' ? text : undefined;
}

function screenSizeFromFingerprint(value?: string): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const parts = value.split('|');
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    return undefined;
  }
  return { width, height };
}

function positiveInteger(value: number | string | undefined, fallback: number, name: string): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}


function randomMsToken(length = 128): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return [...randomBytes(length)]
    .map((value) => alphabet[value & 63])
    .join('');
}

function randomDesktopHex(length: number): string {
  const hex = '0123456789abcdef';
  return [...randomMsToken(length)]
    .map((value) => hex[value.charCodeAt(0) & 15])
    .join('');
}

const DESKTOP_LITE_PARAM_ORDER: Readonly<Record<string, number>> = {
  passport_jssdk_version: 0,
  passport_jssdk_type: 1,
  is_from_ttaccountsdk: 2,
  aid: 3,
  language: 4,
  account_app_language: 5,
  ts: 6,
  next: 7,
  need_logo: 8,
  need_short_url: 9,
  is_new_login: 10,
  is_from_iesaccountsaas: 11,
  account_sdk_source: 12,
  account_sdk_source_info: 13,
  p_js_v: 14,
  p_js_t: 15,
  p_zt: 16,
  p_ver: 17,
  request_host: 18,
  p_bd: 19,
  biz_trace_id: 20,
  new_authn_sdk_version: 21,
  device_id: 22,
  iid: 23,
  version_code: 24,
  device_platform: 25,
  sign: 100,
  qs: 101,
  msToken: 102,
  a_bogus: 103,
};

// Retained lite MFA serializer; normal Account SDK must preserve insertion order.
function encodeDesktopLitePassportParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort((left, right) => {
      const leftOrder = DESKTOP_LITE_PARAM_ORDER[left];
      const rightOrder = DESKTOP_LITE_PARAM_ORDER[right];
      if (leftOrder != null && rightOrder != null) return leftOrder - rightOrder;
      if (leftOrder != null) return -1;
      if (rightOrder != null) return 1;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`)
    .join('&');
}

function appendSubAccountSelection(
  body: Record<string, string>,
  options: PassportLoginOptions,
): void {
  const selection = options.subAccount;
  if (!selection) return;
  if (!selection.smsCodeKey) throw new Error('smsCodeKey is required for sub-account login');
  if (!selection.registerNewUser && !selection.secUid) {
    throw new Error('secUid is required unless registerNewUser is true');
  }
  body['ignore_reused_mobile'] = '1';
  body['sms_code_key'] = selection.smsCodeKey;
  body['sms_code_key_not_mix'] = '1';
  if (selection.registerNewUser) body['register_new_user'] = '1';
  else body['sec_uid'] = selection.secUid!;
}

function appendVerificationFields(
  body: Record<string, string>,
  options: PassportLoginOptions,
): void {
  if (!options.verificationFields) return;
  for (const [key, value] of Object.entries(options.verificationFields)) {
    if (value == null) continue;
    body[key] = encodePassportField(value);
  }
}

function encodePassportField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Preserve the request layer order while applying HTTP's case-insensitive names. */
function mergeRequestHeaders(...sources: Array<RequestInit['headers']>): Record<string, string> {
  const result: Record<string, string> = {};
  const names = new Map<string, string>();
  for (const source of sources) {
    if (!source) continue;
    // Headers accepts all three RequestInit forms and validates/normalizes values.
    // Keep existing record spelling for internal callers inspecting the request.
    const spelling = new Map(Object.keys(source).map(name => [name.toLowerCase(), name]));
    for (const [name, value] of new Headers(source)) {
      const key = names.get(name) ?? spelling.get(name) ?? name;
      names.set(name, key);
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}
