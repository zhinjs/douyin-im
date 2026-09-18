import { DesktopDocumentCollector, DesktopPropertyClassifier } from './desktop-device-properties.js';

describe('Desktop G property classification', () => {
  const classifier = () => new DesktopPropertyClassifier({ Symbol, Object });
  it('preserves tag codes and distinguishes primitives from boxed values', () => {
    const c = classifier();
    const values = [true, false, new Boolean(true), () => {}, undefined, NaN, new Number(1), '', new String(''), [], [1], {}, null, 1n];
    expect(values.map(value => c.classify({ value }, 'value'))).toEqual([1, 2, 2, 3, 4, 5, 5, 7, 8, 9, 10, 11, 99, -1]);
  });
  it('uses toString tags including collection/storage tags before typeof', () => {
    const c = classifier();
    const tags = ['HTMLAllCollection', 'Storage', 'Array', 'Unknown'];
    expect(tags.map(tag => c.classify({ value: { [Symbol.toStringTag]: tag, length: 0 } }, 'value'))).toEqual([12, 13, 9, 99]);
  });
  it('catches only the initial property access', () => {
    const c = classifier();
    expect(c.classify(null, 'value')).toBe(404);
    expect(c.classify({ get value() { throw Error('property'); } }, 'value')).toBe(404);
    expect(() => c.classify({ value: { get [Symbol.toStringTag]() { throw Error('tag'); } } }, 'value')).toThrow('tag');
    expect(() => c.classify({ value: { [Symbol.toStringTag]: 'Array', get length() { throw Error('length'); } } }, 'value')).toThrow('length');
  });
  it('selects the fallback typeof implementation lazily and retains that selection', () => {
    let iteratorReads = 0;
    function LegacySymbol() { /* Context-supplied legacy Symbol shape. */ }
    Object.defineProperty(LegacySymbol, 'iterator', { configurable: true, get() { iteratorReads++; return undefined; } });
    const c = new DesktopPropertyClassifier({ Symbol: LegacySymbol, Object });
    c.classify({ value: {} }, 'value');
    expect(iteratorReads).toBe(0);
    const value = { constructor: LegacySymbol, [Symbol.toStringTag]: 'Unknown' };
    expect(c.classify({ value }, 'value')).toBe(-1);
    Object.defineProperty(LegacySymbol, 'iterator', { value: Symbol('native') });
    expect(c.classify({ value }, 'value')).toBe(-1);
    expect(iteratorReads).toBe(1);
  });
});

describe('Desktop V document collector', () => {
  it('re-reads document six times and preserves default ToPrimitive conversion', () => {
    const trace: string[] = [];
    const converted = { [Symbol.toPrimitive](hint: string) { trace.push(hint); return 'UTF-8'; } };
    const document = { all: undefined, characterSet: converted, compatMode: null, documentMode: undefined, images: [], layers: null };
    const c = new DesktopDocumentCollector({ Symbol, Object, get document() { trace.push('document'); return document; } });
    expect(c.collect()).toEqual({ all: 4, characterSet: 'UTF-8', compatMode: 'null', documentMode: 'undefined', images: 9, layers: 99 });
    expect(trace).toEqual(['document', 'document', 'default', 'document', 'document', 'document', 'document']);
    expect(c.collect()).not.toBe(document);
  });
  it('propagates direct field and binding errors', () => {
    expect(() => new DesktopDocumentCollector({ Symbol, Object, get document(): object { throw Error('binding'); } }).collect()).toThrow('binding');
    expect(() => new DesktopDocumentCollector({ Symbol, Object, document: { characterSet: Symbol('bad') } }).collect()).toThrow(TypeError);
    expect(() => new DesktopDocumentCollector({ Symbol, Object, document: { get characterSet() { throw Error('charset'); } } }).collect()).toThrow('charset');
  });
  it.each(['all', 'images', 'layers'] as const)('retains the original VM target alias after a failing %s read', key => {
    const backing = { all: undefined, characterSet: 'UTF-8', compatMode: 'CSS1Compat', documentMode: undefined, images: [], layers: null };
    const writes: string[] = [];
    const document = new Proxy(backing, {
      get(target, name, receiver) { if (name === key) throw Error(key); return Reflect.get(target, name, receiver); },
      set(target, name, value, receiver) { writes.push(String(name)); return Reflect.set(target, name, value, receiver); },
    });
    const result = new DesktopDocumentCollector({ Symbol, Object, document }).collect();
    expect(result).toBe(document);
    expect(backing[key]).toBe(404);
    const fields = ['all', 'characterSet', 'compatMode', 'documentMode', 'images', 'layers'];
    expect(writes).toEqual(fields.slice(fields.indexOf(key)));
    if (key !== 'all') expect(backing.documentMode).toBeUndefined();
  });
  it('rejects refused writes to an aliased target and propagates throwing setters', () => {
    const document = Object.freeze({ get all() { throw Error('read'); }, images: [], layers: null });
    expect(() => new DesktopDocumentCollector({ Symbol, Object, document }).collect()).toThrow(TypeError);
    const throwing = { get all() { throw Error('read'); }, set all(_value: never) { throw Error('write'); } };
    expect(() => new DesktopDocumentCollector({ Symbol, Object, document: throwing }).collect()).toThrow('write');
  });
});
