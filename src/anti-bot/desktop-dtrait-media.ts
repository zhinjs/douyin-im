export interface DesktopDTraitMediaContext {
  readonly document: {
    createElement(tag: string): { canPlayType(type: string): unknown };
  };
  readonly Audio: new () => { canPlayType(type: string): unknown };
  readonly window: object;
  readonly MediaSource?: { isTypeSupported(type: string): unknown } | undefined;
  readonly MediaRecorder?:
    | { isTypeSupported(type: string): unknown }
    | undefined;
  hash(value: unknown): number;
  /** The source reports the original error; SDK diagnostics omit environment/error contents. */
  onDiagnostic(code: 'md'): void;
}

/** F232–252. Requires browser APIs, checks support only: never sets media URLs or starts playback. */
export function createDesktopDTraitMediaCollector(
  context: DesktopDTraitMediaContext
): () => Promise<{ str_13: number | string }> {
  function supported() {
    try {
      // F250 calls F246 each time; F232 stores that function, not the sorted array.
      const types = [
        'audio/ogg; codecs="vorbis"',
        'audio/mpeg',
        'audio/mpegurl',
        'audio/wav; codecs="1"',
        'audio/x-m4a',
        'audio/aac',
        'video/ogg; codecs="theora"',
        'video/quicktime',
        'video/mp4; codecs="avc1.42E01E"',
        'video/webm; codecs="vp8"',
        'video/webm; codecs="vp9"',
        'video/x-matroska',
      ].sort();
      const video = context.document.createElement('video'),
        audio = new context.Audio();
      const recorderPresent = 'MediaRecorder' in context.window;
      return types.reduce<{ mimeType: string }[]>((items, mimeType) => {
        const item = {
          mimeType,
          audioPlayType: audio.canPlayType(mimeType),
          videoPlayType: video.canPlayType(mimeType),
          mediaSource: context.MediaSource!.isTypeSupported(mimeType),
          mediaRecorder: recorderPresent
            ? context.MediaRecorder!.isTypeSupported(mimeType)
            : false,
        };
        if (
          !item.audioPlayType &&
          !item.videoPlayType &&
          !item.mediaSource &&
          !item.mediaRecorder
        )
          return items;
        items.push(item);
        return items;
      }, []);
    } catch {
      return undefined;
    }
  }
  return async () => {
    try {
      const items = supported();
      return {
        str_13: Array.isArray(items)
          ? context.hash(items.map(item => item.mimeType).join(','))
          : '',
      };
    } catch {
      context.onDiagnostic('md');
      return { str_13: context.hash('') };
    }
  };
}
