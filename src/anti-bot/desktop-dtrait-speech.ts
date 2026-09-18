export interface DesktopDTraitVoice {
  voiceURI?: unknown;
  name?: unknown;
  lang?: unknown;
  localService?: unknown;
  default?: unknown;
}
export interface DesktopDTraitSpeechContext {
  readonly window: object;
  readonly speechSynthesis?:
    | {
        getVoices(): DesktopDTraitVoice[] | null | undefined;
        addEventListener?(type: string, listener: () => void): unknown;
        onvoiceschanged?: unknown;
      }
    | undefined;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  hash(value: unknown): number;
  /** Raw exception/voice data is never sent to diagnostics. */
  onDiagnostic(
    code: 'speech',
    reason: '!supported' | 'timeout' | 'error'
  ): void;
}

/** F253–285: no settled guard/listener removal in source. Bind only to an account-owned disposable realm. */
export function createDesktopDTraitSpeechCollector(
  context: DesktopDTraitSpeechContext
): () => Promise<{ str_23: number; str_22: number }> {
  const empty = () => ({ str_23: context.hash(''), str_22: context.hash('') });
  return async () => {
    await new Promise<void>(resolve => context.setTimeout(() => resolve(), 50));
    return new Promise(resolve => {
      try {
        if (!('speechSynthesis' in context.window)) {
          context.onDiagnostic('speech', '!supported');
          resolve(empty());
          return;
        }
        context.speechSynthesis!.getVoices();
        const timer = context.setTimeout(() => {
          context.onDiagnostic('speech', 'timeout');
          resolve(empty());
        }, 300);
        const changed = () => {
          const voices = context.speechSynthesis!.getVoices();
          const local = (voices || []).find(voice => voice.localService);
          if (!voices || !voices.length || !local) return;
          context.clearTimeout(timer);
          const seen = new Set<unknown>();
          const unique = voices.filter(voice => {
            if (seen.has(voice.voiceURI)) return false;
            seen.add(voice.voiceURI);
            return true;
          });
          const localNames = unique
            .filter(voice => voice.localService)
            .map(voice => voice.name);
          const remoteNames = unique
            .filter(voice => !voice.localService)
            .map(voice => voice.name);
          const languages = [...new Set(unique.map(voice => voice.lang))];
          const defaults = unique.filter(
            voice => voice.default && voice.localService
          );
          let defaultName: unknown = '',
            defaultLang: unknown = '';
          if (defaults.length === 1) {
            defaultName = defaults[0]!.name;
            defaultLang = ((defaults[0]!.lang || '') as string).replace(
              new RegExp('_'),
              '-'
            );
          }
          resolve({
            str_23: context.hash(
              ''
                .concat((languages || []).join(','), ',')
                .concat((localNames || []).join(','))
            ),
            str_22: context.hash(
              ''
                .concat(defaultLang as string, ',')
                .concat(defaultName as string, ',')
                .concat((remoteNames || []).join(','))
            ),
          });
        };
        changed();
        // Registration occurs even after synchronous success, exactly as source. Realm owner must eventually release it.
        if (context.speechSynthesis!.addEventListener)
          context.speechSynthesis!.addEventListener('voiceschanged', changed);
        else context.speechSynthesis!.onvoiceschanged = changed;
      } catch {
        context.onDiagnostic('speech', 'error');
        resolve(empty());
      }
    });
  };
}
