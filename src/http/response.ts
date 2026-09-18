import type { HttpResponse } from './types.js';
import { parseLosslessJson } from './lossless-json.js';

export type ResponseFailureKind = 'captcha' | 'passport-verification' | 'challenge' | 'empty' | 'invalid-json' | 'http';

/** Diagnostic metadata only: never attach the request query, credentials or response body. */
export class DouyinResponseError extends Error {
  override readonly name = 'DouyinResponseError';
  readonly endpoint: string;
  readonly logId: string | undefined;
  readonly guardResult: string | undefined;
  readonly hasGuardServerData: boolean;
  readonly contentType: string | undefined;
  readonly contentLength: string | undefined;

  constructor(
    readonly kind: ResponseFailureKind,
    readonly status: number,
    url: string,
    headers: Headers,
  ) {
    const endpoint = new URL(url).pathname;
    const logId = headers.get('x-tt-logid') ?? undefined;
    const guardResult = headers.get('bd-ticket-guard-result') ?? undefined;
    const hasGuardServerData = headers.has('bd-ticket-guard-server-data');
    const contentType = headers.get('content-type') ?? undefined;
    const contentLength = headers.get('content-length') ?? undefined;
    const diagnostics = [
      logId ? `logid=${logId}` : '',
      guardResult ? `guard=${guardResult}` : '',
      hasGuardServerData ? 'guard-data=yes' : '',
      contentType ? `content-type=${contentType}` : '',
      contentLength ? `content-length=${contentLength}` : '',
    ].filter(Boolean).join(' ');
    super(`Douyin ${kind}: HTTP ${status} ${endpoint}${diagnostics ? ` (${diagnostics})` : ''}`);
    this.endpoint = endpoint;
    this.logId = logId;
    this.guardResult = guardResult;
    this.hasGuardServerData = hasGuardServerData;
    this.contentType = contentType;
    this.contentLength = contentLength;
  }
}

/** JSON endpoints only. Bootstrap HTML and protobuf responses retain their own decoders. */
export function parseJsonResponse<T>(response: HttpResponse<string>, url: string, options: { preserveLargeIntegers?: boolean } = {}): T {
  const { status, headers, rawText, ok } = response;
  const fail = (kind: ResponseFailureKind): never => {
    throw new DouyinResponseError(kind, status, url, headers);
  };
  // Desktop's default Axios settle rejects non-2xx before business projection.
  // Challenge hints on a transport failure do not turn it into a resumable
  // verification response, regardless of whether the body happens to be JSON.
  if (!ok) return fail('http');
  // JSON business errors keep their existing DTO/status-code contract.
  let decoded: unknown;
  try {
    decoded = options.preserveLargeIntegers ? parseLosslessJson(rawText) : JSON.parse(rawText);
  } catch {
    if (headers.get('x-vc-bdturing-parameters')) return fail('captcha');
    if (headers.get('x-tt-verify-passport-decision')) return fail('passport-verification');
    if (/__ac_nonce|_\$jsvmprt/.test(rawText)) return fail('challenge');
    return fail(rawText.trim() ? 'invalid-json' : 'empty');
  }
  if (decoded === null || typeof decoded !== 'object') return fail('invalid-json');
  return decoded as T;
}
