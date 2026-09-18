import { encodeBrowserInfo } from '../passport/index.js';
import { fileURLToPath } from 'node:url';
import { desktopLoginBrowserInfo } from './default-browser-info.js';
import type { DesktopHardware, RegisteredDevice } from './device-registration.js';

// Isolate hardware and HTTP without replacing ApiConnection's initialization flow.
const hardware = { platform: 'darwin' } as DesktopHardware;
const read = jest.fn<Promise<DesktopHardware>, []>();
const register = jest.fn<Promise<RegisteredDevice>, [DesktopHardware, RegisteredDevice?]>();
const activate = jest.fn<Promise<void>, [DesktopHardware, RegisteredDevice]>();
const esmJest = jest as typeof jest & { unstable_mockModule(name: string, factory: () => unknown): void };
esmJest.unstable_mockModule(fileURLToPath(new URL('./device-registration.ts', import.meta.url)), () => ({
  readDesktopHardware: read, registerDesktopDevice: register, activateDesktopDevice: activate,
}));
const { ApiConnection } = await import('./api-connection.js');

beforeEach(() => {
  read.mockResolvedValue(hardware);
  register.mockResolvedValue({ deviceId: '123', installId: '456' });
  activate.mockResolvedValue(undefined);
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); read.mockReset(); register.mockReset(); activate.mockReset(); });

it('starts with zero identity and publishes it to the first certificate request without using the GUID hash', async () => {
  const client = new ApiConnection({ guid: 'abc' });
  expect([client.getDeviceId(), client.getInstallId()]).toEqual(['0', '0']);
  expect(client.getAccountSdkSourceInfo()).toBe(encodeBrowserInfo(desktopLoginBrowserInfo('0')));
  const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data: {} }));
  client.enableTicketGuard(() => undefined);
  client.startTicketGuard();
  const url = new URL(String(network.mock.calls[0]![0]));
  expect(url.searchParams.get('device_id')).toBe('0');
  expect(url.searchParams.get('iid')).toBe('0');
  expect(read).not.toHaveBeenCalled();
  for (let step = 0; step < 12; step++) await Promise.resolve();
});

it.each([
  ['0', '0'], ['100', '0'], ['0', '200'], ['100', '200'],
])('preserves current registration identity DID=%s IID=%s and shares concurrent initialization', async (deviceId, installId) => {
  const client = new ApiConnection({ deviceId, installId });
  const first = client.initializeDevice();
  expect(client.initializeDevice()).toBe(first);
  await expect(first).resolves.toEqual({ deviceId: '123', installId: '456' });
  expect(register).toHaveBeenCalledWith(hardware, { deviceId, installId });
  expect(register).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledWith(hardware, { deviceId: '123', installId: '456' });
  expect(client.getAccountSdkSourceInfo()).toBe(encodeBrowserInfo(desktopLoginBrowserInfo('123')));
});

it.each(['registration', 'hardware'] as const)('uses GUID hash only after %s failure and updates default browser info', async failure => {
  const client = new ApiConnection({ guid: 'abc' });
  if (failure === 'hardware') read.mockRejectedValue(new Error('fixture hardware unavailable'));
  else register.mockRejectedValue(new Error('fixture registration failure'));
  await expect(client.initializeDevice()).resolves.toEqual({ deviceId: '96354', installId: '0' });
  expect(client.getAccountSdkSourceInfo()).toBe(encodeBrowserInfo(desktopLoginBrowserInfo('96354')));
  if (failure === 'hardware') expect(activate).not.toHaveBeenCalled();
  else expect(activate).toHaveBeenCalledWith(hardware, { deviceId: '96354', installId: '0' });
});

it('keeps a cached identity on failed registration and still attempts activation', async () => {
  const client = new ApiConnection({ guid: 'abc', deviceId: '100', installId: '0', accountSdkSourceInfo: 'custom-browser-info' });
  register.mockRejectedValue(new Error('fixture registration failure'));
  await expect(client.initializeDevice()).resolves.toEqual({ deviceId: '100', installId: '0' });
  expect(activate).toHaveBeenCalledWith(hardware, { deviceId: '100', installId: '0' });
  expect(client.getAccountSdkSourceInfo()).toBe('custom-browser-info');
});

it('keeps successfully registered IDs when activation fails', async () => {
  activate.mockRejectedValue(new Error('fixture activation failure'));
  const client = new ApiConnection({ guid: 'abc' });
  await expect(client.initializeDevice()).resolves.toEqual({ deviceId: '123', installId: '456' });
  expect(client.getAccountSdkSourceInfo()).toBe(encodeBrowserInfo(desktopLoginBrowserInfo('123')));
});

it('registers immediately without a DID, but refreshes a cached DID exactly once after 60 seconds', async () => {
  jest.useFakeTimers();
  const cold = new ApiConnection();
  await expect(cold.startDeviceLifecycle()).resolves.toEqual({ deviceId: '123', installId: '456' });
  expect(register).toHaveBeenCalledTimes(1);
  const warm = new ApiConnection({ deviceId: '100', installId: '200' });
  const save = jest.fn(); warm.setDeviceUpdateHandler(save);
  await expect(warm.startDeviceLifecycle()).resolves.toEqual({ deviceId: '100', installId: '200' });
  await warm.startDeviceLifecycle();
  await jest.advanceTimersByTimeAsync(59_999);
  expect(register).toHaveBeenCalledTimes(1);
  activate.mockImplementation(async () => { expect(save).toHaveBeenCalledWith({ deviceId: '123', installId: '456' }); });
  await jest.advanceTimersByTimeAsync(1);
  expect(register).toHaveBeenCalledTimes(2);
  expect(warm.getDeviceId()).toBe('123');
  await warm.startDeviceLifecycle();
  await jest.advanceTimersByTimeAsync(120_000);
  expect(register).toHaveBeenCalledTimes(2);
});

it('cancels the delayed refresh when the owning lifecycle retires', async () => {
  jest.useFakeTimers();
  const client = new ApiConnection({ deviceId: '100' });
  await client.startDeviceLifecycle();
  client.invalidateAuthenticationResponses();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(read).not.toHaveBeenCalled();
  await client.startDeviceLifecycle();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(register).toHaveBeenCalledTimes(1);
});

it.each(['hardware', 'register', 'failure'] as const)('ignores a retired %s result without fallback, persistence or activation', async stage => {
  const client = new ApiConnection({ deviceId: '100', installId: '200' });
  const save = jest.fn(); client.setDeviceUpdateHandler(save);
  let finish!: () => void;
  if (stage === 'hardware') read.mockImplementation(() => new Promise(resolve => { finish = () => resolve(hardware); }));
  else register.mockImplementation(() => new Promise((resolve, reject) => {
    finish = () => stage === 'failure' ? reject(new Error('late network failure')) : resolve({ deviceId: '123', installId: '456' });
  }));
  const task = client.initializeDevice();
  const result = expect(task).rejects.toThrow('设备注册已取消');
  await Promise.resolve();
  client.invalidateAuthenticationResponses(); finish();
  await result;
  expect([client.getDeviceId(), client.getInstallId()]).toEqual(['100', '200']);
  expect(save).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  if (stage === 'hardware') expect(register).not.toHaveBeenCalled();
});

it('blocks authenticated dispatch after device persistence failure and retries saving, not registration', async () => {
  const client = new ApiConnection();
  const save = jest.fn().mockImplementation(() => { throw new Error('fixture disk full'); });
  client.setDeviceUpdateHandler(save);
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
  await expect(client.initializeDevice()).rejects.toThrow('fixture disk full');
  expect(activate).not.toHaveBeenCalled();
  await expect(client.requestRaw('https://imdesktop.douyin.com/test', {})).rejects.toThrow('fixture disk full');
  expect(network).not.toHaveBeenCalled();
  save.mockImplementation(() => undefined);
  await client.requestRaw('https://imdesktop.douyin.com/test', {});
  expect(save).toHaveBeenLastCalledWith({ deviceId: '123', installId: '456' });
  expect(network).toHaveBeenCalledTimes(1);
  expect(register).toHaveBeenCalledTimes(1);
});
