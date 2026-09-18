import { DesktopBdmsConfiguration } from './desktop-config.js';
import { DesktopReportLifecycle } from './desktop-report-lifecycle.js';
import { DesktopBehaviorState } from './desktop-behavior.js';

function fixture(start: () => void = () => {}) {
  const context = { window: {} as { onwheelx?: { _Ax?: string } }, Array, Object, RegExp, Symbol, TypeError };
  return { context, manager: new DesktopBdmsConfiguration(context, start) };
}
describe('Desktop init configuration and pathname predicates', () => {
  it('initializes exact defaults, locks marker before start and preserves the shared config object', () => {
    let started = 0;
    const f = fixture(() => { started++; expect(Object.getOwnPropertyDescriptor(f.context.window.onwheelx!, '_Ax')?.writable).toBe(false); });
    const config = f.manager.config;
    expect(config).toEqual({ aid: 0, pageId: 0, boe: false, ddrt: 3, paths: { include: [], exclude: [] }, track: { mode: 0, delay: 300, paths: [] }, dump: true, rpU: '' });
    expect(f.context.window.onwheelx).toBeUndefined();
    f.manager.init({});
    expect(f.manager.config).toBe(config);
    expect(f.context.window.onwheelx?._Ax).toBe('0X21');
    expect(started).toBe(1);
  });
  it('keeps first truthy account identifiers but resets selected scalars on each init', () => {
    const { manager } = fixture();
    manager.init({ aid: 1, pageId: 2, boe: true, ddrt: 9, dump: false, rpU: 'x', track: { mode: 2, delay: 8 } });
    manager.init({ aid: 3, pageId: 4 });
    expect(manager.config).toMatchObject({ aid: 1, pageId: 2, boe: false, ddrt: 3, dump: true, rpU: '', track: { mode: 2, delay: 8 } });
    manager.init({ ddrt: 0, dump: null, track: { mode: 0, delay: 0 } });
    expect(manager.config).toMatchObject({ ddrt: 3, dump: true, track: { mode: 0, delay: 300 } });
  });
  it('appends independent include/exclude/behavior rules without deduplication', () => {
    const { manager } = fixture();
    manager.init({ paths: ['/passport'], track: { paths: ['/login'] } });
    manager.init({ paths: { include: ['/passport'], exclude: ['/blocked'] }, track: { mode: 2, paths: ['/ignored'] } });
    expect(manager.config.paths.include).toHaveLength(2);
    expect(manager.matchesSigning('/passport/login')).toBe(true);
    expect(manager.matchesSigning('/passport/blocked')).toBe(false);
    expect(manager.matchesBehavior('/login')).toBe(true); // No mode gate in this predicate.
    expect(manager.matchesBehavior('/ignored')).toBe(false);
  });
  it('compiles both path lists before append, retaining earlier scalar writes on failure', () => {
    let starts = 0;
    const { manager, context } = fixture(() => { starts++; });
    expect(() => manager.init({ aid: 7, paths: { include: ['good'], exclude: ['['] } })).toThrow(SyntaxError);
    expect(manager.config.aid).toBe(7);
    expect(manager.config.paths.include).toEqual([]);
    expect(starts).toBe(0);
    expect(Object.getOwnPropertyDescriptor(context.window.onwheelx!, '_Ax')?.writable).toBe(true);
  });
  it('keeps already appended signing paths and track scalars if track compilation fails', () => {
    const { manager } = fixture();
    expect(() => manager.init({ paths: ['ok'], track: { delay: 5, paths: ['['] } })).toThrow(SyntaxError);
    expect(manager.matchesSigning('ok')).toBe(true);
    expect(manager.config.track.delay).toBe(5);
    expect(manager.config.track.paths).toEqual([]);
  });
  it('copies RegExp inputs and retains matcher lastIndex rather than resetting it', () => {
    const { manager } = fixture();
    const input = /a/g; input.lastIndex = 1;
    manager.init({ paths: [input] });
    expect(manager.config.paths.include[0]).not.toBe(input);
    expect(manager.matchesSigning('a')).toBe(true);
    expect(manager.matchesSigning('a')).toBe(false);
    expect(manager.matchesSigning('a')).toBe(true);
    expect(input.lastIndex).toBe(1);
  });
  it('short circuits excluded paths before include tests and requires an include match', () => {
    const { manager } = fixture();
    expect(manager.matchesSigning('/anything')).toBe(false);
    manager.init({ paths: { include: [/a/g], exclude: ['a'] } });
    expect(manager.matchesSigning('a')).toBe(false);
    expect(manager.config.paths.include[0]!.lastIndex).toBe(0);
  });
  it('copies sparse mapped arrays by index, ignoring custom array iterators', () => {
    const { manager } = fixture();
    const mapped = [/a/];
    Object.defineProperty(mapped, Symbol.iterator, { value: function* () { yield /wrong/; } });
    const input: string[] = [];
    Object.defineProperty(input, 'map', { value: () => mapped });
    manager.init({ paths: input });
    expect(manager.matchesSigning('a')).toBe(true);
    const sparse: string[] = new Array<string>(1);
    manager.init({ paths: sparse });
    expect(Object.hasOwn(manager.config.paths.include, 1)).toBe(true);
    expect(() => manager.matchesSigning('no')).toThrow(TypeError);
  });
  it('rejects readonly marker/config writes and preserves earlier side effects', () => {
    const { manager, context } = fixture();
    const marker = { _Ax: 'existing' };
    Object.defineProperty(context.window, 'onwheelx', { value: marker, writable: false });
    expect(() => manager.init({ aid: 1 })).toThrow(TypeError);
    expect(context.window.onwheelx).toBe(marker);
    expect(marker._Ax).toBe('existing');
    expect(Object.getOwnPropertyDescriptor(marker, '_Ax')?.writable).toBe(true);
    const next = fixture(); Object.freeze(next.manager.config);
    expect(() => next.manager.init({ boe: true })).toThrow(TypeError);
    expect(next.context.window.onwheelx).toEqual({ _Ax: '0X21' });
    expect(next.manager.config.boe).toBe(false);
  });
  it('drives the existing lifecycle once-flags without reinstalling timers on repeated init', () => {
    const timeouts: number[] = [], intervals: number[] = [], events: string[] = [];
    let collections = 0;
    const f = fixture(() => lifecycle.start());
    const state = new DesktopBehaviorState(0);
    const lifecycle = new DesktopReportLifecycle({ performance: { now: () => 0 }, Date: { now: () => 0 },
      document: { addEventListener(name) { events.push(name); } },
      setTimeout(_fn, delay) { timeouts.push(delay); }, setInterval(_fn, delay) { intervals.push(delay); }, requestAnimationFrame() {},
    }, f.manager.config, state.createReportSources(() => ({})), { send() {} }, () => {}, () => { collections++; });
    f.manager.init({ track: { mode: 2 }, ddrt: 4 });
    f.manager.init({ track: { mode: 0, delay: 5 } });
    f.manager.init({ track: { delay: 6 }, ddrt: 8 });
    expect(timeouts).toEqual([4000]);
    expect(intervals).toEqual([5000]);
    expect(events).toEqual(['visibilitychange']);
    expect(collections).toBe(1);
  });
});
