import { decodeWire, decodeWireTree } from './wire.js';

describe('schema-free protobuf decoder', () => {
  it('decodes bigint varints, JSON and nested messages without losing precision', () => {
    const data = Buffer.from([
      0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
      0x12, 0x07, ...Buffer.from('{"a":1}'),
      0x1a, 0x02, 0x08, 0x2a,
    ]);
    const fields = decodeWire(data);
    expect(fields[0]).toEqual({ field: 1, type: 'varint', value: 0x7fffffffffffffffn });
    expect(fields[1]).toEqual({ field: 2, type: 'string', value: '{"a":1}' });
    expect(fields[2]).toEqual({
      field: 3,
      type: 'message',
      value: [{ field: 1, type: 'varint', value: 42n }],
    });
    expect(decodeWireTree(data)[0]?.v).toBe('9223372036854775807');
  });

  it('returns complete fields before a truncated tail', () => {
    expect(decodeWire(Buffer.from([0x08, 0x01, 0x12, 0x05, 0x61]))).toEqual([
      { field: 1, type: 'varint', value: 1n },
    ]);
  });
});
