import type { DesktopDTraitCryptoUtil } from './desktop-dtrait-crypto.js';

export interface DesktopDTraitHashContext {
  readonly encoder: { encode(value?: string): Uint8Array };
  /** Diagnostic codes only: raw feature values and exceptions may contain device data. */
  onDiagnostic(code: 'murmur3_len' | 'murmur3_encode'): void;
}

/** Source A: one UTF-8 cache per browser realm, intentionally retaining ordinary-object lookup. */
export function createDesktopDTraitHash(context: DesktopDTraitHashContext) {
  const cache: Record<string, Uint8Array> = {};
  return (value: unknown, seed = 0): number => {
    if (typeof value !== 'string') {
      // Retain source coercion/throw order, but never forward the raw value to telemetry.
      void 'length_error, raw:'
        .concat(value as string, ', type:')
        .concat(typeof value);
      context.onDiagnostic('murmur3_len');
    }
    const text = typeof value === 'string' ? value : String(value);
    let bytes: Uint8Array;
    if (!cache[text]) {
      try {
        cache[text] = context.encoder.encode(text);
        bytes = cache[text]!;
      } catch (error) {
        void ''.concat(error as string);
        context.onDiagnostic('murmur3_encode');
        bytes = new Uint8Array(0);
      }
    } else bytes = cache[text]!;
    const length = bytes.length,
      blocks = Math.floor(length / 4);
    let hash = seed;
    for (let i = 0; i < blocks; i++) {
      const at = i * 4;
      let k =
        bytes[at]! |
        (bytes[at + 1]! << 8) |
        (bytes[at + 2]! << 16) |
        (bytes[at + 3]! << 24);
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      hash ^= Math.imul(k, 0x1b873593);
      hash = (hash << 13) | (hash >>> 19);
      hash = Math.imul(hash, 5) + 0xe6546b64;
    }
    let tail = 0;
    const at = 4 * blocks,
      remainder = length & 3;
    if (remainder === 3) tail ^= bytes[at + 2]! << 16;
    if (remainder >= 2) tail ^= bytes[at + 1]! << 8;
    if (remainder >= 1) {
      tail ^= bytes[at]!;
      tail = Math.imul(tail, 0xcc9e2d51);
      tail = (tail << 15) | (tail >>> 17);
      hash ^= Math.imul(tail, 0x1b873593);
    }
    hash ^= length;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
  };
}

export interface DesktopDTraitFeatureContext {
  /** Use a hash instance shared within this realm, not across accounts. */
  hash(value: unknown): number;
  getCryptoUtil():
    | Pick<DesktopDTraitCryptoUtil, 'bufferConcat'>
    | null
    | undefined;
  btoa(value: string): string;
}
export interface DesktopDTraitFeatureOptions {
  reserved?: number;
  dTraitType?: number;
  version?: number;
}
const versionZero: Record<string, number> = {};
for (let i = 1; i <= 10; i++) versionZero[`bool_${i}`] = i;
for (let i = 1; i <= 33; i++) versionZero[`str_${i}`] = i + 31;
// F126 supplies no numeric features and no other version. Do not invent mappings.
const mappings: Record<string, Record<string, number>> = { 0: versionZero };

function encodeIndexed(getFeatures: () => Record<string, unknown>): Uint8Array {
  const bytes = new Uint8Array(Object.keys(getFeatures()).length * 5);
  const keys = Object.keys(getFeatures());
  let at = 0;
  for (const key of keys) {
    bytes[at] = parseInt(key, 10);
    // Type-only assertion: four separate JS bitwise conversions, not a single Number(value).
    const value = getFeatures()[key] as number;
    bytes[at + 1] = (value >>> 24) & 255;
    bytes[at + 2] = (value >>> 16) & 255;
    bytes[at + 3] = (value >>> 8) & 255;
    bytes[at + 4] = value & 255;
    at += 5;
  }
  return bytes;
}

/** Pinned core F89–101/F126. Encodes supplied features; does not collect or fabricate them. */
export class DesktopDTraitFeatures {
  reserved = 0;
  dTraitType = 1;
  centralAccessType = 0;
  edgeAccessType = 1;
  version = 0;
  boolFeatures: Record<string, unknown> = {};
  numberFeatures: Record<string, unknown> = {};
  centralStringFeatures: Record<string, unknown> = {};
  edgeStringFeatures: Record<string, unknown> = {};
  constructor(
    private readonly context: DesktopDTraitFeatureContext,
    options: DesktopDTraitFeatureOptions
  ) {
    this.reserved = options.reserved || 0;
    this.dTraitType = options.dTraitType || 1;
    this.version = options.version || 0;
  }
  addBoolFeature(name: string, value: unknown): void {
    const index = mappings?.[this.version]?.[name];
    if (index && index >= 0 && index <= 480)
      this.boolFeatures[index] = Boolean(value);
  }
  addNumFeature(name: string, value: unknown): void {
    const index = mappings?.[this.version]?.[name];
    if (index && index >= 16 && index <= 31) this.numberFeatures[index] = value;
  }
  addStringFeature(name: string, value: unknown): void {
    const index = mappings?.[this.version]?.[name];
    if (index && index >= 32 && index <= 255) {
      this.centralStringFeatures[index] = value;
      this.edgeStringFeatures[index] = this.context.hash(
        (value as object).toString()
      );
    }
  }
  getCentralStringBuffer(): Uint8Array {
    return encodeIndexed(() => this.centralStringFeatures);
  }
  getEdgeStringBuffer(): Uint8Array {
    return encodeIndexed(() => this.edgeStringFeatures);
  }
  getNumberBuffer(): Uint8Array {
    return encodeIndexed(() => this.numberFeatures);
  }
  getBoolBuffer(): Uint8Array {
    let max = 0;
    for (const key of Object.keys(this.boolFeatures)) {
      const index = parseInt(key, 10);
      if (index > max) max = index;
    }
    const bytes = new Uint8Array((Math.floor(max / 32) + 1) * 5);
    for (const key of Object.keys(this.boolFeatures)) {
      const index = parseInt(key, 10);
      // F98 really uses block index, not block * 5, for this header write.
      if (index % 32 === 0)
        bytes[Math.floor(index / 32)] = Math.floor(index / 8);
      if (this.boolFeatures[index]) {
        const at =
          5 * (Math.floor(index / 32) + 1) - Math.floor((index % 32) / 8) - 1;
        bytes[at] = bytes[at]! | (1 << (index % 8));
      }
    }
    return bytes;
  }
  getResult(): { centralString: string; edgeString: string } {
    const central = this.getCentralStringBuffer(),
      edge = this.getEdgeStringBuffer();
    const number = this.getNumberBuffer(),
      bool = this.getBoolBuffer();
    const centralHeader = new Uint8Array(1),
      edgeHeader = new Uint8Array(1);
    centralHeader[0] =
      (this.reserved << 6) |
      (this.dTraitType << 5) |
      (this.centralAccessType << 4) |
      this.version;
    edgeHeader[0] =
      (this.reserved << 6) |
      (this.dTraitType << 5) |
      (this.edgeAccessType << 4) |
      this.version;
    // Both F100 concat calls use centralHeader. Edge header computation still occurs in source.
    const c = this.context
      .getCryptoUtil()
      ?.bufferConcat([centralHeader, bool, number, central]);
    const e = this.context
      .getCryptoUtil()
      ?.bufferConcat([centralHeader, bool, number, edge]);
    const base64 = (bytes: Uint8Array | undefined) =>
      this.context.btoa(
        // eslint-disable-next-line prefer-spread -- F101 apply accepts absent/array-like bytes; spreading would change those semantics.
        String.fromCharCode.apply(String, bytes as unknown as number[])
      );
    return { centralString: base64(c), edgeString: base64(e) };
  }
}
