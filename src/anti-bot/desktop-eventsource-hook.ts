import { setDesktopProperty } from './desktop-property-write.js';
import type { DesktopTokenState, DesktopXhrUrlContext } from './desktop-token.js';
import type { DesktopFetchHookCallbacks } from './desktop-fetch-hook.js';

export interface DesktopEventSourceHookContext extends DesktopXhrUrlContext {
  readonly window: { EventSource?: unknown };
  readonly Object: Omit<ObjectConstructor, 'setPrototypeOf'> & { setPrototypeOf?: ObjectConstructor['setPrototypeOf'] };
  readonly Reflect: typeof Reflect | undefined;
  readonly Proxy: ProxyConstructor | undefined;
  readonly Boolean: BooleanConstructor;
  readonly TypeError: TypeErrorConstructor;
}

export interface DesktopEventSourceWrapper<T extends object = object> {
  new(input: string | URL, options?: unknown): T;
  (input: string | URL, options?: unknown): T;
  readonly prototype: object;
  handleUrl(input: string | URL): string | URL;
}

/** BDMS .7 PC9435–9782. Preserves the source's Babel-derived constructor contract. */
export function installDesktopEventSourceHook(
  context: DesktopEventSourceHookContext,
  tokens: Pick<DesktopTokenState, 'token'>,
  callbacks: DesktopFetchHookCallbacks,
): void {
  if (typeof context.window.EventSource !== 'function') return;
  const parent = context.window.EventSource;
  const object = context.Object;
  const typeError = context.TypeError;
  if (typeof parent !== 'function' && parent !== null) {
    throw new typeError('Super expression must either be null or a function');
  }
  let getPrototype: (value: object) => object;
  const prototypeOf = (value: object): object => {
    if (!getPrototype) {
      if (object.setPrototypeOf) {
        const get = object.getPrototypeOf;
        getPrototype = Reflect.apply(get.bind, get, []);
      } else getPrototype = value => Reflect.get(value, '__proto__') || object.getPrototypeOf(value);
    }
    return getPrototype(value);
  };
  const Wrapper = function(this: object, input: string | URL, options?: unknown): object {
    if (!(this instanceof Wrapper)) throw new typeError('Cannot call a class as a function');
    const url = Wrapper.handleUrl(input);
    const superConstructor = prototypeOf(Wrapper) as DesktopEventSourceWrapper;
    let result: unknown;
    if (useReflect) {
      const newTarget = Reflect.get(prototypeOf(this), 'constructor') as DesktopEventSourceWrapper;
      result = context.Reflect!.construct(superConstructor, [url, options], newTarget);
    } else {
      // Source fallback calls the original function's dynamic apply, not Reflect.apply.
      result = superConstructor.apply(this, [url, options]);
    }
    if (result && (typeof result === 'object' || typeof result === 'function')) return result;
    if (result !== undefined) throw new typeError('Derived constructors may only return object or undefined');
    return this;
  } as unknown as DesktopEventSourceWrapper;
  setDesktopProperty(Wrapper, 'prototype', object.create(parent && parent.prototype, {
    constructor: { value: Wrapper, writable: true, configurable: true },
  }));
  object.defineProperty(Wrapper, 'prototype', { writable: false });
  if (parent) {
    if (object.setPrototypeOf) {
      const set = object.setPrototypeOf;
      Reflect.apply(set.bind, set, [])(Wrapper, parent);
    }
    else setDesktopProperty(Wrapper, '__proto__', parent);
  }
  const useReflect = nativeReflectConstruct();
  object.defineProperty(Wrapper, 'handleUrl', {
    enumerable: false, configurable: true, writable: true,
    value(input: string | URL): string | URL {
      const isUrl = typeof context.URL !== 'undefined' && input instanceof context.URL;
      const base = context.location.href;
      const url = isUrl ? input : new context.URL(input, base);
      if (!Reflect.apply(callbacks.matchesSigning, null, [url.pathname])) return input;
      if (Reflect.apply(callbacks.matchesBehavior, null, [url.pathname])) Reflect.apply(callbacks.reportBehavior, null, []);
      if (tokens.token && !url.searchParams.has('msToken')) url.searchParams.append('msToken', tokens.token);
      const signature = Reflect.apply(callbacks.sign, null, [url.search.slice(1), {}]);
      url.searchParams.append('a_bogus', signature);
      return url;
    },
  });
  object.defineProperty(Wrapper, 'prototype', { writable: false });
  setDesktopProperty(context.window, 'EventSource', Wrapper);

  function nativeReflectConstruct(): boolean {
    if (typeof context.Reflect === 'undefined' || !context.Reflect.construct) return false;
    if ((context.Reflect.construct as typeof Reflect.construct & { sham?: unknown }).sham) return false;
    if (typeof context.Proxy === 'function') return true;
    try {
      context.Boolean.prototype.valueOf.call(context.Reflect.construct(context.Boolean, [], function() {}));
      return true;
    } catch { return false; }
  }
}
