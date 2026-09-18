import crypto from 'crypto';

/** 抖音聊天 Desktop Passport appKey，aid=339757。 */
export const DESKTOP_PASSPORT_APP_KEY = '3c452fb664e3de0e936108429a0bc697';

/** Account SDK 每日固定使用 UTC 12:00 作为 aid-sign 时间桶。 */
export function passportNoonUtcTs(now = new Date()): string {
  return String(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    12,
    0,
    0,
    0,
  ) / 1_000);
}

/**
 * Account SDK request interceptor: HKDF-SHA256 32-byte key followed by
 * HMAC-SHA256(`aid={aid}&path={path}&ts={ts}`).
 */
export function buildPassportAidSign(input: {
  aid: string;
  path: string;
  ts: string;
  appKey?: string;
}): string {
  const key = derivePassportAidSignKey(
    Buffer.from(input.ts),
    Buffer.from(input.appKey ?? DESKTOP_PASSPORT_APP_KEY),
  );
  return crypto
    .createHmac('sha256', key)
    .update(`aid=${input.aid}&path=${input.path}&ts=${input.ts}`)
    .digest('hex');
}

function derivePassportAidSignKey(salt: Uint8Array, ikm: Uint8Array): Buffer {
  const extractSalt = salt.length > 0 ? salt : Buffer.alloc(32);
  const prk = crypto.createHmac('sha256', extractSalt).update(ikm).digest();
  // Desktop Ll/Gl uses empty info and a 32-byte output: exactly one expansion
  // block. T(0) is empty, not PRK; the first HMAC input is just counter 0x01.
  return crypto.createHmac('sha256', prk).update(Buffer.from([1])).digest();
}

export interface PassportSignQsInput {
  /** 查询参数（不含 sign / qs / msToken / a_bogus） */
  query: Record<string, string>;
  /** POST body 字段；使用解码后的值（与 SDK 内存对象一致，非 URL 编码串） */
  body?: Record<string, string>;
  appKey?: string;
}

export interface PassportSignQsOutput {
  sign: string;
  qs: string;
}

function sortedParamString(obj: Record<string, string>, keepFirstN?: number): {
  str: string;
  keys: string[];
} {
  let keys = Object.keys(obj).sort();
  if (keepFirstN !== undefined && keepFirstN >= 0) {
    keys = keys.slice(0, keepFirstN);
  }
  const str = keys
    .map((k) => {
      const v = obj[k];
      const val =
        typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      return `${k}=${val}`;
    })
    .join('&');
  return { str, keys };
}

/** qs：对「排序后前 10 个 query 键名」逗号拼接，再 UTF-8 + 每字节 XOR 5 → hex（无补零） */
function encodeQsKeyNames(keyNames: string[]): string {
  const input = keyNames.join(',');
  const out: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const cp = input.charCodeAt(i);
    const bytes: number[] = [];
    if (cp >= 0 && cp <= 0x7f) {
      bytes.push(cp);
    } else if (cp >= 0x80 && cp <= 0x7ff) {
      bytes.push(0xc0 | (31 & (cp >> 6)), 0x80 | (63 & cp));
    } else if (
      (cp >= 0x800 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xffff)
    ) {
      bytes.push(
        0xe0 | (15 & (cp >> 12)),
        0x80 | (63 & (cp >> 6)),
        0x80 | (63 & cp),
      );
    }
    for (const b of bytes) {
      out.push((5 ^ b).toString(16));
    }
  }
  return out.join('');
}

/**
 * 复现 tt-account-sdk 的 `d(query, body, appKey)` 请求拦截器；默认使用 Desktop appKey。
 */
export function buildPassportSignQs(
  input: PassportSignQsInput,
): PassportSignQsOutput {
  const appKey = input.appKey ?? DESKTOP_PASSPORT_APP_KEY;
  const body = input.body ?? {};
  const { str: queryStr, keys } = sortedParamString(input.query, 10);
  const { str: bodyStr } = sortedParamString(body);
  const payload = `${queryStr}&${bodyStr}&app_key=${appKey}`;
  const sign = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  const qs = encodeQsKeyNames(keys);
  return { sign, qs };
}

/** 将 application/x-www-form-urlencoded 解析为签名用的 body 对象（值已 decode） */
export function parseFormBodyForSign(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body) return out;
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      out[decodeURIComponent(part)] = '';
    } else {
      out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(
        part.slice(eq + 1),
      );
    }
  }
  return out;
}
