import type { webcrypto } from 'node:crypto';

export interface DesktopWebSecurePemPair { publicPem: string; privatePem: string }
export interface DesktopWebSecureSignature { hex: string; buffer: ArrayBuffer }
// C860 I is module/realm scoped, contains only successful public-key extraction results.
const publicKeys = new Map<string, { hex: string; rawHex: string }>();

/** C860 J: system WebCrypto provider. No account storage, certificate issuance or fallback loader. */
export class DesktopWebSecureSystemCrypto {
  constructor(private readonly subtle: webcrypto.SubtleCrypto = globalThis.crypto.subtle) {}

  generateNewKeyPairPEM = (): Promise<DesktopWebSecurePemPair> => this.run('generateNewKeyPairPEM', async () => {
    const pair = await this.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const privatePem = pem(await this.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY');
    const publicPem = pem(await this.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY');
    return { publicPem, privatePem };
  });

  /** M returns ASN.1 DER, not WebCrypto's 64-byte P1363 signature. */
  signWithECDSA = (privatePem: string, text: string): Promise<DesktopWebSecureSignature> => this.run('signWithECDSA', async () => {
    const key = await this.subtle.importKey('pkcs8', unpem(privatePem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const raw = await this.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(text));
    const buffer = desktopWebSecureSignatureDer(raw);
    return { hex: hex(buffer), buffer };
  });

  /** V consumes raw P1363. Intentionally not the rr.verify() => true placeholder. */
  verifyWithECDSA = (publicPem: string, rawSignature: Uint8Array, text: string): Promise<boolean> => this.run('verifyWithECDSA', async () => {
    const key = await this.subtle.importKey('spki', unpem(publicPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return this.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSignature, new TextEncoder().encode(text));
  });

  /** SDK diagnostic, not rr's constant-true verifier. No storage changes or certificate claims. */
  async validateKeyPair(privatePem: string, publicPem: string): Promise<boolean> {
    try {
      const privateKey = await this.subtle.importKey('pkcs8', unpem(privatePem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const publicKey = await this.subtle.importKey('spki', unpem(publicPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const challenge = new TextEncoder().encode('douyin-im:web-secure:key-pair-check');
      const signature = await this.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, challenge);
      return await this.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, challenge);
    } catch { return false; }
  }

  /** rr uses module71312 HMAC, including its nonstandard handling of unpaired UTF-16 surrogates. */
  async hmacSha256(key: Uint8Array, text: string): Promise<string> {
    // HMAC pads an empty key to an all-zero block; WebCrypto rejects a zero-bit imported key.
    const imported = await this.subtle.importKey('raw', key.length ? key : new Uint8Array(64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = new Uint8Array(await this.subtle.sign('HMAC', imported, legacySha256Text(text)));
    return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  }

  extractPublicKeyHexFromPem = (publicPem: string): Promise<{ hex: string; rawHex: string }> => this.run('extractPublicKeyHexFromPem', async () => {
    const cached = publicKeys.get(publicPem); if (cached) return cached;
    const key = await this.subtle.importKey('spki', unpem(publicPem), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const buffer = await this.subtle.exportKey('spki', key), result = { hex: hex(buffer), rawHex: rawPublicHex(buffer) };
    publicKeys.set(publicPem, result); return result;
  });

  extractPublicKeyFromPrivateKey = (privatePem: string): Promise<DesktopWebSecureSignature & { rawHex: string }> => this.run('extractPublicKeyFromPrivateKey', async () => {
    const key = await this.subtle.importKey('pkcs8', unpem(privatePem), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await this.subtle.exportKey('jwk', key);
    const publicKey = await this.subtle.importKey('jwk', { kty: 'EC', crv: jwk.crv!, x: jwk.x!, y: jwk.y! }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const buffer = await this.subtle.exportKey('spki', publicKey);
    return { hex: hex(buffer), rawHex: rawPublicHex(buffer), buffer };
  });

  extractPrivateKeyHexFromPem = (privatePem: string): Promise<{ privateKeyHex: string; privateKeyPKCSHex: string }> => this.run('extractPrivateKeyHexFromPem', async () => {
    const key = await this.subtle.importKey('pkcs8', unpem(privatePem), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const buffer = await this.subtle.exportKey('pkcs8', key), outer = children(new Uint8Array(buffer));
    const inner = children(value(required(outer, 2, 4))), scalar = required(inner, 1, 4);
    return { privateKeyHex: hex(value(scalar)), privateKeyPKCSHex: hex(buffer) };
  });

  /** O extracts SPKI from TBSCertificate child 6 (v3); does NOT verify certificate trust/signature. */
  extractPublicKeyFromX509Cert = (certificatePem: string): Promise<Uint8Array> => this.run('extractPublicKeyFromX509Cert', () => this.certificatePublicKey(certificatePem));

  deriveEcdhKey = (privatePem: string, certificatePem: string): Promise<{ hex: string; bytes: Uint8Array }> => this.run('deriveEcdhKey', async () => {
    const privateKey = await this.subtle.importKey('pkcs8', unpem(privatePem), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const spki = await this.certificatePublicKey(certificatePem);
    const publicKey = await this.subtle.importKey('spki', spki, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await this.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const hkdfKey = await this.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const bytes = new Uint8Array(await this.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new Uint8Array() }, hkdfKey, 256));
    return { hex: hex(bytes), bytes };
  });

  private async certificatePublicKey(certificatePem: string): Promise<Uint8Array> {
    const outer = children(unpem(certificatePem)), tbs = required(outer, 0, 0x30);
    const spki = required(children(tbs.bytes.slice(tbs.start, tbs.end)), 6, 0x30);
    const key = await this.subtle.importKey('spki', spki.bytes.slice(spki.start, spki.end), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    return new Uint8Array(await this.subtle.exportKey('spki', key));
  }

  private async run<T>(name: string, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      const original = error as Error, wrapped = new Error(`[Func ${name}]${original.message}`);
      if (original.stack) wrapped.stack = original.stack; throw wrapped;
    }
  }
}

/** T's integer normalization, limited explicitly to the P-256 provider's 64-byte result. */
export function desktopWebSecureSignatureDer(raw: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(raw);
  if (bytes.length !== 64) throw new Error('Expected a 64-byte P-256 P1363 signature');
  const integer = (part: Uint8Array): number[] => {
    let start = 0; while (start < part.length && part[start] === 0) start++;
    const value = start === part.length ? [0] : Array.from(part.slice(start));
    if (value[0]! & 0x80) value.unshift(0);
    return [2, value.length, ...value];
  };
  const encoded = [...integer(bytes.slice(0, 32)), ...integer(bytes.slice(32))];
  return Uint8Array.from([0x30, encoded.length, ...encoded]).buffer;
}

function hex(buffer: ArrayBuffer | Uint8Array): string {
  return Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}
function pem(buffer: ArrayBuffer, label: string): string {
  return `-----BEGIN ${label}-----\n${btoa(Array.from(new Uint8Array(buffer), byte => String.fromCharCode(byte)).join(''))}\n-----END ${label}-----`;
}
function unpem(text: string): Uint8Array {
  const binary = atob(text.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '')
    .replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '')
    .replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, ''));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

// Bounded DER traversal replaces the source's bundled ASN1HEX dependency, not a general X.509 validator.
interface DerValue { bytes: Uint8Array; tag: number; start: number; content: number; end: number }
function read(bytes: Uint8Array, start: number, limit = bytes.length): DerValue {
  let cursor = start;
  if (cursor + 2 > limit) throw new Error('Truncated DER header');
  const tag = bytes[cursor++]!, first = bytes[cursor++]!;
  let length = first;
  if (first & 128) {
    const count = first & 127;
    if (!count || count > 4 || cursor + count > limit) throw new Error('Invalid DER length');
    length = 0; for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++]!;
  }
  if (cursor + length > limit) throw new Error('Truncated DER value');
  return { bytes, tag, start, content: cursor, end: cursor + length };
}
function children(bytes: Uint8Array): DerValue[] {
  const parent = read(bytes, 0);
  if (parent.tag !== 0x30 || parent.end !== bytes.length) throw new Error('Expected DER sequence');
  const result: DerValue[] = [];
  for (let cursor = parent.content; cursor < parent.end;) { const child = read(bytes, cursor, parent.end); result.push(child); cursor = child.end; }
  return result;
}
function required(values: DerValue[], index: number, tag: number): DerValue {
  const item = values[index]; if (!item || item.tag !== tag) throw new Error('Unexpected DER structure'); return item;
}
function value(item: DerValue): Uint8Array { return item.bytes.slice(item.content, item.end); }
function rawPublicHex(buffer: ArrayBuffer): string {
  const point = value(required(children(new Uint8Array(buffer)), 1, 3));
  if (point[0] !== 0 || point[1] !== 4) throw new Error('Expected uncompressed EC public key');
  return hex(point.slice(1));
}

function legacySha256Text(text: string): Uint8Array {
  if (typeof text !== 'string') throw new Error('input is invalid type');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 63));
    else if (code < 0xd800 || code >= 0xe000) bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
    else {
      code = 0x10000 + (((code & 1023) << 10) | (text.charCodeAt(++i) & 1023));
      bytes.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 63), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
    }
  }
  return Uint8Array.from(bytes);
}
