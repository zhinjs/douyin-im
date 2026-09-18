import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiConnection } from './api-connection.js';
import { DesktopSettings, desktopFloatHintConfig, desktopSettingsUrl, parseDesktopSettings } from './settings.js';
import { AccountStore } from '../store/account-store.js';

describe('Desktop application settings', () => {
  let directory: string;
  const managers: DesktopSettings[] = [];
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douyin-settings-')); });
  afterEach(() => {
    managers.forEach(manager => manager.stop()); managers.length = 0;
    jest.restoreAllMocks(); jest.useRealTimers(); rmSync(directory, { recursive: true, force: true });
  });
  function manager(request: (signal: AbortSignal) => Promise<Record<string, unknown> | undefined>, identity = 'device-one') {
    const onError = jest.fn();
    const value = new DesktopSettings({ directory, identity, request, onError });
    managers.push(value); return { value, onError };
  }

  it('pins the first-party endpoint and all eleven settings parameters, not the user privacy API', () => {
    const url = new URL(desktopSettingsUrl('123', '456', '20002', 'darwin', 'arm64'));
    expect(url.origin + url.pathname).toBe('https://imdesktop.douyin.com/service/settings/v3/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ aid: '339757', iid: '456', device_id: '123',
      channel: 'prod', device_platform: 'darwin', version_code: '1.2.1', node_arch: 'arm64', from_aid: '339757',
      from_channel: '20002', from_version: '1.2.1', app_arch: 'arm64' });
  });

  it('uses a bounded plain GET without authenticated headers or cookie mutation', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'success', data: { settings: { feature: 1 } } }),
      { headers: { 'set-cookie': 'sessionid=other' } }));
    const client = new ApiConnection({ deviceId: '123', installId: '456', initialCookies: 'sessionid=kept' });
    await expect(client.getApplicationSettings()).resolves.toEqual({ feature: 1 });
    expect(fetcher).toHaveBeenCalledWith(client.getApplicationSettingsUrl(), { method: 'GET', signal: expect.any(AbortSignal) });
    expect(client.getCookies()).toBe('sessionid=kept');
    await new ApiConnection({ deviceId: '0' }).getApplicationSettings();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation to the settings fetch and rejects HTTP failures', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const client = new ApiConnection({ deviceId: '123' });
    const pending = client.getApplicationSettings(controller.signal);
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    fetcher.mockResolvedValue(new Response('', { status: 503 }));
    await expect(client.getApplicationSettings()).rejects.toThrow('settings HTTP 503');
  });

  it.each([{}, { status_code: 0, data: { settings: {} } }, { message: 'success', settings: {} },
    { message: 'success', data: { settings: [] } }, { message: 'demotion', data: { settings: {} } }])('rejects unproven response shape %j', response => {
    expect(() => parseDesktopSettings(response)).toThrow('settings response is invalid');
  });

  it('maps source config into an independent native hint option and rejects malformed entries', () => {
    expect(desktopFloatHintConfig({})).toBeUndefined();
    expect(desktopFloatHintConfig({ im_msg_not_float_not_hint: { enable: false } })).toBeUndefined();
    expect(desktopFloatHintConfig({ im_msg_not_float_not_hint: { enable: true } })).toEqual({ enable: true, notHintMessages: {}, notFloatMessages: {} });
    expect(desktopFloatHintConfig({ im_msg_not_float_not_hint: { enable: true, not_hint_config: { '7': [-1, 4294967338] } } }))
      .toEqual({ enable: true, notHintMessages: { '7': [-1, 42] }, notFloatMessages: {} });
    for (const not_hint_config of [[], { 7: ['42'] }, { 7: [42.1] }, { bad: [] }, { 2147483648: [] }]) {
      expect(() => desktopFloatHintConfig({ im_msg_not_float_not_hint: { enable: true, not_hint_config } })).toThrow();
      expect(() => desktopFloatHintConfig({ im_msg_not_float_not_hint: { enable: true, not_float_config: not_hint_config } })).toThrow();
    }
    expect(desktopFloatHintConfig({ im_msg_not_float_not_hint: { enable: true, not_hint_config: { 7: [42] }, not_float_config: { 1001: [100140] } } }))
      .toEqual({ enable: true, notHintMessages: { 7: [42] }, notFloatMessages: { 1001: [100140] } });
  });

  it('persists and restores only the matching device/profile, keeps prior settings after errors, and isolates reads', async () => {
    const request = jest.fn().mockResolvedValue({ feature: { value: 1 } });
    const first = manager(request);
    const snapshot = await first.value.start();
    (snapshot!['feature'] as Record<string, unknown>)['value'] = 999;
    expect(first.value.snapshot()).toEqual({ feature: { value: 1 } });
    expect(JSON.parse(readFileSync(join(directory, 'desktop-settings.json'), 'utf8'))).toEqual({ version: 1,
      identity: 'device-one', settings: { feature: { value: 1 } } });
    first.value.stop();
    const restored = manager(async () => { throw new Error('offline'); });
    expect(restored.value.snapshot()).toEqual({ feature: { value: 1 } });
    await expect(restored.value.start()).resolves.toEqual({ feature: { value: 1 } });
    expect(restored.onError).toHaveBeenCalledTimes(1);
    expect(manager(request, 'device-two').value.snapshot()).toBeUndefined();
  });

  it('shares an in-flight read and prevents late responses from writing after stop', async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    let signal!: AbortSignal;
    const request = jest.fn((input: AbortSignal) => { signal = input; return new Promise<Record<string, unknown>>(done => { resolve = done; }); });
    const first = manager(request);
    const one = first.value.start(); const two = first.value.refresh();
    expect(request).toHaveBeenCalledTimes(1);
    first.value.stop(); expect(signal.aborted).toBe(true);
    resolve({ feature: 'late' }); await one; await two;
    expect(first.value.snapshot()).toBeUndefined();
    expect(() => readFileSync(join(directory, 'desktop-settings.json'))).toThrow();
    expect(first.onError).not.toHaveBeenCalled();
  });

  it('refreshes at two hours, retains valid configuration after a malformed update, and stops its timer', async () => {
    jest.useFakeTimers();
    const request = jest.fn().mockResolvedValue({ feature: 1 });
    const first = manager(request);
    await first.value.start();
    request.mockResolvedValue({ im_msg_not_float_not_hint: { enable: true, not_hint_config: { 7: 'bad' } } });
    await jest.advanceTimersByTimeAsync(7_200_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(first.value.snapshot()).toEqual({ feature: 1 });
    expect(first.onError).toHaveBeenCalledTimes(1);
    first.value.stop(); await jest.advanceTimersByTimeAsync(7_200_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('applies only a matching cached BDTicket startup snapshot before login, not subsequent refreshes', async () => {
    const store = new AccountStore({ dataDir: directory });
    const account = { platformUid: '10001', session: { cookies: 'sessionid=fixture' },
      deviceProfile: AccountStore.buildDeviceProfile('test', 'trace', { deviceId: '123', installId: '456', guid: 'fixture' }),
      meta: { createdAt: '', updatedAt: '' } };
    store.save(account);
    const config = store.toClientConfig(account);
    const identity = new ApiConnection(config).getApplicationSettingsUrl();
    let settings = { bdticket_switch: false };
    const cache = new DesktopSettings({ directory: store.accountDataDir('10001'), identity,
      request: async () => settings, onError: error => { throw error; } });
    managers.push(cache);
    await cache.start();
    const first = new ApiConnection(config); first.enableTicketGuard(() => undefined);
    const loginUrl = 'https://imdesktop.douyin.com/passport/web/check_qrconnect/';
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
    await first.requestRaw(loginUrl, { method: 'POST' });
    expect(fetcher).toHaveBeenCalledTimes(1); // No cert request when the startup hook is off.
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).has('bd-ticket-guard-ree-public-key')).toBe(false);
    settings = { bdticket_switch: true }; await cache.refresh();
    await first.requestRaw(loginUrl, { method: 'POST' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.requiresTicket('https://imdesktop.douyin.com/aweme/v1/web/commit/follow/user/')).toBe(false);
    const second = new ApiConnection(config); second.enableTicketGuard(() => undefined);
    expect(second.requiresTicket('https://imdesktop.douyin.com/aweme/v1/web/commit/follow/user/')).toBe(true);
    settings = { bdticket_switch: false }; await cache.refresh();
    const otherDevice = new ApiConnection({ ...config, deviceId: 'different' }); otherDevice.enableTicketGuard(() => undefined);
    expect(otherDevice.requiresTicket('https://imdesktop.douyin.com/aweme/v1/web/commit/follow/user/')).toBe(true);
  });

  it('restarts with the updated device identity, preserves cache, and ignores an old response even if abort is ignored', async () => {
    jest.useFakeTimers();
    const request = jest.fn<Promise<Record<string, unknown>>, [AbortSignal]>().mockResolvedValue({ feature: 'cached' });
    const first = manager(request);
    await first.value.start();
    let finish!: (settings: Record<string, unknown>) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = first.value.refresh();
    const oldSignal = request.mock.calls[1]![0];
    request.mockResolvedValue({ feature: 'new' });
    const refresh = first.value.restart('device-two');
    expect(oldSignal.aborted).toBe(true);
    expect(first.value.snapshot()).toEqual({ feature: 'cached' });
    await refresh;
    finish({ feature: 'stale' }); await old;
    expect(first.value.snapshot()).toEqual({ feature: 'new' });
    expect(JSON.parse(readFileSync(join(directory, 'desktop-settings.json'), 'utf8'))).toMatchObject({ identity: 'device-two', settings: { feature: 'new' } });
    await jest.advanceTimersByTimeAsync(7_200_000);
    expect(request).toHaveBeenCalledTimes(4);
    first.value.stop(); await first.value.restart('device-three');
    await jest.advanceTimersByTimeAsync(7_200_000);
    expect(request).toHaveBeenCalledTimes(4);
  });
});
