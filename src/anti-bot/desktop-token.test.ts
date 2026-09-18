import { DesktopTokenState, signDesktopXhrUrl, type DesktopTokenContext } from './desktop-token.js';

function fixture(initial: string | null = null) {
  const trace: string[] = [];
  let stored = initial;
  const callbacks: ((time: number) => void)[] = [];
  const context: DesktopTokenContext = {
    localStorage: {
      getItem(key) { trace.push(`get:${key}`); return stored; },
      setItem(key, value) { trace.push(`set:${key}:${value}`); stored = value; },
    },
    requestAnimationFrame(callback) { trace.push('raf'); callbacks.push(callback); return 1; },
  };
  const state = new DesktopTokenState(context);
  const report = (token: string | null) => state.onReportLoad({ getResponseHeader(name) { trace.push(`header:${name}`); return token; } }, () => trace.push('device'));
  return { context, state, trace, callbacks, report };
}

describe('Desktop report token state', () => {
  it('reads storage once and does not refresh from later storage changes', () => {
    const f = fixture('cached');
    f.context.localStorage.setItem('xmst', 'external');
    expect(f.state.token).toBe('cached'); expect(f.state.token).toBe('cached');
    expect(f.trace).toEqual(['get:xmst', 'set:xmst:external']);
  });
  it('tolerates storage getter and read failures', () => {
    const f = fixture();
    Object.defineProperty(f.context, 'localStorage', { get() { throw Error('denied'); } });
    const state = new DesktopTokenState(f.context);
    state.onReportLoad({ getResponseHeader: () => 'next' }, () => {});
    expect(state.token).toBe('next'); expect(f.callbacks).toHaveLength(1);
  });
  it('persists then updates memory then schedules only the first blank-to-token transition', () => {
    const f = fixture();
    f.report('first'); f.report('second'); f.report(null); f.report('');
    expect(f.state.token).toBe('second'); expect(f.callbacks).toHaveLength(1);
    expect(f.trace).toEqual(['get:xmst', 'header:x-ms-token', 'set:xmst:first', 'raf', 'header:x-ms-token', 'set:xmst:second', 'header:x-ms-token', 'header:x-ms-token']);
    f.callbacks[0]!(1); expect(f.trace.at(-1)).toBe('device');
  });
  it('never schedules an initial report when a token was cached', () => {
    const f = fixture('cached'); f.report('rotated'); expect(f.callbacks).toHaveLength(0);
  });
  it('propagates response-header errors without writing storage or scheduling', () => {
    const f = fixture();
    expect(() => f.state.onReportLoad({ getResponseHeader() { throw Error('header'); } }, () => {})).toThrow('header');
    expect(f.state.token).toBe(''); expect(f.trace).toEqual(['get:xmst']);
  });
  it('commits memory even when RAF throws and does not schedule on the next rotation', () => {
    const f = fixture(); f.context.requestAnimationFrame = () => { throw Error('raf'); };
    expect(() => f.report('first')).toThrow('raf'); expect(f.state.token).toBe('first');
    expect(() => f.report('second')).not.toThrow(); expect(f.state.token).toBe('second');
  });
  it('isolates separate script contexts', () => {
    const a = fixture(), b = fixture(); a.report('a'); expect(b.state.token).toBe('');
  });
});

describe('Desktop matched XHR URL signing', () => {
  const context = { URL, location: { href: 'https://local.invalid/login/index.html' } };
  function run(input: string | URL, token = '', body: unknown = 'raw=body') {
    const calls: unknown[][] = [];
    const url = signDesktopXhrUrl(context, input, body, { token }, { sign(...args) { calls.push(args); return 'signed+/='; } });
    return { url, calls };
  }
  it('resolves relative URLs, appends token before signing, and preserves raw body identity', () => {
    const body = new Uint8Array([1]);
    const f = run('../passport?q=a%20b&x=~#fragment', 'token+', body);
    expect(f.calls).toEqual([['q=a+b&x=%7E&msToken=token%2B', body]]);
    expect(f.url).toBe('https://local.invalid/passport?q=a+b&x=%7E&msToken=token%2B&a_bogus=signed%2B%2F%3D#fragment');
  });
  it.each(['msToken=', 'msToken=explicit', 'msToken=a&msToken=b'])('preserves existing %s instead of appending stored token', query => {
    expect(run(`/passport?${query}`, 'cached').calls).toEqual([[query, 'raw=body']]);
  });
  it.each(['a_bogus=', 'a_bogus=explicit', 'a_bogus=a&a_bogus=b'])('does not sign when %s already exists, but still appends token', query => {
    const f = run(`/passport?${query}`, 'cached');
    expect(f.calls).toEqual([]); expect(f.url).toBe(`https://local.invalid/passport?${query}&msToken=cached`);
  });
  it('preserves encoding when neither token nor signature needs mutation', () => {
    expect(run('/passport?q=a%20b&x=~&a_bogus=', '').url).toBe('https://local.invalid/passport?q=a%20b&x=~&a_bogus=');
  });
  it('mutates and returns the original same-context URL object', () => {
    const url = new URL('https://local.invalid/passport');
    expect(run(url, 'cached').url).toBe(url); expect(url.searchParams.get('msToken')).toBe('cached');
  });
  it('retains token mutation on a URL object when signing fails', () => {
    const url = new URL('https://local.invalid/passport');
    expect(() => signDesktopXhrUrl(context, url, '', { token: 'cached' }, { sign() { throw Error('sign'); } })).toThrow('sign');
    expect(url.search).toBe('?msToken=cached');
  });
  it('does not read token if explicit msToken is present', () => {
    const state = { get token(): string { throw Error('must not read'); } };
    expect(signDesktopXhrUrl(context, '/passport?msToken=&a_bogus=', '', state, { sign: () => '' })).toContain('msToken=&a_bogus=');
  });
});
