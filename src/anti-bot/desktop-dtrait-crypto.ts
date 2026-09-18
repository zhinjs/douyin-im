import type { webcrypto } from 'node:crypto';

export interface DesktopDTraitCryptoJS {
  lib: { WordArray: { create(bytes: Uint8Array): unknown } };
  AES: {
    encrypt(
      text: unknown,
      key: unknown,
      options: unknown
    ): { ciphertext: { toString(encoder: unknown): string } };
  };
  mode: { CBC: unknown };
  pad: { Pkcs7: unknown };
  enc: { Base64: unknown };
}
export interface DesktopDTraitRsaInstance {
  setPublicKey(key: string): void;
  encrypt(text: string): string | false;
}
export interface DesktopDTraitCryptoContext {
  readonly window: {
    crypto?: Pick<webcrypto.Crypto, 'subtle' | 'getRandomValues'>;
  };
  readonly crypto?: Pick<webcrypto.Crypto, 'subtle'> | undefined;
  readonly location: { search: string };
  readonly Math: { random(): number };
  readonly TextEncoder: typeof TextEncoder;
  atob(value: string): string;
  btoa(value: string): string;
  /** Bind the actual CryptoJS and JSEncrypt module loaders; never replace them with an empty success. */
  loadCryptoJS(): Promise<DesktopDTraitCryptoJS>;
  loadJSEncrypt(): Promise<{
    default: (new () => DesktopDTraitRsaInstance) | null;
  }>;
  onBackgroundError?(error: unknown): void;
}
export interface DesktopDTraitCipher {
  cipherText: string;
  encryptedData: string;
  iv: string;
}

/** C860 n utility namespace. No Node global mutation or implicit network access. */
export function createDesktopDTraitCryptoUtil(
  context: DesktopDTraitCryptoContext
) {
  const parseQuery = (text: string): Record<string, string> => {
    if (!text) return {};
    const result: Record<string, string> = {};
    (text.indexOf('?') === 0 ? text.slice(1) : text)
      .split('&')
      .forEach(pair => {
        const [name, value = ''] = pair.split('=');
        result[name!] = decodeURIComponent(value);
      });
    return result;
  };
  const getQuery = (url?: string): Record<string, string> => {
    if (!url) return parseQuery(context.location.search.slice(1));
    const parts = url.split('?');
    if (parts.length < 2) return {};
    return parseQuery(parts[parts.length - 1]!.split('#')[0]!);
  };
  return {
    parseQuery,
    getQuery,
    isSupportSystemCrypto: () =>
      !getQuery()['disableSystemCrypto'] &&
      Boolean(context.window.crypto?.subtle),
    bufferConcat: (values: Uint8Array[]) => {
      const result = new Uint8Array(
        values.reduce((sum, value) => sum + value.byteLength, 0)
      );
      let offset = 0;
      for (const value of values) {
        result.set(new Uint8Array(value), offset);
        offset += value.byteLength;
      }
      return result;
    },
    buff2base64: (value: Uint8Array) =>
      context.btoa(String.fromCharCode(...value)),
    base642buff: (value: string) => {
      const text = context.atob(value);
      return Uint8Array.from(text, char => char.charCodeAt(0));
    },
    hexToUint8Array: (value: string) =>
      new Uint8Array(value.match(/.{2}/g)!.map(pair => parseInt(pair, 16))),
    uint8ArrayToHex: (value: Uint8Array) => {
      let text = '';
      value.forEach(byte => {
        text += byte.toString(16).padStart(2, '0');
      });
      return text;
    },
    unit8ArrayToString: (value: Uint8Array) => {
      let text = '';
      for (const byte of value) text += String.fromCharCode(byte);
      return text;
    },
    getRandomValues: (value: Uint8Array) => {
      if (context.window.crypto?.getRandomValues)
        context.window.crypto.getRandomValues(value);
      else
        for (let i = 0; i < value.length; i++)
          value[i] = (4294967296 * context.Math.random()) | 0;
      return value; // Source fallback is weak; production host must provide browser cryptographic randomness.
    },
  };
}
export type DesktopDTraitCryptoUtil = ReturnType<
  typeof createDesktopDTraitCryptoUtil
>;

/** En/Dn: initializes immediately, uses AES-CBC/PKCS7, IV+ciphertext in cipherText. */
export class DesktopDTraitAes {
  supportSystemCrypto = false;
  cryptoJS: DesktopDTraitCryptoJS | null = null;
  initPromise: Promise<boolean>;
  readonly util: DesktopDTraitCryptoUtil;
  constructor(private readonly context: DesktopDTraitCryptoContext) {
    this.util = createDesktopDTraitCryptoUtil(context);
    this.initPromise = this.init();
    observe(context, this.initPromise);
  }
  init = async (): Promise<boolean> => {
    if (!this.util.isSupportSystemCrypto()) {
      this.supportSystemCrypto = false;
      this.cryptoJS = await this.context.loadCryptoJS();
    } else this.supportSystemCrypto = true;
    return Promise.resolve(true);
  };
  getIv = (length = 16): Uint8Array =>
    this.util.getRandomValues(new Uint8Array(length));
  getAesKey = (): Uint8Array => this.util.getRandomValues(new Uint8Array(16));
  encryptData = async (
    hexKey: string,
    text: string
  ): Promise<DesktopDTraitCipher> => {
    const iv = this.getIv();
    if (this.supportSystemCrypto)
      return await this.encryptDataWithLocal(hexKey, text, iv);
    await this.initPromise;
    return await this.encryptDataWithCryptoJS(
      this.util.hexToUint8Array(hexKey),
      text,
      iv
    );
  };
  encryptDataWithLocal = async (
    hexKey: string,
    text: string,
    iv: Uint8Array
  ): Promise<DesktopDTraitCipher> => {
    const key = await this.context.crypto!.subtle.importKey(
      'raw',
      this.util.hexToUint8Array(hexKey),
      { name: 'AES-CBC' },
      false,
      ['encrypt', 'decrypt']
    );
    const input = new this.context.TextEncoder().encode(text);
    const encrypted = new Uint8Array(
      await this.context.crypto!.subtle.encrypt(
        { name: 'AES-CBC', iv },
        key,
        input
      )
    );
    return {
      cipherText: this.util.buff2base64(
        this.util.bufferConcat([iv, encrypted])
      ),
      encryptedData: this.util.buff2base64(encrypted),
      iv: this.util.buff2base64(iv),
    };
  };
  encryptDataWithCryptoJS = async (
    key: Uint8Array,
    text: string,
    iv: Uint8Array
  ): Promise<DesktopDTraitCipher> => {
    if (!this.cryptoJS) await this.initPromise;
    const js = this.cryptoJS!,
      ivWords = js.lib.WordArray.create(iv),
      keyWords = js.lib.WordArray.create(key),
      textWords = js.lib.WordArray.create(
        new this.context.TextEncoder().encode(text)
      );
    const encrypted = js.AES.encrypt(textWords, keyWords, {
      iv: ivWords,
      mode: js.mode.CBC,
      padding: js.pad.Pkcs7,
    }).ciphertext.toString(js.enc.Base64);
    return {
      cipherText: this.util.buff2base64(
        this.util.bufferConcat([iv, this.util.base642buff(encrypted)])
      ),
      encryptedData: encrypted,
      iv: this.util.buff2base64(iv),
    };
  };
}

/** In/On always waits for JSEncrypt. False maps to empty string, not a valid ciphertext. */
export class DesktopDTraitRsa {
  supportSystemCrypto = false;
  JSEncrypt: (new () => DesktopDTraitRsaInstance) | null = null;
  initPromise: Promise<boolean>;
  constructor(private readonly context: DesktopDTraitCryptoContext) {
    this.initPromise = this.init();
    observe(context, this.initPromise);
  }
  init = async (): Promise<boolean> =>
    this.context.loadJSEncrypt().then(module => {
      this.JSEncrypt = module.default;
      return true;
    });
  encryptData = async (publicKey: string, text: string): Promise<string> => {
    await this.initPromise;
    if (!this.JSEncrypt) return '';
    const cipher = new this.JSEncrypt();
    cipher.setPublicKey(publicKey);
    const result = cipher.encrypt(text);
    return result === false ? '' : result;
  };
}

/** Module-entry globals, singleton ownership scoped to this explicit host, not all accounts. */
const installed = new WeakMap<
  object,
  {
    aes: DesktopDTraitAes;
    rsa: DesktopDTraitRsa;
    util: DesktopDTraitCryptoUtil;
  }
>();
export function installDesktopDTraitCrypto(
  context: DesktopDTraitCryptoContext,
  target: Record<string, unknown>
) {
  const previous = installed.get(target);
  if (previous) return previous;
  const aes = new DesktopDTraitAes(context);
  target['DTraitUcAesEncrypt'] = aes;
  const rsa = new DesktopDTraitRsa(context);
  target['DTraitUcRsaEncrypt'] = rsa;
  const util = createDesktopDTraitCryptoUtil(context);
  target['DTraitUcCryptoJSUtil'] = util;
  const result = { aes, rsa, util };
  installed.set(target, result);
  return result;
}
function observe(
  context: DesktopDTraitCryptoContext,
  task: Promise<unknown>
): void {
  void task.catch(error => {
    try {
      context.onBackgroundError?.(error);
    } catch {
      /* Observe detached initialization only. */
    }
  });
}
