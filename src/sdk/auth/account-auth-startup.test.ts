import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiConnection } from '../../desktop/api-connection.js';
import { AccountStore } from '../../store/account-store.js';
import { AccountAuth, type AccountAuthHooks } from './account-auth.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douyin-auth-startup-')); });
afterEach(() => { jest.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

function fixture(deviceId = '0') {
  const store = new AccountStore({ dataDir: directory });
  const client = new ApiConnection({ deviceId, installId: '200' });
  const hooks: AccountAuthHooks = {
    onQrcode: jest.fn(), onQrStatus: jest.fn(), onSms: jest.fn(), onVoice: jest.fn(),
    onAccountSelection: jest.fn(), onSmsRequired: jest.fn(), onVerification: jest.fn(), onLoggedIn: jest.fn(),
  };
  const auth = new AccountAuth({ client, store, loginMethod: 'qr' }, hooks);
  const pendingIds = () => readdirSync(join(directory, 'accounts', '_pending'));
  const warmup = jest.spyOn(client, 'ttwidCheck').mockRejectedValue(new Error('fixture warmup unavailable'));
  const qr = jest.spyOn(client, 'getQrcode').mockResolvedValue({ token: 'fixture', qrcodeBase64: 'Zml4dHVyZQ==', expireTime: 9999999999 });
  return { store, client, hooks, auth, pendingIds, warmup, qr };
}

it('persists the key and starts an unauthenticated certificate before registration without waiting for it', async () => {
  const { store, client, auth, pendingIds, hooks, warmup, qr } = fixture();
  let finishCertificate!: (value: Response) => void;
  const order: string[] = [];
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    order.push('certificate');
    const url = new URL(String(input));
    expect(url.pathname).toBe('/passport/ticket_guard/get_client_cert/');
    expect(url.searchParams.get('device_id')).toBe('0');
    expect(url.searchParams.get('iid')).toBe('200');
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(store.loadPending(pendingIds()[0]!)?.desktopTicketGuard?.privateKey).toBeTruthy();
    return new Promise(resolve => { finishCertificate = resolve; });
  });
  jest.spyOn(client, 'initializeDevice').mockImplementation(async () => {
    order.push('device');
    jest.spyOn(client, 'getDeviceId').mockReturnValue('300');
    jest.spyOn(client, 'getInstallId').mockReturnValue('400');
    return { deviceId: '300', installId: '400' };
  });
  try {
    await auth.beginLogin();
    expect(order).toEqual(['certificate', 'device']);
    expect(warmup).toHaveBeenCalledTimes(1);
    expect(qr).toHaveBeenCalledTimes(1);
    expect(hooks.onQrcode).toHaveBeenCalledTimes(1);
    expect(store.loadPending(pendingIds()[0]!)?.deviceProfile).toMatchObject({ deviceId: '300', installId: '400' });
    expect(client.hasBoundTicket()).toBe(false);
    // Rebinding persistence cannot request another device certificate.
    client.enableTicketGuard(() => undefined);
    client.startTicketGuard();
    expect(network).toHaveBeenCalledTimes(1);
  } finally {
    finishCertificate(Response.json({ message: 'success', data: {} }));
    auth.cancel();
  }
});

it('does not warm up, show a QR or recreate pending state after cancellation during registration', async () => {
  const { client, auth, pendingIds, warmup, qr } = fixture();
  let finishDevice!: () => void;
  let finishCertificate!: (value: Response) => void;
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finishCertificate = resolve; }));
  jest.spyOn(client, 'initializeDevice').mockImplementation(() => new Promise(resolve => {
    finishDevice = () => resolve({ deviceId: '100', installId: '200' });
  }));
  const login = auth.beginLogin();
  const rejected = expect(login).rejects.toThrow('登录已取消');
  auth.cancel();
  finishDevice();
  finishCertificate(Response.json({ message: 'success', data: { cert: 'late fixture' } }));
  await rejected;
  // Flush the detached certificate callback, which is device-only and may outlive login.
  for (let step = 0; step < 12; step++) await Promise.resolve();
  expect(pendingIds()).toEqual([]);
  expect(warmup).not.toHaveBeenCalled();
  expect(qr).not.toHaveBeenCalled();
});

it('does not start certificate, device or login requests if saving the initial key fails', async () => {
  const { store, client, auth, warmup, qr } = fixture();
  const save = store.createPending.bind(store);
  jest.spyOn(store, 'createPending').mockImplementation(pending => {
    if (pending.desktopTicketGuard) throw new Error('fixture disk full');
    return save(pending);
  });
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  const device = jest.spyOn(client, 'initializeDevice');
  try {
    await expect(auth.beginLogin()).rejects.toThrow('fixture disk full');
    expect(network).not.toHaveBeenCalled();
    expect(device).not.toHaveBeenCalled();
    expect(warmup).not.toHaveBeenCalled();
    expect(qr).not.toHaveBeenCalled();
  } finally { auth.cancel(); }
});

it('shows the QR using cached identity and persists delayed updates only while the pending owner is active', async () => {
  jest.useFakeTimers();
  const { client, auth, store, pendingIds, qr } = fixture('100');
  jest.spyOn(client, 'startTicketGuard').mockImplementation(() => undefined);
  const registration = jest.spyOn(client, 'initializeDevice').mockResolvedValue({ deviceId: '300', installId: '400' });
  const install = jest.spyOn(client, 'setDeviceUpdateHandler');
  try {
    await auth.beginLogin();
    expect(qr).toHaveBeenCalledTimes(1);
    expect(registration).not.toHaveBeenCalled();
    const save = install.mock.calls[0]![0];
    save({ deviceId: '300', installId: '400' });
    expect(store.loadPending(pendingIds()[0]!)?.deviceProfile).toMatchObject({ deviceId: '300', installId: '400' });
    auth.cancel(); save({ deviceId: 'late', installId: 'late' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(registration).not.toHaveBeenCalled();
    expect(pendingIds()).toEqual([]);
  } finally { auth.cancel(); jest.useRealTimers(); }
});
