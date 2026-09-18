import { DesktopDeviceIdentityCollector, type DesktopIdentityImage } from './desktop-device-identity.js';
import { DesktopDeviceReporter, type DesktopDeviceReportContext } from './desktop-device-report.js';
import { DesktopBehaviorState } from './desktop-behavior.js';
import { DesktopReportSender, type DesktopReportXhr } from './desktop-report.js';
import { DesktopTokenState } from './desktop-token.js';

function host() {
  const images: DesktopIdentityImage[] = [];
  const queries: string[] = [];
  const stores: string[] = [];
  const clock = { now: 1000, calls: 0 };
  class Image implements DesktopIdentityImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';
    constructor() { images.push(this); }
  }
  class HostDate {
    static now() { clock.calls++; return clock.now; }
    getTimezoneOffset() { return -330; }
  }
  const context = {
    Symbol, Object, Math, Date: HostDate, Image,
    window: { screen: {}, chrome: {}, eval: { toString: () => 'raw-eval' } },
    document: {
      body: null, images: [], fonts: { check: () => true },
      createEvent() {},
      createElement() { return { getContext: (kind: string) => kind === 'webgl' ? null : { drawImage() {}, getImageData: () => ({ data: [0, 0, 0, 0] }) } }; },
    },
    navigator: { permissions: { query: ({ name }: { name: string }) => { queries.push(name); return Promise.resolve({ state: 'granted' }); } } },
    localStorage: { setItem: (key: string, value: string) => { stores.push(`local:set:${key}:${value}`); }, removeItem: (key: string) => { stores.push(`local:remove:${key}`); } },
    sessionStorage: { setItem: (key: string, value: string) => { stores.push(`session:set:${key}:${value}`); }, removeItem: (key: string) => { stores.push(`session:remove:${key}`); } },
  };
  // The synthetic canvas intentionally supports both overloads on one object.
  return { context: context as unknown as DesktopDeviceReportContext, images, queries, stores, clock };
}
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe('Desktop Q identity collector', () => {
  it('collects real supplied probe values and delays storage/permissions/time until image completion', async () => {
    const f = host();
    const pending = new DesktopDeviceIdentityCollector(f.context).collect();
    expect(f.images[0]!.src).toBe('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    expect(f.stores).toEqual([]);
    expect(f.queries).toEqual([]);
    expect(f.clock.calls).toBe(0);
    f.clock.now = 2000;
    f.images[0]!.onload!();
    expect(await pending).toEqual({ browserType: 16, jsFontsList: '1fffffff', jsv: '1.5', load: 3, magic: 3, msgType: 1, nap: '2'.repeat(20), nativeLength: 8, privacyMode: 0, timestamp: '2000', timezone: 6 });
    expect(f.stores).toEqual(['local:set:bdms:', 'local:remove:bdms', 'session:set:bdms:', 'session:remove:bdms']);
    expect(f.queries).toHaveLength(20);
  });
  it('starts all permission queries before awaiting them, retaining source order and late time', async () => {
    const f = host();
    const resolvers: ((value: { state: string }) => void)[] = [];
    f.context.navigator.permissions!.query = ({ name }) => { f.queries.push(name); return new Promise(resolve => { resolvers.push(resolve); }); };
    const pending = new DesktopDeviceIdentityCollector(f.context).collect();
    f.images[0]!.onerror!();
    await drain();
    expect(f.queries).toEqual(['geolocation', 'notifications', 'push', 'midi', 'camera', 'microphone', 'speaker', 'device-info', 'background-sync', 'bluetooth', 'persistent-storage', 'ambient-light-sensor', 'accelerometer', 'gyroscope', 'magnetometer', 'clipboard', 'accessibility-events', 'clipboard-read', 'clipboard-write', 'payment-handler']);
    expect(f.clock.calls).toBe(0);
    f.clock.now = 9000;
    for (let i = resolvers.length - 1; i >= 0; i--) resolvers[i]!({ state: i === 0 ? 'denied' : 'prompt' });
    expect(await pending).toMatchObject({ load: 1, nap: '0' + '1'.repeat(19), timestamp: '9000' });
  });
  it('keeps individual error codes distinct from absent API and batch failure', async () => {
    const text = 'is not a valid enum value of type PermissionName';
    for (const [error, expected] of [[{ message: text }, '3'.repeat(20)], [{ message: 'x ' + text }, '4'.repeat(20)], [{}, '7']] as const) {
      const f = host();
      f.context.navigator.permissions!.query = () => Promise.reject(error);
      const pending = new DesktopDeviceIdentityCollector(f.context).collect();
      f.images[0]!.onload!();
      expect(await pending).toMatchObject({ nap: expected });
    }
    const f = host();
    Object.defineProperty(f.context.navigator, 'permissions', { value: undefined });
    const pending = new DesktopDeviceIdentityCollector(f.context).collect();
    f.images[0]!.onload!();
    expect(await pending).toMatchObject({ nap: '6' });
  });
  it('rejects Image setup and initial permission access failures, but tolerates callback failures', async () => {
    const setup = host();
    Object.defineProperty(setup.context, 'Image', { get() { throw Error('Image'); } });
    await expect(new DesktopDeviceIdentityCollector(setup.context).collect()).rejects.toThrow('Image');
    const permission = host();
    Object.defineProperty(permission.context.navigator, 'permissions', { get() { throw Error('permissions'); } });
    const pending = new DesktopDeviceIdentityCollector(permission.context).collect();
    permission.images[0]!.onload!();
    await expect(pending).rejects.toThrow('permissions');
    const callback = host();
    callback.context.document.createElement = () => { throw Error('canvas'); };
    const result = new DesktopDeviceIdentityCollector(callback.context).collect();
    callback.images[0]!.onload!();
    expect(await result).toMatchObject({ load: 1 });
  });
  it('rejects refused image handler writes before probes begin', async () => {
    const f = host();
    Object.defineProperty(f.context, 'Image', { value: class { constructor() { return Object.freeze({}); } } });
    await expect(new DesktopDeviceIdentityCollector(f.context).collect()).rejects.toThrow(TypeError);
    expect(f.stores).toEqual([]);
    expect(f.queries).toEqual([]);
  });
  it('does not set a storage bit until both set and remove complete, and still tries the next store', async () => {
    const f = host();
    f.context.localStorage.removeItem = () => { throw Error('remove'); };
    const pending = new DesktopDeviceIdentityCollector(f.context).collect();
    f.images[0]!.onload!();
    expect(await pending).toMatchObject({ magic: 2 });
    expect(f.stores).toContain('session:remove:bdms');
  });
});

describe('Desktop complete device report', () => {
  it('connects production collectors, encoding, token storage and first-token re-collection on one host', async () => {
    const f = host();
    const frames: ((time: number) => void)[] = [];
    const requests: Xhr[] = [];
    const storage = new Map<string, string>();
    class Xhr implements DesktopReportXhr {
      withCredentials = false;
      url = ''; body = ''; listener?: () => void;
      constructor() { requests.push(this); }
      open(method: string, url: string, async: boolean) { expect(method).toBe('POST'); expect(async).toBe(true); this.url = url; }
      send(body: string) { this.body = body; }
      addEventListener(type: string, listener: () => void) { expect(type).toBe('load'); this.listener = listener; }
      getResponseHeader(name: string) { expect(name).toBe('x-ms-token'); return 'issued'; }
    }
    const context = Object.assign(f.context, {
      XMLHttpRequest: Xhr, URL, JSON, Math: { round: Math.round, floor: Math.floor, random: () => .5 },
      navigator: { ...f.context.navigator, sendBeacon() { throw Error('not a device path'); } },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } },
      requestAnimationFrame(callback: (time: number) => void) { frames.push(callback); },
    });
    const config = { aid: 339757, pageId: 23420, boe: false, rpU: '' };
    const tokens = new DesktopTokenState(context);
    let followup: Promise<void> | undefined;
    const sender = new DesktopReportSender(context, config, tokens, () => { followup = reporter.report(); });
    const reporter = new DesktopDeviceReporter(context, config, { mask: () => 42 }, new DesktopBehaviorState(0), sender);
    const first = reporter.report();
    await drain(); f.images[0]!.onload!(); await first;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://mssdk.bytedance.com/web/common?ms_appid=339757');
    expect(requests[0]!.withCredentials).toBe(true);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ magic: 538969122, version: 1, dataType: 8, strData: expect.any(String), ulr: 0 });
    requests[0]!.listener!();
    expect(tokens.token).toBe('issued');
    expect(storage.get('xmst')).toBe('issued');
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    await drain();
    expect(f.images).toHaveLength(2);
    f.images[1]!.onload!(); await followup;
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toContain('&msToken=issued');
    requests[1]!.listener!();
    expect(frames).toHaveLength(1);
  });
  it('uses production collectors, shared G and late config/M/q, with one send', async () => {
    const f = host();
    const reports: unknown[] = [];
    const config = { aid: 1, pageId: 2 };
    const behavior = new DesktopBehaviorState(0);
    let masks = 0;
    const reporter = new DesktopDeviceReporter(f.context, config, { mask() { masks++; return 42; } }, behavior, { send(report) { reports.push(report); } });
    const pending = reporter.report();
    await drain();
    expect(reports).toEqual([]);
    expect(masks).toBe(0);
    config.aid = 3; config.pageId = 4;
    f.images[0]!.onload!();
    await pending;
    expect(masks).toBe(1);
    expect(reports).toHaveLength(1);
    expect(Object.keys(reports[0] as object)).toEqual(['battery', 'document', 'navigator', 'plugins', 'screen', 'webgl', 'window', 'wID', 'envCode', 'ubCode']);
    expect(reports[0]).toMatchObject({ battery: {}, plugins: { plugin: [], pv: '0' }, webgl: {}, wID: { aid: 3, pageId: 4, load: 3, msgType: 1 }, envCode: 42, ubCode: 14 });
  });
  it('does not send a partial report on a synchronous collector error', async () => {
    const f = host();
    Object.defineProperty(f.context.document, 'characterSet', { get() { throw Error('charset'); } });
    let sent = false;
    const reporter = new DesktopDeviceReporter(f.context, { aid: 1, pageId: 2 }, { mask: () => 0 }, new DesktopBehaviorState(0), { send() { sent = true; } });
    await expect(reporter.report()).rejects.toThrow('charset');
    expect(sent).toBe(false);
    expect(f.images).toHaveLength(0);
  });
  it('propagates the sender failure without retrying', async () => {
    const f = host();
    let sends = 0;
    const reporter = new DesktopDeviceReporter(f.context, { aid: 1, pageId: 2 }, { mask: () => 0 }, new DesktopBehaviorState(0), { send() { sends++; throw Error('send'); } });
    const pending = reporter.report();
    await drain();
    f.images[0]!.onload!();
    await expect(pending).rejects.toThrow('send');
    expect(sends).toBe(1);
  });
});
