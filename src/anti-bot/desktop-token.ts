export interface DesktopTokenContext {
  readonly localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  requestAnimationFrame(callback: (time: number) => void): unknown;
}

/** BDMS .7 xmst state, owned by one script context, not by the account Cookie jar. */
export class DesktopTokenState {
  private inner = '';

  constructor(private readonly context: DesktopTokenContext) {
    try { this.inner = context.localStorage.getItem('xmst') || ''; } catch { /* Storage may be unavailable. */ }
  }

  get token(): string { return this.inner; }

  /** Only the report XHR load handler calls this; ordinary business responses do not. */
  onReportLoad(xhr: { getResponseHeader(name: string): string | null }, deviceReport: (time: number) => void): void {
    const alreadyHadToken = !!this.inner;
    const next = xhr.getResponseHeader('x-ms-token');
    if (!next) return;
    try { this.context.localStorage.setItem('xmst', next); } catch { /* Memory still advances. */ }
    this.inner = next;
    if (!alreadyHadToken) Reflect.apply(this.context.requestAnimationFrame, null, [deviceReport]);
  }
}

export interface DesktopXhrUrlContext {
  readonly URL: typeof URL;
  readonly location: { readonly href: string };
}

/**
 * URL step of an already-matched XHR send (PC8191–8401), not a hook installer.
 * Retains same-realm URL identity, including mutations if signing subsequently throws.
 * Matching, deferred open/header replay and report scheduling belong to the caller.
 */
export function signDesktopXhrUrl(
  context: DesktopXhrUrlContext,
  input: string | URL,
  body: unknown,
  state: Pick<DesktopTokenState, 'token'>,
  signer: { sign(query: string, body: unknown): string },
): string | URL {
  const { url, isUrl } = prepareDesktopXhrUrl(context, input, body, state, signer);
  return isUrl ? url : url.href;
}

/** Shared URL preparation; the hook must retain this URL until after deferred replay. */
export function prepareDesktopXhrUrl(
  context: DesktopXhrUrlContext,
  input: string | URL,
  body: unknown,
  state: Pick<DesktopTokenState, 'token'>,
  signer: { sign(query: string, body: unknown): string },
): { url: URL; isUrl: boolean } {
  const isUrl = typeof context.URL !== 'undefined' && input instanceof context.URL;
  const url = isUrl ? input : new context.URL(input, context.location.href);
  if (!url.searchParams.has('msToken') && state.token) url.searchParams.append('msToken', state.token);
  if (!url.searchParams.has('a_bogus')) {
    // XHR passes only query and send body, even when a Content-Type header was queued.
    const signature = signer.sign(url.searchParams.toString(), body);
    url.searchParams.append('a_bogus', signature);
  }
  return { url, isUrl };
}
