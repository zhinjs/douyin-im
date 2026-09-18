import { createDesktopDTraitMediaCollector } from './desktop-dtrait-media.js';

function fixture() {
  const calls: string[][] = [];
  const audio = jest.fn((type: string): unknown => {
    calls.push(['audio', type]);
    return '';
  });
  const video = jest.fn((type: string): unknown => {
    calls.push(['video', type]);
    return '';
  });
  const source = jest.fn((type: string): unknown => {
    calls.push(['source', type]);
    return false;
  });
  const recorder = jest.fn((type: string): unknown => {
    calls.push(['recorder', type]);
    return false;
  });
  const context = {
    document: { createElement: jest.fn(() => ({ canPlayType: video })) },
    Audio: class {
      canPlayType = audio;
    },
    window: {} as object,
    MediaSource: { isTypeSupported: source },
    MediaRecorder: { isTypeSupported: recorder },
    hash: jest.fn((input: unknown) => String(input).length),
    onDiagnostic: jest.fn(),
  };
  return {
    context,
    calls,
    audio,
    video,
    source,
    recorder,
    collect: createDesktopDTraitMediaCollector(context),
  };
}

it('checks all three APIs for all sorted MIME types even when audio already reports support', async () => {
  const f = fixture();
  f.audio.mockImplementation(type => {
    f.calls.push(['audio', type]);
    return 'probably';
  });
  await f.collect();
  const types = [
    'audio/aac',
    'audio/mpeg',
    'audio/mpegurl',
    'audio/ogg; codecs="vorbis"',
    'audio/wav; codecs="1"',
    'audio/x-m4a',
    'video/mp4; codecs="avc1.42E01E"',
    'video/ogg; codecs="theora"',
    'video/quicktime',
    'video/webm; codecs="vp8"',
    'video/webm; codecs="vp9"',
    'video/x-matroska',
  ];
  expect(f.calls).toEqual(
    types.flatMap(type => [
      ['audio', type],
      ['video', type],
      ['source', type],
    ])
  );
  expect(f.context.hash).toHaveBeenCalledWith(types.join(','));
  expect(f.recorder).not.toHaveBeenCalled();
});

it('checks recorder property presence including inherited falsey values', async () => {
  const f = fixture();
  f.context.window = Object.create({ MediaRecorder: null });
  f.recorder.mockImplementation(type => {
    f.calls.push(['recorder', type]);
    return true;
  });
  await f.collect();
  expect(f.recorder).toHaveBeenCalledTimes(12);
  expect(f.calls.slice(0, 4).map(v => v[0])).toEqual([
    'audio',
    'video',
    'source',
    'recorder',
  ]);
});

it('hashes an empty array result, distinct from environment failure', async () => {
  const f = fixture();
  expect(await f.collect()).toEqual({ str_13: 0 });
  expect(f.context.hash).toHaveBeenCalledWith('');
});

it('discards partial results and returns an un-hashed empty string for an inner API failure', async () => {
  const f = fixture();
  f.audio.mockReturnValue('yes');
  f.source
    .mockImplementationOnce(() => true)
    .mockImplementationOnce(() => {
      throw Error('source');
    });
  expect(await f.collect()).toEqual({ str_13: '' });
  expect(f.context.hash).not.toHaveBeenCalled();
  expect(f.context.onDiagnostic).not.toHaveBeenCalled();
});

it('reports a hash failure with redacted diagnostics and performs one empty hash fallback', async () => {
  const f = fixture();
  f.context.hash
    .mockImplementationOnce(() => {
      throw Error('private-environment');
    })
    .mockReturnValueOnce(7);
  expect(await f.collect()).toEqual({ str_13: 7 });
  expect(f.context.onDiagnostic.mock.calls).toEqual([['md']]);
  expect(f.context.hash).toHaveBeenCalledTimes(2);
});

it('rejects when the fallback hash itself fails', async () => {
  const f = fixture();
  f.context.hash.mockImplementation(() => {
    throw Error('hash');
  });
  await expect(f.collect()).rejects.toThrow('hash');
  expect(f.context.hash).toHaveBeenCalledTimes(2);
});

it('constructs and checks browser media anew on each invocation without playback', async () => {
  const f = fixture();
  await f.collect();
  await f.collect();
  expect(f.context.document.createElement.mock.calls).toEqual([
    ['video'],
    ['video'],
  ]);
  expect(f.audio).toHaveBeenCalledTimes(24);
});
