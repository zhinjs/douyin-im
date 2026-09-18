import { DesktopPassportSecurePlugin, type DesktopPassportSecurePluginProps } from './desktop-passport-secure-plugin.js';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture(props: DesktopPassportSecurePluginProps = { aid: 339757 }, realm = {}) {
  const calls: string[] = [], background = jest.fn();
  const sdk = { setConfig: jest.fn(() => { calls.push('config'); }), setDisableCrossStorage: jest.fn(() => { calls.push('disableCross'); }),
    setAgidAndHost: jest.fn(() => { calls.push('agid'); }), setWebId: jest.fn(() => { calls.push('webid'); }),
    start: jest.fn(() => { calls.push('start'); return Promise.resolve(); }), startDTrait: jest.fn(() => { calls.push('dtrait'); return true; }) };
  const getCookie = jest.fn((name: string): string => { calls.push(name); return name === 'passport_csrf_token_default' ? 'synthetic-webid' : ''; });
  const context = { sdk, realm, getCookie, onBackgroundError: background };
  return { plugin: new DesktopPassportSecurePlugin(context, props), context, sdk, calls, background, getCookie };
}

it('initializes cookie/header/SSO, then agid/WebId/start/DTrait/callback without waiting', () => {
  const f = fixture({ aid: 339757, ztsdkOptions: { initCallback: () => { f.calls.push('callback'); } } });
  expect(f.plugin.init()).toBeUndefined(); expect(f.plugin.hasInit).toBe(true);
  expect(f.calls).toEqual(['config', 'config', 'config', 'agid', 'passport_csrf_token', 'passport_csrf_token_default', 'webid', 'start', 'dtrait', 'callback']);
  const configs = f.sdk.setConfig.mock.calls as unknown as [Record<string, unknown>][];
  expect(configs[0]![0]).toEqual(expect.objectContaining({ aid: 339757, scene: 'web_protect', certType: 'cookie', signVersion: 2 }));
  expect(configs[1]![0]).toEqual(expect.objectContaining({ certType: 'header', namespace: 'web', onlyProviderPathList: ['/passport/web/one_login/'] }));
  expect(configs[2]![0]).toEqual(expect.objectContaining({ scene: 'sso', namespace: 'sso', consumerPathList: ['sso.douyin.com/check_login/'] }));
  expect(f.sdk.startDTrait).toHaveBeenCalledWith({ aid: 339757, webId: 'synthetic-webid' });
});

it('cookie takes original options last while header preserves appended default paths', () => {
  const paths = ['/custom'], callback = () => {}, options = { consumerPathList: paths, providerPathList: ['/provider'], agid: 8, initCallback: callback, signVersion: 9, disableCrossStorage: true };
  const f = fixture({ aid: 1, ztsdkOptions: options, dtrait: false }); f.plugin.init();
  const [cookie, header] = (f.sdk.setConfig.mock.calls as unknown as [Record<string, unknown>][]).map(call => call[0]);
  expect(cookie!['consumerPathList']).toBe(paths); expect(cookie!['initCallback']).toBe(callback); expect(cookie!['agid']).toBe(8);
  expect(header!['consumerPathList']).toEqual(['/custom', '/passport/token/beat/web', '/passport/account/info/v2']);
  expect(header!['providerPathList']).toEqual(expect.arrayContaining(['/provider', '/passport/web/check_qrconnect/']));
  expect(header).not.toHaveProperty('initCallback'); expect(header).not.toHaveProperty('disableCrossStorage'); expect(header!['signVersion']).toBe(9);
  expect(f.calls.indexOf('disableCross')).toBeLessThan(f.calls.indexOf('agid')); expect(f.sdk.startDTrait).not.toHaveBeenCalled(); expect(paths).toEqual(['/custom']);
});

it('all disabled configurations still run metadata and start', () => {
  const f = fixture({ ztsdkOptions: { enableCookieOptions: false, enableHeaderOptions: false }, ssoZtsdkOptions: { enable: false }, dtrait: false }); f.plugin.init();
  expect(f.sdk.setConfig).not.toHaveBeenCalled(); expect(f.sdk.start).toHaveBeenCalledTimes(1); expect(f.plugin.hasInit).toBe(true);
});

it('uses first csrf cookie without reading fallback and ignores dtraitOption content', () => {
  const f = fixture({ aid: 1, dtraitOption: { aid: 999, consumerPathList: ['/ignored'] } }); f.getCookie.mockReturnValue('first'); f.plugin.init();
  expect(f.getCookie).toHaveBeenCalledTimes(1); expect(f.sdk.startDTrait).toHaveBeenCalledWith({ aid: 1, webId: 'first' });
});

it('realm gate suppresses a second instance, but not a separate account realm', () => {
  const realm = {}, first = fixture({}, realm), second = fixture({}, realm), independent = fixture();
  first.plugin.init(); first.plugin.init(); second.plugin.init(); independent.plugin.init();
  expect(first.sdk.start).toHaveBeenCalledTimes(1); expect(second.sdk.start).not.toHaveBeenCalled(); expect(second.plugin.hasInit).toBe(false); expect(independent.sdk.start).toHaveBeenCalledTimes(1);
});

it('callback failure happens after realm gate but before instance hasInit', () => {
  const f = fixture({ ztsdkOptions: { initCallback: () => { throw Error('callback'); } } });
  expect(() => f.plugin.init()).toThrow('callback'); expect(f.plugin.hasInit).toBe(false); f.plugin.init(); expect(f.sdk.start).toHaveBeenCalledTimes(1);
});

it('synchronous DTrait failure leaves gate unset so retry repeats earlier configuration', () => {
  const f = fixture(); f.sdk.startDTrait.mockImplementationOnce(() => { throw Error('dtrait'); });
  expect(() => f.plugin.init()).toThrow('dtrait'); expect(f.plugin.hasInit).toBe(false); f.plugin.init(); expect(f.sdk.setConfig).toHaveBeenCalledTimes(6);
});

it('rejected SDK start is observed but does not delay callback or undo initialization', async () => {
  const f = fixture(); f.sdk.start.mockRejectedValue(Error('start')); f.plugin.init(); expect(f.plugin.hasInit).toBe(true);
  await flush(); expect(f.background).toHaveBeenCalledWith(expect.objectContaining({ message: 'start' }));
});

it('densifies sparse header path arrays without altering cookie option identity', () => {
  const paths: string[] = []; paths.length = 2; paths[1] = '/custom'; const f = fixture({ ztsdkOptions: { consumerPathList: paths } }); f.plugin.init();
  const configs = f.sdk.setConfig.mock.calls as unknown as [Record<string, unknown>][];
  expect(configs[0]![0]['consumerPathList']).toBe(paths); expect(0 in paths).toBe(false);
  expect(configs[1]![0]['consumerPathList']).toEqual([undefined, '/custom', '/passport/token/beat/web', '/passport/account/info/v2']);
  expect(0 in (configs[1]![0]['consumerPathList'] as string[])).toBe(true);
});
