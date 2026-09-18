import { setDesktopProperty, deleteDesktopProperty } from './desktop-property-write.js';
import { prepareDesktopXhrUrl, type DesktopTokenState, type DesktopXhrUrlContext } from './desktop-token.js';

type XhrMethod = DesktopHookXhr['open'];
interface DeferredInvocation { func: XhrMethod; args: unknown[] }

export interface DesktopHookXhr {
  open(...args: unknown[]): unknown;
  setRequestHeader(...args: unknown[]): unknown;
  send(...args: unknown[]): unknown;
  bdmsInvokeList?: DeferredInvocation[];
}

export interface DesktopXhrHookContext extends DesktopXhrUrlContext {
  readonly XMLHttpRequest: { readonly prototype: DesktopHookXhr };
  readonly Array: ArrayConstructor;
}

export interface DesktopXhrHookCallbacks {
  matchesSigning(pathname: string): boolean;
  matchesBehavior(pathname: string): boolean;
  sign(query: string, body: unknown): string;
  reportBehavior(): void;
}

/**
 * BDMS .7 PC7833–8490. Install once on the owned host, AFTER report method capture.
 * Not an account HTTP adapter. Does not hook abort, add retries, or deduplicate installs.
 */
export function installDesktopXhrHook(
  context: DesktopXhrHookContext,
  tokens: Pick<DesktopTokenState, 'token'>,
  callbacks: DesktopXhrHookCallbacks,
): void {
  const prototype = context.XMLHttpRequest.prototype;
  const open = prototype.open;
  const send = prototype.send;
  const header = prototype.setRequestHeader;
  function copy(args: IArguments): unknown[] {
    const length = args.length;
    const result = new context.Array<unknown>(length);
    for (let i = 0; i < length; i++) setDesktopProperty(result, i, args[i]);
    return result;
  }
  // The complete bundle is strict: rejected writes/deletes throw.
  /* eslint-disable prefer-spread, prefer-rest-params -- Preserve method.apply and source argument-copy allocation order. */
  setDesktopProperty(prototype, 'open', function(this: DesktopHookXhr) {
    deleteDesktopProperty(this, 'bdmsInvokeList');
    const args = copy(arguments);
    const input = args[1] as string | URL;
    const isUrl = typeof context.URL !== 'undefined' && input instanceof context.URL;
    const pathname = isUrl ? input.pathname : new context.URL(input, context.location.href).pathname;
    if (!Reflect.apply(callbacks.matchesSigning, null, [pathname])) {
      open.apply(this, args);
      return;
    }
    setDesktopProperty(this, 'bdmsInvokeList', []);
    this.bdmsInvokeList!.push({ func: open, args });
  });
  setDesktopProperty(prototype, 'setRequestHeader', function(this: DesktopHookXhr) {
    const args = copy(arguments);
    if (this.bdmsInvokeList) {
      this.bdmsInvokeList.push({ func: header, args });
      return;
    }
    header.apply(this, args);
  });
  setDesktopProperty(prototype, 'send', function(this: DesktopHookXhr, body: unknown) {
    if (this.bdmsInvokeList) {
      const args = this.bdmsInvokeList[0]!.args;
      const { url, isUrl } = prepareDesktopXhrUrl(context, args[1] as string | URL, body, tokens, {
        sign: (query, value) => Reflect.apply(callbacks.sign, null, [query, value]),
      });
      if (!isUrl) setDesktopProperty(args, 1, url.href);
      this.bdmsInvokeList!.forEach(entry => { entry.func.apply(this, entry.args); });
      if (Reflect.apply(callbacks.matchesBehavior, null, [url.pathname])) {
        Reflect.apply(callbacks.reportBehavior, null, []);
      }
      deleteDesktopProperty(this, 'bdmsInvokeList');
    }
    send.apply(this, [body]);
  });
  /* eslint-enable prefer-spread, prefer-rest-params */
}
