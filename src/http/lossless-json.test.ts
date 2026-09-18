import { parseLosslessJson, readJsonInteger } from './lossless-json.js';

describe('lossless integer JSON', () => {
  it('keeps native lexical integer types, duplicate keys, escaped keys and narrowing', () => {
    expect(readJsonInteger('{"id":9007199254740993}', 'id', 64)).toBe(9007199254740993n);
    expect(readJsonInteger('{"id":18446744073709551615}', 'id', 64)).toBe(-1n);
    expect(readJsonInteger('{"id":4294967298}', 'id', 32)).toBe(2n);
    expect(readJsonInteger('{"id":2,"nested":{"id":99},"array":[{"id":12}]}', 'id', 32)).toBe(2n);
    expect(readJsonInteger('{"id":1,"i\\u0064":2}', 'id', 32)).toBe(2n);
    expect(readJsonInteger('{"id":2,"id":false}', 'id', 32)).toBeUndefined();
    expect(readJsonInteger('{"id":2,"id":{"x":1}}', 'id', 32)).toBeUndefined();
    expect(readJsonInteger('{"id":-9223372036854775808}', 'id', 64)).toBe(-9223372036854775808n);
  });
  it.each(['"2"', '2.0', '2e0', 'true', 'null', '[]', '{}', '18446744073709551616', '-9223372036854775809'])('does not coerce a non-native integer token %s', token => {
    expect(readJsonInteger(`{"id":${token}}`, 'id', 64)).toBeUndefined();
  });
  it.each(['{}', '[]', 'null', '2', '{"id":2,}', '{"id":02}', '{"nested":{"id":2}}'])('safely rejects absent or invalid top-level fields %s', text => {
    expect(readJsonInteger(text, 'id', 64)).toBeUndefined();
  });
  it('preserves signed int64 literals while leaving ordinary values and quoted content unchanged', () => {
    expect(parseLosslessJson('{"id":9223372036854775807,"negative":-9223372036854775808,"uids":[9007199254740993,22],"status":0,"flag":false,"text":"escaped \\" 9223372036854775807","null":null}'))
      .toEqual({ id: '9223372036854775807', negative: '-9223372036854775808', uids: ['9007199254740993', 22], status: 0, flag: false, text: 'escaped " 9223372036854775807', null: null });
  });
  it.each(['{"id":01}', '{"id":1e}', '{"id":9223372036854775807,}', 'undefined'])('does not repair invalid JSON %s', text => {
    expect(() => parseLosslessJson(text)).toThrow();
  });
  it('retains floats/exponents, safe boundaries and escaped backslashes', () => {
    const text = JSON.stringify({ text: '\\"12345678901234567890', safe: Number.MAX_SAFE_INTEGER, float: 1.5 });
    expect(parseLosslessJson(text)).toEqual(JSON.parse(text));
    expect(parseLosslessJson('[1e3,-2.5,9007199254740992]')).toEqual([1000, -2.5, '9007199254740992']);
  });
});
