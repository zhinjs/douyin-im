import { createDesktopDTraitMathCollector } from './desktop-dtrait-math.js';

function fixture() {
  const math = Object.create(Math) as Math;
  const hash = jest.fn((text: unknown) => String(text).length);
  const context = { Math: math, hash };
  return {
    math,
    hash,
    context,
    collect: createDesktopDTraitMathCollector(context),
  };
}

it('calculates eight values before hashing and includes the discarded eight hashes', () => {
  const f = fixture(),
    values = [
      Math.acos(0.12312423423423424),
      Math.atanh(0.5),
      Math.log(3) / 2,
      Math.sin(-1e300),
      Math.cos(10.000000000123),
      Math.tan(-1e300),
      Math.expm1(1),
      Math.pow(Math.PI, -100),
    ];
  f.collect();
  expect(f.hash.mock.calls.map(([value]) => value)).toEqual([
    ...values.map(String),
    [values[5], values[1], values[2], values[4]].join(','),
    [values[6], values[7], values[3], values[5]].join(','),
  ]);
});

it.each(['acos', 'atanh', 'sin', 'cos', 'tan', 'expm1'] as const)(
  'uses zero when %s is falsy, without substituting an approximation',
  name => {
    const f = fixture();
    Object.defineProperty(f.math, name, { value: null });
    f.collect();
    const position = { acos: 0, atanh: 1, sin: 3, cos: 4, tan: 5, expm1: 6 }[
      name
    ];
    expect(f.hash.mock.calls[position]).toEqual(['0']);
  }
);

it.each(['log', 'pow'] as const)('does not add a fallback for %s', name => {
  const f = fixture();
  Object.defineProperty(f.math, name, { value: undefined });
  expect(f.collect).toThrow(TypeError);
  expect(f.hash).not.toHaveBeenCalled();
});

it('retains its captured Math object but reads its current methods on each call', () => {
  const f = fixture();
  f.context.Math = Object.create(Math) as Math;
  Object.defineProperty(f.context.Math, 'acos', { value: () => 123 });
  Object.defineProperty(f.math, 'acos', { value: () => 456 });
  f.collect();
  expect(f.hash.mock.calls[0]).toEqual(['456']);
});

it.each([1, 8, 9, 10])(
  'propagates failure of hash call %d instead of skipping discarded work',
  index => {
    const f = fixture();
    let calls = 0;
    f.hash.mockImplementation(() => {
      if (++calls === index) throw Error('hash');
      return calls;
    });
    expect(f.collect).toThrow('hash');
    expect(calls).toBe(index);
  }
);
