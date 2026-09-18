import { buildDesktopFingerprint, type DesktopFingerprintContext } from './desktop-fingerprint.js';

function context(): DesktopFingerprintContext {
  return {
    window: { innerWidth: 1707, innerHeight: 1019, outerWidth: 1707, outerHeight: 1067,
      screenX: 0, screenY: 0, pageYOffset: 0,
      screen: { availWidth: 1707, availHeight: 1019, width: 1707, height: 1067, colorDepth: 24, pixelDepth: 24 } },
    document: { body: { clientWidth: 0, clientHeight: 0 } }, navigator: { platform: 'MacIntel' },
  };
}

describe('Desktop BDMS .7 window fingerprint', () => {
  it('preserves the 17 source fields in insertion order', () => {
    expect(buildDesktopFingerprint(context())).toBe('1707|1019|1707|1067|0|0|0|0|1707|1019|1707|1067|0|0|24|24|MacIntel');
  });

  it('reads pageYOffset for both offset fields, as the source does', () => {
    const input = context();
    const window = { ...input.window, pageXOffset: 999, pageYOffset: 12 };
    expect(buildDesktopFingerprint({ ...input, window }).split('|').slice(6, 8)).toEqual(['12', '12']);
  });

  it('applies signed ToInt32 to every numeric field, including color depth', () => {
    const input: DesktopFingerprintContext = {
      window: { innerWidth: 4294967297.9, innerHeight: -2.9, outerWidth: Infinity, outerHeight: NaN,
        screenX: 2147483648, screenY: -4294967297.9, pageYOffset: -0,
        screen: { availWidth: 1.9, availHeight: -1.9, width: 4294967295, height: 4294967296, colorDepth: 24.9, pixelDepth: -1.9 } },
      document: { body: { clientWidth: 2147483648, clientHeight: undefined } }, navigator: { platform: '测试😀' },
    };
    expect(buildDesktopFingerprint(input)).toBe('1|-2|0|0|-2147483648|-1|0|0|1|-1|-1|0|-2147483648|0|24|-1|测试😀');
  });

  it.each([undefined, null])('uses -1 dimensions when body is %s', body => {
    expect(buildDesktopFingerprint({ ...context(), document: { body } }).split('|').slice(12, 14)).toEqual(['-1', '-1']);
  });

  it('uses zero for absent dimensions when body exists', () => {
    expect(buildDesktopFingerprint({ window: { screen: {} }, document: { body: {} }, navigator: {} }))
      .toBe('0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|undefined');
  });

  it('does not cache values across signatures', () => {
    let y = 1;
    const input = context();
    const window = { ...input.window, get pageYOffset() { return y++; } };
    expect(buildDesktopFingerprint({ ...input, window }).split('|').slice(6, 8)).toEqual(['1', '2']);
    expect(buildDesktopFingerprint({ ...input, window }).split('|').slice(6, 8)).toEqual(['3', '4']);
  });
});
