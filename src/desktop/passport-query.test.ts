import { randomBizTraceId, signPassportQuery } from './passport-query.js';
import { buildPassportSignQs } from '../passport/signQs.js';
import { generateABogus, generateDesktopABogus } from '../anti-bot/aBogus.js';

describe('Desktop normal Passport query serialization', () => {
  const desktopState = {
    aid: 339757, pageId: 23420, environmentMask: 129, behaviorMask: 14, flag: 3 as const,
    fingerprint: '1707|1019|1707|1067|0|0|0|0|1707|1019|1707|1067|0|0|24|24|MacIntel',
    nowMs: 1789214400000, inkMs: 1789214399999, random: () => 0,
  };
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('matches the original trace constructor vector rather than a random token truncation', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-12T01:23:45Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(randomBizTraceId()).toBe('8ec96339');
  });

  it('uses the source monotonic-clock fallback when the wall clock is not positive', () => {
    jest.useFakeTimers().setSystemTime(0);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    jest.spyOn(performance, 'now').mockReturnValue(1);
    expect(randomBizTraceId()).toBe('8e300000');
  });
  it.each([
    [':$,[]', ':$,[]'],
    ['a b+c', 'a+b%2Bc'],
    ["!'()~*", "!'()~*"],
    ['&=/#?%', '%26%3D%2F%23%3F%25'],
    ['中文', '%E4%B8%AD%E6%96%87'],
    ['file%3A%2F%2F', 'file%253A%252F%252F'],
  ])('encodes the Axios query value %s', (value, wire) => {
    const signed = signPassportQuery({ value }, {}, { enableABogus: false });
    expect(signed.search.split('&')[0]).toBe(`value=${wire}`);
    expect(new URLSearchParams(signed.search).get('value')).toBe(value);
  });

  it('preserves insertion order on wire while sorting only the sign input', () => {
    const input = { z: 'last', 'a b[]': 'first', middle: 'two words' };
    const result = signPassportQuery(input, {}, { enableABogus: false });
    expect(result.search.startsWith('z=last&a+b[]=first&middle=two+words&sign=')).toBe(true);
    expect(result.query).toMatchObject(buildPassportSignQs({ query: input }));
    expect(input).toEqual({ z: 'last', 'a b[]': 'first', middle: 'two words' });
  });

  it('appends token and a manual signature without changing their decoded values', () => {
    const result = signPassportQuery({ next: 'https://example.invalid/a' }, {}, {
      msToken: 'a+b/c==', aBogus: '!$(),[] +/=',
    });
    expect(result.search).toContain('next=https:%2F%2Fexample.invalid%2Fa&');
    expect(result.search.endsWith('&msToken=a%2Bb%2Fc%3D%3D&a_bogus=!$(),[]+%2B%2F%3D')).toBe(true);
    expect(new URLSearchParams(result.search).get('a_bogus')).toBe('!$(),[] +/=');
  });

  it('reserializes Axios query through the BDMS URLSearchParams hook before signing and sending', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-12T00:00:00Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0.25);
    const result = signPassportQuery({ next: 'https://example.invalid/a b', punctuation: ':$,[]~!()' }, {}, {
      userAgent: 'offline fixture', msToken: 'fixture',
    });
    const unsignedWire = result.search.slice(0, result.search.lastIndexOf('&a_bogus='));
    expect(result.query['a_bogus']).toBe(generateABogus({
      userAgent: 'offline fixture', query: new URLSearchParams(unsignedWire).toString(), body: '',
    }));
    expect(result.search).toBe(new URLSearchParams(result.query).toString());
    expect(result.search).toContain('punctuation=%3A%24%2C%5B%5D%7E%21%28%29&');
    // Verifies the source-proven hook serialization; the current signer algorithm is separate.
  });

  it('applies hook query serialization to the account default signer', () => {
    const result = signPassportQuery({ next: 'file:///?x=[a]~', space: 'a b+c' }, {}, {
      userAgent: 'offline fixture', aBogusVariant: 'jumpbyte-desktop',
      msToken: 'fixture+/=', bodyWire: 'text=a%20b%2Bc',
    });
    expect(result.search).toBe(new URLSearchParams(result.query).toString());
    expect(result.search).toContain('next=file%3A%2F%2F%2F%3Fx%3D%5Ba%5D%7E&space=a+b%2Bc&');
    expect(new URLSearchParams(result.search).get('msToken')).toBe('fixture+/=');
  });

  it('uses the source-version core with explicit state and exact wire body', () => {
    const bodyWire = 'text=a%20b%2Bc&emoji=%F0%9F%98%80';
    const result = signPassportQuery({ next: 'file:///?x=[a]~' }, {}, {
      userAgent: 'offline fixture', msToken: 'fixture+/=', bodyWire,
      aBogusVariant: 'jumpbyte-desktop', desktopBdmsState: desktopState,
    });
    const unsigned = new URLSearchParams(result.search);
    unsigned.delete('a_bogus');
    expect(result.query['a_bogus']).toBe(generateDesktopABogus({
      ...desktopState, query: unsigned.toString(), body: bodyWire, userAgent: 'offline fixture',
    }));
    expect(result.search).toBe(new URLSearchParams(result.query).toString());
  });

  it('does not fall back to a different signer when explicit Desktop state is invalid', () => {
    expect(() => signPassportQuery({}, {}, {
      userAgent: 'offline fixture', aBogusVariant: 'jumpbyte-desktop',
      desktopBdmsState: { ...desktopState, environmentMask: NaN },
    })).toThrow(RangeError);
  });

  it('keeps explicit manual override and disabled-signing semantics with Desktop state', () => {
    const extras = { userAgent: 'offline fixture', desktopBdmsState: { ...desktopState, nowMs: NaN } };
    expect(signPassportQuery({}, {}, { ...extras, aBogus: 'manual' }).query['a_bogus']).toBe('manual');
    expect(signPassportQuery({}, {}, { ...extras, enableABogus: false }).query['a_bogus']).toBeUndefined();
  });
});
