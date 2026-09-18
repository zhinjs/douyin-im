import type { DesktopWebSecureSdk } from './desktop-web-secure-sdk.js';
import type { DesktopWebSecureSceneConfig } from './desktop-web-secure-config.js';

export interface DesktopPassportSecureOptions extends DesktopWebSecureSceneConfig {
  agid?: number | string;
  initCallback?: () => unknown;
  enableHeaderOptions?: boolean;
  enableCookieOptions?: boolean;
  disableCrossStorage?: boolean;
}
export interface DesktopPassportSecurePluginProps {
  aid?: number | string;
  ztsdkOptions?: DesktopPassportSecureOptions;
  ssoZtsdkOptions?: DesktopWebSecureSceneConfig & { enable?: boolean };
  dtrait?: boolean;
  dtraitOption?: unknown;
}
export interface DesktopPassportSecurePluginContext {
  /** C321 pp is module/realm-wide. Use the account's actual isolated window object. */
  readonly realm: object;
  readonly sdk: Pick<DesktopWebSecureSdk, 'setConfig' | 'setDisableCrossStorage' | 'setAgidAndHost' | 'setWebId' | 'start' | 'startDTrait'>;
  getCookie(name: string): string | null | undefined;
  onBackgroundError?(error: unknown): void;
}
const initialized = new WeakSet<object>();

/** hp: source order and merge precedence. Does not start BDMS or install a browser/default login. */
export class DesktopPassportSecurePlugin {
  hasInit = false;
  defaultConfig: DesktopWebSecureSceneConfig = { scene: 'web_protect', signVersion: 2 };
  defaultWebConsumerPathList = ['/passport/token/beat/web', '/passport/account/info/v2'];
  constructor(readonly context: DesktopPassportSecurePluginContext, public initProps: DesktopPassportSecurePluginProps) {}
  init = (): void => {
    if (this.hasInit || initialized.has(this.context.realm)) return;
    const { aid, ztsdkOptions = {}, ssoZtsdkOptions = {}, dtrait = true } = this.initProps;
    void this.initProps.dtraitOption; // Desktop reads and ignores this field.
    const { agid = 1, initCallback, enableHeaderOptions = true, enableCookieOptions = true, ...web } = ztsdkOptions;
    const { enable: enableSso = true, ...sso } = ssoZtsdkOptions;
    const { consumerPathList = [], providerPathList = [], onlyProviderPathList = [], urlRewriteRules = [], disableCrossStorage = false, ...webRest } = web;
    const { consumerPathList: ssoConsumers = [], providerPathList: ssoProviders = [], urlRewriteRules: ssoRules = [], ...ssoRest } = sso;
    const sdk = this.context.sdk;
    // Cookie deliberately spreads the entire original options LAST, including path lists/control fields.
    if (enableCookieOptions) sdk.setConfig({ aid, certType: 'cookie', ...this.defaultConfig,
      consumerPathList: append(append([], consumerPathList || []), this.defaultWebConsumerPathList), ...ztsdkOptions });
    if (enableHeaderOptions) sdk.setConfig({ aid, certType: 'header', scene: 'web_protect', namespace: 'web', signVersion: 2,
      providerPathList: append(['/passport/web/sms_login/', '/passport/web/sms_login_only/', '/passport/web/email/login/', '/passport/web/email/code_login/',
        '/passport/web/email/quick_login/', '/passport/web/web_login/', '/passport/web/check_qrconnect/', '/passport/web/user/login/'], providerPathList || []),
      onlyProviderPathList: append(['/passport/web/one_login/'], onlyProviderPathList || []),
      consumerPathList: append(append([], consumerPathList || []), this.defaultWebConsumerPathList), urlRewriteRules: append([], (urlRewriteRules || []) as unknown[]), ...webRest });
    if (enableSso) sdk.setConfig({ aid, certType: 'header', scene: 'sso', namespace: 'sso', signVersion: 2,
      consumerPathList: append(['sso.douyin.com/check_login/'], ssoConsumers || []),
      providerPathList: append(['sso.douyin.com/quick_login/v2/', 'sso.douyin.com/check_qrconnect/', 'sso.douyin.com/account_login/v2/',
        'sso.douyin.com/one_login/', 'sso.douyin.com/quick_login_only/'], ssoProviders || []),
      urlRewriteRules: append([['sso.douyin.com/check_login/', '/passport/sso/check_login/']], (ssoRules || []) as unknown[]), ...ssoRest });
    if (disableCrossStorage) sdk.setDisableCrossStorage(true);
    sdk.setAgidAndHost(agid);
    const webId = this.context.getCookie('passport_csrf_token') || this.context.getCookie('passport_csrf_token_default') || '';
    sdk.setWebId(webId);
    const pending = sdk.start();
    // Additive detached rejection observation; no await, retry, rollback or ready event.
    void pending.catch(error => { try { this.context.onBackgroundError?.(error); } catch { /* Observation only. */ } });
    if (dtrait) sdk.startDTrait({ aid, webId });
    initialized.add(this.context.realm);
    initCallback?.();
    this.hasInit = true;
  };
}

/** C321 dp(..., true): densify holes and copy numeric indices, not iterator semantics. */
function append<T>(target: T[], source: ArrayLike<T>): T[] {
  const copy: T[] = []; for (let i = 0, length = source.length; i < length; i++) copy[i] = source[i]!;
  return target.concat(copy);
}
