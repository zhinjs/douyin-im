import {
  createDesktopDTraitSpeechCollector,
  type DesktopDTraitVoice,
} from './desktop-dtrait-speech.js';
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function fixture(initial: DesktopDTraitVoice[] = []) {
  let voices = initial,
    next = 0,
    handler: (() => void) | undefined;
  const order: string[] = [],
    timers = new Map<number, { callback: () => void; delay: number }>();
  const context = {
    window: {} as object,
    speechSynthesis: {
      getVoices: jest.fn(() => {
        order.push('voices');
        return voices;
      }),
      addEventListener: jest.fn((type: string, fn: () => void) => {
        void type;
        order.push('listen');
        handler = fn;
      }),
      onvoiceschanged: undefined as unknown,
    },
    setTimeout: jest.fn((callback: () => void, delay: number) => {
      order.push('set:' + delay);
      timers.set(++next, { callback, delay });
      return next;
    }),
    clearTimeout: jest.fn((handle: unknown) => {
      order.push('clear');
      timers.delete(handle as number);
    }),
    hash: jest.fn((value: unknown) => {
      order.push('hash');
      return String(value).length;
    }),
    onDiagnostic: jest.fn(),
  };
  Object.defineProperty(context.window, 'speechSynthesis', {
    value: undefined,
  });
  return {
    context,
    order,
    timers,
    collect: createDesktopDTraitSpeechCollector(context),
    voices(value: DesktopDTraitVoice[]) {
      voices = value;
    },
    fire(id: number) {
      const timer = timers.get(id)!;
      timers.delete(id);
      timer.callback();
    },
    event() {
      handler!();
    },
  };
}
const voice = {
  voiceURI: 'u1',
  name: 'Local',
  lang: 'en_US_X',
  localService: true,
  default: true,
};

it('waits 50ms, warms up voices, and registers the listener even after immediate success', async () => {
  const f = fixture([voice]);
  let settled = false;
  const result = f.collect().then(v => {
    settled = true;
    return v;
  });
  await flush();
  expect(settled).toBe(false);
  expect(f.context.speechSynthesis.getVoices).not.toHaveBeenCalled();
  f.fire(1);
  await result;
  expect(f.order).toEqual([
    'set:50',
    'voices',
    'set:300',
    'voices',
    'clear',
    'hash',
    'hash',
    'listen',
  ]);
  expect(f.context.speechSynthesis.addEventListener).toHaveBeenCalledWith(
    'voiceschanged',
    expect.any(Function)
  );
});

it('deduplicates URI and preserves language ordering, replacing only the first default-language underscore', async () => {
  const f = fixture([
    voice,
    { ...voice, name: 'duplicate', lang: 'jp' },
    { voiceURI: 'u2', name: 'Remote', lang: 'fr_FR', localService: false },
    { voiceURI: 'u3', name: 'Other', lang: 'en_US_X', localService: true },
  ]);
  const result = f.collect();
  f.fire(1);
  await result;
  expect(f.context.hash.mock.calls).toEqual([
    ['en_US_X,fr_FR,Local,Other'],
    ['en-US_X,Local,Remote'],
  ]);
});

it('does not pick one of multiple local defaults', async () => {
  const f = fixture([voice, { ...voice, voiceURI: 'u2', name: 'Other' }]);
  const result = f.collect();
  f.fire(1);
  await result;
  expect(f.context.hash.mock.calls[1]).toEqual([',,']);
});

it('checks local availability before URI deduplication, not after', async () => {
  const f = fixture([{ ...voice, localService: false, name: 'Remote' }, voice]);
  const result = f.collect();
  f.fire(1);
  await result;
  expect(f.context.hash.mock.calls).toEqual([['en_US_X,'], [',,Remote']]);
});

it.each([{ voices: [] }, { voices: [{ ...voice, localService: false }] }])(
  'times out an empty or remote-only list',
  async ({ voices }) => {
    const f = fixture(voices);
    let settled = false;
    const result = f.collect().then(v => {
      settled = true;
      return v;
    });
    f.fire(1);
    await flush();
    expect(settled).toBe(false);
    expect(f.timers.get(2)?.delay).toBe(300);
    f.fire(2);
    expect(await result).toEqual({ str_23: 0, str_22: 0 });
    expect(f.context.onDiagnostic).toHaveBeenCalledWith('speech', 'timeout');
  }
);

it('falls back after the initial delay if the API property is absent', async () => {
  const f = fixture();
  f.context.window = {};
  const result = f.collect();
  f.fire(1);
  expect(await result).toEqual({ str_23: 0, str_22: 0 });
  expect(f.context.speechSynthesis.getVoices).not.toHaveBeenCalled();
  expect(f.context.setTimeout).toHaveBeenCalledTimes(1);
});

it('retains late events after timeout; repeated hashes cannot replace the first Promise result', async () => {
  const f = fixture();
  const result = f.collect();
  f.fire(1);
  await flush();
  f.fire(2);
  expect(await result).toEqual({ str_23: 0, str_22: 0 });
  f.voices([voice]);
  f.event();
  expect(f.context.hash).toHaveBeenCalledTimes(4);
  expect(await result).toEqual({ str_23: 0, str_22: 0 });
});

it('does not catch a later event hash failure or fabricate completion after its timer was cleared', async () => {
  const f = fixture();
  let settled = false;
  void f.collect().then(() => {
    settled = true;
  });
  f.fire(1);
  await flush();
  f.voices([voice]);
  f.context.hash.mockImplementation(() => {
    throw Error('late hash');
  });
  expect(f.event).toThrow('late hash');
  expect(f.timers.size).toBe(0);
  await flush();
  expect(settled).toBe(false);
});

it('uses the legacy property when addEventListener is falsey and does not restore it', async () => {
  const f = fixture([voice]);
  Reflect.set(f.context.speechSynthesis, 'addEventListener', undefined);
  const previous = () => {};
  f.context.speechSynthesis.onvoiceschanged = previous;
  const result = f.collect();
  f.fire(1);
  await result;
  expect(typeof f.context.speechSynthesis.onvoiceschanged).toBe('function');
  expect(f.context.speechSynthesis.onvoiceschanged).not.toBe(previous);
});
