import { createDecipheriv, webcrypto } from 'node:crypto';
import {
  DesktopDTraitAes,
  DesktopDTraitRsa,
  createDesktopDTraitCryptoUtil,
  installDesktopDTraitCrypto,
  type DesktopDTraitCryptoContext,
  type DesktopDTraitCryptoJS,
} from './desktop-dtrait-crypto.js';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  class Rsa {
    setPublicKey = jest.fn();
    encrypt = jest.fn((): string | false => 'synthetic');
  }
  const loadJS = jest
    .fn<Promise<DesktopDTraitCryptoJS>, []>()
    .mockRejectedValue(Error('no CryptoJS binding'));
  const loadRsa = jest.fn(async () => ({ default: Rsa })),
    background = jest.fn();
  const context: DesktopDTraitCryptoContext = {
    window: {
      crypto: {
        subtle: webcrypto.subtle,
        getRandomValues: value => {
          const bytes = value as Uint8Array;
          for (let i = 0; i < bytes.length; i++) bytes[i] = i;
          return value;
        },
      },
    },
    crypto: webcrypto,
    location: { search: '' },
    Math: { random: () => 0.1 },
    TextEncoder,
    atob,
    btoa,
    loadCryptoJS: loadJS,
    loadJSEncrypt: loadRsa,
    onBackgroundError: background,
  };
  return { context, loadJS, loadRsa, background };
}

it.each(['', 'hello', '中文 🥔', 'a'.repeat(32)])(
  'encrypts %j with real AES-CBC/PKCS7 and prefix IV',
  async text => {
    const f = fixture(),
      aes = new DesktopDTraitAes(f.context),
      hex = '000102030405060708090a0b0c0d0e0f';
    const encrypted = await aes.encryptData(hex, text),
      iv = Buffer.from(encrypted.iv, 'base64'),
      cipher = Buffer.from(encrypted.encryptedData, 'base64');
    expect(Buffer.from(encrypted.cipherText, 'base64')).toEqual(
      Buffer.concat([iv, cipher])
    );
    expect(iv).toEqual(Buffer.from(hex, 'hex'));
    const decipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from(hex, 'hex'),
      iv
    );
    expect(
      Buffer.concat([decipher.update(cipher), decipher.final()]).toString()
    ).toBe(text);
    expect(f.loadJS).not.toHaveBeenCalled();
  }
);

it('random key is bytes, not hex; installer reuses realm objects but isolates other accounts', async () => {
  const f = fixture(),
    target = {},
    a = installDesktopDTraitCrypto(f.context, target),
    b = installDesktopDTraitCrypto(f.context, target),
    c = installDesktopDTraitCrypto(f.context, {});
  expect(a).toBe(b);
  expect(c.aes).not.toBe(a.aes);
  expect(target).toEqual({
    DTraitUcAesEncrypt: a.aes,
    DTraitUcRsaEncrypt: a.rsa,
    DTraitUcCryptoJSUtil: a.util,
  });
  expect(a.aes.getAesKey()).toBeInstanceOf(Uint8Array);
  expect(a.aes.getAesKey()).toHaveLength(16);
  await Promise.all([a.rsa.initPromise, c.rsa.initPromise]);
});

it('retains query semantics: truthy string 0 disables system crypto, empty string does not', async () => {
  const f = fixture();
  f.context.location.search = '?disableSystemCrypto=0';
  const aes = new DesktopDTraitAes(f.context);
  await expect(aes.initPromise).rejects.toThrow('no CryptoJS binding');
  expect(aes.supportSystemCrypto).toBe(false);
  f.context.location.search = '?disableSystemCrypto=';
  const other = new DesktopDTraitAes(f.context);
  expect(other.supportSystemCrypto).toBe(true);
  await other.initPromise;
});

it('utility retains malformed/odd hex parsing, last question-mark query and raw byte strings', () => {
  const u = createDesktopDTraitCryptoUtil(fixture().context);
  expect([...u.hexToUint8Array('0gzzf')]).toEqual([0, 0]);
  expect(() => u.hexToUint8Array('f')).toThrow();
  expect(u.parseQuery('?a=b=c&a=last+value')).toEqual({ a: 'last+value' });
  expect(u.getQuery('https://test/?a=first?a=last#hash')).toEqual({
    a: 'last',
  });
  expect(u.unit8ArrayToString(new Uint8Array([65, 255]))).toBe('Aÿ');
  expect(u.uint8ArrayToHex(new Uint8Array([0, 255]))).toBe('00ff');
  expect(() => u.parseQuery('x=%ZZ')).toThrow(URIError);
});

it('waits for the actual fallback module and preserves WordArray/UTF8/IV invocation shape', async () => {
  const f = fixture();
  delete f.context.window.crypto;
  let finish!: (js: DesktopDTraitCryptoJS) => void;
  f.loadJS.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const aes = new DesktopDTraitAes(f.context),
    encrypted = aes.encryptData('000102030405060708090a0b0c0d0e0f', '中文');
  let done = false;
  void encrypted.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  const create = jest.fn(value => value),
    encrypt = jest.fn(() => ({
      ciphertext: { toString: () => btoa('cipher') },
    }));
  finish({
    lib: { WordArray: { create } },
    AES: { encrypt },
    mode: { CBC: 'cbc' },
    pad: { Pkcs7: 'pkcs7' },
    enc: { Base64: 'base64' },
  });
  const result = await encrypted;
  expect(create.mock.calls.map(([bytes]) => [...bytes])).toEqual([
    Array(16).fill(153),
    Array.from({ length: 16 }, (_, i) => i),
    [...new TextEncoder().encode('中文')],
  ]);
  expect(result.encryptedData).toBe(btoa('cipher'));
  expect(encrypt).toHaveBeenCalledWith(
    expect.any(Uint8Array),
    expect.any(Uint8Array),
    { iv: expect.any(Uint8Array), mode: 'cbc', padding: 'pkcs7' }
  );
});

it('propagates bad AES length and fallback load rejection instead of returning ciphertext', async () => {
  const f = fixture(),
    aes = new DesktopDTraitAes(f.context);
  await expect(aes.encryptData('00', 'text')).rejects.toThrow();
  f.context.location.search = '?disableSystemCrypto=1';
  const fallback = new DesktopDTraitAes(f.context);
  await expect(fallback.encryptData('00', 'text')).rejects.toThrow(
    'no CryptoJS binding'
  );
  await flush();
  expect(f.background).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'no CryptoJS binding' })
  );
});

it.each([false, 'cipher'] as const)(
  'RSA waits for initialization, uses new instance per call, and maps %s',
  async returned => {
    const f = fixture(),
      calls: unknown[][] = [];
    let release!: (module: { default: typeof Cipher }) => void;
    class Cipher {
      constructor() {
        calls.push(['new']);
      }
      setPublicKey(key: string) {
        calls.push(['key', key]);
      }
      encrypt(text: string) {
        calls.push(['text', text]);
        return returned;
      }
    }
    const context = {
      ...f.context,
      loadJSEncrypt: () =>
        new Promise<{ default: typeof Cipher }>(resolve => {
          release = resolve;
        }),
    };
    const rsa = new DesktopDTraitRsa(context),
      result = rsa.encryptData('public', 'message');
    await flush();
    expect(calls).toEqual([]);
    release({ default: Cipher });
    await expect(result).resolves.toBe(returned === false ? '' : returned);
    await rsa.encryptData('second', 'body');
    expect(calls.filter(call => call[0] === 'new')).toHaveLength(2);
  }
);

it('publishes AES before starting RSA initialization as the original module entry does', async () => {
  const f = fixture(),
    target: Record<string, unknown> = {};
  const loader = f.context.loadJSEncrypt;
  f.context.loadJSEncrypt = () => {
    expect(target['DTraitUcAesEncrypt']).toBeInstanceOf(DesktopDTraitAes);
    return loader();
  };
  await installDesktopDTraitCrypto(f.context, target).rsa.initPromise;
});
