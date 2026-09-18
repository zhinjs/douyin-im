export type QrConnectStatus = 'new' | 'scanned' | 'confirmed' | 'expired' | string;

export interface QrUserData {
  app_id?: number;
  user_id?: number;
  user_id_str?: string;
  sec_user_id?: string;
  screen_name?: string;
  name?: string;
  avatar_url?: string;
  mobile?: string;
  has_password?: number;
  country_code?: number;
  [key: string]: unknown;
}

export interface GetQrcodeData {
  token: string;
  qrcode: string;
  expire_time: number;
  error_code?: number;
  qrcode_index_url?: string;
  app_name?: string;
  web_name?: string;
}

export interface GetQrcodeResponse {
  message: string;
  data: GetQrcodeData;
}

export interface CheckQrconnectData {
  /** Account SDK 兼容形状：部分适配器会把 Passport 业务数据再包一层 data。 */
  data?: CheckQrconnectData;
  status?: QrConnectStatus;
  /** 二维码失效时 Desktop Passport 可直接下发替换二维码。 */
  token?: string;
  qrcode?: string;
  expire_time?: number;
  qrcode_index_url?: string;
  error_code?: number;
  account_flow?: string;
  encrypt_uid?: string;
  biz_params?: Record<string, unknown>;
  common_params?: Record<string, unknown>;
  captcha?: string;
  verify_ticket?: string;
  verify_center_decision_conf?: string;
  verify_center_secondary_decision_conf?: string;
  sms_code_key?: string;
  description?: string;
  desc_url?: string;
  extra?: string;
  redirect_url?: string;
  scan_app_id?: number;
  user_data?: QrUserData;
  scan_user_info?: Record<string, unknown>;
  scan_device_info?: Record<string, unknown>;
}

export interface QrMfaChallenge {
  encrypt_uid?: string;
  biz_params?: Record<string, unknown>;
  common_params?: Record<string, unknown>;
}

export interface CheckQrconnectResponse {
  message: string;
  data: CheckQrconnectData;
}

export interface QrCodeInfo {
  token: string;
  qrcodeBase64: string;
  expireTime: number;
  /** 扫码页 URL，可用于终端 ASCII 二维码 */
  qrcodeIndexUrl?: string;
}

export interface PassportApiData {
  error_code?: number;
  description?: string;
  captcha?: string;
  verify_ticket?: string;
  verify_center_decision_conf?: string;
  verify_center_secondary_decision_conf?: string;
  mobile?: string;
  mobile_ticket?: string;
  retry_time?: number;
  /** 同一手机号绑定多个账号时，Passport 用 1454 返回候选账号。 */
  sub_account?: PassportSubAccount[];
  sms_code_key?: string;
  [key: string]: unknown;
}

export interface PassportApiResponse {
  message: string;
  data: PassportApiData;
}

export type PassportTokenBeatScene = 'boot' | 'active' | 'polling';

export interface PassportLoginOptions {
  /** 原连接返回的失败响应；只用于用户完成验证后的原请求重放。 */
  retry?: PassportApiResponse | CheckQrconnectResponse;
  /** 滑块通过后重试时与 Cookie `s_v_web_id` 同源 */
  fp?: string;
  /** 验证重放时显式补入原表单的字段；上层仅自动补源码指定的 sms_code_key。 */
  verificationFields?: Readonly<Record<string, unknown>>;
  /** error_code=1454 后按用户选择继续同一手机号的登录。 */
  subAccount?: {
    smsCodeKey: string;
    secUid?: string;
    registerNewUser?: boolean;
  };
}

export interface PassportSubAccount {
  sec_uid?: string;
  user_id?: string | number;
  name?: string;
  avatar?: string;
  aweme_id?: string | number;
  is_bind_login_mobile?: boolean;
  passport_enterprise_user_type?: number;
  business_account_active?: boolean;
  app_account_group_id?: number;
  [key: string]: unknown;
}
