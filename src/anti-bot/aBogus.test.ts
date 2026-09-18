import { generateABogus, generateJumpbyteABogus } from './aBogus.js';

const AB_CHARSET = /^[A-Za-z0-9+/_-]+=*$/;

describe('generateABogus', () => {
  it('produces non-empty url-safe token', () => {
    const token = generateABogus({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      query: 'aid=2906&sign=abc&qs=def&msToken=xyz',
      body: '',
      keyVal: 0,
    });
    expect(token.length).toBeGreaterThan(80);
    expect(token.length).toBeLessThan(400);
    expect(AB_CHARSET.test(token)).toBe(true);
  });

  it('POST body changes output', () => {
    const ua = 'Mozilla/5.0 test';
    const q = 'aid=2906&sign=x&qs=y';
    const a = generateABogus({ userAgent: ua, query: q, body: '' });
    const b = generateABogus({
      userAgent: ua,
      query: q,
      body: 'token=abc&need_logo=false',
    });
    expect(a).not.toBe(b);
  });
});

describe('generateJumpbyteABogus', () => {
  it.each([0, 0x80, 0xff])('preserves secure 64-bit draw conversion for byte %i', byte => {
    const crypto = globalThis.crypto;
    const original = crypto.getRandomValues;
    let calls = 0;
    crypto.getRandomValues = function<T extends Parameters<typeof original>[0]>(array: T): T {
      expect(array).toBeInstanceOf(Uint8Array);
      expect(array!.byteLength).toBe(8);
      new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength).fill(byte); calls++;
      return array;
    };
    try {
      const options = { userAgent: 'fixture', query: 'a=1', nowMs: 10000 };
      const expected = Number(Buffer.alloc(8, byte).readBigUInt64BE() >> 11n) / 0x20000000000000;
      expect(generateJumpbyteABogus(options)).toBe(generateJumpbyteABogus({ ...options, random: () => expected }));
      expect(calls).toBeGreaterThan(0);
    } finally { crypto.getRandomValues = original; }
  });
  it('matches the fixed vector from jumpbyte-bot', () => {
    let seed = 1;
    const random = (): number => {
      seed = (seed * 48271) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    expect(generateJumpbyteABogus({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
      query: 'aid=339757&device_platform=PC',
      nowMs: 1787830000000,
      random,
    })).toBe(
      'DX4Vhe7LmZQbKVFSYCBP9vKU-CjlNsuyCFi/WH/PyOzLLqeYFuNcQnc-jxLWslog' +
      'K8MkwI171nz/bEncpsUspenkFmpDu0sj845VIzmL/Z7sbsJhJrg2CjSxFk4PW/GO8' +
      'QASi27RIsBiIxo5nNCzAdlSq/-rBcbDQ1-GVITSO2ym-SWc27qdYKEXSk3cQTx1sjm=',
    );
  });
});
