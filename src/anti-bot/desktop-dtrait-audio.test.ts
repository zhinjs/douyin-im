import {
  createDesktopDTraitAudioCollector,
  type DesktopDTraitAudioContext,
  type DesktopDTraitOfflineAudio,
} from './desktop-dtrait-audio.js';

function fixture() {
  const frequency = new Float32Array([-1.25, 2.5, -3.75, 4]);
  const time = new Float32Array([-0.5, 0.25, -0.125]);
  const channel = new Float32Array([1, 1, 2, NaN, NaN, -0, 0]);
  const analyser = {
    frequencyBinCount: 4,
    fftSize: 3,
    getFloatFrequencyData: jest.fn((data: Float32Array) => {
      data.set(frequency);
    }),
    getFloatTimeDomainData: jest.fn((data: Float32Array) => {
      data.set(time);
    }),
  };
  const oscillator = {
    type: '',
    frequency: { value: 0 },
    connect: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  };
  const compressor = {
    threshold: { value: 0 },
    knee: { value: 0 },
    attack: { value: 1 },
    connect: jest.fn(),
  };
  const then = jest.fn(() => {
    throw Error('must not inspect render return');
  });
  const audio: DesktopDTraitOfflineAudio = {
    destination: {},
    createAnalyser: jest.fn(() => analyser),
    createOscillator: jest.fn(() => oscillator),
    createDynamicsCompressor: jest.fn(() => compressor),
    startRendering: jest.fn(() =>
      Object.defineProperty({}, 'then', { get: then })
    ),
    oncomplete: null,
  };
  const constructed = jest.fn();
  const hash = jest.fn((value: unknown): number => {
    void value;
    return hash.mock.calls.length;
  });
  const context: DesktopDTraitAudioContext = {
    Date: { now: jest.fn(() => 100) },
    Math,
    OfflineAudioContext: class {
      constructor(...args: number[]) {
        constructed(...args);
        return audio;
      }
    } as new (
      channels: number,
      length: number,
      sampleRate: number
    ) => DesktopDTraitOfflineAudio,
    hash,
    onDiagnostic: jest.fn(),
  };
  const event = { renderedBuffer: { getChannelData: jest.fn(() => channel) } };
  return {
    audio,
    analyser,
    oscillator,
    compressor,
    frequency,
    time,
    event,
    constructed,
    hash,
    context,
    then,
    collect: createDesktopDTraitAudioCollector(context),
  };
}

describe('Desktop DTrait offline audio collector', () => {
  it('uses the exact graph and four hash inputs, ignoring the rendering return value', async () => {
    const f = fixture(),
      pending = f.collect();
    expect(f.constructed).toHaveBeenCalledWith(1, 5000, 44100);
    expect(f.oscillator).toMatchObject({
      type: 'triangle',
      frequency: { value: 10000 },
    });
    expect(f.compressor).toMatchObject({
      threshold: { value: -50 },
      knee: { value: 40 },
      attack: { value: 0 },
    });
    expect(f.oscillator.connect).toHaveBeenCalledWith(f.compressor);
    expect(f.compressor.connect.mock.calls).toEqual([
      [f.analyser],
      [f.audio.destination],
    ]);
    expect(f.oscillator.start).toHaveBeenCalledWith(0);
    expect(f.hash).not.toHaveBeenCalled();
    f.audio.oncomplete!(f.event);
    await expect(pending).resolves.toEqual({
      str_8: 1,
      str_9: 2,
      str_20: 3,
      str_25: 4,
    });
    expect(f.hash.mock.calls).toEqual([['11.5'], ['0.875'], ['11.5'], ['4']]);
    expect(f.then).not.toHaveBeenCalled();
    expect(f.oscillator.stop).not.toHaveBeenCalled();
  });
  it('sums the first 100 frequency values independently from channel data', async () => {
    const f = fixture();
    f.analyser.frequencyBinCount = 102;
    f.analyser.getFloatFrequencyData.mockImplementation(data => {
      data.fill(-1);
      data[100] = -20;
      data[101] = 30;
    });
    const pending = f.collect();
    f.audio.oncomplete!(f.event);
    await pending;
    expect(f.hash.mock.calls[0]).toEqual(['150']);
    expect(f.hash.mock.calls[2]).toEqual(['100']);
  });
  it('coerces zero and NaN sums to empty strings before hashing', async () => {
    const f = fixture();
    f.frequency.fill(NaN);
    f.time.fill(0);
    f.event.renderedBuffer.getChannelData.mockReturnValue(new Float32Array());
    const pending = f.collect();
    f.audio.oncomplete!(f.event);
    await pending;
    expect(f.hash.mock.calls).toEqual([[''], [''], [''], ['']]);
  });
  it('uses four separate fallback hashes on synchronous startRendering failure', async () => {
    const f = fixture();
    f.audio.startRendering = jest.fn(() => {
      throw Error('render');
    });
    await expect(f.collect()).resolves.toEqual({
      str_8: 1,
      str_9: 2,
      str_20: 3,
      str_25: 4,
    });
    expect(f.hash.mock.calls).toEqual([[''], [''], [''], ['']]);
    expect(f.context.onDiagnostic).toHaveBeenCalledWith('audio');
  });
  it('does not catch oncomplete setter rejection with the synchronous fallback', async () => {
    const f = fixture();
    Object.defineProperty(f.audio, 'oncomplete', {
      set() {
        throw Error('setter');
      },
    });
    await expect(f.collect()).rejects.toThrow('setter');
    expect(f.context.onDiagnostic).not.toHaveBeenCalled();
    expect(f.hash).not.toHaveBeenCalled();
  });
  it('propagates callback exceptions to its caller and leaves collection pending', async () => {
    const f = fixture();
    f.hash.mockImplementation(() => {
      throw Error('hash');
    });
    let state = 'pending';
    void f.collect().then(
      () => {
        state = 'resolved';
      },
      () => {
        state = 'rejected';
      }
    );
    expect(() => f.audio.oncomplete!(f.event)).toThrow('hash');
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(state).toBe('pending');
    expect(f.context.onDiagnostic).not.toHaveBeenCalled();
  });
  it('repeats extraction and hashing for late completion callbacks', async () => {
    const f = fixture(),
      pending = f.collect();
    f.audio.oncomplete!(f.event);
    const result = await pending;
    f.audio.oncomplete!(f.event);
    expect(f.hash).toHaveBeenCalledTimes(8);
    expect(result.str_8).toBe(1);
    expect(f.event.renderedBuffer.getChannelData).toHaveBeenCalledTimes(2);
  });
  it('does not invent a timeout when no completion event arrives', async () => {
    const f = fixture();
    let state = 'pending';
    void f.collect().then(
      () => {
        state = 'resolved';
      },
      () => {
        state = 'rejected';
      }
    );
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(state).toBe('pending');
    expect(f.hash).not.toHaveBeenCalled();
  });
});
