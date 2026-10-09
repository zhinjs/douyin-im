import * as protocol from './protocol.js';
import * as sdk from './index.js';

describe('adapter extension exports', () => {
  it('exposes the building blocks for a custom IM transport and Frontier observation', () => {
    for (const name of [
      'encodeRequest', 'decodeRequestRaw', 'decodeResponseRaw',
      'ImProtoTransport', 'ImProtoTransportError', 'desktopBodyDigest',
      'DESKTOP_IM_PROFILE', 'desktopCookieProtoOptions', 'desktopImQuery',
      'pushFromResponse', 'FrontierImWs', 'ImSharedContent',
    ]) {
      expect(protocol).toHaveProperty(name);
    }
  });

  it('exposes the saved-session error from the product entry', () => {
    const error = new sdk.SavedSessionRequiredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('saved_session_required');
    expect(error.name).toBe('SavedSessionRequiredError');
  });

  it('round-trips a request through the exported codec', async () => {
    const options = protocol.desktopCookieProtoOptions('3240000001');
    const bytes = await protocol.encodeRequest({
      token: '', cmd: 2006, inboxType: 0, body: {}, authType: 1,
      deviceId: options.deviceId, sdkVersion: options.sdkVersion, buildNumber: options.buildNumber,
      versionCode: options.versionCode, devicePlatform: options.devicePlatform, biz: options.biz,
      access: options.access, headers: options.headers,
    });
    const raw = await protocol.decodeRequestRaw(bytes);
    expect(raw['cmd']).toBe(2006);
    expect(typeof raw['sequenceId']).toBe('string');
  });
});
