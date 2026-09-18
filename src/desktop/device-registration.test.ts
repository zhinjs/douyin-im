import { encodeDeviceLog } from './device-log.js';
import { activateDesktopDevice, buildDeviceRegistration, registerDesktopDevice, type DesktopHardware } from './device-registration.js';
import { guidDeviceId } from '../store/device-id.js';

const hardware: DesktopHardware = {
  platform: 'darwin', release: '24.1.0', model: 'Mac14,5', uuid: 'fixture-uuid', serial: 'fixture-serial',
  sku: 'fixture-sku', mac: '00:11:22:33:44:55', resolution: '1920x1080',
  timezone: 'CST+0800', timezoneName: 'Asia/Shanghai', timezoneOffset: 28800, language: 'zh-CN',
};

describe('Desktop device registration', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['hello', '746303070003fbcc2b94447748e31d71f90474ef364058b53f3d8ef96685c7e6f9ba74972e58'],
    ['{"aid":339757}', '7463030e0003fbcc2b94447748e36092f9046084a0b40cd21eb97f0c7c9812fdf11cd2f63f365892b05c4e31ae2ba98831d41af94036'],
    ['抖音聊天', '7463030f0003fbcc2b94447748e323d5f90401c4be4486e4b91dd451048bf25ef9a5d22615fe58876d8193ec73f67455ec09c7249deb'],
  ])('matches the installed passport-util v3 fixture for %s', (plain, hex) => {
    // Generated with Desktop 1.2.1 bundled logEncrypt, fixed clock 1700000000000.
    expect(encodeDeviceLog(plain!, 1700000000000)).toEqual(Buffer.from(hex!, 'hex'));
  });

  it('uses the Desktop GUID hash fallback', () => {
    expect(guidDeviceId('abc')).toBe('96354');
  });

  it.each([['0', '0'], ['100', '0'], ['0', '200']])('accepts native zero/unpaired cached DID=%s IID=%s', (deviceId, installId) => {
    expect(buildDeviceRegistration(hardware, { deviceId, installId }).body).toBeInstanceOf(Buffer);
  });

  it.each(['-1', '01', '1e3', '18446744073709551616'])('still rejects malformed or out-of-range registration identities: %s', value => {
    expect(() => buildDeviceRegistration(hardware, { deviceId: value, installId: '0' })).toThrow('Invalid saved');
    expect(() => buildDeviceRegistration(hardware, { deviceId: '0', installId: value })).toThrow('Invalid saved');
  });

  it('registers and activates with the dedicated headers, without account cookies', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_id: 1234567890123456, install_id: 1234567890123457 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'success' })));
    const request = buildDeviceRegistration(hardware);
    const url = new URL(request.url);
    expect(url.pathname).toBe('/service/2/desktop/device_register/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ aid: '339757', channel: 'local_test', macos_uuid: hardware.uuid });
    expect(request.body.subarray(0, 3)).toEqual(Buffer.from([0x74, 0x63, 3]));
    const registered = await registerDesktopDevice(hardware);
    await activateDesktopDevice(hardware, registered);
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ 'Content-Type': 'application/json', 'User-Agent': 'TTNetwork PC' });
    const active = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(active.pathname).toBe('/service/2/app_alert/');
    expect(active.searchParams.get('device_id')).toBe(registered.deviceId);
    expect(active.searchParams.get('iid')).toBe(registered.installId);
  });

  it('rejects missing, unsafe and unsuccessful IDs without exposing the response', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    for (const result of [{ device_id: 0 }, { device_id: 9007199254740992, install_id: 1 }, { error: 'private-hardware' }]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify(result)));
      await expect(registerDesktopDevice(hardware)).rejects.toThrow('invalid ID');
    }
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'error' })));
    await expect(activateDesktopDevice(hardware, { deviceId: '1', installId: '2' })).rejects.toThrow('not confirmed');
  });
});
