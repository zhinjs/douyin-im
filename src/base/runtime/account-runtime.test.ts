import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApiConnection } from '../../desktop/api-connection.js';
import { AccountStore } from '../../store/account-store.js';
import type { StoredAccount } from '../../store/types.js';
import { AccountRuntime } from './account-runtime.js';

describe('AccountRuntime protocol state', () => {
  const roots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { runtime: AccountRuntime; account: StoredAccount; store: AccountStore } {
    const root = mkdtempSync(join(tmpdir(), 'douyin-account-runtime-'));
    roots.push(root);
    const store = new AccountStore({ dataDir: root });
    return {
      store,
      runtime: new AccountRuntime(store, new ApiConnection()),
      account: {
        platformUid: '10001',
        session: { cookies: 'sessionid=persisted' },
        deviceProfile: { userAgent: 'test', bizTraceId: 'trace' },
        meta: { createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
      },
    };
  }

  it('binds restored cookies and persists one stable device id', () => {
    const { runtime, account } = fixture();
    const connection = new ApiConnection({ initialCookies: 'ttwid=warm' });

    runtime.bindRestored(connection, account);
    const first = runtime.bound;
    const second = runtime.bound;

    expect(connection.jar.toHeader()).toContain('ttwid=warm');
    expect(connection.jar.toHeader()).toContain('sessionid=persisted');
    expect(first.deviceId).toMatch(/^\d+$/);
    expect(second.deviceId).toBe(first.deviceId);
    expect(first.platformUid).toBe('10001');
  });

  it('atomically replaces a promoted connection and can clear bound state', () => {
    const { runtime, account } = fixture();
    const first = new ApiConnection();
    const second = new ApiConnection();
    runtime.bindPromoted(first, account);
    runtime.bindPromoted(second, { ...account, platformUid: '20002' });

    expect(runtime.bound.client).toBe(second);
    expect(runtime.platformUid).toBe('20002');

    runtime.clear();
    expect(runtime.platformUid).toBeUndefined();
    expect(() => runtime.bound).toThrow('账号未绑定');
  });

  it('persists device updates before notifying business consumers and retires old owners', () => {
    const { store, account } = fixture();
    const connection = new ApiConnection({ deviceId: '100', installId: '200' });
    const update = jest.fn(() => {
      expect(store.load(account.platformUid)?.deviceProfile).toMatchObject({ deviceId: '300', installId: '400' });
    });
    const runtime = new AccountRuntime(store, connection, update);
    const install = jest.spyOn(connection, 'setDeviceUpdateHandler');
    runtime.bindPromoted(connection, account);
    const old = install.mock.calls[0]![0];
    old({ deviceId: '300', installId: '400' });
    expect(update).toHaveBeenCalledTimes(1);
    runtime.bindPromoted(connection, account);
    old({ deviceId: 'stale', installId: 'stale' });
    runtime.suspend();
    install.mock.calls[1]![0]({ deviceId: 'late', installId: 'late' });
    expect(store.load(account.platformUid)?.deviceProfile).toMatchObject({ deviceId: '300', installId: '400' });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not persist a late response after the runtime switches or clears its account', () => {
    const { runtime, account } = fixture();
    const first = new ApiConnection();
    const second = new ApiConnection();
    const firstEnable = jest.spyOn(first, 'enableTicketGuard');
    const secondEnable = jest.spyOn(second, 'enableTicketGuard');
    runtime.bindPromoted(first, account);
    const firstPersist = firstEnable.mock.calls[0]![0];
    const replacement = { ...account, platformUid: '20002', session: { ...account.session } };
    runtime.bindPromoted(second, replacement);
    const secondPersist = secondEnable.mock.calls[0]![0];
    first.jar.set('sessionid', 'stale');
    firstPersist(first.getTicketGuardState()!);
    expect(account.session.cookies).not.toContain('stale');
    runtime.clear();
    second.jar.set('sessionid', 'late');
    secondPersist(second.getTicketGuardState()!);
    expect(replacement.session.cookies).not.toContain('late');
  });

  it('retires old persistence callbacks even when the same account and connection are rebound', () => {
    const { runtime, account } = fixture();
    const client = new ApiConnection({ initialCookies: 'sessionid=original' });
    const enable = jest.spyOn(client, 'enableTicketGuard');
    runtime.bindPromoted(client, account);
    const old = enable.mock.calls[0]![0];
    runtime.suspend();
    expect(runtime.platformUid).toBe(account.platformUid);
    client.jar.set('sessionid', 'fresh');
    runtime.bindPromoted(client, account);
    const current = enable.mock.calls[1]![0];
    const state = client.getTicketGuardState()!;
    current({ ...state, clientCert: 'current' });
    old({ ...state, clientCert: 'stale' });
    expect(account.session.cookies).toBe('sessionid=fresh');
    expect(account.session.desktopTicketGuard?.clientCert).toBe('current');
  });

  it.each(['rotated', undefined])('persists Cookie msToken without restoring it into signing state (%s)', async token => {
    const { runtime, account, store } = fixture();
    account.session.cookies += '; msToken=old';
    Object.assign(account.session, { msToken: 'old' });
    const client = new ApiConnection(store.toClientConfig(account));
    runtime.bindRestored(client, account);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).includes('/get_client_cert/')) return Response.json({ message: 'success', data: {} });
      return new Response('{}', { headers: token ? { 'set-cookie': `msToken=${token}; Path=/` }
        : { 'set-cookie': 'msToken=; Max-Age=0; Path=/' } });
    });
    await client.requestRaw('https://imdesktop.douyin.com/aweme/v1/web/user/profile/other/', { method: 'GET' });
    const saved = store.load(account.platformUid)!;
    const restored = new ApiConnection(store.toClientConfig(saved));
    expect(restored.jar.get('msToken')).toBe(token);
    expect(restored.getMsToken()).toBeUndefined();
    expect(store.toClientConfig(saved)).not.toHaveProperty('msToken');
  });
});
