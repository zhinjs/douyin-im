import { randomUUID } from 'crypto';
import type { ApiConnection } from '../../desktop/api-connection.js';
import { PassportRequestError } from '../../desktop/passport-error.js';
import type {
  CheckQrconnectData,
  CheckQrconnectResponse,
  PassportLoginOptions,
  PassportApiResponse,
  PassportTokenBeatScene,
  PassportSubAccount,
  QrCodeInfo,
  QrConnectStatus,
  QrMfaChallenge,
  QrUserData,
} from '../../desktop/types.js';
import { AccountStore } from '../../store/account-store.js';
import type { StoredAccount, SessionProbeResult } from '../../store/types.js';
import type { LoginAccountOption, LoginAccountSelectionPayload } from '../account-events.js';
import {
  LoginVerification,
  type LoginVerificationDescriptor,
  type LoginVerificationResult,
} from './login-verification.js';
import {
  openBrowserVerification,
  type BrowserLoginVerificationContext,
} from './browser-verification.js';

export type LoginMethod = 'qr' | 'sms' | 'password';

export interface AccountAuthConfig {
  client: ApiConnection;
  store: AccountStore;
  loginMethod: LoginMethod;
  mobile?: string;
  password?: string;
}

export interface AccountAuthHooks {
  onQrcode: (info: QrCodeInfo) => void;
  onQrStatus: (payload: {
    status: QrConnectStatus;
    screenName?: string;
    errorCode?: number;
    description?: string;
    responseFields?: string[];
  }) => void;
  onSms: (payload: { mobile: string; maskedMobile?: string }) => void;
  onVoice: (payload: { mobile: string; maskedMobile?: string }) => void;
  onAccountSelection: (payload: LoginAccountSelectionPayload) => void;
  onSmsRequired: (payload: { mobile: string; reason: string }) => void;
  onVerification: (payload: { verification: LoginVerification }) => void;
  /** 登录成功并 promote 后；调用方负责 goOnline */
  onLoggedIn: (account: StoredAccount) => void | Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function qrPollDelay(pollCount: number): number {
  // C339's R.current is incremented per outer QR poll, not seconds elapsed.
  if (pollCount >= 180) return 5_000;
  if (pollCount >= 60) return 3_000;
  return 1_000;
}

/**
 * 登录深模块 — QR / SMS / 密码 / 服务端验证挑战 / promote。
 * 只产出 StoredAccount，不启动 IM。
 */
export class AccountAuth {
  private pendingId?: string;
  private qrInfo?: QrCodeInfo;
  private attempt = 0;
  private pendingVerification?: LoginVerification;
  private pendingSubAccounts?: {
    method: 'sms' | 'password';
    smsCodeKey: string;
    accounts: readonly LoginAccountOption[];
  };
  private lastSmsCode?: string;

  constructor(
    private readonly config: AccountAuthConfig,
    private readonly hooks: AccountAuthHooks,
  ) {}

  get loginMethod(): LoginMethod {
    return this.config.loginMethod;
  }

  get qrCodeInfo(): QrCodeInfo | undefined {
    return this.qrInfo;
  }

  setClient(client: ApiConnection): void {
    this.config.client = client;
  }

  /** Online renewal still uses Passport's human verification middleware, without promoting an account. */
  async refreshSession(scene: PassportTokenBeatScene, signal: AbortSignal): Promise<PassportApiResponse> {
    signal.throwIfAborted();
    const attempt = this.attempt;
    const client = this.config.client;
    const cancel = () => {
      if (this.attempt === attempt) this.pendingVerification?.cancel('Session 续期已停止');
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      let response = await client.sendPassportTokenBeat(scene, signal);
      signal.throwIfAborted(); this.ensureActive(attempt);
      while (!passportSucceeded(response)) {
        const result = await this.waitForPassportVerification('token-beat', response.data, client);
        signal.throwIfAborted(); this.ensureActive(attempt);
        if (!result) return response;
        response = await client.sendPassportTokenBeat(scene, signal, {
          ...mergeVerificationOptions({}, result, normalizePassportData(response.data)), retry: response,
        });
        signal.throwIfAborted(); this.ensureActive(attempt);
      }
      return response;
    } finally { signal.removeEventListener('abort', cancel); }
  }

  /** Restore uses its candidate connection, not the account's still-unverified runtime. */
  async probeRestoredSession(client: ApiConnection, signal?: AbortSignal): Promise<SessionProbeResult> {
    signal?.throwIfAborted();
    const attempt = this.attempt;
    const cancel = () => {
      if (this.attempt === attempt) this.pendingVerification?.cancel('Session 恢复已取消');
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await client.probeSession(signal, async response => {
        signal?.throwIfAborted(); this.ensureActive(attempt);
        const result = await this.waitForPassportVerification('account-info', response.data, client);
        signal?.throwIfAborted(); this.ensureActive(attempt);
        return result ? mergeVerificationOptions({}, result, normalizePassportData(response.data)) : undefined;
      });
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  cancel(): void {
    this.attempt += 1;
    this.config.client.invalidateAuthenticationResponses();
    this.pendingVerification?.cancel('登录已取消');
    delete this.pendingVerification;
    delete this.pendingSubAccounts;
    delete this.lastSmsCode;
    delete this.qrInfo;
    if (this.pendingId) this.config.store.removePending(this.pendingId);
    delete this.pendingId;
  }

  async beginLogin(): Promise<void> {
    const attempt = ++this.attempt;
    delete this.pendingSubAccounts;
    delete this.lastSmsCode;
    this.ensurePending();

    // Desktop starts BDTicket before its window callback registers the device.
    // The certificate request is detached; login must not await its completion.
    const client = this.config.client;
    client.startTicketGuard();
    await client.startDeviceLifecycle();
    this.ensureActive(attempt);
    const pending = this.config.store.loadPending(this.pendingId!);
    if (!pending) throw new Error('登录已取消，不能保存设备身份');
    Object.assign(pending.deviceProfile, { deviceId: client.getDeviceId(), installId: client.getInstallId() });
    this.config.store.createPending(pending);
    try {
      await client.ttwidCheck();
    } catch {
      // Desktop's ttwid warmup is best effort, not a login prerequisite.
    }
    this.ensureActive(attempt);

    const { loginMethod, mobile, password } = this.config;

    if (loginMethod === 'qr') {
      await this.createQrcode(attempt);
      return;
    }

    if (loginMethod === 'sms' && mobile) {
      await this.sendSmsCode(attempt);
      return;
    }

    if (loginMethod === 'password' && mobile && password) {
      await this.performPasswordLogin(attempt);
      return;
    }
    throw new Error(`登录配置不完整: method=${loginMethod}`);
  }

  private async createQrcode(attempt: number): Promise<void> {
    let options: PassportLoginOptions = {};
    let retry: PassportRequestError | undefined;
    for (;;) {
      this.ensureActive(attempt);
      let qrInfo: QrCodeInfo;
      try {
        qrInfo = retry
          ? await this.config.client.getQrcode({ error: retry, ...(options.fp ? { fp: options.fp } : {}) })
          : await this.config.client.getQrcode();
      } catch (error) {
        this.ensureActive(attempt);
        if (!(error instanceof PassportRequestError)) throw error;
        const data = error.data;
        const result = await this.waitForPassportVerification('get-qrcode', data);
        this.ensureActive(attempt);
        if (!result) throw error;
        options = mergeVerificationOptions(options, result, normalizePassportData(data));
        retry = error;
        continue;
      }
      this.ensureActive(attempt);
      this.qrInfo = qrInfo;
      this.hooks.onQrcode(qrInfo);
      return;
    }
  }

  async continueQrLogin(): Promise<void> {
    if (this.config.loginMethod !== 'qr') {
      throw new Error('continueQrLogin() 仅用于扫码登录');
    }
    if (!this.qrInfo) {
      throw new Error('请先 beginLogin() 并等待 onQrcode');
    }

    const attempt = this.attempt;
    let lastStatus: QrConnectStatus | undefined;
    let scanned = false;
    let refreshes = 0;
    let transientPassportErrors = 0;
    let missingPassportErrors = 0;
    // C339's single rejected branch shares two cumulative budgets across all
    // rejected checks. Fulfilled polls and QR replacements do not reset them.
    const retryQrError = (code: unknown): boolean => {
      if ((code === 6 || code === 'ECONNABORTED') && transientPassportErrors < 3) {
        transientPassportErrors += 1;
        return true;
      }
      if (!code && missingPassportErrors < 3) {
        missingPassportErrors += 1;
        return true;
      }
      return false;
    };
    let pollCount = 0;
    let extraBody: Record<string, string> = {};
    let verificationOptions: PassportLoginOptions = {};
    let legacyMfaCompleted = false;
    // Desktop relies on server status/replacement and explicit cancellation.
    // expire_time is QR display metadata, not a deadline for human verification.
    for (;;) {
      this.ensureActive(attempt);
      let poll: CheckQrconnectResponse;
      // Passport's verification replay belongs to the same outer poll in C339.
      if (!verificationOptions.retry) pollCount += 1;
      try {
        poll = Object.keys(verificationOptions).length > 0
          ? await this.config.client.checkQrconnect(
              this.qrInfo.token,
              extraBody,
              verificationOptions,
            )
          : await this.config.client.checkQrconnect(this.qrInfo.token, extraBody);
      } catch (error) {
        this.ensureActive(attempt);
        if (!retryQrError(asRecord(error)?.['error_code'])) {
          throw new Error(`二维码状态查询失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        await sleep(qrPollDelay(pollCount));
        continue;
      }
      this.ensureActive(attempt);
      const data = (asRecord(poll.data) ?? {}) as CheckQrconnectData;
      const passportData = data as unknown as Record<string, unknown>;
      const normalizedPassportData = normalizePassportData(passportData);
      const passportDecision = poll.message === 'success' ? undefined : verificationDecision(passportData);
      if (passportDecision) {
        this.hooks.onQrStatus({
          status: 'verifying',
          ...(data.description ? { description: data.description } : {}),
        });
        const result = await this.waitForVerification(
          passportVerificationDescriptor('qr-connect', normalizedPassportData, passportDecision),
          { connection: this.config.client },
        );
        this.ensureActive(attempt);
        verificationOptions = mergeVerificationOptions(
          verificationOptions,
          result,
          normalizedPassportData,
        );
        verificationOptions.retry = poll;
        this.hooks.onQrStatus({ status: 'verified' });
        continue;
      }
      // Verification replay finishes here; the next normal poll is a fresh request.
      verificationOptions = {};
      // Retained jumpbyte QR MFA branch, separate from the installed C321
      // decision dispatcher above. Its lite transport is not Desktop parity proof.
      if (!legacyMfaCompleted && (data.account_flow === 'verify' || data.biz_params != null)) {
        this.hooks.onQrStatus({
          status: 'verifying',
          ...(data.description ? { description: data.description } : {}),
        });
        const challenge = qrMfaChallenge(data);
        const resumeFields = pickQrBizParams(data.biz_params);
        const result = await this.waitForVerification(
          {
            source: 'qr-connect',
            operation: 'qr-connect',
            ...(data.error_code != null ? { errorCode: data.error_code } : {}),
            ...(data.description ? { description: data.description } : {}),
            decision: {
              ...challenge,
              verify_from: 'qr_connect_mfa',
              std_verify_way: 'mobile_sms_verify',
            },
            methods: ['mobile-sms'],
          },
          {
            connection: this.config.client,
            qrMfa: { challenge, resumeFields },
          },
        );
        this.ensureActive(attempt);
        extraBody = {
          ...extraBody,
          ...resumeFields,
          ...stringRecord(result.fields),
        };
        legacyMfaCompleted = true;
        this.hooks.onQrStatus({ status: 'verified' });
        continue;
      }
      if (!passportSucceeded(poll)) {
        // C339 QR consumer retries three numeric-6/ECONNABORTED rejections,
        // and independently three rejections without a truthy error code.
        // A rejected response can never enter its fulfilled status switch.
        if (!retryQrError(normalizedPassportData['error_code'])) {
          throw passportLoginError(normalizedPassportData);
        }
        await sleep(qrPollDelay(pollCount));
        continue;
      }
      if (typeof data.status !== 'string' || data.status.length === 0) {
        throw new Error('二维码状态响应缺少有效状态');
      }
      if (data.status !== lastStatus) {
        lastStatus = data.status;
        const screenName = qrScreenName(data);
        const isScanned = data.status === 'scanned' || data.status === '2';
        if (!isScanned || !scanned) {
          this.hooks.onQrStatus({
            status: data.status,
            ...(screenName ? { screenName } : {}),
          });
        }
        if (isScanned) scanned = true;
      }
      if (data.status === 'confirmed' || data.status === '3') {
        await this.finishLogin(data.user_data as QrUserData | undefined, attempt);
        return;
      }
      if (data.status === 'expired' || data.status === 'refused' || data.status === '4' || data.status === '5') {
        if (data.token && data.qrcode && refreshes < 5) {
          refreshes += 1;
          this.qrInfo = {
            token: data.token,
            qrcodeBase64: data.qrcode,
            expireTime: data.expire_time ?? Math.floor((Date.now() + 180_000) / 1000),
            ...(data.qrcode_index_url ? { qrcodeIndexUrl: data.qrcode_index_url } : {}),
          };
          lastStatus = undefined;
          scanned = false;
          extraBody = {};
          verificationOptions = {};
          legacyMfaCompleted = false;
          this.hooks.onQrcode(this.qrInfo);
          // The replacement resolves the current outer poll; C339's W waits
          // the normal interval before checking the replacement token.
          await sleep(qrPollDelay(pollCount));
          continue;
        }
        throw new Error(data.status === 'refused' ? '二维码登录已拒绝' : '二维码已失效');
      }
      if (!['new', '1', 'scanned', '2'].includes(data.status)) {
        throw new Error('二维码状态响应无法识别');
      }
      await sleep(qrPollDelay(pollCount));
    }
  }

  async continueSmsLogin(code: string): Promise<void> {
    const attempt = this.attempt;
    const mobile = this.config.mobile;
    if (!mobile) {
      throw new Error('未配置手机号');
    }
    const normalizedCode = code.trim();
    if (!/^\d{4,8}$/.test(normalizedCode)) throw new Error('短信验证码格式不正确');
    this.lastSmsCode = normalizedCode;
    await this.performSmsLogin(attempt);
  }

  /** 首次发码、密码被要求改用验证码以及用户重发都走同一条 Desktop Passport 路径。 */
  async requestSmsCode(): Promise<void> {
    if (!this.config.mobile) throw new Error('未配置手机号');
    if (this.config.loginMethod === 'qr') throw new Error('扫码账号不能切换为手机号登录');
    this.config.loginMethod = 'sms';
    delete this.pendingSubAccounts;
    await this.sendSmsCode(this.attempt);
  }

  /** 短信收不到时请求 Desktop Passport 的语音验证码，验证码仍由 continueSmsLogin 提交。 */
  async requestVoiceCode(): Promise<void> {
    if (!this.config.mobile) throw new Error('未配置手机号');
    if (this.config.loginMethod === 'qr') throw new Error('扫码账号不能请求语音验证码');
    this.config.loginMethod = 'sms';
    delete this.pendingSubAccounts;
    await this.sendVoiceCode(this.attempt);
  }

  /** error_code=1454 后选择同一手机号关联的具体账号。 */
  async continueWithSubAccount(selection: {
    secUid?: string;
    registerNewUser?: boolean;
  }): Promise<void> {
    const pending = this.pendingSubAccounts;
    const mobile = this.config.mobile;
    if (!pending || !mobile) throw new Error('当前没有等待选择的登录账号');
    const selected = selection.secUid
      ? pending.accounts.find((account) => account.secUid === selection.secUid)
      : undefined;
    if (!selection.registerNewUser && !selected) throw new Error('登录候选账号不存在');
    if (selected?.isEnterprise && !selected.isActive) throw new Error('企业账号尚未激活');
    if (selection.registerNewUser && !pending.accounts.every((account) => !account.isMainAccount)) {
      throw new Error('当前手机号已有关联主账号，不能新建账号');
    }
    const options: PassportLoginOptions = {
      subAccount: {
        smsCodeKey: pending.smsCodeKey,
        ...(selection.secUid ? { secUid: selection.secUid } : {}),
        ...(selection.registerNewUser ? { registerNewUser: true } : {}),
      },
    };
    if (pending.method === 'password') await this.performPasswordLogin(this.attempt, options);
    else await this.performSmsLogin(this.attempt, options);
  }

  private async finishLogin(
    userData: Record<string, unknown> | QrUserData | undefined,
    attempt: number,
  ): Promise<void> {
    this.ensureActive(attempt);
    const sessionId = this.config.client.jar.get('sessionid');
    if (!sessionId || sessionId.toLowerCase() === 'deleted') {
      throw new Error('登录成功但未拿到 sessionid');
    }
    let completeUserData = userData as Record<string, unknown> | undefined;
    if (this.config.loginMethod === 'qr' || !numericUserId(completeUserData)) {
      try {
        const response = await this.config.client.getSelfProfile();
        const profile = asRecord(response['user']);
        const uid = profile?.['uid'] ?? profile?.['user_id_str'] ?? profile?.['user_id'];
        if (uid != null || profile?.['nickname']) {
          completeUserData = {
            ...(completeUserData ?? {}),
            ...(uid != null ? { user_id_str: String(uid) } : {}),
            ...(profile?.['nickname'] ? { screen_name: String(profile['nickname']) } : {}),
          };
        }
      } catch {
        // 下方 canonical identity 校验统一给出确定错误，不把 uid_tt 当平台 UID。
      }
    }
    // Profile lookup may outlive logout/cancellation. Never recreate its pending
    // record or promote a stale login after the asynchronous identity lookup.
    this.ensureActive(attempt);
    const stored = this.promote(completeUserData);
    delete this.pendingId;
    this.ensureActive(attempt);
    await this.hooks.onLoggedIn(stored);
  }

  private ensureActive(attempt: number): void {
    if (attempt !== this.attempt) throw new Error('登录已取消');
  }

  private promote(userData?: Record<string, unknown> | QrUserData): StoredAccount {
    const pendingId = this.ensurePending();
    const { client, store } = this.config;
    const platformUid = AccountStore.resolveCanonicalUserId(
      userData as Record<string, unknown> | undefined,
    );
    const meta: Record<string, string | undefined> = {};
    const ud = userData as Record<string, unknown> | undefined;
    if (ud?.['screen_name']) meta['screenName'] = String(ud['screen_name']);
    if (ud?.['avatar_url']) meta['avatarUrl'] = String(ud['avatar_url']);
    const uidTt = client.jar.get('uid_tt');
    if (uidTt) meta['passportUidTt'] = uidTt;

    return store.promote(
      pendingId,
      platformUid,
      AccountStore.buildSession(client.getCookies(), client.getTicketGuardState()),
      meta,
    );
  }

  private ensurePending(): string {
    if (!this.pendingId) {
      this.pendingId = randomUUID();
      const { client, store, loginMethod } = this.config;
      const screen = client.getScreenSize();
      store.createPending({
        id: this.pendingId,
        loginMethod: loginMethod === 'qr' ? 'qr' : loginMethod === 'sms' ? 'sms' : 'password',
        startedAt: new Date().toISOString(),
        deviceProfile: AccountStore.buildDeviceProfile(
          client.getUserAgent(),
          client.getBizTraceId(),
          {
            deviceId: client.getDeviceId(),
            installId: client.getInstallId(),
            guid: client.getGuid(),
            screenWidth: screen.width,
            screenHeight: screen.height,
          },
        ),
        cookies: client.getCookies(),
      });
      const pendingId = this.pendingId;
      client.setDeviceUpdateHandler(device => {
        if (this.pendingId !== pendingId || this.config.client !== client) return;
        const pending = store.loadPending(pendingId);
        if (!pending) throw new Error('登录已取消，不能保存设备身份');
        Object.assign(pending.deviceProfile, device);
        store.createPending(pending);
      });
      client.enableTicketGuard(state => {
        // A shared device-certificate task may finish after cancellation/promote.
        // Only the current pending owner may save; do not recreate a retired one.
        if (this.pendingId !== pendingId || this.config.client !== client) return;
        const pending = store.loadPending(pendingId);
        if (!pending) throw new Error('登录已取消，不能保存验证票据');
        pending.cookies = client.getCookies();
        pending.desktopTicketGuard = state;
        store.createPending(pending);
      });
    }
    return this.pendingId;
  }

  private async performPasswordLogin(
    attempt: number,
    options: PassportLoginOptions = {},
  ): Promise<void> {
    const mobile = this.config.mobile;
    const password = this.config.password;
    if (!mobile || !password) throw new Error('密码登录配置不完整');
    const response = hasPassportOptions(options)
      ? await this.config.client.userLogin(mobile, password, options)
      : await this.config.client.userLogin(mobile, password);
    this.ensureActive(attempt);
    if (passportSucceeded(response)) {
      delete this.pendingSubAccounts;
      await this.finishLogin(normalizePassportData(response.data), attempt);
      return;
    }
    const responseData = normalizePassportData(response.data);
    const result = await this.waitForPassportVerification('password-login', response.data);
    if (result) {
      await this.performPasswordLogin(
        attempt,
        { ...mergeVerificationOptions(options, result, responseData), retry: response },
      );
      return;
    }
    if (this.handleLoginBranch('password', responseData)) return;
    throw passportLoginError(responseData);
  }

  private async performSmsLogin(
    attempt: number,
    options: PassportLoginOptions = {},
  ): Promise<void> {
    const mobile = this.config.mobile;
    if (!mobile) throw new Error('未配置手机号');
    const code = this.requiredSmsCode();
    const response = hasPassportOptions(options)
      ? await this.config.client.smsLogin(mobile, code, options)
      : await this.config.client.smsLogin(mobile, code);
    this.ensureActive(attempt);
    if (passportSucceeded(response)) {
      delete this.pendingSubAccounts;
      await this.finishLogin(normalizePassportData(response.data), attempt);
      return;
    }
    const responseData = normalizePassportData(response.data);
    const result = await this.waitForPassportVerification('sms-login', response.data);
    if (result) {
      await this.performSmsLogin(
        attempt,
        { ...mergeVerificationOptions(options, result, responseData), retry: response },
      );
      return;
    }
    if (this.handleLoginBranch('sms', responseData)) return;
    throw passportLoginError(responseData);
  }

  private async waitForPassportVerification(
    operation: 'token-beat' | 'account-info' | 'get-qrcode' | 'send-sms' | 'send-voice-sms' | 'sms-login' | 'password-login',
    data: Record<string, unknown>,
    client: ApiConnection = this.config.client,
  ): Promise<LoginVerificationResult | undefined> {
    const decision = verificationDecision(data);
    if (!decision) return undefined;
    const response = normalizePassportData(data);
    return this.waitForVerification(
      passportVerificationDescriptor(operation, response, decision),
      { connection: client },
    );
  }

  private async sendSmsCode(
    attempt: number,
    options: PassportLoginOptions = {},
  ): Promise<void> {
    const mobile = this.config.mobile;
    if (!mobile) throw new Error('未配置手机号');
    const response = hasPassportOptions(options)
      ? await this.config.client.sendCode(mobile, options)
      : await this.config.client.sendCode(mobile);
    this.ensureActive(attempt);
    if (!passportSucceeded(response)) {
      const responseData = normalizePassportData(response.data);
      const result = await this.waitForPassportVerification('send-sms', response.data);
      if (result) {
        await this.sendSmsCode(
          attempt,
          { ...mergeVerificationOptions(options, result, responseData), retry: response },
        );
        return;
      }
      throw passportLoginError(responseData);
    }
    const payload: { mobile: string; maskedMobile?: string } = { mobile };
    if (response.data.mobile != null) payload.maskedMobile = String(response.data.mobile);
    this.hooks.onSms(payload);
  }

  private async sendVoiceCode(
    attempt: number,
    options: PassportLoginOptions = {},
  ): Promise<void> {
    const mobile = this.config.mobile;
    if (!mobile) throw new Error('未配置手机号');
    const response = hasPassportOptions(options)
      ? await this.config.client.sendVoiceCode(mobile, options)
      : await this.config.client.sendVoiceCode(mobile);
    this.ensureActive(attempt);
    if (!passportSucceeded(response)) {
      const responseData = normalizePassportData(response.data);
      const result = await this.waitForPassportVerification('send-voice-sms', response.data);
      if (result) {
        await this.sendVoiceCode(
          attempt,
          { ...mergeVerificationOptions(options, result, responseData), retry: response },
        );
        return;
      }
      throw passportLoginError(responseData);
    }
    const payload: { mobile: string; maskedMobile?: string } = { mobile };
    if (response.data.mobile != null) payload.maskedMobile = String(response.data.mobile);
    this.hooks.onVoice(payload);
  }

  private waitForVerification(
    descriptor: LoginVerificationDescriptor,
    browserContext: BrowserLoginVerificationContext,
  ): Promise<LoginVerificationResult> {
    if (this.pendingVerification) throw new Error('已有登录验证正在进行');
    return new Promise<LoginVerificationResult>((resolve, reject) => {
      let finished = false;
      const finish = (result?: LoginVerificationResult, error?: Error): void => {
        if (finished) return;
        finished = true;
        delete this.pendingVerification;
        if (error) reject(error);
        else resolve(result ?? {});
      };
      const verification = new LoginVerification(descriptor, {
        open: (current, options) =>
          openBrowserVerification(current, browserContext, options),
        complete: async (result) => finish(result),
        cancel: (reason) => finish(undefined, new Error(reason ?? '登录验证已取消')),
      });
      this.pendingVerification = verification;
      this.hooks.onVerification({ verification });
    });
  }

  private handleLoginBranch(
    method: 'sms' | 'password',
    data: Record<string, unknown>,
  ): boolean {
    // LOGIN's password/SMS handlers branch on numeric codes, not coerced strings.
    const errorCode = data['error_code'];
    if (method === 'password' && errorCode === 1039 && this.config.mobile) {
      this.hooks.onSmsRequired({
        mobile: this.config.mobile,
        reason: String(data['description'] ?? '为保护账号安全，请使用验证码登录'),
      });
      return true;
    }
    const rawAccounts = Array.isArray(data['sub_account'])
      ? data['sub_account'].filter(isRecord) as PassportSubAccount[]
      : [];
    const smsCodeKey = String(data['sms_code_key'] ?? '');
    if (errorCode !== 1454 || rawAccounts.length === 0 || !smsCodeKey) return false;
    const accounts = rawAccounts.map(normalizeLoginAccount).filter(isPresent);
    if (accounts.length === 0) return false;
    this.pendingSubAccounts = { method, smsCodeKey, accounts };
    this.hooks.onAccountSelection({
      method,
      accounts,
      canRegisterNewUser: accounts.every((account) => !account.isMainAccount),
    });
    return true;
  }

  private requiredSmsCode(): string {
    if (!this.lastSmsCode) throw new Error('当前登录账号缺少已提交的短信验证码');
    return this.lastSmsCode;
  }
}

function normalizeLoginAccount(raw: PassportSubAccount): LoginAccountOption | undefined {
  const secUid = String(raw.sec_uid ?? '');
  if (!secUid) return undefined;
  const uid = String(raw.user_id ?? '');
  const nickname = String(raw.name ?? '');
  const avatar = String(raw.avatar ?? '');
  const douyinId = String(raw.aweme_id ?? '');
  return {
    secUid,
    ...(uid && uid !== '0' ? { uid } : {}),
    ...(nickname ? { nickname } : {}),
    ...(avatar ? { avatar } : {}),
    ...(douyinId && douyinId !== '0' ? { douyinId } : {}),
    // LOGIN account selection: truthy main/active flags, strict enterprise type.
    // Missing activation must not allow an enterprise account to submit.
    isMainAccount: Boolean(raw.is_bind_login_mobile),
    isEnterprise: raw.passport_enterprise_user_type === 6,
    isActive: Boolean(raw.business_account_active),
    raw,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function passportSucceeded(response: {
  message: string;
}): boolean {
  // Account SDK response middleware classifies the envelope, not data.error_code.
  return response.message === 'success';
}

const QR_BIZ_PARAM_KEYS = [
  'passport_mfa_retry_tag',
  'std_verify_flow_id',
  'std_verify_scene',
  'std_verify_template',
  'std_verify_token',
  'std_verify_type',
  'std_verify_way',
] as const;

function pickQrBizParams(params?: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  if (!params) return result;
  for (const key of QR_BIZ_PARAM_KEYS) {
    const value = params[key];
    if (value != null) result[key] = String(value);
  }
  return result;
}

function qrMfaChallenge(data: CheckQrconnectData): QrMfaChallenge {
  return {
    ...(data.encrypt_uid ? { encrypt_uid: data.encrypt_uid } : {}),
    ...(data.biz_params ? { biz_params: data.biz_params } : {}),
    ...(data.common_params ? { common_params: data.common_params } : {}),
  };
}

interface ParsedVerificationDecision {
  raw: string;
  data: Record<string, unknown>;
  secondary: boolean;
}

function verificationDecision(
  data: Record<string, unknown>,
): ParsedVerificationDecision | undefined {
  const nested = asRecord(data['data']);
  const candidates: ReadonlyArray<readonly [unknown, boolean]> = [
    [nested?.['verify_center_decision_conf'], false],
    [nested?.['verify_center_secondary_decision_conf'], true],
    [data['verify_center_decision_conf'], false],
    [data['verify_center_secondary_decision_conf'], true],
  ];
  // C321 rl.processPlugin selects primary || secondary. Falsy primary values
  // must not hide a real secondary challenge.
  const selected = candidates.find(([value]) => Boolean(value));
  const rawValue = selected?.[0];
  const secondary = selected?.[1] === true;
  if (isRecord(rawValue)) {
    return {
      raw: JSON.stringify(rawValue),
      data: {
        ...rawValue,
        ...(secondary ? { verification_level: 'secondary' } : {}),
      },
      secondary,
    };
  }
  if (typeof rawValue === 'string' && rawValue.length > 0) {
    return {
      raw: rawValue,
      data: {
        ...parseDecisionConf(rawValue),
        ...(secondary ? { verification_level: 'secondary' } : {}),
      },
      secondary,
    };
  }
  // The installed normal SDK rejects the original error when no decision was
  // supplied. An error code or a captcha-looking field cannot create one.
  return undefined;
}

function parseDecisionConf(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { verify_data: parsed };
  } catch {
    return { verify_data: value };
  }
}

function passportVerificationDescriptor(
  operation: LoginVerificationDescriptor['operation'],
  response: Record<string, unknown>,
  decision: ParsedVerificationDecision,
): LoginVerificationDescriptor {
  const errorCode = Number(response['error_code']);
  return {
    source: operation === 'qr-connect' ? 'qr-connect' : 'passport',
    operation,
    ...(Number.isFinite(errorCode) ? { errorCode } : {}),
    ...(typeof response['description'] === 'string'
      ? { description: response['description'] }
      : {}),
    decisionConf: decision.raw,
    decision: decision.data,
    ...(decision.secondary ? { methods: inferSecondaryMethods(decision.data) } : {}),
  };
}

function inferSecondaryMethods(
  decision: Readonly<Record<string, unknown>>,
): readonly ('auxiliary-mobile-sms' | 'mobile-qr' | 'push' | 'unknown')[] {
  const text = JSON.stringify(decision).toLowerCase();
  const methods: Array<'auxiliary-mobile-sms' | 'mobile-qr' | 'push' | 'unknown'> = [];
  if (/sms|mobile/.test(text)) methods.push('auxiliary-mobile-sms');
  if (/qr|scan/.test(text)) methods.push('mobile-qr');
  if (/push/.test(text)) methods.push('push');
  return methods.length > 0 ? methods : ['unknown'];
}

function mergeVerificationOptions(
  current: PassportLoginOptions,
  result: LoginVerificationResult,
  response: Record<string, unknown>,
): PassportLoginOptions {
  // Each callback patches only the immediately preceding request snapshot.
  // Carrying an earlier secondary patch into a later captcha would re-encode
  // its already patched form again, unlike C321's separate callback branches.
  const next = { ...current };
  delete next.fp;
  delete next.verificationFields;
  const fields: Record<string, unknown> = {};
  // C321 rl.processPlugin supplies requestData only for numeric 2046 and a
  // truthy server ticket. Coercion/empty tickets would also re-encode the form.
  if (!result.fp && response['error_code'] === 2046 && response['sms_code_key']) {
    fields['sms_code_key'] = response['sms_code_key'];
  }
  // C321 secondVerify callback ignores its payload; only requestData.sms_code_key
  // is patched into the original form. Arbitrary callback fields are not login credentials.
  return {
    ...next,
    ...(result.fp ? { fp: result.fp } : {}),
    ...(Object.keys(fields).length > 0 ? { verificationFields: fields } : {}),
  };
}

function stringRecord(
  value: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value) return result;
  for (const [key, item] of Object.entries(value)) {
    if (item == null) continue;
    result[key] = typeof item === 'string' ? item : JSON.stringify(item);
  }
  return result;
}

function passportLoginError(data: Record<string, unknown>): Error {
  const code = data['error_code'] ?? '-';
  const description = data['description'] ?? data['error_str'] ?? 'unknown error';
  return new Error(`登录失败：Passport 未返回 success，error_code=${String(code)} ${String(description)}`);
}

function normalizePassportData(data: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(data['data']);
  return nested ? { ...data, ...nested } : data;
}

function hasPassportOptions(options: PassportLoginOptions): boolean {
  return Object.keys(options).length > 0;
}

function qrScreenName(data: CheckQrconnectData): string | undefined {
  const value = data.scan_user_info?.['screen_name'];
  return value == null ? undefined : String(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function numericUserId(value: Record<string, unknown> | undefined): string | undefined {
  for (const candidate of [value?.['user_id_str'], value?.['user_id']]) {
    const text = candidate == null ? '' : String(candidate);
    if (/^\d+$/.test(text) && text !== '0') return text;
  }
  return undefined;
}
