import { buildFrontierWsUrl, computeAccessKey, IM_WS_CONFIG } from './credentials.js';

describe('Desktop Frontier credentials', () => {
  it('uses the native Douyin Chat 1.2.1 profile without token parameters', () => {
    const url = new URL(buildFrontierWsUrl({ deviceId: '3240130901' }));

    expect(url.origin).toBe('wss://frontier100-normal.zijieapi.com');
    expect(url.pathname).toBe('/ws/v2');
    expect(url.searchParams.get('aid')).toBe('339757');
    expect(url.searchParams.get('fpid')).toBe('89');
    expect(url.searchParams.get('device_id')).toBe('3240130901');
    expect(url.searchParams.get('app_name')).toBe('aweme_im_desktop');
    expect(url.searchParams.get('version_code')).toBe('1.2.1');
    expect(url.searchParams.get('xsack')).toBe('1');
    expect(url.searchParams.get('xaack')).toBe('1');
    expect(url.searchParams.get('xsqos')).toBe('1');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.has('ts_sign')).toBe(false);
    expect(url.searchParams.has('sdk_cert')).toBe(false);
    expect(IM_WS_CONFIG.wsProtocols).toEqual(['pbbp2']);
    expect(IM_WS_CONFIG.service).toBe(1);
    expect(IM_WS_CONFIG.method).toBe(1);
  });

  it('uses the access-key algorithm embedded by the desktop renderer Frontier client', () => {
    expect(computeAccessKey(89, 'e0f82475ab9dbf5717d18b4a9c0d7fd0', '3240130901'))
      .toBe('48f5c0a800f9dc1717b51b7388c4ba43');
  });
});
