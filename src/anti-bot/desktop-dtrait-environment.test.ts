import {
  createDesktopDTraitEnvironmentCollector,
  type DesktopDTraitEnvironmentContext,
} from './desktop-dtrait-environment.js';

function fixture() {
  const hash = jest.fn((value: unknown): number => {
    void value;
    return hash.mock.calls.length;
  });
  const resolvedOptions = jest
    .fn()
    .mockReturnValueOnce({ locale: 'locale-first', timeZone: 'ignore' })
    .mockReturnValueOnce({ locale: 'ignore', timeZone: 'zone-second' });
  const DateTimeFormat = jest.fn(() => ({ resolvedOptions }));
  const context: DesktopDTraitEnvironmentContext = {
    navigator: {
      connection: { downlink: 5, effectiveType: '4g' },
      language: 'zh',
      languages: ['zh', 'en'],
      vendor: 'Test',
      userAgent: 'Test/1',
      maxTouchPoints: '2.9',
      deviceMemory: 8,
      hardwareConcurrency: 12,
      plugins: [{ name: 'First' }, null, { name: 'Second' }],
      mimeTypes: [{ type: 'a/b' }],
    },
    window: {
      Intl: { DateTimeFormat },
      Notification: { permission: 'default' },
      devicePixelRatio: 2,
    },
    screen: {
      availHeight: 900,
      availLeft: -100,
      availTop: 20,
      availWidth: 1400,
      height: 1000,
      width: 1500,
      colorDepth: 24,
      pixelDepth: 30,
    },
    hash,
    parseInt: jest.fn(parseInt),
    onDiagnostic: jest.fn(),
  };
  return {
    context,
    hash,
    DateTimeFormat,
    resolvedOptions,
    collect: createDesktopDTraitEnvironmentCollector(context),
  };
}

describe('Desktop DTrait string environment', () => {
  it('preserves all eleven hash inputs, output order and independent Intl calls', () => {
    const f = fixture();
    expect(f.collect()).toEqual({
      str_14: 1,
      str_15: 2,
      str_16: 3,
      str_18: 4,
      str_19: 5,
      str_29: 6,
      str_27: 7,
      str_28: 8,
      str_30: 9,
      str_31: 10,
      str_32: 11,
    });
    expect(f.hash.mock.calls.map(([value]) => value)).toEqual([
      '5,4g',
      'zh,zh,en',
      'a/b,Test',
      'First,Second',
      'Test/1',
      '2,8,12,2.9',
      'locale-first+zone-second',
      'default',
      '900,-100,20,1400',
      '1000,1500',
      '24,30,2',
    ]);
    expect(f.DateTimeFormat).toHaveBeenCalledTimes(2);
    expect(f.context.parseInt).toHaveBeenCalledWith('2.9', 10);
  });

  it('does not treat native-like array collections as actual arrays', () => {
    const f = fixture();
    f.context.navigator.plugins = { 0: { name: 'ignored' }, length: 1 };
    f.context.navigator.mimeTypes = { 0: { type: 'ignored' }, length: 1 };
    f.collect();
    expect(f.hash.mock.calls[2]).toEqual([',Test']);
    expect(f.hash.mock.calls[3]).toEqual(['']);
  });

  it('preserves undefined string coercion and direct undefined notification hash', () => {
    const f = fixture();
    delete f.context.navigator.connection;
    delete f.context.navigator.languages;
    delete f.context.window.Intl;
    delete f.context.window.Notification;
    f.collect();
    expect(f.hash.mock.calls[0]).toEqual(['undefined,undefined']);
    expect(f.hash.mock.calls[1]).toEqual(['zh,undefined']);
    expect(f.hash.mock.calls[6]).toEqual(['undefined+undefined']);
    expect(f.hash.mock.calls[7]).toEqual([undefined]);
  });

  it('uses msMaxTouchPoints without parseInt only when maxTouchPoints is undefined', () => {
    const f = fixture();
    delete f.context.navigator.maxTouchPoints;
    f.context.navigator.msMaxTouchPoints = '7.5';
    f.collect();
    expect(f.hash.mock.calls[5]).toEqual(['7.5,8,12,undefined']);
    expect(f.context.parseInt).not.toHaveBeenCalled();
  });

  it('parses null maxTouchPoints as NaN rather than using the legacy value', () => {
    const f = fixture();
    f.context.navigator.maxTouchPoints = null;
    f.context.navigator.msMaxTouchPoints = 8;
    f.collect();
    expect(f.hash.mock.calls[5]).toEqual(['NaN,8,12,null']);
  });

  it('abandons prior hashes and replaces every field after a later getter error', () => {
    const f = fixture();
    Object.defineProperty(f.context.screen, 'width', {
      get() {
        throw Error('private-data');
      },
    });
    const result = f.collect();
    expect(f.hash).toHaveBeenCalledTimes(20);
    expect(f.hash.mock.calls.slice(9)).toEqual(
      Array.from({ length: 11 }, () => [''])
    );
    expect(result.str_14).toBe(10);
    expect(f.context.onDiagnostic).toHaveBeenCalledWith('str');
  });

  it('propagates fallback hash failures instead of recursively retrying', () => {
    const f = fixture();
    f.hash.mockImplementation(() => {
      throw Error('hash');
    });
    expect(f.collect).toThrow('hash');
    expect(f.hash).toHaveBeenCalledTimes(2);
    expect(f.context.onDiagnostic).toHaveBeenCalledTimes(1);
  });

  it('re-reads realm values on the next collection', () => {
    const f = fixture();
    f.collect();
    f.context.navigator.userAgent = 'Changed/2';
    f.collect();
    expect(f.hash.mock.calls[15]).toEqual(['Changed/2']);
  });
});
