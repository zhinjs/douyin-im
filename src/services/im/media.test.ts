import { createCipheriv } from 'crypto';
import { decryptCencSample, decryptImage, sniffImageFormat } from './media.js';

describe('IM media crypto', () => {
  it('decrypts the image GCM container', () => {
    const key = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(12, 3);
    const plain = Buffer.from('image-content');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    expect(decryptImage(encrypted, key.toString('hex'))).toEqual(plain);
  });

  it('uses one CTR stream across protected subsamples', () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const iv = Buffer.alloc(8, 1);
    const plain = Buffer.from('AAsecretBBhiddenCC');
    const protectedPlain = Buffer.concat([plain.subarray(2, 8), plain.subarray(10, 16)]);
    const cipher = createCipheriv('aes-128-ctr', key, Buffer.concat([iv, Buffer.alloc(8)]));
    const protectedEncrypted = Buffer.concat([cipher.update(protectedPlain), cipher.final()]);
    const encrypted = Buffer.concat([
      plain.subarray(0, 2), protectedEncrypted.subarray(0, 6),
      plain.subarray(8, 10), protectedEncrypted.subarray(6), plain.subarray(16),
    ]);
    expect(decryptCencSample(encrypted, key, iv, [
      { clear: 2, protected: 6 },
      { clear: 2, protected: 6 },
    ])).toEqual(plain);
  });

  it('sniffs common decrypted image formats', () => {
    expect(sniffImageFormat(Buffer.from([0xff, 0xd8]))).toBe('jpeg');
    expect(sniffImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .toBe('png');
    expect(sniffImageFormat(Buffer.from('GIF89a'))).toBe('gif');
    expect(sniffImageFormat(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmp42')]))).toBe('unknown');
  });
});
