/** A rejected business request requiring human verification, not a transport retry. */
export class ActionChallengeError extends Error {
  override readonly name = 'ActionChallengeError';
  readonly #raw: string;

  constructor(readonly source: 'passport-decision' | 'bdturing', raw: string) {
    super(source === 'passport-decision' ? '业务操作需要身份二次验证' : '业务操作需要验证码验证');
    if (!raw || raw.length > 65_536) throw new Error('平台业务验证数据无效');
    if (source === 'passport-decision') {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new Error('平台二次验证数据不是有效 JSON'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('平台二次验证数据不是对象');
    }
    this.#raw = raw;
  }

  /** Sensitive platform input: only pass to the verification UI, never log. */
  get raw(): string { return this.#raw; }
}
