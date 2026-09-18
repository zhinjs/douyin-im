/**
 * Desktop AccountSDK module83848：跳过 UTF-16 代理项，其余 UTF-8 字节
 * XOR 0x05 后以不补零的小写 hex 拼接。不是标准 UTF-8 全字符编码。
 */
export function mixModeEncode(plain: string): string {
  const bytes = Buffer.from(plain.replace(/[\uD800-\uDFFF]/g, ''), 'utf8');
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i]! ^ 5).toString(16);
  }
  return out;
}

/** Passport 形态：`+国家码 号码`。已带国家码时不会重复拼接。 */
export function normalizePassportMobile(
  raw: string,
  defaultCountryCode = '86',
): string {
  // Desktop assembles the selected country code and local number with one
  // space before MF encoding. Preserve that explicit boundary before stripping
  // display formatting; compact foreign numbers remain opaque below.
  const separated = raw.trim().match(/^(\+\d{1,3})\s+(.+)$/s);
  if (separated) {
    const local = separated[2]!.replace(/[\s\-()]/g, '');
    if (!local) throw new Error('手机号不能为空');
    if (!/^\d+$/.test(local)) throw new Error('手机号格式不正确');
    return `${separated[1]} ${local}`;
  }
  const compact = raw.trim().replace(/[\s\-()]/g, '');
  if (!compact) throw new Error('手机号不能为空');
  const prefix = `+${defaultCountryCode}`;
  if (compact.startsWith(prefix)) {
    const local = compact.slice(prefix.length);
    if (!local) throw new Error('手机号不能为空');
    if (!/^\d+$/.test(local)) throw new Error('手机号格式不正确');
    return `${prefix} ${local}`;
  }
  if (compact.startsWith('+')) {
    if (!/^\+\d+$/.test(compact)) throw new Error('手机号格式不正确');
    return compact;
  }
  const digits = compact.replace(/\D/g, '');
  if (!digits) throw new Error('手机号格式不正确');
  const local = digits.startsWith(defaultCountryCode) && digits.length > 11
    ? digits.slice(defaultCountryCode.length)
    : digits;
  return `+${defaultCountryCode} ${local}`;
}

export function mixModeEncodeMobile(
  mobile: string,
  countryCode = '86',
): string {
  return mixModeEncode(normalizePassportMobile(mobile, countryCode));
}

/** `send_code` 默认短信类型明文 `24` */
export const SEND_CODE_TYPE_PLAIN = '24';

export function mixModeEncodeSendCodeType(
  typePlain: string = SEND_CODE_TYPE_PLAIN,
): string {
  return mixModeEncode(typePlain);
}
