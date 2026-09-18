import { DESKTOP_APP_VERSION } from './constants.js';
import { mixModeEncode } from '../passport/mixMode.js';

const ENCRYPT_FIELDS = new Set([
  'mobile', 'email', 'password', 'code', 'account', 'sms_code', 'email_code', 'type',
  'sms_type', 'ect_type', 'recaptcha_token', 'sms_code_key', 'username', 'unbind_exist',
  'current_password', 'old_mobile',
]);

/** AccountSDK 955: verify -> pack -> lt/pt/vt; not the normal login query builder. */
export function encodeActionVerificationPack(decision: Readonly<Record<string, unknown>>, did: string, iid: string): string {
  const data: Record<string, unknown> = {
    mix_mode: 0, aid: 339757, ...decision,
    device_id: did, iid, version_code: DESKTOP_APP_VERSION, device_platform: process.platform,
  };
  delete data['is_login'];
  let encrypted = false;
  for (const key of ENCRYPT_FIELDS) {
    if (data[key] === undefined) continue;
    if (data[key] === null) throw new Error('平台二次验证加密字段无效');
    // C955 st() and the normal login's module83848.w share this field codec;
    // their request/query middleware and encrypted field sets remain distinct.
    data[key] = mixModeEncode(String(data[key]));
    encrypted = true;
  }
  data['mix_mode'] = data['fixed_mix_mode'] = encrypted ? 1 : 0;
  return Object.entries(data).map(([key, value]) =>
    `${encodeURIComponent(key)}=${encodeURIComponent(typeof value === 'object' ? JSON.stringify(value) : String(value))}`,
  ).join('&');
}
