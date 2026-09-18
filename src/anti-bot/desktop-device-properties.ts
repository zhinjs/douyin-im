import { setDesktopProperty } from './desktop-property-write.js';
export interface DesktopPropertyContext {
  readonly Symbol?: unknown;
  readonly Object: typeof Object;
}

/** BDMS .7 G, with its own context-lifetime Babel typeof selection. */
export class DesktopPropertyClassifier {
  private readonly symbol: unknown;
  private readonly object: typeof Object;
  private typeOf: ((input: unknown) => string) | undefined;

  constructor(context: DesktopPropertyContext) {
    this.symbol = context.Symbol;
    this.object = context.Object;
  }

  classify(target: unknown, key: PropertyKey): number {
    return this.classifyProperty(target, key);
  }

  protected classifyProperty(target: unknown, key: PropertyKey, onReadError?: () => void): number {
    let value: unknown;
    // Only this property read is covered by G's 404 fallback.
    try { value = (target as Record<PropertyKey, unknown>)[key]; } catch { onReadError?.(); return 404; }
    const tag = this.object.prototype.toString.call(value);
    switch (tag) {
      case '[object Boolean]': return value === true ? 1 : 2;
      case '[object Function]': return 3;
      case '[object Undefined]': return 4;
      case '[object Number]': return 5;
      case '[object String]': return value === '' ? 7 : 8;
      case '[object Array]': return (value as { length: unknown }).length === 0 ? 9 : 10;
      case '[object Object]': return 11;
      case '[object HTMLAllCollection]': return 12;
      case '[object Storage]': return 13;
      default: return this.fallbackType(value) === 'object' ? 99 : -1;
    }
  }

  private fallbackType(value: unknown): string {
    if (!this.typeOf) {
      this.typeOf = typeof this.symbol === 'function' && typeof (this.symbol as SymbolConstructor).iterator === 'symbol'
        ? input => typeof input
        : input => input && typeof this.symbol === 'function' &&
          (input as { constructor?: unknown }).constructor === this.symbol && input !== this.symbol.prototype
          ? 'symbol' : typeof input;
    }
    return this.typeOf(value);
  }
}

export interface DesktopDocumentContext extends DesktopPropertyContext {
  readonly document: {
    readonly all?: unknown;
    readonly characterSet?: unknown;
    readonly compatMode?: unknown;
    readonly documentMode?: unknown;
    readonly images?: unknown;
    readonly layers?: unknown;
  };
}

/** V reuses G; each field re-reads the context document binding, without caching or fallback. */
export class DesktopDocumentCollector extends DesktopPropertyClassifier {
  constructor(private readonly context: DesktopDocumentContext) { super(context); }

  collect() {
    let result: object = {};
    const classify = (key: 'all' | 'images' | 'layers') => {
      const document = this.context.document;
      return this.classifyProperty(document, key, () => {
        // Original VM leaves the failed read's target on its operand stack.
        // V subsequently writes into and returns that target, not its new report.
        result = document;
      });
    };
    // Strict bundle writes propagate refused assignments.
    const put = (key: string, value: unknown) => { setDesktopProperty(result, key, value); };
    put('all', classify('all'));
    // Casts only satisfy TS: + '' keeps the original default ToPrimitive hint.
    put('characterSet', (this.context.document.characterSet as string) + '');
    put('compatMode', (this.context.document.compatMode as string) + '');
    put('documentMode', (this.context.document.documentMode as string) + '');
    put('images', classify('images'));
    put('layers', classify('layers'));
    return result;
  }
}
