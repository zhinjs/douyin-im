/** Rejected Passport business data. Request query and response secrets are not log fields. */
export class PassportRequestError extends Error {
  override readonly name = 'PassportRequestError';
  readonly endpoint: string;
  readonly errorCode: number | undefined;
  readonly #data: Readonly<Record<string, unknown>>;

  constructor(endpoint: string, data: Readonly<Record<string, unknown>>) {
    const path = new URL(endpoint, 'https://imdesktop.douyin.com').pathname;
    const code = typeof data['error_code'] === 'number' && Number.isSafeInteger(data['error_code'])
      ? data['error_code'] : undefined;
    super(`Passport 未返回 success: ${path} (code=${code ?? 'unknown'})`);
    this.endpoint = path;
    this.errorCode = code;
    this.#data = structuredClone(data);
  }

  /** Sensitive verification input; read only to resume authentication, never log. */
  get data(): Record<string, unknown> { return structuredClone(this.#data); }
}
