import { DesktopEnvironmentState, type DesktopEnvironmentContext } from './desktop-environment-mask.js';

// Explicit synthetic host bindings, never used as a production browser fallback.
function fixture() {
  return {
    window: { screen: {}, eval: () => undefined, innerWidth: 1000, innerHeight: 700, outerWidth: 1100, outerHeight: 800 },
    navigator: { [Symbol.toStringTag]: 'Navigator', userAgent: 'Macintosh Chrome/130', platform: 'MacIntel', toString: Object.prototype.toString },
    document: { [Symbol.toStringTag]: 'HTMLDocument', createElement: () => ({ toDataURL: Object.prototype.toString }) },
    location: { href: 'https://offline.invalid' }, history: { [Symbol.toStringTag]: 'History' }, Symbol,
  };
}

describe('Desktop BDMS .7 environment mask', () => {
  it('captures only Symbol on construction; failed browser gate skips all probes', () => {
    const reads: PropertyKey[] = [];
    const context = new Proxy({}, { get(_target, key) { reads.push(key); return undefined; } });
    const state = new DesktopEnvironmentState(context);
    expect(reads).toEqual(['Symbol']);
    expect(state.mask()).toBe(129);
    expect(reads).toEqual(['Symbol', 'window']); // window missing: do not read other bindings
  });

  it('uses observed object tags, accepts Document and Object location alternatives', () => {
    const context = fixture();
    expect(new DesktopEnvironmentState(context).mask()).toBe(1);
    context.document[Symbol.toStringTag] = 'Document';
    expect(new DesktopEnvironmentState(context).mask()).toBe(1);
    context.navigator[Symbol.toStringTag] = 'Object';
    expect(new DesktopEnvironmentState(context).mask()).toBe(129);
  });

  it('does not short-circuit remaining tags when navigator tag mismatches', () => {
    const context = fixture();
    context.navigator[Symbol.toStringTag] = 'Object';
    Object.defineProperty(context.history, Symbol.toStringTag, { get() { throw new Error('history tag'); } });
    expect(() => new DesktopEnvironmentState(context).mask()).toThrow('history tag');
  });

  it('catches canvas inspection errors, but propagates later navigator errors', () => {
    const context = fixture();
    context.document.createElement = () => { throw new Error('canvas'); };
    expect(new DesktopEnvironmentState(context).mask()).toBe(3);
    const late = fixture();
    Object.defineProperty(late.navigator, 'toString', { get() { throw new Error('navigator function'); } });
    expect(() => new DesktopEnvironmentState(late).mask()).toThrow('navigator function');
  });

  it('checks both plugin bits and preserves invalid instanceof errors', () => {
    const context = fixture();
    class PluginArray {}
    expect(new DesktopEnvironmentState({ ...context, PluginArray }).mask()).toBe(19);
    Object.assign(context.navigator, { plugins: new PluginArray() });
    expect(new DesktopEnvironmentState({ ...context, PluginArray }).mask()).toBe(1);
    expect(() => new DesktopEnvironmentState({ ...context, PluginArray: 1 }).mask()).toThrow(TypeError);
  });

  it('sets headless bit but does not skip weak-signal reads', () => {
    const context = fixture();
    context.navigator.userAgent = 'Macintosh HeadlessChrome/130';
    expect(new DesktopEnvironmentState(context).mask()).toBe(9);
    Object.defineProperty(context.navigator, 'connection', { get() { throw new Error('weak signal'); } });
    expect(() => new DesktopEnvironmentState(context).mask()).toThrow('weak signal');
  });

  it('requires all three weak signals and recognizes an own false webdriver descriptor', () => {
    const context = fixture();
    Object.assign(context.navigator, { connection: { rtt: 0 }, userAgentData: { brands: [], platform: '' } });
    expect(new DesktopEnvironmentState(context).mask()).toBe(1);
    context.window.innerWidth = 800; context.window.innerHeight = 600;
    expect(new DesktopEnvironmentState(context).mask()).toBe(9);
    const webdriver = fixture();
    Object.defineProperty(webdriver.navigator, 'webdriver', { value: false });
    expect(new DesktopEnvironmentState(webdriver).mask()).toBe(9);
  });

  it('keeps A nonboolean numeric conversion, including throws and values spanning bits', () => {
    const context = fixture();
    const win = context.window;
    Object.assign(win, { CanvasRenderingContext2D: function Canvas() {} });
    expect(new DesktopEnvironmentState(context).mask()).toBe(1);
    Object.assign(win, { CanvasRenderingContext2D: { valueOf: () => 3 } });
    expect(new DesktopEnvironmentState(context).mask()).toBe(49);
    Object.assign(win, { CanvasRenderingContext2D: 1n });
    expect(() => new DesktopEnvironmentState(context).mask()).toThrow(TypeError);
  });

  it('distinguishes webpack process tag from lexical process title and does not guard null', () => {
    expect(new DesktopEnvironmentState({ ...fixture(), process: { title: 'node' } }).mask()).toBe(33);
    expect(new DesktopEnvironmentState({ ...fixture(), process: { title: 'electron' } }).mask()).toBe(1);
    expect(new DesktopEnvironmentState({ ...fixture(), webpackGlobal: { process: { [Symbol.toStringTag]: 'process' } } }).mask()).toBe(33);
    expect(() => new DesktopEnvironmentState({ ...fixture(), process: null }).mask()).toThrow(TypeError);
  });

  it('retains the selected Babel typeof branch over later Symbol binding changes', () => {
    const context: DesktopEnvironmentContext = { ...fixture(), process: { title: 'node' } };
    const state = new DesktopEnvironmentState(context);
    Object.defineProperty(context, 'Symbol', { get() { throw new Error('should not reselect typeof'); } });
    expect(state.mask()).toBe(33);
    expect(state.mask()).toBe(33);
  });

  it('uses strict Firefox signed dimension gaps and separately observes storage status', () => {
    const context = fixture();
    context.navigator.userAgent = 'Macintosh Firefox/130';
    Object.assign(context.navigator, { serviceWorker: {} });
    context.window.outerWidth = context.window.innerWidth + 400;
    context.window.outerHeight = context.window.innerHeight + 300;
    expect(new DesktopEnvironmentState(context).mask()).toBe(1);
    context.window.outerWidth++;
    expect(new DesktopEnvironmentState(context).mask()).toBe(65);
    context.window.outerWidth = -10000;
    expect(new DesktopEnvironmentState(context).mask()).toBe(1);
  });

  it.each(['cefSharp', 'CefSharp', 'eoapi', 'eoWebBrowserDispatcher'])('observes embedded host %s', field => {
    const context = fixture(); Object.assign(context.window, { [field]: {} });
    expect(new DesktopEnvironmentState(context).mask()).toBe(257);
  });

  it.each([
    ['file:///app', 513], ['FILEanything', 513], ['http://localhost.evil.example', 513],
    ['https://localhost', 1], ['http://999.999.999.9999', 513], ['https://[::1]/', 1], ['HTTPS://127.0.0.1', 1],
  ])('preserves original address regexp for %s', (href, expected) => {
    const context = fixture(); context.location.href = href;
    expect(new DesktopEnvironmentState(context).mask()).toBe(expected);
  });

  it('does not conflate OS classification and platform names', () => {
    const context = fixture(); context.navigator.platform = 'Win32';
    expect(new DesktopEnvironmentState(context).mask()).toBe(1025);
    context.navigator.userAgent = 'Android 13 Chrome/130'; context.navigator.platform = 'Linux';
    expect(new DesktopEnvironmentState(context).mask()).toBe(1);
  });

  it('keeps storage state across masks and skips probing when gate subsequently fails', () => {
    const context = fixture(), callbacks: ((value: { quota?: number }) => void)[] = [];
    Object.assign(context.navigator, { storage: { estimate: () => ({ then: (callback: typeof callbacks[number]) => callbacks.push(callback) }) } });
    const state = new DesktopEnvironmentState(context);
    expect(state.mask()).toBe(1);
    callbacks[0]!({ quota: 1 });
    expect(state.mask()).toBe(5);
    context.navigator[Symbol.toStringTag] = 'Object';
    expect(state.mask()).toBe(129);
    expect(callbacks).toHaveLength(2);
    context.navigator[Symbol.toStringTag] = 'Navigator';
    callbacks[1]!({ quota: 2300000000 });
    expect(state.mask()).toBe(1);
  });
});
