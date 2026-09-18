import { generateDesktopABogus, type DesktopABogusOptions } from './aBogus.js';

// Unchanged Desktop BDMS 1.0.1.7, SHA d99cb66e29ff84dabfb64179512c09dd2ec27987c41733c133b160816a0d860e.
// These states describe the isolated fixture, not a default Electron environment.
const fixture: DesktopABogusOptions = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) douyinim/1.2.1 Chrome/130.0.6723.58 Electron/33.2.0-rs.21.release.main.1 Safari/537.36',
  query: 'aid=339757&fixture=one', body: '',
  aid: 339757, pageId: 23420, environmentMask: 129, behaviorMask: 14, flag: 3,
  fingerprint: '1707|1019|1707|1067|0|0|0|0|1707|1019|1707|1067|0|0|24|24|MacIntel',
  nowMs: 1789214400000, inkMs: 1789214399999, random: () => 0,
};

describe('Desktop BDMS 1.0.1.7 core', () => {
  it.each([
    ['', 'DfmhQDgDDDDkDD6d5v2LfY3q4op3YDL/0GetFDhV5VvZcg39HMYD9exoDx46mHjjFs/jIeLjy4hbTrOgrQAj0pjUHWUxWnQ2mg62Kl5Q5xSSs1feeLDmnGJx-ktIFee05v/3EcvBokKaSYT0AIee-wHvyhnFwo8sNipD'],
    ['token=offline-token', 'DfmhQDgDDDDkDD6d5v2LfY3q4optYDL/0GetFDhV55zZcg39HMYD9exoDx46mHjjFs/jIeLjy4hbTrOgrQAj0pjUHWUxWnQ2mg62Kl5Q5xSSs1feeLDmnGJx-ktIFee05v/3EcvBokKaSYT0AIee-wHvyhnFwo8sNiki'],
  ])('matches the actual original XHR signature for body %s', (body, expected) => {
    expect(generateDesktopABogus({ ...fixture, body })).toBe(expected);
  });

  it('consumes exactly three random values and matches the original fixed-half vector', () => {
    let calls = 0;
    expect(generateDesktopABogus({ ...fixture, random: () => { calls++; return 0.5; } })).toBe(
      'xfmZ/RLDDi2sDDW35v2LfY3q4op3YDL/0GetFDhV5VvZcg39HMYD9exoDx46mHjjFs/jIeLjy4hbTrOgrQAj0pjUHWUxWnQ2mg62Kl5Q5xSSs1feeLDmnGJx-ktIFee05v/3EcvBokKaSYT0AIee-wHvyhnFwo8sNipD',
    );
    expect(calls).toBe(3);
  });

  it('preserves the source UTF-16 UA and fingerprint byte paths', () => {
    expect(generateDesktopABogus({ ...fixture,
      userAgent: fixture.userAgent + ' 测试😀',
      fingerprint: fixture.fingerprint + '测试😀',
      nowMs: 1700000000123, inkMs: 1700000000122,
    })).toBe('DfmhQDgDDDDkDD6d56KLfY3q4op3Y8CI0GetFDhV5VVWqL39HMTa9exoIBG6XFLjwG/-Iegjy4hbTrOgrQAj0pjUHWUxWnQ2mg62Kl5Q5xSSs1feeLDmnGJx-ktIFee05v/3EcvBokKaSYT0AIee-wHvyhnFwo8sNiDuyzzlSInLaCS=');
  });

  it.each(['query', 'body'] as const)('rejects unpaired surrogate in %s like source SM3 conversion', field => {
    expect(() => generateDesktopABogus({ ...fixture, [field]: '\ud800' })).toThrow(URIError);
  });

  it.each(['aid', 'pageId', 'environmentMask', 'behaviorMask', 'nowMs', 'inkMs'] as const)(
    'does not invent a default for invalid %s', field => {
      expect(() => generateDesktopABogus({ ...fixture, [field]: NaN })).toThrow(RangeError);
    },
  );

  it.each([-0.1, 1, NaN, Infinity])('rejects invalid random source output %s', value => {
    expect(() => generateDesktopABogus({ ...fixture, random: () => value })).toThrow(RangeError);
  });

  it.each(['query', 'body', 'userAgent', 'fingerprint'] as const)('rejects missing JS caller input %s', field => {
    expect(() => Reflect.apply(generateDesktopABogus, undefined, [{ ...fixture, [field]: undefined }])).toThrow(TypeError);
  });

  it('rejects an unknown descriptor flag rather than manufacturing state', () => {
    expect(() => Reflect.apply(generateDesktopABogus, undefined, [{ ...fixture, flag: 0 }])).toThrow(RangeError);
  });

  it('rejects a fingerprint that cannot fit its declared length field', () => {
    expect(() => generateDesktopABogus({ ...fixture, fingerprint: 'x'.repeat(65536) })).toThrow(RangeError);
  });

  it('does not mutate caller state', () => {
    const options = Object.freeze({ ...fixture });
    expect(generateDesktopABogus(options)).toBe(generateDesktopABogus(options));
  });
});
