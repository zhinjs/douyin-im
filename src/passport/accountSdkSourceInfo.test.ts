import { encodeAccountSdkSourceInfo, encodeBrowserInfo } from './accountSdkSourceInfo.js';
import { mixModeEncode } from './mixMode.js';
import { ApiConnection } from '../desktop/api-connection.js';

afterEach(() => jest.restoreAllMocks());

// Fixed C321 module74321 a() outputs, independently checked by the source oracle.
it.each([
  ['ASCII', '4456464c4c'], ['A中é', '44e1bda8c6ac'], ['a😀b', '6467'],
  ['\ud800A\udfff', '44'], ['\u0001😀1', '434'], ['\u0005', '0'], ['', ''],
])('encodes browser source text %j using the Desktop byte codec', (plain, wire) => {
  expect(encodeAccountSdkSourceInfo(plain)).toBe(wire);
});

it.each([
  { name: 'ASCII profile' }, { name: '抖音聊天', path: '/用户/登录' },
  { permission: 'é', label: '😀', isolated: '\ud800', control: '\u0001', nested: { '中文': '值' } },
])('serializes browserInfo before encoding and preserves its exact login query value: %j', async info => {
  const plain = JSON.stringify(info);
  const encoded = encodeBrowserInfo(info);
  // JSON escapes controls and isolated surrogates, but not a valid emoji pair;
  // the source byte encoder drops that pair. No lossy decoder is used as an oracle.
  const expected = mixModeEncode(plain);
  expect(encoded).toBe(expected);
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'success', data: {} }));
  const connection = new ApiConnection({ accountSdkSourceInfo: encoded, enableABogus: false });
  await connection.userLogin('13800000000', 'fixture password');
  expect(fetch).toHaveBeenCalledTimes(1);
  const url = new URL(String(fetch.mock.calls[0]![0]));
  expect(url.origin).toBe('https://imdesktop.douyin.com');
  expect(url.pathname).toBe('/passport/web/user/login/');
  expect(url.searchParams.get('account_sdk_source_info')).toBe(expected);
  expect(info).toEqual(JSON.parse(plain));
});
