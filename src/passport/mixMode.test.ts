import { readFileSync } from 'fs';
import { join } from 'path';
import {
  mixModeEncode,
  mixModeEncodeMobile,
  mixModeEncodeSendCodeType,
  normalizePassportMobile,
} from './mixMode.js';

interface MixModeVector {
  plain: string;
  encoded: string;
  field?: string;
}

describe('mixModeEncode', () => {
  const vectors = JSON.parse(
    readFileSync(
      join(process.cwd(), 'fixtures/captured/login/mix_mode.vectors.json'),
      'utf8',
    ),
  ) as { vectors: MixModeVector[] };

  it.each(vectors.vectors)('encodes $field plain', ({ plain, encoded }) => {
    expect(mixModeEncode(plain)).toBe(encoded);
  });

  it.each([
    ['A中é', '44e1bda8c6ac'],
    ['a😀b', '6467'],
    ['\ud800A\udfff', '44'],
    ['\u0001😀1', '434'],
    ['\u0005', '0'],
    ['', ''],
  ])('matches Desktop module83848 for %j', (plain, encoded) => {
    expect(mixModeEncode(plain)).toBe(encoded);
  });

  it('encodes mobile via helper', () => {
    expect(mixModeEncodeMobile('13800000000')).toBe(
      '2e3d332534363d3535353535353535',
    );
  });

  it.each([
    '13800000000',
    '8613800000000',
    '+8613800000000',
    '+86 138-0000-0000',
  ])('normalizes %s without duplicating the country code', (mobile) => {
    expect(normalizePassportMobile(mobile)).toBe('+86 13800000000');
    expect(mixModeEncodeMobile(mobile)).toBe('2e3d332534363d3535353535353535');
  });

  it('rejects an empty mobile number', () => {
    expect(() => normalizePassportMobile(' +86 ')).toThrow('手机号不能为空');
  });

  it.each([
    ['+63 9000000000', '+63 9000000000'],
    ['+1 202 000 0000', '+1 2020000000'],
    [' +852\t5000 0000 ', '+852 50000000'],
    ['+63 (900)-000-0000', '+63 9000000000'],
  ])('preserves an explicit international country boundary for %j', (mobile, expected) => {
    expect(normalizePassportMobile(mobile)).toBe(expected);
    expect(mixModeEncodeMobile(mobile)).toBe(mixModeEncode(expected));
  });

  it('does not guess a country boundary in a compact foreign number', () => {
    expect(normalizePassportMobile('+639000000000')).toBe('+639000000000');
  });

  it.each(['+63 abc', '+63 900+000', '+63 ( )'])('rejects malformed separated input %j', mobile => {
    expect(() => normalizePassportMobile(mobile)).toThrow(/手机号/);
  });

  it('encodes send_code type 24 as 3731', () => {
    expect(mixModeEncodeSendCodeType()).toBe('3731');
  });
});
