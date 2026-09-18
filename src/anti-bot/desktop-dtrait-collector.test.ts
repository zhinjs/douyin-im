import {
  DesktopDTraitCollector,
  prepareDesktopDTraitCollection,
  type DesktopDTraitCollectionPlugins,
} from './desktop-dtrait-collector.js';
import { createDesktopDTraitMathCollector } from './desktop-dtrait-math.js';
import {
  createDesktopDTraitHash,
  DesktopDTraitFeatures,
} from './desktop-dtrait-features.js';

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function fixture() {
  let now = 100;
  const timers: (() => void)[] = [];
  const context = {
    Date: { now: () => now },
    setTimeout: jest.fn((fn: () => void) => {
      timers.push(fn);
    }),
  };
  return {
    context,
    timers,
    advance(ms: number) {
      now += ms;
    },
  };
}
const options = () => ({ cache: {}, debug: false });
function plugins(): DesktopDTraitCollectionPlugins {
  return {
    boolFeature: () => ({ bool_1: true }),
    strFeature: () => ({}),
    canvas: () => ({}),
    audio: () => ({}),
    css: () => ({}),
    domRect: () => ({}),
    mediaTypes: () => ({}),
    speech: () => ({}),
    svgRect: () => ({}),
    math: () => ({}),
    webGL: () => ({}),
    fonts: () => ({}),
  };
}

it('starts all first phases eagerly and defers second phases until the runner', async () => {
  const f = fixture(),
    calls: string[] = [];
  const run = prepareDesktopDTraitCollection(
    f.context,
    {
      a: () => {
        calls.push('a');
        return () => {
          calls.push('second');
          return 7;
        };
      },
      b: () => {
        calls.push('b');
        return 3;
      },
    },
    options()
  );
  expect(calls).toEqual(['a', 'b']);
  expect(await run()).toEqual({
    a: { value: 7, duration: 0 },
    b: { value: 3, duration: 0 },
  });
  expect(calls).toEqual(['a', 'b', 'second']);
});

it('adds phase durations but excludes idle time between phases, and reruns only phase two', async () => {
  const f = fixture(),
    first = jest.fn(() => {
      f.advance(2);
      return () => {
        f.advance(3);
        return 1;
      };
    });
  const run = prepareDesktopDTraitCollection(f.context, { first }, options());
  await flush();
  f.advance(1000);
  expect(await run()).toEqual({ first: { value: 1, duration: 5 } });
  f.advance(1000);
  expect(await run()).toEqual({ first: { value: 1, duration: 5 } });
  expect(first).toHaveBeenCalledTimes(1);
});

it('preserves single-task throws and async rejections as error results', async () => {
  const f = fixture(),
    sync = Error('sync'),
    asyncError = Error('async');
  const run = prepareDesktopDTraitCollection(
    f.context,
    {
      sync: () => {
        throw sync;
      },
      async: async () => {
        throw asyncError;
      },
      second: () => () => {
        throw sync;
      },
    },
    options()
  );
  expect(await run()).toEqual({
    sync: { error: sync, duration: 0 },
    async: { error: asyncError, duration: 0 },
    second: { error: sync, duration: 0 },
  });
});

it('supports thenables and catches a throwing then getter', async () => {
  const f = fixture();
  const results = await prepareDesktopDTraitCollection(
    f.context,
    {
      a: () => ({
        then(done: (value: number) => void) {
          done(3);
        },
      }),
      b: () =>
        Object.defineProperty({}, 'then', {
          get() {
            throw Error('getter');
          },
        }),
    },
    options()
  )();
  expect(results['a']).toEqual({ value: 3, duration: 0 });
  expect(results['b']).toEqual({
    error: expect.objectContaining({ message: 'getter' }),
    duration: 0,
  });
});

it('does not add an overall timeout to a pending task', async () => {
  const f = fixture();
  let finish!: (value: number) => void,
    settled = false;
  const run = prepareDesktopDTraitCollection(
    f.context,
    {
      a: () =>
        new Promise<number>(resolve => {
          finish = resolve;
        }),
    },
    options()
  );
  const pending = run().then(result => {
    settled = true;
    return result;
  });
  await flush();
  f.advance(1000000);
  await flush();
  expect(settled).toBe(false);
  expect(f.context.setTimeout).not.toHaveBeenCalled();
  finish(4);
  expect(await pending).toEqual({ a: { value: 4, duration: 1000000 } });
});

it('yields even after the final item at the exact 16ms boundary', async () => {
  const f = fixture();
  const run = prepareDesktopDTraitCollection(
    f.context,
    {
      a: () => {
        f.advance(16);
        return 1;
      },
    },
    options()
  );
  expect(f.context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 0);
  const pending = run();
  f.timers.shift()!();
  expect(await pending).toEqual({ a: { value: 1, duration: 16 } });
});

it('does not yield below the time slice budget', async () => {
  const f = fixture();
  await prepareDesktopDTraitCollection(
    f.context,
    {
      a: () => {
        f.advance(15);
        return 1;
      },
    },
    options()
  )();
  expect(f.context.setTimeout).not.toHaveBeenCalled();
});

it('keeps options/cache shared by identity within a group and excludes inherited registry entries', async () => {
  const f = fixture(),
    input = options(),
    inherited = jest.fn();
  const tasks = Object.assign(Object.create({ inherited }), {
    a: (o: typeof input) => {
      expect(o).toBe(input);
      Reflect.set(o.cache, 'saved', 2);
      return 1;
    },
    b: (o: typeof input) => Reflect.get(o.cache, 'saved'),
  });
  expect(
    await prepareDesktopDTraitCollection(f.context, tasks, input)()
  ).toEqual({ a: { value: 1, duration: 0 }, b: { value: 2, duration: 0 } });
  expect(inherited).not.toHaveBeenCalled();
});

it('merges plugin values in registration order and does not retry individual feature failure', async () => {
  const f = fixture(),
    p = plugins(),
    first = jest.fn(() => ({ str_1: 1 })),
    last = jest.fn(() => ({ str_1: 2 }));
  p.strFeature = first;
  p.fonts = last;
  p.canvas = () => {
    throw Error('single');
  };
  expect(await new DesktopDTraitCollector(f.context, p).collect()).toEqual({
    num: {},
    bool: { bool_1: true },
    str: { str_1: 2 },
  });
  expect(first).toHaveBeenCalledTimes(1);
  expect(last).toHaveBeenCalledTimes(1);
});

it.each([2, Infinity])(
  'retries aggregate failures up to four attempts when %s attempts fail',
  async failures => {
    const f = fixture(),
      p = plugins();
    let attempts = 0;
    p.boolFeature = () => {
      attempts++;
      return { bool_1: true };
    };
    p.canvas = () =>
      Object.defineProperty({}, 'str_1', {
        enumerable: true,
        get() {
          if (attempts <= failures) throw Error('merge');
          return 5;
        },
      });
    const result = await new DesktopDTraitCollector(f.context, p).collect();
    expect(attempts).toBe(failures === Infinity ? 4 : 3);
    expect(result).toEqual(
      failures === Infinity
        ? { bool: {}, num: {}, str: {} }
        : { num: {}, bool: { bool_1: true }, str: { str_1: 5 } }
    );
  }
);

it('uses a fresh cache per group and per collection', async () => {
  const f = fixture(),
    p = plugins(),
    caches: unknown[] = [];
  p.boolFeature = o => {
    caches.push(o.cache);
    return {};
  };
  p.strFeature = o => {
    caches.push(o.cache);
    return {};
  };
  const collector = new DesktopDTraitCollector(f.context, p);
  await collector.collect();
  await collector.collect();
  expect(new Set(caches).size).toBe(4);
});

it('runs actual Math through the collection group and feature encoder without fixed fingerprint values', async () => {
  const f = fixture(),
    p = plugins(),
    hash = createDesktopDTraitHash({
      encoder: new TextEncoder(),
      onDiagnostic() {},
    });
  p.math = createDesktopDTraitMathCollector({ Math, hash });
  const collected = await new DesktopDTraitCollector(f.context, p).collect();
  const feature = new DesktopDTraitFeatures(
    {
      hash,
      btoa,
      getCryptoUtil: () => ({
        bufferConcat: values => new Uint8Array(Buffer.concat(values)),
      }),
    },
    {}
  );
  for (const key in collected.bool)
    feature.addBoolFeature(key, collected.bool[key]);
  for (const key in collected.str)
    feature.addStringFeature(key, collected.str[key]);
  const values = p.math(options()) as Record<string, number>;
  const expected = Buffer.alloc(16);
  expected[0] = 32;
  expected[5] = 2;
  expected[6] = 42;
  expected.writeUInt32BE(values['str_11']!, 7);
  expected[11] = 43;
  expected.writeUInt32BE(values['str_12']!, 12);
  expect(feature.getResult().centralString).toBe(expected.toString('base64'));
});
