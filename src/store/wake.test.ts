import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AccountStore } from './account-store.js';
import type { ClientFactory, HttpClient, SessionProbeResult, StoredAccount } from './types.js';
import { tryRestoreSession } from './wake.js';
import { ApiConnection } from '../desktop/api-connection.js';

describe('stored Session wake-up', () => {
  let dataDir = '';

  afterEach(() => {
    jest.restoreAllMocks();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  function prepare(probe: SessionProbeResult): {
    store: AccountStore;
    createClient: ClientFactory;
  } {
    dataDir = mkdtempSync(join(tmpdir(), 'douyin-im-wake-'));
    const store = new AccountStore({ dataDir });
    const account: StoredAccount = {
      platformUid: '1150530166719210',
      session: { cookies: 'sessionid=session; sid_guard=opaque' },
      deviceProfile: {
        userAgent: 'desktop-test',
        bizTraceId: 'trace',
        deviceId: '3249781169',
        guid: 'test-guid',
        screenWidth: 1728,
        screenHeight: 1117,
      },
      meta: {
        screenName: 'old name',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    };
    store.save(account);
    const createClient: ClientFactory = () => ({
      requestRaw: jest.fn(),
      getCookies: () => 'sessionid=refreshed',
      getUserAgent: () => 'desktop-test',
      probeSession: async () => probe,
    });
    return { store, createClient };
  }

  it('persists a verified desktop Session and refreshed profile', async () => {
    const { store, createClient } = prepare({
      status: 'alive',
      uid: '1150530166719210',
      screenName: 'new name',
      reason: 'ok',
    });

    const result = await tryRestoreSession(store, createClient, '1150530166719210');

    expect(result.outcome).toBe('ok');
    expect(result.wake).toMatchObject({
      status: 'ok',
      verified: true,
      reason: 'ok',
      screenName: 'new name',
    });
    expect(store.load('1150530166719210')).toMatchObject({
      session: { cookies: 'sessionid=refreshed' },
      meta: { screenName: 'new name' },
    });
  });

  it('starts certificates after key persistence and before device registration and restore probing', async () => {
    const { store, createClient } = prepare({ status: 'alive', uid: '1150530166719210', reason: 'ok' });
    const client = createClient({});
    const order: string[] = [];
    client.enableTicketGuard = save => {
      save({ version: 1, privateKey: 'fixture-key' });
      order.push('persist');
    };
    client.startTicketGuard = () => {
      expect(store.load('1150530166719210')!.session.desktopTicketGuard?.privateKey).toBe('fixture-key');
      order.push('certificate');
    };
    client.initializeDevice = async () => {
      order.push('device');
      return { deviceId: '3249781169', installId: '456' };
    };
    const probe = client.probeSession.bind(client);
    client.probeSession = async () => { order.push('probe'); return probe(); };
    await expect(tryRestoreSession(store, () => client, '1150530166719210')).resolves.toMatchObject({ outcome: 'ok' });
    expect(order).toEqual(['persist', 'certificate', 'device', 'probe']);
  });

  it.each(['alive', 'error'] as const)('saves device-only updates during probing and retires a rejected restore (%s)', async status => {
    const uid = '1150530166719210';
    const { store, createClient } = prepare({ status: 'error', reason: 'unused' });
    const client = createClient({});
    let update!: Parameters<NonNullable<HttpClient['setDeviceUpdateHandler']>>[0];
    client.setDeviceUpdateHandler = handler => { update = handler; };
    client.startDeviceLifecycle = jest.fn(async () => ({ deviceId: '3249781169', installId: '0' }));
    client.initializeDevice = jest.fn();
    client.invalidateAuthenticationResponses = jest.fn();
    client.probeSession = async () => {
      update({ deviceId: '300', installId: '400' });
      expect(store.load(uid)!.session.cookies).toContain('sessionid=session');
      expect(store.load(uid)!.deviceProfile).toMatchObject({ deviceId: '300', installId: '400' });
      return { status, uid, reason: 'fixture' };
    };
    await tryRestoreSession(store, () => client, uid);
    expect(client.initializeDevice).not.toHaveBeenCalled();
    update({ deviceId: '500', installId: '600' });
    expect(store.load(uid)!.deviceProfile.deviceId).toBe(status === 'alive' ? '500' : '300');
    expect(client.invalidateAuthenticationResponses).toHaveBeenCalledTimes(status === 'alive' ? 0 : 1);
  });

  it('retires device work immediately on abort, even while the probe has not settled', async () => {
    const uid = '1150530166719210';
    const { store, createClient } = prepare({ status: 'error', reason: 'unused' });
    const client = createClient({}); const controller = new AbortController();
    let update!: Parameters<NonNullable<HttpClient['setDeviceUpdateHandler']>>[0];
    client.setDeviceUpdateHandler = handler => { update = handler; };
    client.invalidateAuthenticationResponses = jest.fn();
    let finish!: (probe: SessionProbeResult) => void;
    client.probeSession = () => new Promise(resolve => { finish = resolve; });
    const task = tryRestoreSession(store, () => client, uid, { signal: controller.signal });
    const rejected = expect(task).rejects.toThrow();
    controller.abort();
    expect(client.invalidateAuthenticationResponses).toHaveBeenCalledTimes(1);
    update({ deviceId: 'late', installId: 'late' });
    expect(store.load(uid)!.deviceProfile.deviceId).toBe('3249781169');
    finish({ status: 'alive', uid, reason: 'late' }); await rejected;
  });

  it.each(['match', 'mismatch', 'passport-error'] as const)('stages real request-layer Passport rotations until the Douyin identity check (%s)', async outcome => {
    const { store } = prepare({ status: 'error', reason: 'unused' });
    const uid = '1150530166719210';
    jest.spyOn(ApiConnection.prototype, 'initializeDevice').mockResolvedValue({ deviceId: '3249781169', installId: '456' });
    const paths: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'error' });
      paths.push(path);
      if (path === '/passport/account/info/v2/') {
        expect(store.load(uid)!.session.cookies).toContain('sessionid=session');
        expect(store.load(uid)!.session.desktopTicketGuard?.privateKey).toBeTruthy();
        const headers = new Headers({
          'set-cookie': 'sessionid=candidate; Path=/',
          'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket: 'candidate', ts_sign_ree: 'candidate-signature' })).toString('base64'),
        });
        return Response.json({ message: outcome === 'passport-error' ? 'error' : 'success', data: {} }, { headers });
      }
      expect(path).toBe('/aweme/v1/web/user/profile/self/');
      expect(new Headers(init?.headers).get('cookie')).toContain('sessionid=candidate');
      // HTTP interception has accepted the candidate, but disk still belongs to
      // the original identity until the second request is checked by wake.
      expect(store.load(uid)!.session.cookies).toContain('sessionid=session');
      expect(store.load(uid)!.session.desktopTicketGuard?.binding).toBeUndefined();
      return Response.json({ status_code: 0, user: { uid: outcome === 'match' ? uid : '10002' } });
    });
    const result = await tryRestoreSession(store, config => new ApiConnection({ ...config, enableABogus: false }), uid);
    expect(result.outcome).toBe(outcome === 'match' ? 'ok' : 'error');
    expect(paths).toEqual(outcome === 'passport-error'
      ? ['/passport/account/info/v2/']
      : ['/passport/account/info/v2/', '/aweme/v1/web/user/profile/self/']);
    const saved = store.load(uid)!;
    expect(saved.session.cookies).toContain(outcome === 'match' ? 'sessionid=candidate' : 'sessionid=session');
    expect(new ApiConnection(store.toClientConfig(saved)).hasBoundTicket()).toBe(outcome === 'match');
    result.wake?.client.invalidateAuthenticationResponses?.();
  });

  it('keeps the verified account snapshot when a certificate arrives after the probe', async () => {
    const { store, createClient } = prepare({ status: 'alive', uid: '1150530166719210', screenName: 'verified name', reason: 'ok' });
    const client = createClient({});
    let persist!: Parameters<NonNullable<HttpClient['enableTicketGuard']>>[0];
    client.enableTicketGuard = save => { persist = save; save({ version: 1, privateKey: 'fixture-key' }); };
    const result = await tryRestoreSession(store, () => client, '1150530166719210');
    const verifiedAt = result.wake!.account.session.verifiedAt;
    persist({ version: 1, privateKey: 'fixture-key', serverSn: 'late-certificate' });
    expect(store.load('1150530166719210')).toMatchObject({
      session: { verifiedAt, desktopTicketGuard: { serverSn: 'late-certificate' } },
      meta: { screenName: 'verified name' },
    });
    expect(result.wake!.account.session.desktopTicketGuard?.serverSn).toBe('late-certificate');
  });

  it.each([false, true])('never restores a legacy Cookie duplicate as a signing token (skipVerify=%s)', async skipVerify => {
    const { store, createClient } = prepare({ status: 'alive', uid: '1150530166719210', reason: 'ok' });
    const account = store.load('1150530166719210')!;
    // Old files may contain this field; retain their data without interpreting it as xmst.
    Object.assign(account.session, { msToken: 'old' }); store.save(account);
    expect(store.toClientConfig(account)).not.toHaveProperty('msToken');
    const client = createClient({});
    let persist!: Parameters<NonNullable<HttpClient['enableTicketGuard']>>[0];
    const state = { version: 1 as const, privateKey: 'offline-key' };
    client.enableTicketGuard = save => { persist = save; save(state); };
    client.probeSession = async () => {
      persist(state);
      return { status: 'alive', uid: account.platformUid, reason: 'ok' };
    };
    const result = await tryRestoreSession(store, () => client, account.platformUid, { skipVerify });
    if (skipVerify) persist(state);
    expect(result.outcome).toBe('ok');
    expect(result.wake!.account.session).toMatchObject({ msToken: 'old' });
    expect(store.toClientConfig(store.load(account.platformUid)!)).not.toHaveProperty('msToken');
  });

  it.each(['mismatch', 'missing', 'expired', 'error', 'throw'] as const)('does not publish probe cookies or late tickets after %s', async outcome => {
    const { store, createClient } = prepare({ status: 'error', reason: 'unused' });
    const client = createClient({});
    let cookies = 'sessionid=session; sid_guard=opaque';
    client.getCookies = () => cookies;
    let persist!: Parameters<NonNullable<HttpClient['enableTicketGuard']>>[0];
    const initial = { version: 1 as const, privateKey: 'fixture-original-key' };
    client.enableTicketGuard = save => { persist = save; save(initial); };
    client.probeSession = async () => {
      cookies = 'sessionid=unverified';
      persist({ ...initial, serverSn: 'probe-update' });
      expect(store.load('1150530166719210')!.session.cookies).toBe('sessionid=session; sid_guard=opaque');
      if (outcome === 'throw') throw new Error('probe interrupted');
      if (outcome === 'expired' || outcome === 'error') return { status: outcome, reason: 'rejected' };
      return { status: 'alive', ...(outcome === 'mismatch' ? { uid: '222' } : {}), reason: 'not the expected identity' };
    };
    const restoring = tryRestoreSession(store, () => client, '1150530166719210');
    if (outcome === 'throw') await expect(restoring).rejects.toThrow('probe interrupted');
    else expect((await restoring).outcome).not.toBe('ok');
    persist({ ...initial, serverSn: 'late-update' });
    expect(store.load('1150530166719210')!.session).toMatchObject({
      cookies: 'sessionid=session; sid_guard=opaque', desktopTicketGuard: initial,
    });
    expect(store.load('1150530166719210')!.session.desktopTicketGuard?.serverSn).toBeUndefined();
  });

  it('commits buffered cookies and ticket state together only after the expected UID is confirmed', async () => {
    const { store, createClient } = prepare({ status: 'error', reason: 'unused' });
    const client = createClient({});
    let cookies = 'sessionid=session; sid_guard=opaque';
    client.getCookies = () => cookies;
    let persist!: Parameters<NonNullable<HttpClient['enableTicketGuard']>>[0];
    client.enableTicketGuard = save => { persist = save; save({ version: 1, privateKey: 'fixture-key' }); };
    client.probeSession = async () => {
      cookies = 'sessionid=verified-rotation';
      persist({ version: 1, privateKey: 'fixture-key', serverSn: 'probe-cert' });
      expect(store.load('1150530166719210')!.session.cookies).toBe('sessionid=session; sid_guard=opaque');
      return { status: 'alive', uid: '1150530166719210', reason: 'confirmed' };
    };
    const result = await tryRestoreSession(store, () => client, '1150530166719210');
    expect(result.outcome).toBe('ok');
    expect(store.load('1150530166719210')!.session).toMatchObject({
      cookies: 'sessionid=verified-rotation', desktopTicketGuard: { serverSn: 'probe-cert' },
    });
  });

  it('revokes restoration writes immediately on cancellation, including late successful probes', async () => {
    const { store, createClient } = prepare({ status: 'error', reason: 'unused' });
    const client = createClient({});
    client.getCookies = () => 'sessionid=session; sid_guard=opaque';
    let persist!: Parameters<NonNullable<HttpClient['enableTicketGuard']>>[0];
    client.enableTicketGuard = save => { persist = save; save({ version: 1, privateKey: 'fixture-key' }); };
    let finish!: (result: SessionProbeResult) => void;
    client.probeSession = signal => {
      expect(signal).toBe(controller.signal);
      return new Promise(resolve => { finish = resolve; });
    };
    const controller = new AbortController(); const reason = new Error('cancelled restore');
    const restoring = tryRestoreSession(store, () => client, '1150530166719210', { signal: controller.signal });
    const cancelled = expect(restoring).rejects.toBe(reason);
    controller.abort(reason);
    client.getCookies = () => 'sessionid=late';
    persist({ version: 1, privateKey: 'fixture-key', serverSn: 'late' });
    finish({ status: 'alive', uid: '1150530166719210', screenName: 'late', reason: 'ok' });
    await cancelled;
    expect(store.load('1150530166719210')!.session.cookies).toBe('sessionid=session; sid_guard=opaque');
    expect(store.load('1150530166719210')!.session.desktopTicketGuard?.serverSn).toBeUndefined();
    expect(store.load('1150530166719210')!.meta.screenName).toBe('old name');
  });

  it('keeps a network/protocol failure distinct from an expired Session', async () => {
    const { store, createClient } = prepare({ status: 'error', reason: 'network unavailable' });

    const result = await tryRestoreSession(store, createClient, '1150530166719210');

    expect(result.outcome).toBe('error');
    expect(result.wake).toMatchObject({
      status: 'error',
      verified: false,
      reason: 'network unavailable',
    });
    expect(store.load('1150530166719210')?.session.verifiedAt).toBeUndefined();
  });

  it('registers before probing and persists the returned identity without dropping Session', async () => {
    const { store, createClient } = prepare({ status: 'alive', uid: '1150530166719210', reason: 'ok' });
    const http = createClient({});
    let initialized = false;
    http.initializeDevice = async () => {
      initialized = true;
      return { deviceId: '1234567890123456', installId: '1234567890123457' };
    };
    const probe = http.probeSession;
    http.probeSession = async () => { expect(initialized).toBe(true); return probe(); };
    const result = await tryRestoreSession(store, () => http, '1150530166719210');
    expect(result.outcome).toBe('ok');
    const saved = store.load('1150530166719210')!;
    expect(store.toClientConfig(saved)).toMatchObject({ deviceId: '1234567890123456', installId: '1234567890123457' });
    expect(saved.session.cookies).toBe('sessionid=refreshed');
  });

  it.each(['222', undefined])('rejects an alive probe with mismatched or missing uid %s without saving', async (uid) => {
    const { store, createClient } = prepare({ status: 'alive', ...(uid ? { uid } : {}), reason: 'ok' });
    const save = jest.spyOn(store, 'save');
    const result = await tryRestoreSession(store, createClient, '1150530166719210');
    expect(result.outcome).toBe('error');
    expect(result.wake).toMatchObject({ verified: false });
    expect(save).not.toHaveBeenCalled();
    expect(store.load('1150530166719210')?.session.cookies).toBe('sessionid=session; sid_guard=opaque');
  });

  it('starts a fresh login only after the remote probe confirms expiry', async () => {
    const { store, createClient } = prepare({ status: 'expired', reason: 'passport rejected' });

    const result = await tryRestoreSession(store, createClient, '1150530166719210');

    expect(result.outcome).toBe('expired');
    expect(result.wake).toMatchObject({
      status: 'expired',
      verified: true,
      reason: 'passport rejected',
    });
  });

  it('reports an explicitly skipped probe as unverified recovery', async () => {
    const { store, createClient } = prepare({ status: 'expired', reason: 'must not run' });

    const result = await tryRestoreSession(
      store,
      createClient,
      '1150530166719210',
      { skipVerify: true },
    );

    expect(result.outcome).toBe('ok');
    expect(result.wake).toMatchObject({ status: 'ok', verified: false });
  });
});
