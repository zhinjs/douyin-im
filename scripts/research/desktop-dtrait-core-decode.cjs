// Pinned core data decoder. Never evals JavaScript or executes VM instructions.
const fs = require('node:fs'), zlib = require('node:zlib'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const HASH = '9aced1ed5ef083c59fb1d1e6937d2bb8767fce677415ddc8fabc299ad6502665';
function decode(path) {
  const source = fs.readFileSync(path, 'utf8'); assert.equal(crypto.createHash('sha256').update(source).digest('hex'), HASH);
  const start = source.indexOf('UEsCAP8w'), end = source.indexOf('")', start), raw = Buffer.from(source.slice(start, end), 'base64');
  const seed = [...raw.subarray(4, 8)].reduce((a, b) => a + b, 0) % 256;
  const data = zlib.inflateRawSync(Uint8Array.from(raw.subarray(8), (value, index) => value ^ ((seed + seed % 10 * index) % 256)));
  let cursor = 0;
  const byte = () => { if (cursor >= data.length) throw Error('truncated VM data'); return data[cursor++]; };
  function integer() {
    let value = 0, shift = 0, item;
    do { item = byte(); value |= (item & 127) << shift; shift += 7; } while (item & 128);
    return shift < 32 && (item & 64) ? value | (-1 << shift) : value;
  }
  function string() {
    let codepoint = -1; const points = [];
    for (;;) {
      const item = byte();
      if (item >= 128 && item < 192) codepoint = (codepoint << 6) + (item & 63);
      else { if (codepoint >= 0) points.push(codepoint); if (item < 128) codepoint = item; else if (item < 224) codepoint = item & 31; else if (item < 240) codepoint = item & 15; else if (item < 248) codepoint = item & 7; else break; }
    }
    return String.fromCodePoint(...points);
  }
  const strings = Array.from({ length: integer() }, string);
  const functions = Array.from({ length: integer() }, () => {
    const offset = cursor, argc = integer(), strict = Boolean(integer());
    const trys = Array.from({ length: integer() }, () => Array.from({ length: 4 }, integer));
    const code = Array.from({ length: integer() }, integer); return { offset, argc, strict, trys, code };
  });
  assert.equal(cursor, data.length); assert.equal(strings.length, 796); assert.equal(functions.length, 366);
  const one = new Set([2,6,7,10,13,17,21,23,25,26,30,32,34,37,39,40,41,42,43,48,54,59,60,69,71,73]), two = new Set([12,46,75]);
  const stringOps = new Set([10,13,25,30,32,37,39,48,54,59,69,73]);
  function disassemble(id) {
    if (!Number.isInteger(id) || !functions[id]) throw Error('invalid function id');
    const code = functions[id].code, result = [];
    for (let pc = 0; pc < code.length;) { const at = pc, op = code[pc++], count = two.has(op) ? 2 : one.has(op) ? 1 : 0, args = code.slice(pc, pc + count); pc += count; result.push({ at, op, args, ...(stringOps.has(op) ? { text: strings[args[0]] } : {}) }); }
    return result;
  }
  return { source, data, strings, functions, disassemble };
}
module.exports = { decode, HASH };
if (require.main === module) {
  const result = decode(process.argv[2]), ids = process.argv.slice(3).map(Number);
  console.log(JSON.stringify(ids.length ? ids.map(id => ({ id, ...result.functions[id], ops: result.disassemble(id) })) : { hash: HASH, inflatedBytes: result.data.length, strings: result.strings.length, functions: result.functions.length, remaining: 0 }, null, 2));
}
