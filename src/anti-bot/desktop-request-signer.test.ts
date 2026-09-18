import { generateDesktopABogus } from './aBogus.js';
import { DesktopBehaviorState } from './desktop-behavior.js';
import { buildDesktopFingerprint } from './desktop-fingerprint.js';
import { DesktopRequestSigner, type DesktopSigningContext } from './desktop-request-signer.js';

function fixture() {
  // A private prototype per test; never write to Object.prototype or a real Navigator.
  const prototype: { vendorSubs?: { ink: number } } = {};
  const navigator = Object.assign(Object.create(prototype) as DesktopSigningContext['navigator'], { userAgent: ' UA ', platform: 'MacIntel' });
  let dates = 0, randoms = 0;
  const context: DesktopSigningContext = {
    navigator, window: { screen: {} }, document: { body: {}, createElement: () => ({}) }, Symbol,
    Date: { now: () => 1000 + 10 * dates++ }, Math: { random: () => { randoms++; return 0.5; } },
  };
  const config = { aid: 339757, pageId: 23420, track: { mode: 0 } };
  const behavior = new DesktopBehaviorState(0);
  const signer = new DesktopRequestSigner(context, config, behavior);
  const expected = (body: string, userAgent = ' UA ', flag: 3 | 11 | 12 = 11, inkMs = 999, behaviorMask = 14) => generateDesktopABogus({
    query: 'q=test', body, userAgent, ...config, flag, inkMs, nowMs: 1010, behaviorMask, environmentMask: 129,
    fingerprint: buildDesktopFingerprint(context), random: () => 0.5,
  });
  return { context, prototype, config, behavior, signer, expected, stats: () => ({ dates, randoms }) };
}

describe('one-context Desktop request signer', () => {
  it('writes ink before sampling a distinct core time and uses three random draws', () => {
    const f = fixture();
    expect(f.signer.sign('q=test', 'raw=body')).toBe(f.expected('raw=body'));
    expect(f.prototype.vendorSubs).toEqual({ ink: 999 });
    expect(f.stats()).toEqual({ dates: 2, randoms: 3 });
    expect(Object.hasOwn(Object.prototype, 'vendorSubs')).toBe(false);
  });

  it.each([undefined, null, {}, new Uint8Array([1]), { toString() { throw new Error('not stringified'); } }].map((body, index) => ({ body, index })))('clears nonstring body $index without coercing it', ({ body }) => {
    const f = fixture(); expect(f.signer.sign('q=test', body)).toBe(f.expected(''));
  });

  it.each([
    ['multipart/form-data; boundary=test', ''], ['x-multipart/form-data', ''],
    ['Multipart/Form-Data', 'text'], ['', 'text'], ['application/json', 'text'],
  ])('normalizes body using case-sensitive content type %s', (contentType, body) => {
    const f = fixture(); expect(f.signer.sign('q=test', 'text', contentType)).toBe(f.expected(body));
  });

  it.each([
    ['baiduboxapp UA EasyBrowserWebCore=0xabcdef123', 'baiduboxapp UA'],
    ['baiduboxapp UA WebCore=0xabcdef123', 'baiduboxapp UA'],
    ['UA WebCore=0xabcdef123', 'UA WebCore=0xabcdef123'],
    ['baiduboxapp UA WebCore=0xABCDEF123', 'baiduboxapp UA WebCore=0xABCDEF123'],
    ['AlipayClient ChannelId(12) ChannelId(34)', 'AlipayClient ChannelId(34)'],
    ['baiduboxapp AlipayClient ChannelId(12) WebCore=0xabcdef123', 'baiduboxapp AlipayClient'],
  ])('normalizes UA %s', (ua, expected) => {
    const f = fixture(); Object.defineProperty(f.context.navigator, 'userAgent', { value: ua });
    expect(f.signer.sign('q=test', '')).toBe(f.expected('', expected));
  });

  it.each([false, true])('reads flag from a truthy own _Ax writable=%s', writable => {
    const f = fixture(), marker = {};
    Object.defineProperty(marker, '_Ax', { value: 1, writable });
    Object.defineProperty(f.context.window, 'onwheelx', { value: marker });
    expect(f.signer.sign('q=test', '')).toBe(f.expected('', undefined, writable ? 12 : 3));
  });

  it('uses flag 12 for inherited marker and 11 for a false marker', () => {
    const inherited = fixture();
    Object.defineProperty(inherited.context.window, 'onwheelx', { value: Object.create({ _Ax: 1 }) });
    expect(inherited.signer.sign('q=test', '')).toBe(inherited.expected('', undefined, 12));
    const empty = fixture(); Object.defineProperty(empty.context.window, 'onwheelx', { value: { _Ax: 0 } });
    expect(empty.signer.sign('q=test', '')).toBe(empty.expected(''));
  });

  it('honors own vendorSubs shadowing and source zero-to-1000 fallback', () => {
    const f = fixture(); Object.defineProperty(f.context.navigator, 'vendorSubs', { value: { ink: 0 } });
    expect(f.signer.sign('q=test', '')).toBe(f.expected('', undefined, 11, 0));
    expect(f.prototype.vendorSubs?.ink).toBe(999);
  });

  it('rejects a read-only prototype write before mask/core sampling in the strict bundle', () => {
    const f = fixture(); Object.defineProperty(f.prototype, 'vendorSubs', { value: { ink: 42 }, writable: false });
    expect(() => f.signer.sign('q=test', '')).toThrow(TypeError);
    expect(f.stats()).toEqual({ dates: 1, randoms: 0 });
    expect(f.prototype.vendorSubs?.ink).toBe(42);
  });

  it('propagates setter errors before core sampling', () => {
    const f = fixture(); Object.defineProperty(f.prototype, 'vendorSubs', { set() { throw new Error('ink setter'); } });
    expect(() => f.signer.sign('q=test', '')).toThrow('ink setter');
    expect(f.stats()).toEqual({ dates: 1, randoms: 0 });
  });

  it('does not read ink or consume randomness after a query encoding failure', () => {
    const f = fixture(); let inkReads = 0;
    Object.defineProperty(f.context.navigator, 'vendorSubs', { get() { inkReads++; return {}; } });
    expect(() => f.signer.sign('\ud800', '')).toThrow(URIError);
    expect(inkReads).toBe(0);
    expect(f.stats()).toEqual({ dates: 2, randoms: 0 });
  });

  it('uses changing track state and retains its behavior queue', () => {
    const f = fixture(); f.config.track.mode = 2;
    expect(f.signer.sign('q=test', '')).toBe(f.expected('', undefined, 11, 999, 0));
    expect(f.behavior.mask()).toBe(14);
  });

  it('isolates prototype ink writes between contexts', () => {
    const a = fixture(), b = fixture(); a.signer.sign('q=test', '');
    expect(b.prototype.vendorSubs).toBeUndefined();
  });
});
