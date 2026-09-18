export interface DesktopDTraitAudioAnalyser {
  readonly frequencyBinCount: number;
  readonly fftSize: number;
  getFloatFrequencyData(target: Float32Array): void;
  getFloatTimeDomainData(target: Float32Array): void;
}
export interface DesktopDTraitOfflineAudio {
  readonly destination: unknown;
  createAnalyser(): DesktopDTraitAudioAnalyser;
  createOscillator(): {
    type: string;
    readonly frequency: { value: number };
    connect(target: unknown): unknown;
    start(time: number): void;
  };
  createDynamicsCompressor(): {
    readonly threshold: { value: number };
    readonly knee: { value: number };
    readonly attack: { value: number };
    connect(target: unknown): unknown;
  };
  startRendering(): unknown;
  oncomplete:
    | ((event: {
        renderedBuffer: { getChannelData(channel: number): Float32Array };
      }) => void)
    | null;
}
export interface DesktopDTraitAudioContext {
  readonly OfflineAudioContext?:
    | (new (
        channels: number,
        length: number,
        sampleRate: number
      ) => DesktopDTraitOfflineAudio)
    | undefined;
  readonly Date: { now(): number };
  readonly Math: Pick<Math, 'abs'>;
  hash(value: unknown): number;
  onDiagnostic(code: 'audio'): void;
}

/** F155–178: offline synthesis only. Source callback errors/absent completion can leave collection pending. */
export function createDesktopDTraitAudioCollector(
  context: DesktopDTraitAudioContext
) {
  return async (): Promise<
    Record<'str_8' | 'str_9' | 'str_20' | 'str_25', number>
  > => {
    try {
      context.Date.now(); // Original reads this even though the recorded start time is never consumed.
      const Audio = context.OfflineAudioContext!;
      const audio = new Audio(1, 5000, 44100);
      const analyser = audio.createAnalyser();
      const oscillator = audio.createOscillator();
      const compressor = audio.createDynamicsCompressor();
      oscillator.type = 'triangle';
      oscillator.frequency.value = 10000;
      compressor.threshold.value = -50;
      compressor.knee.value = 40;
      compressor.attack.value = 0;
      oscillator.connect(compressor);
      compressor.connect(analyser);
      compressor.connect(audio.destination);
      oscillator.start(0);
      audio.startRendering(); // Source does not consume this return value; do not await it before registering completion.
      return new Promise(resolve => {
        audio.oncomplete = event => {
          const buffer = event.renderedBuffer;
          const frequency = new Float32Array(analyser.frequencyBinCount);
          const time = new Float32Array(analyser.fftSize);
          analyser.getFloatFrequencyData(frequency);
          analyser.getFloatTimeDomainData(time);
          const frequencySum = [...frequency].reduce(
            (sum, value) => sum + context.Math.abs(value),
            0
          );
          const timeSum = [...time].reduce(
            (sum, value) => sum + context.Math.abs(value),
            0
          );
          const first100 = frequency
            .slice(0, 100)
            .reduce((sum, value) => sum + context.Math.abs(value), 0);
          const unique = new Set(buffer.getChannelData(0))?.size;
          resolve({
            str_8: context.hash(''.concat((frequencySum || '') as string)),
            str_9: context.hash(''.concat((timeSum || '') as string)),
            str_20: context.hash(''.concat((first100 || '') as string)),
            str_25: context.hash(''.concat((unique || '') as string)),
          });
        };
      });
    } catch {
      // Diagnostics are redacted, while the original synchronous fallback and four separate hashes remain.
      context.onDiagnostic('audio');
      return {
        str_8: context.hash(''),
        str_9: context.hash(''),
        str_20: context.hash(''),
        str_25: context.hash(''),
      };
    }
  };
}
