import { classifyDesktopBrowser, classifyDesktopOS, classifyDesktopPlatform, DesktopStorageState, type DesktopStorageContext } from './desktop-environment.js';

/** Actual bindings from one runtime. Missing bindings remain missing, never browser-shaped defaults. */
export interface DesktopEnvironmentContext {
  readonly window?: DesktopStorageContext['window'] & {
    readonly screen?: unknown; readonly eval?: unknown;
    readonly innerWidth?: number; readonly innerHeight?: number;
    readonly outerWidth?: number; readonly outerHeight?: number;
    readonly Audio?: unknown; readonly CanvasRenderingContext2D?: unknown;
    readonly _phantom?: unknown; readonly callPhantom?: unknown; readonly __nightmare?: unknown;
    readonly cefSharp?: unknown; readonly CefSharp?: unknown;
    readonly eoapi?: unknown; readonly eoWebBrowserDispatcher?: unknown;
  };
  readonly navigator?: DesktopStorageContext['navigator'] & {
    readonly appVersion?: string; readonly platform?: string;
    readonly plugins?: unknown; readonly webdriver?: unknown;
    readonly connection?: { readonly rtt?: number };
    readonly userAgentData?: { readonly brands?: { readonly length?: number } | null; readonly platform?: string };
  };
  readonly document?: { createElement(tag: string): { readonly toDataURL?: unknown } };
  readonly location?: { readonly href?: string };
  readonly history?: unknown;
  readonly PluginArray?: unknown;
  readonly MSPluginsCollection?: unknown;
  readonly webpackGlobal?: { readonly process?: unknown };
  readonly process?: unknown;
  readonly Symbol?: unknown;
}

/** Installed BDMS .7 M, including its context-lifetime storage/typeof closures. */
export class DesktopEnvironmentState {
  private readonly storage: DesktopStorageState;
  private readonly symbol: unknown;
  private processType: ((value: unknown) => string) | undefined;

  constructor(private readonly context: DesktopEnvironmentContext) {
    // j's original bridge captures Symbol by value at module initialization.
    this.symbol = context.Symbol;
    // No browser/storage probing until the original browser gate succeeds.
    this.storage = new DesktopStorageState(context as DesktopStorageContext);
  }

  mask(): number {
    let mask = 1;
    if (!this.isBrowser()) return mask | (1 << 7);
    mask |= +this.nativeMismatch() << 1;
    mask |= +this.storage.probe() << 2;
    mask |= +this.automationSignals() << 3;
    // A() is intentionally not boolean: unary + preserves constructor/object coercion.
    mask |= +(this.legacyAutomation() as number) << 4;
    mask |= +this.nodeProcess() << 5;
    mask |= +this.firefoxWindowGap() << 6;
    mask |= +this.embeddedHost() << 8;
    mask |= +this.localAddress() << 9;
    mask |= +this.platformMismatch() << 10;
    return mask;
  }

  private isBrowser(): boolean {
    const c = this.context;
    if (!(typeof c.window !== 'undefined' && typeof c.navigator !== 'undefined' &&
      typeof c.document !== 'undefined' && typeof c.location !== 'undefined' && typeof c.history !== 'undefined')) return false;
    const navigator = Object.prototype.toString.call(c.navigator) === '[object Navigator]';
    const document = Object.prototype.toString.call(c.document) === '[object HTMLDocument]' || Object.prototype.toString.call(c.document) === '[object Document]';
    const location = Object.prototype.toString.call(c.location) === '[object Location]' || Object.prototype.toString.call(c.location) === '[object Object]';
    const history = Object.prototype.toString.call(c.history) === '[object History]';
    return navigator && document && location && history;
  }

  private nativeMismatch(): boolean {
    const suspicious = (fn: unknown): boolean => typeof fn !== 'function' || fn.toString().indexOf('[native code]') <= 0;
    try {
      if (suspicious(this.context.document!.createElement('canvas').toDataURL)) return true;
    } catch { return true; }
    return suspicious(this.context.navigator!.toString) || this.pluginArrayMismatch() || this.msPluginsMismatch();
  }

  private pluginArrayMismatch(): boolean {
    return typeof this.context.PluginArray !== 'undefined' && !(this.context.navigator!.plugins instanceof (this.context.PluginArray as typeof Object));
  }

  private msPluginsMismatch(): boolean {
    return typeof this.context.MSPluginsCollection !== 'undefined' && !(this.context.navigator!.plugins instanceof (this.context.MSPluginsCollection as typeof Object));
  }

  private automationSignals(): boolean {
    if (!this.context.window!.screen || !this.context.window!.eval) return true;
    // All weak signals precede even a true strong signal; preserve getter/throw order.
    const connection = !!this.context.navigator!.connection && this.context.navigator!.connection.rtt === 0;
    let userAgentData = false;
    if (this.context.navigator!.userAgentData) {
      const brands = this.context.navigator!.userAgentData.brands;
      userAgentData = brands?.length === 0 && this.context.navigator!.userAgentData.platform === '';
    }
    const iw = this.context.window!.innerWidth === 800;
    const ih = this.context.window!.innerHeight === 600;
    const ow = this.context.window!.outerWidth === 0;
    const oh = this.context.window!.outerHeight === 0;
    const dimensions = (iw && ih) || (ow && oh);
    return (!!this.context.navigator!.appVersion && this.context.navigator!.appVersion.indexOf('HeadlessChrome') >= 0) ||
      typeof this.context.navigator!.userAgent !== 'string' || this.context.navigator!.userAgent.indexOf('HeadlessChrome') >= 0 ||
      this.context.navigator!.webdriver === true || Object.getOwnPropertyDescriptor(this.context.navigator!, 'webdriver') !== undefined ||
      [connection, userAgentData, dimensions].filter(value => value).length >= 3;
  }

  private legacyAutomation(): unknown {
    return this.pluginArrayMismatch() || this.msPluginsMismatch() ||
      !!this.context.window!._phantom || !!this.context.window!.callPhantom || !!this.context.window!.__nightmare ||
      (!this.context.window!.Audio && this.context.window!.CanvasRenderingContext2D);
  }

  private nodeProcess(): boolean {
    return (typeof this.context.webpackGlobal !== 'undefined' && Object.prototype.toString.call(this.context.webpackGlobal.process) === '[object process]') ||
      ((typeof this.context.process === 'undefined' ? 'undefined' : this.typeOfProcess(this.context.process)) === 'object' &&
        (this.context.process as { title?: unknown }).title === 'node');
  }

  private typeOfProcess(value: unknown): string {
    if (!this.processType) {
      this.processType = typeof this.symbol === 'function' && typeof (this.symbol as SymbolConstructor).iterator === 'symbol'
        ? input => typeof input
        : input => input && typeof this.symbol === 'function' &&
          (input as { constructor?: unknown }).constructor === this.symbol && input !== (this.symbol as { prototype: unknown }).prototype
          ? 'symbol' : typeof input;
    }
    return this.processType(value);
  }

  private firefoxWindowGap(): boolean {
    if (classifyDesktopBrowser(this.context.navigator!.userAgent) !== 'Firefox') return false;
    const outerWidth = this.context.window!.outerWidth as number;
    const outerHeight = this.context.window!.outerHeight as number;
    const innerWidth = this.context.window!.innerWidth as number;
    const innerHeight = this.context.window!.innerHeight as number;
    return outerWidth - innerWidth > 400 || outerHeight - innerHeight > 300;
  }

  private embeddedHost(): boolean {
    return !!this.context.window!.cefSharp || !!this.context.window!.CefSharp ||
      !!this.context.window!.eoapi || !!this.context.window!.eoWebBrowserDispatcher;
  }

  private localAddress(): boolean {
    const href = this.context.location!.href;
    const local = new RegExp('^(file|http://localhost)', 'i');
    const ip = new RegExp('^https?://([0-9]{1,3}(\\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})');
    return local.test(href as string) || ip.test(href as string);
  }

  private platformMismatch(): boolean {
    const os = classifyDesktopOS(this.context.navigator!.userAgent);
    const platform = classifyDesktopPlatform(this.context.navigator!.platform);
    const windows = platform === 'Windows' && os !== 'Windows';
    const linux = platform === 'Linux' && os !== 'Linux' && os !== 'HarmonyOS' && os !== 'Android';
    const android = platform === 'Android' && os !== 'Android';
    const apple = platform === 'Apple' && os !== 'MacOS' && os !== 'iOS';
    const other = platform === 'Other' && os !== 'Other';
    return windows || linux || android || apple || other;
  }
}
