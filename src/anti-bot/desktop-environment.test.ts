import { classifyDesktopBrowser, classifyDesktopOS, classifyDesktopPlatform, DesktopStorageState } from './desktop-environment.js';

describe('installed BDMS classification rules', () => {
  it.each([
    ['HuaweiBrowser/1 Chrome/130', 'Huawei'], ['Chrome/130 Edg/130 OPR/80', 'Chrome'],
    ['EdgiOS/130', 'Edge'], ['Focus/1', 'Firefox'], ['Trident/7 rv:11.0 like Gecko', 'IE'],
    ['OPR/80', 'Opera'], ['Version/17.0 Mobile/15 Safari', 'Safari'], ['Safari/999', 'Other'],
  ])('classifies browser %s as %s', (input, name) => { expect(classifyDesktopBrowser(input)).toBe(name); });

  it.each([
    ['Android 10 OpenHarmony Linux', 'HarmonyOS'], ['Android-x86 Linux', 'Android'],
    ['Macintosh CriOS/130', 'iOS'], ['Macintosh', 'MacOS'], ['Windows NT 10.0', 'Windows'],
    ['Linux x86_64', 'Linux'], ['unknown', 'Other'],
  ])('classifies OS %s as %s', (input, name) => { expect(classifyDesktopOS(input)).toBe(name); });

  it.each([
    ['Android Mac Linux Win', 'Android'], ['MacIntel Linux Win', 'Apple'],
    ['Linux Win', 'Linux'], ['Win32', 'Windows'], ['', 'Other'],
  ])('classifies platform %s as %s', (input, name) => { expect(classifyDesktopPlatform(input)).toBe(name); });

  it('keeps per-regexp coercion and propagates conversion errors', () => {
    let calls = 0;
    expect(classifyDesktopBrowser({ toString: () => ++calls === 1 ? '' : 'Chrome/130' })).toBe('Chrome');
    expect(calls).toBe(2);
    expect(classifyDesktopBrowser(undefined)).toBe('Other');
    expect(() => classifyDesktopPlatform(Symbol('platform'))).toThrow(TypeError);
  });
});

describe('Desktop storage environment state', () => {
  function chrome() {
    const callbacks: ((value: { quota?: number }) => void)[] = [];
    const navigator = { userAgent: 'Chrome/130', storage: { estimate: () => ({ then(callback: typeof callbacks[number]) { callbacks.push(callback); } }) } };
    return { callbacks, navigator, state: new DesktopStorageState({ navigator, window: {} }) };
  }

  it('starts each estimate and uses prior state until callback completion, including clearing', () => {
    const { state, callbacks } = chrome();
    expect(state.probe()).toBe(false);
    expect(state.probe()).toBe(false);
    callbacks[1]!({ quota: 1 });
    expect(state.probe()).toBe(true);
    callbacks[0]!({ quota: 2300000000 });
    expect(state.probe()).toBe(false);
    expect(callbacks).toHaveLength(4);
    callbacks[2]!({ quota: 0 });
    expect(state.probe()).toBe(false);
    callbacks[3]!({});
    expect(state.probe()).toBe(false);
  });

  it('observes native Promise microtasks without awaiting inside probe', async () => {
    let finish!: (value: { quota?: number }) => void;
    const state = new DesktopStorageState({ navigator: { userAgent: 'Chrome/130', storage: {
      estimate: () => new Promise<{ quota?: number }>(resolve => { finish = resolve; }),
    } }, window: {} });
    expect(state.probe()).toBe(false);
    finish({ quota: 1 });
    await Promise.resolve();
    expect(state.probe()).toBe(true);
  });

  it('preserves synchronous thenable timing instead of adding a Promise wrapper', () => {
    const state = new DesktopStorageState({ navigator: { userAgent: 'Chrome/130', storage: {
      estimate: () => ({ then: callback => callback({ quota: 1 }) }),
    } }, window: {} });
    expect(state.probe()).toBe(true);
  });

  it('shares state across UA changes in one context, but not across instances', () => {
    const { state, navigator, callbacks } = chrome();
    state.probe();
    navigator.userAgent = 'Firefox/120';
    expect(state.probe()).toBe(true); // no serviceWorker
    callbacks[0]!({ quota: 2300000000 });
    navigator.userAgent = 'unknown';
    expect(state.probe()).toBe(false);
    expect(new DesktopStorageState({ navigator, window: {} }).probe()).toBe(false);
  });

  it('registers Firefox listeners in order; success deletes the probe database but never clears state', () => {
    const events: { type: string; callback: () => void }[] = [], deleted: string[] = [], opened: string[] = [];
    const state = new DesktopStorageState({ navigator: { userAgent: 'Firefox/120', serviceWorker: {} }, window: {
      indexedDB: {
        open(name) { opened.push(name); return { addEventListener(type, callback) { events.push({ type, callback }); } }; },
        deleteDatabase(name) { deleted.push(name); },
      },
    } });
    expect(state.probe()).toBe(false);
    expect(events.map(event => event.type)).toEqual(['success', 'error']);
    events[1]!.callback();
    events[0]!.callback();
    expect(state.probe()).toBe(true);
    expect(opened).toEqual(['bdmsCheck', 'bdmsCheck']);
    expect(deleted).toEqual(['bdmsCheck']);
  });

  it('matches Safari out-of-memory text case-sensitively and preserves true on other errors', () => {
    const errors: ((error: { message: string }) => void)[] = [];
    const state = new DesktopStorageState({ navigator: { userAgent: 'Version/17.0 Safari', storage: {
      getDirectory: () => ({ catch: callback => { errors.push(callback); } }),
    } }, window: {} });
    expect(state.probe()).toBe(false);
    errors[0]!({ message: 'Out of memory' });
    expect(state.probe()).toBe(false);
    errors[1]!({ message: 'failed: out of memory' });
    expect(state.probe()).toBe(true);
    errors[2]!({ message: 'permission denied' });
    expect(state.probe()).toBe(true);
  });

  it('does not catch synchronous host failures or start storage probes for unrelated browsers', () => {
    let attempts = 0;
    const navigator = { userAgent: 'Other', storage: { estimate() { attempts++; throw new Error('host failure'); } } };
    const state = new DesktopStorageState({ navigator, window: {} });
    expect(state.probe()).toBe(false);
    expect(attempts).toBe(0);
    navigator.userAgent = 'Chrome/130';
    expect(() => state.probe()).toThrow('host failure');
    expect(attempts).toBe(1);
  });
});
