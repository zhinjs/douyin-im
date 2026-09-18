/** Legacy login compatibility template, not measured Desktop/host browserInfo. */
export function desktopLoginBrowserInfo(deviceId: string): Record<string, unknown> {
  return {
    hardwareConcurrency: 8,
    webdriver: false,
    chromedriver: false,
    shelldriver: false,
    plugins: 5,
    permissions: [{ name: 'notifications', state: 'granted' }],
    innerHeight: 484,
    innerWidth: 726,
    outerHeight: 484,
    outerWidth: 726,
    stoargeStatus: {
      indexedDB: {
        idb: 'object', open: 'function', indexedDB: 'object', IDBKeyRange: 'function',
        openDatabase: 'function', isSafari: false, hasFetch: false,
      },
      localStorage: { isSupportLStorage: true, size: 1993, write: true },
      storageQuotaStatus: { usage: 0, quota: 36104626176, isPrivate: false },
    },
    webgl: {
      vendor: 'Google Inc. (Google)',
      renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    },
    notificationPermission: 'granted',
    performance: {
      timeOrigin: 1787813991280.3,
      usedJSHeapSize: 18200000,
      navigationTiming: {
        decodedBodySize: 2527,
        entryType: 'navigation',
        initiatorType: 'navigation',
        name: `file:///renderer/login/index.html?window=login&channel=0&guid=${deviceId}`,
        renderBlockingStatus: 'non-blocking',
      },
    },
    request_host: '',
    request_pathname: '/renderer/login/index.html',
    browser: { t: '7781993187871', bit_protocol: 'false', bit_helper: false },
  };
}
