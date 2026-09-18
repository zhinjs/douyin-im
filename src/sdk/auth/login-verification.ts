import { randomUUID } from 'node:crypto';

export type LoginVerificationSource = 'passport' | 'qr-connect';

export type LoginVerificationMethod =
  | 'captcha'
  | 'mobile-sms'
  | 'auxiliary-mobile-sms'
  | 'mobile-qr'
  | 'push'
  | 'unknown';

export type LoginVerificationOperation =
  | 'token-beat'
  | 'account-info'
  | 'get-qrcode'
  | 'send-sms'
  | 'send-voice-sms'
  | 'sms-login'
  | 'password-login'
  | 'qr-connect';

export interface LoginVerificationResult {
  /** 滑块完成后由验证码 SDK 生成的浏览器指纹。 */
  fp?: string;
  /** 旧式 QR MFA 的续接字段；标准 Passport VerifyCenter 回调不采用任意 payload。 */
  fields?: Readonly<Record<string, unknown>>;
}

export interface OpenLoginVerificationOptions {
  /** 本地验证页端口；0 表示随机端口。 */
  port?: number;
  /** 默认 true，自动使用系统浏览器打开本地验证页。 */
  openBrowser?: boolean;
  /** 默认 5 分钟。 */
  timeoutMs?: number;
}

export interface LoginVerificationDescriptor {
  source: LoginVerificationSource;
  operation: LoginVerificationOperation;
  errorCode?: number;
  description?: string;
  decisionConf?: string;
  decision: Readonly<Record<string, unknown>>;
  methods?: readonly LoginVerificationMethod[];
}

interface LoginVerificationController {
  open: (
    verification: LoginVerification,
    options: OpenLoginVerificationOptions
  ) => Promise<void>;
  complete: (result: LoginVerificationResult) => Promise<void>;
  cancel: (reason?: string) => void;
}

/**
 * 一次登录验证挑战。
 *
 * 普通应用只需调用 `open()`；自定义 UI 可调用 `complete()` 将官方验证组件的
 * 结果交还 SDK。验证对象与触发它的原请求绑定，不要求调用方判断重试路径。
 */
export class LoginVerification {
  readonly id = randomUUID();
  readonly source: LoginVerificationSource;
  readonly operation: LoginVerificationOperation;
  readonly errorCode: number | undefined;
  readonly description: string | undefined;
  readonly decisionConf: string | undefined;
  readonly decision: Readonly<Record<string, unknown>>;
  readonly methods: readonly LoginVerificationMethod[];

  private settled = false;
  readonly #lifetime = new AbortController();
  private openTask?: Promise<void>;

  /** @internal Local verification host lifetime; null reason denotes completion. */
  get signal(): AbortSignal { return this.#lifetime.signal; }

  constructor(
    descriptor: LoginVerificationDescriptor,
    private readonly controller: LoginVerificationController
  ) {
    this.source = descriptor.source;
    this.operation = descriptor.operation;
    this.errorCode = descriptor.errorCode;
    this.description = descriptor.description;
    this.decisionConf = descriptor.decisionConf;
    this.decision = descriptor.decision;
    this.methods =
      descriptor.methods ?? inferLoginVerificationMethods(descriptor.decision);
  }

  /** 使用 SDK 内置的本地浏览器验证页完成挑战。 */
  open(options: OpenLoginVerificationOptions = {}): Promise<void> {
    if (this.openTask) return this.openTask;
    this.assertPending();
    const task = this.controller.open(this, options).catch((error: unknown) => {
      if (!this.settled) {
        this.cancel(
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    });
    this.openTask = task;
    return task;
  }

  /** 自定义 UI 完成验证后提交结果并恢复原登录请求。 */
  async complete(result: LoginVerificationResult = {}): Promise<void> {
    this.assertPending();
    this.settled = true;
    try {
      await this.controller.complete(result);
      this.#lifetime.abort(null);
    } catch (error) {
      this.#lifetime.abort(error);
      throw error;
    }
  }

  cancel(reason?: string): void {
    if (this.settled) return;
    this.settled = true;
    this.#lifetime.abort(new Error(reason ?? '登录验证已取消'));
    this.controller.cancel(reason);
  }

  private assertPending(): void {
    if (this.settled) throw new Error('登录验证已结束');
  }
}

function inferLoginVerificationMethods(
  decision: Readonly<Record<string, unknown>>
): readonly LoginVerificationMethod[] {
  const text = JSON.stringify(decision).toLowerCase();
  const methods = new Set<LoginVerificationMethod>();
  if (/captcha|slide|slider|verify_sdk/.test(text)) methods.add('captcha');
  if (/secondary|auxiliary|backup_mobile|mobile_seperate/.test(text)) {
    methods.add('auxiliary-mobile-sms');
  }
  if (/mobile_sms|sms_verify|mobile_verify/.test(text))
    methods.add('mobile-sms');
  if (/qrcode|qr_code|scan_verify|scan_qr/.test(text)) methods.add('mobile-qr');
  if (/push_verify|device_push/.test(text)) methods.add('push');
  return methods.size > 0 ? [...methods] : ['unknown'];
}
