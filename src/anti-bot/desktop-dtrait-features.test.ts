import {
  DesktopDTraitFeatures,
  createDesktopDTraitHash,
  type DesktopDTraitFeatureOptions,
} from './desktop-dtrait-features.js';

function fixture(options: DesktopDTraitFeatureOptions = {}) {
  const encoder = {
    encode: jest.fn((text?: string) => new TextEncoder().encode(text)),
  };
  const onDiagnostic = jest.fn(),
    hash = createDesktopDTraitHash({ encoder, onDiagnostic });
  const util = {
    bufferConcat: jest.fn(
      (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))
    ),
  };
  const getCryptoUtil = jest.fn((): typeof util | undefined => util);
  const feature = new DesktopDTraitFeatures(
    { hash, getCryptoUtil, btoa },
    options
  );
  return { feature, encoder, hash, onDiagnostic, util, getCryptoUtil };
}

it('encodes an empty bool block and uses the central header for both strings', () => {
  const { feature } = fixture();
  expect([...feature.getBoolBuffer()]).toEqual([0, 0, 0, 0, 0]);
  expect(feature.getResult()).toEqual({
    centralString: 'IAAAAAAA',
    edgeString: 'IAAAAAAA',
  });
});

it('retains source falsy option defaults rather than masking or using nullish defaults', () => {
  const { feature } = fixture({ reserved: 9, dTraitType: 0, version: 256 });
  expect(feature.dTraitType).toBe(1);
  expect(Buffer.from(feature.getResult().edgeString, 'base64')[0]).toBe(96);
});

it('has only ten bool and thirty-three string feature mappings in version zero', () => {
  const { feature } = fixture();
  feature.addBoolFeature('bool_10', true);
  feature.addBoolFeature('bool_11', true);
  feature.addStringFeature('str_33', 1);
  feature.addStringFeature('str_34', 2);
  feature.addNumFeature('num_1', 9);
  feature.addNumFeature('16', 9);
  expect(feature.boolFeatures).toEqual({ 10: true });
  expect(feature.centralStringFeatures).toEqual({ 64: 1 });
  expect(feature.numberFeatures).toEqual({});
});

it('does not invent a feature mapping for unknown versions', () => {
  const { feature } = fixture({ version: 1 });
  feature.addBoolFeature('bool_1', true);
  feature.addStringFeature('str_1', 1);
  expect(feature.getResult()).toEqual({
    centralString: 'IQAAAAAA',
    edgeString: 'IQAAAAAA',
  });
});

it('stores central values as uint32 bit patterns while edge values use UTF-8 Murmur3', () => {
  const { feature } = fixture();
  feature.addStringFeature('str_1', 0x12345678);
  feature.addStringFeature('str_2', 'abc');
  expect(Buffer.from(feature.getCentralStringBuffer()).toString('hex')).toBe(
    '20123456782100000000'
  );
  expect(Buffer.from(feature.getEdgeStringBuffer()).toString('hex')).toBe(
    '208ed503cc21b3dd93fa'
  );
  expect(feature.getResult()).toEqual({
    centralString: 'IAAAAAAAIBI0VnghAAAAAA==',
    edgeString: 'IAAAAAAAII7VA8whs92T+g==',
  });
});

it.each([null, undefined])(
  'preserves partial central mutation when adding %s throws',
  value => {
    const { feature } = fixture();
    feature.addStringFeature('str_1', 'old');
    const old = feature.edgeStringFeatures['32'];
    expect(() => feature.addStringFeature('str_1', value)).toThrow(TypeError);
    expect(feature.centralStringFeatures['32']).toBe(value);
    expect(feature.edgeStringFeatures['32']).toBe(old);
  }
);

it('encodes sparse bool blocks with the original boundary address, including false high indexes', () => {
  const { feature } = fixture();
  feature.boolFeatures = { 32: true, 64: true, 480: false };
  const bytes = feature.getBoolBuffer();
  expect(bytes.length).toBe(80);
  expect([...bytes.entries()].filter(([, value]) => value)).toEqual([
    [1, 4],
    [2, 8],
    [9, 1],
    [14, 1],
    [15, 60],
  ]);
});

it('encodes numeric keys in Object.keys order with big-endian truncated values', () => {
  const { feature } = fixture();
  feature.numberFeatures = { 20: 1.9, 16: -1, 17: 2 ** 32 + 7 };
  expect(Buffer.from(feature.getNumberBuffer()).toString('hex')).toBe(
    '10ffffffff11000000071400000001'
  );
});

it('performs four separate value conversions for each indexed value', () => {
  const { feature } = fixture();
  let calls = 0;
  feature.numberFeatures = {
    16: {
      valueOf() {
        return ++calls;
      },
    },
  };
  expect([...feature.getNumberBuffer()]).toEqual([16, 0, 0, 0, 4]);
  expect(calls).toBe(4);
});

it.each([1n, Symbol('value')])(
  'rejects unsupported bitwise value %s rather than coercing it early',
  value => {
    const { feature } = fixture();
    feature.numberFeatures = { 16: value };
    expect(() => feature.getNumberBuffer()).toThrow(TypeError);
  }
);

it('does not treat absent crypto utility as nonempty data and reads the utility twice', () => {
  const f = fixture();
  f.getCryptoUtil.mockReturnValueOnce(f.util).mockReturnValueOnce(undefined);
  expect(f.feature.getResult()).toEqual({
    centralString: 'IAAAAAAA',
    edgeString: '',
  });
  expect(f.getCryptoUtil).toHaveBeenCalledTimes(2);
});

it('runs buffer encoders in central/edge/number/bool order', () => {
  const f = fixture(),
    calls: string[] = [];
  for (const name of [
    'getCentralStringBuffer',
    'getEdgeStringBuffer',
    'getNumberBuffer',
    'getBoolBuffer',
  ] as const) {
    const original = f.feature[name].bind(f.feature);
    jest.spyOn(f.feature, name).mockImplementation(() => {
      calls.push(name);
      return original();
    });
  }
  f.feature.getResult();
  expect(calls).toEqual([
    'getCentralStringBuffer',
    'getEdgeStringBuffer',
    'getNumberBuffer',
    'getBoolBuffer',
  ]);
});

it.each([
  ['', 0],
  ['abc', 3017643002],
  ['😀', 3199479546],
  ['\ud800', 3063719617],
  ['toString', 0],
] as const)('matches source hash for %s', (value, expected) => {
  expect(fixture().hash(value)).toBe(expected);
});

it('shares UTF-8 caching within a hash realm, not across independent realms', () => {
  const a = fixture(),
    b = fixture();
  a.hash('abc');
  a.hash('abc');
  b.hash('abc');
  expect(a.encoder.encode).toHaveBeenCalledTimes(1);
  expect(b.encoder.encode).toHaveBeenCalledTimes(1);
});

it('falls back to empty bytes after encoding failure, without caching failure or logging raw data', () => {
  const f = fixture();
  f.encoder.encode.mockImplementation(() => {
    throw Error('private-device-data');
  });
  expect(f.hash('synthetic')).toBe(0);
  expect(f.hash('synthetic')).toBe(0);
  expect(f.encoder.encode).toHaveBeenCalledTimes(2);
  expect(f.onDiagnostic.mock.calls).toEqual([
    ['murmur3_encode'],
    ['murmur3_encode'],
  ]);
});

it('does not hide a diagnostic sink exception', () => {
  const f = fixture();
  f.onDiagnostic.mockImplementation(() => {
    throw Error('sink');
  });
  expect(() => f.hash(42)).toThrow('sink');
});
