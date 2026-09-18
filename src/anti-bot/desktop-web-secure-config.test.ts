import { classifyDesktopWebSecureRequest as classify, DesktopWebSecureConfiguration } from './desktop-web-secure-config.js';

const page = 'file:///Applications/Test.app/renderer/login/index.html';
const request = { url: 'https://imdesktop.douyin.com/passport/web/check_qrconnect/?query=1' };

it('keeps native ticket paths and BDMS paths out of Web SecureSDK default configuration', () => {
  const state = new DesktopWebSecureConfiguration();
  state.setConfig({ aid: 339757, scene: 'login', certType: 'header' });
  expect(classify(request, state.config, page, 'pubKey', 'pubKey')).toMatchObject({
    needProxy: false, onlyProxyResp: false, needReport: true,
    hostname: 'imdesktop.douyin.com', pathname: '/passport/web/check_qrconnect/',
  });
});

it('appends configs without cloning or deduplication, including undefined aid and scene', () => {
  const state = new DesktopWebSecureConfiguration();
  const first = { aid: 339757, scene: 'login' };
  state.setConfig(first); state.setConfig(first); state.setConfig({});
  expect(state.config['login']).toEqual([first, first]);
  expect(state.config['login']![0]).toBe(first);
  expect(state.config['undefined']).toEqual([{}]);
  expect(state.aid).toBeUndefined();
});

it('selects the remote aid array once even when entries change aid', () => {
  const state = new DesktopWebSecureConfiguration();
  state.setConfig({ aid: 339757, scene: 'login' });
  const first = { aid: 99, scene: 'provider', providerPathList: ['/passport/'] };
  const second = { scene: 'consumer', consumerPathList: ['/passport/'] };
  state.applyRemoteConfig({ '339757': [first, second], '99': [{ scene: 'wrong' }] });
  expect(Object.keys(state.config)).toEqual(['login', 'provider', 'consumer']);
  expect(state.aid).toBeUndefined();
  expect(classify(request, state.config, page)).toMatchObject({ needProxy: true, providerConfig: first, consumerConfig: second });
});

it('does not treat absent remote aid entries as a reason to clear local configs', () => {
  const state = new DesktopWebSecureConfiguration();
  state.setConfig({ aid: 339757, scene: 'login', providerPathList: ['/passport/'] });
  state.applyRemoteConfig({ '2906': [], '6383': [] });
  expect(classify(request, state.config, page).needProxy).toBe(true);
});

it('does not roll back earlier remote entries when a later item throws', () => {
  const state = new DesktopWebSecureConfiguration();
  state.setConfig({ aid: 339757, scene: 'login' });
  expect(() => state.applyRemoteConfig({ '339757': [
    { scene: 'first', consumerPathList: ['/passport'] }, null, { scene: 'not-applied' },
  ] })).toThrow();
  expect(Object.keys(state.config)).toEqual(['login', 'first']);
  expect(state.aid).toBeUndefined();
});

it('uses numeric scene-key enumeration before nonnumeric insertion order', () => {
  const state = new DesktopWebSecureConfiguration();
  state.setConfig({ scene: 'login', providerPathList: ['/'] });
  const numeric = { scene: '2', onlyProviderPathList: ['/'] };
  state.setConfig(numeric);
  state.setConfig({ scene: '1', consumerPathList: ['/'] });
  expect(classify(request, state.config, page).providerConfig).toBe(numeric);
});

it('uses first provider and consumer separately; consumer cancels response-only mode', () => {
  const first = { onlyProviderPathList: ['/passport/'] };
  const second = { providerPathList: ['/passport/'], consumerPathList: ['/passport/'] };
  const result = classify(request, { login: [first, second] }, page);
  expect(result.providerConfig).toBe(first);
  expect(result.consumerConfig).toBe(second);
  expect(result).toMatchObject({ needProxy: true, onlyProxyResp: false });
});

it('uses the native exclusion loop bound and retains provider selections after exclusion', () => {
  const first = { providerPathList: ['/passport/'] };
  expect(classify(request, { login: [first, { excludeConsumerPathList: ['/passport/'] }] }, page).needProxy).toBe(true);
  const excluded = classify(request, { login: [first, {
    excludeConsumerPathList: ['/passport/'], onlyProviderPathList: ['/not-matching'],
  }] }, page);
  expect(excluded).toMatchObject({ needProxy: false, onlyProxyResp: false });
  expect(excluded.providerConfig).toBe(first);
  const revived = classify(request, { login: [first, {
    excludeConsumerPathList: ['/passport/'], onlyProviderPathList: ['/not-matching'], consumerPathList: ['/passport/'],
  }] }, page);
  expect(revived.needProxy).toBe(true);
});

it('skips later consumer exclusions after the first consumer was selected', () => {
  const first = { consumerPathList: ['/passport/'] };
  expect(classify(request, { login: [first, {
    excludeConsumerPathList: ['/passport/'], onlyProviderPathList: ['/not-matching'],
  }] }, page)).toMatchObject({ needProxy: true, consumerConfig: first });
});

it('uses host prefixes including ports, not suffix-domain or exact-host rules', () => {
  expect(classify({ url: 'https://imdesktop.douyin.com.example:8443/passport/' }, {
    login: [{ consumerHostList: ['imdesktop.douyin.com'] }],
  }, page)).toMatchObject({ needProxy: true, hostname: 'imdesktop.douyin.com.example:8443' });
  expect(classify({ url: 'https://imdesktop.douyin.com:8443/passport/' }, {
    login: [{ providerHostPathList: ['imdesktop.douyin.com:8443/passport/'] }],
  }, page).needProxy).toBe(true);
});

it('resolves relative URLs at the real page and falls back to raw path on URL errors', () => {
  expect(classify({ url: '/passport/login' }, { login: [{ providerPathList: ['/passport'] }] }, page)).toMatchObject({
    needProxy: true, hostname: '', pathname: '/passport/login',
  });
  expect(classify({ url: 'http://[' }, { login: [{ providerPathList: ['http:'] }] }, page)).toMatchObject({
    needProxy: true, hostname: undefined, pathname: 'http://[',
  });
});

it.each(['mcs.zijieapi.com', 'mon.zijieapi.com'])('bypasses telemetry host %s before policy evaluation', host => {
  expect(classify({ url: `https://${host}/` }, { login: [{ consumerPathList: ['/'] }] }, page)).toEqual({ needProxy: false });
});

it('handles report exclusion independently and ignores non-array scene entries', () => {
  expect(classify(request, { ignored: { consumerPathList: ['/'] }, login: [{ excludeReportPathList: ['/passport'] }] }, page)).toMatchObject({
    needProxy: false, needReport: false,
  });
});

it('returns only needProxy=false on missing inputs or malformed list exceptions', () => {
  expect(classify(null, {}, page)).toEqual({ needProxy: false });
  expect(classify(request, null, page)).toEqual({ needProxy: false });
  expect(classify(request, { login: [{ excludeReportPathList: null }] }, page)).toEqual({ needProxy: false });
});
