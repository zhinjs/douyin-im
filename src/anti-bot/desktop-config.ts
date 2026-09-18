import { setDesktopProperty } from './desktop-property-write.js';
export interface DesktopBdmsInitOptions {
  aid?: number;
  pageId?: number;
  boe?: boolean;
  ddrt?: number;
  dump?: boolean | null;
  rpU?: string;
  paths?: (string | RegExp)[] | { include?: (string | RegExp)[]; exclude?: (string | RegExp)[] };
  track?: { mode?: number; delay?: number; paths?: (string | RegExp)[] };
}

export interface DesktopBdmsConfig {
  aid: number; pageId: number; boe: boolean; ddrt: number;
  paths: { include: RegExp[]; exclude: RegExp[] };
  track: { mode: number; delay: number; paths: RegExp[] };
  dump: boolean; rpU: string;
}

export interface DesktopConfigContext {
  readonly window: { onwheelx?: object };
  readonly Array: ArrayConstructor;
  readonly Object: ObjectConstructor;
  readonly RegExp: RegExpConstructor;
  readonly Symbol: SymbolConstructor | undefined;
  readonly TypeError: TypeErrorConstructor;
}

/** Stateful init and pathname predicates; does not install request hooks. */
export class DesktopBdmsConfiguration {
  readonly config: DesktopBdmsConfig = {
    aid: 0, pageId: 0, boe: false, ddrt: 3, paths: { include: [], exclude: [] },
    track: { mode: 0, delay: 300, paths: [] }, dump: true, rpU: '',
  };
  private readonly array: ArrayConstructor;
  private readonly object: ObjectConstructor;
  private readonly regexp: RegExpConstructor;
  private readonly symbol: SymbolConstructor | undefined;
  private readonly typeError: TypeErrorConstructor;

  constructor(private readonly context: DesktopConfigContext, private readonly start: () => void) {
    this.array = context.Array; this.object = context.Object; this.regexp = context.RegExp;
    this.symbol = context.Symbol; this.typeError = context.TypeError;
  }

  init(options: DesktopBdmsInitOptions): void {
    setDesktopProperty(this.context.window, 'onwheelx', { _Ax: '0X21' });
    if (!this.config.aid) setDesktopProperty(this.config, 'aid', options.aid || 0);
    if (!this.config.pageId) setDesktopProperty(this.config, 'pageId', options.pageId || 0);
    setDesktopProperty(this.config, 'boe', options.boe || false);
    setDesktopProperty(this.config, 'ddrt', options.ddrt || 3);
    setDesktopProperty(this.config, 'dump', options.dump ?? true);
    setDesktopProperty(this.config, 'rpU', options.rpU || '');
    const paths = options.paths || [];
    let include: RegExp[];
    let exclude: RegExp[] = [];
    if (this.array.isArray(paths)) include = this.compile(paths);
    else {
      const lists = paths as { include?: (string | RegExp)[]; exclude?: (string | RegExp)[] };
      include = this.compile(lists.include || []);
      exclude = this.compile(lists.exclude || []);
    }
    // Both lists compile before either append, but earlier scalar writes are not rolled back.
    /* eslint-disable prefer-spread -- Preserve source apply lookup order and Babel indexed-array copying. */
    const included = this.config.paths.include;
    included.push.apply(included, this.spread(include));
    const excluded = this.config.paths.exclude;
    excluded.push.apply(excluded, this.spread(exclude));
    if (options.track) {
      setDesktopProperty(this.config.track, 'mode', options.track.mode || 0);
      setDesktopProperty(this.config.track, 'delay', options.track.delay || 300);
      if (this.config.track.mode === 0 && options.track.paths) {
        const target = this.config.track.paths;
        target.push.apply(target, this.spread(this.compile(options.track.paths)));
      }
    }
    /* eslint-enable prefer-spread */
    this.object.defineProperty(this.context.window.onwheelx!, '_Ax', { writable: false });
    Reflect.apply(this.start, null, []);
  }

  matchesSigning(pathname: string): boolean {
    const paths = this.config.paths;
    const include = paths.include;
    const exclude = paths.exclude;
    return !exclude.some(pattern => pattern.test(pathname)) && include.some(pattern => pattern.test(pathname));
  }

  matchesBehavior(pathname: string): boolean {
    return this.config.track.paths.some(pattern => pattern.test(pathname));
  }

  private compile(paths: (string | RegExp)[]): RegExp[] {
    return paths.map(pattern => new this.regexp(pattern));
  }

  /** Source Babel spread prioritizes indexed array copying over custom iterators. */
  private spread(input: unknown): RegExp[] {
    if (this.array.isArray(input)) return this.copy(input);
    const value = input as Record<PropertyKey, unknown>;
    if ((typeof this.symbol !== 'undefined' && value[this.symbol.iterator] != null) || value['@@iterator'] != null) {
      return this.array.from(input as Iterable<RegExp>);
    }
    if (input) {
      if (typeof input === 'string') return this.copy(input);
      let tag = this.object.prototype.toString.call(input).slice(8, -1);
      if (tag === 'Object' && value['constructor']) tag = (value['constructor'] as { name: string }).name;
      if (tag === 'Map' || tag === 'Set') return this.array.from(input as Iterable<RegExp>);
      if (tag === 'Arguments' || new this.regexp('^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$').test(tag)) {
        return this.copy(input as ArrayLike<unknown>);
      }
    }
    throw new this.typeError('Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.');
  }

  private copy(input: ArrayLike<unknown>): RegExp[] {
    const length = input.length;
    const result = new this.array<RegExp>(length);
    for (let i = 0; i < length; i++) setDesktopProperty(result, i, input[i]);
    return result;
  }
}
