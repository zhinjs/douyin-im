import { gzipSync } from 'node:zlib';

// Desktop system-device-info 2.0.1 / passport-util logEncrypt v3.
// This is a substitution/rotation format, NOT AES encryption.
const SBOX = Buffer.from('637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16', 'hex');
const KEY = Buffer.from('I+D&*76:j27kVH<us9&d').subarray(0, 16).map((byte) => SBOX[byte]!);

export function encodeDeviceLog(value: string, timestamp = Date.now()): Buffer {
  const gzip = gzipSync(Buffer.from(value), { level: 6, memLevel: 4 });
  gzip.writeUInt32LE(Math.floor(timestamp / 1000), 4);
  gzip[9] = 3;
  const padding = (16 - gzip.length % 16) % 16;
  const input = Buffer.concat([gzip, Buffer.alloc(padding, padding)]);
  const output = Buffer.alloc(6 + input.length);
  output.set([0x74, 0x63, 3, padding, 0, 3]);
  for (let base = 0; base < input.length; base += 16) {
    for (let word = 0; word < 4; word++) {
      for (let byte = 0; byte < 4; byte++) {
        const index = word * 4 + byte;
        output[6 + base + index] = SBOX[input[base + word * 4 + (byte + word) % 4]!]! ^ KEY[index]!;
      }
    }
  }
  return output;
}
