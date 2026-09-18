import { createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, sign, verify, webcrypto } from 'node:crypto';
import { DesktopWebSecureSystemCrypto, desktopWebSecureSignatureDer } from './desktop-web-secure-crypto.js';

const provider = () => new DesktopWebSecureSystemCrypto(webcrypto.subtle);
function pair(curve = 'prime256v1') {
  return generateKeyPairSync('ec', { namedCurve: curve, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
}
function sequence(...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts), length = content.length;
  return Buffer.concat([Buffer.from(length < 128 ? [0x30, length] : [0x30, 0x81, length]), content]);
}
/** Deliberately unsigned synthetic v3-shaped container: extraction must not imply trust. */
function cert(publicPem: string): string {
  const spki = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  const tbs = sequence(...Array.from({ length: 6 }, () => Buffer.from([5, 0])), spki);
  return `-----BEGIN CERTIFICATE-----\n${sequence(tbs).toString('base64')}\n-----END CERTIFICATE-----`;
}

it('generates real P-256 PKCS8/SPKI with Desktop single-line PEM bodies and no trailing newline', async () => {
  const api = provider(), generated = await api.generateNewKeyPairPEM();
  expect(generated.privatePem.split('\n')).toHaveLength(3); expect(generated.publicPem.split('\n')).toHaveLength(3);
  expect(createPrivateKey(generated.privatePem).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  const signature = await api.signWithECDSA(generated.privatePem, 'synthetic');
  expect(verify('sha256', Buffer.from('synthetic'), generated.publicPem, Buffer.from(signature.buffer))).toBe(true);
});

it.each(['', 'hello', '关注：synthetic 🔐', '\u0000\ud800'])('returns real DER signature for %j without treating r||s as DER', async text => {
  const keys = pair(), api = provider(), signature = await api.signWithECDSA(keys.privateKey, text);
  expect(signature.hex).toBe(Buffer.from(signature.buffer).toString('hex'));
  expect(Buffer.from(signature.buffer)[0]).toBe(0x30);
  expect(verify('sha256', Buffer.from(text), keys.publicKey, Buffer.from(signature.buffer))).toBe(true);
  expect(verify('sha256', Buffer.from(`${text}changed`), keys.publicKey, Buffer.from(signature.buffer))).toBe(false);
});

it('really verifies P1363, rejects tampered content, and does not silently convert DER', async () => {
  const keys = pair(), api = provider();
  const raw = sign('sha256', Buffer.from('synthetic'), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  expect(await api.verifyWithECDSA(keys.publicKey, raw, 'synthetic')).toBe(true);
  expect(await api.verifyWithECDSA(keys.publicKey, raw, 'changed')).toBe(false);
  const der = await api.signWithECDSA(keys.privateKey, 'synthetic');
  expect(await api.verifyWithECDSA(keys.publicKey, new Uint8Array(der.buffer), 'synthetic')).toBe(false);
  expect(await api.verifyWithECDSA(pair().publicKey, raw, 'synthetic')).toBe(false);
});

it('extracts canonical SPKI, uncompressed point and scalar; caches successful public PEM results by identity', async () => {
  const keys = pair(), api = provider();
  const direct = await api.extractPublicKeyHexFromPem(keys.publicKey), restored = await api.extractPublicKeyFromPrivateKey(keys.privateKey);
  expect(direct).toEqual({ hex: restored.hex, rawHex: restored.rawHex });
  expect(direct.rawHex).toHaveLength(130); expect(direct.rawHex.startsWith('04')).toBe(true);
  expect(await api.extractPublicKeyHexFromPem(keys.publicKey)).toBe(direct);
  expect(await provider().extractPublicKeyHexFromPem(keys.publicKey)).toBe(direct);
  const scalar = await api.extractPrivateKeyHexFromPem(keys.privateKey), jwk = createPrivateKey(keys.privateKey).export({ format: 'jwk' });
  expect(scalar.privateKeyHex).toBe(Buffer.from(jwk.d!, 'base64url').toString('hex'));
  expect(scalar.privateKeyPKCSHex).toBe(createPrivateKey(keys.privateKey).export({ format: 'der', type: 'pkcs8' }).toString('hex'));
});

it('preserves a leading-zero 32-byte private scalar', async () => {
  const privateDer = Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420' + '00'.repeat(31) + '01' + 'a14403420004' +
    '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' + '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5', 'hex');
  const pem = `-----BEGIN PRIVATE KEY-----\n${privateDer.toString('base64')}\n-----END PRIVATE KEY-----`;
  expect((await provider().extractPrivateKeyHexFromPem(pem)).privateKeyHex).toBe('00'.repeat(31) + '01');
});

it('extracts v3-position SPKI without claiming certificate verification', async () => {
  const keys = pair(), api = provider();
  expect(Buffer.from(await api.extractPublicKeyFromX509Cert(cert(keys.publicKey)))).toEqual(createPublicKey(keys.publicKey).export({ format: 'der', type: 'spki' }));
});

it('derives ECDH followed by HKDF SHA256, empty salt/info, exactly 32 bytes', async () => {
  const client = pair(), server = pair(), api = provider();
  const derived = await api.deriveEcdhKey(client.privateKey, cert(server.publicKey));
  const shared = diffieHellman({ privateKey: createPrivateKey(client.privateKey), publicKey: createPublicKey(server.publicKey) });
  expect(Buffer.from(derived.bytes)).toEqual(Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32)));
  expect(derived.hex).toBe(Buffer.from(derived.bytes).toString('hex'));
});

it.each(['not-a-pem', '', pair('secp384r1').privateKey])('rejects unusable private keys rather than reporting ready', async key => {
  await expect(provider().signWithECDSA(key, 'test')).rejects.toThrow('[Func signWithECDSA]');
});

it('rejects malformed and non-v3-position certificate structures with the operation name', async () => {
  const api = provider();
  for (const content of ['MAA=', 'MIH/', 'MIAAAA==', 'MAQCAQA=']) {
    await expect(api.extractPublicKeyFromX509Cert(content)).rejects.toThrow('[Func extractPublicKeyFromX509Cert]');
  }
});

it('encodes DER INTEGER sign padding and redundant-zero removal exactly', () => {
  const input = new Uint8Array(64); input[0] = 0x80; input[63] = 1;
  expect(Buffer.from(desktopWebSecureSignatureDer(input.buffer)).toString('hex')).toBe('302602210080' + '00'.repeat(31) + '020101');
  expect(Buffer.from(desktopWebSecureSignatureDer(new ArrayBuffer(64))).toString('hex')).toBe('3006020100020100');
  expect(() => desktopWebSecureSignatureDer(new ArrayBuffer(63))).toThrow('64-byte');
});

it.each([0, 1, 32, 64, 65, 150])('HMAC accepts %d-byte keys and returns raw digest base64', async size => {
  const key = Uint8Array.from({ length: size }, (_, index) => index & 255), text = 'synthetic 关注 🔐';
  expect(await provider().hmacSha256(key, text)).toBe(createHmac('sha256', key).update(text).digest('base64'));
});

it.each([['\ud800', 'f0908080'], ['\udc00', 'f0908080'], ['\ud800A', 'f0908181']])('HMAC preserves module71312 malformed surrogate encoding %j', async (text, bytes) => {
  const key = new Uint8Array([1, 2, 3]);
  expect(await provider().hmacSha256(key, text!)).toBe(createHmac('sha256', key).update(Buffer.from(bytes!, 'hex')).digest('base64'));
  expect(await provider().hmacSha256(key, text!)).not.toBe(createHmac('sha256', key).update(text!).digest('base64'));
});
