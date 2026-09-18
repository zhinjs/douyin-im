import {
  DesktopDTraitCollector,
  type DesktopDTraitCollectionPlugins,
} from './desktop-dtrait-collector.js';
import { createDesktopDTraitHash } from './desktop-dtrait-features.js';
import {
  createDesktopDTraitCore,
  type DesktopDTraitCoreContext,
  type DesktopDTraitCoreRealmState,
} from './desktop-dtrait-request-core.js';
import {
  createDesktopDTraitBoolCollector,
  type DesktopDTraitBoolContext,
} from './desktop-dtrait-bool.js';
import {
  createDesktopDTraitEnvironmentCollector,
  type DesktopDTraitEnvironmentContext,
} from './desktop-dtrait-environment.js';
import {
  createDesktopDTraitCanvasCollector,
  createDesktopDTraitDomCollector,
  type DesktopDTraitCanvasContext,
  type DesktopDTraitDomContext,
} from './desktop-dtrait-rendering.js';
import {
  createDesktopDTraitCssCollector,
  type DesktopDTraitCssContext,
} from './desktop-dtrait-css.js';
import {
  createDesktopDTraitMediaCollector,
  type DesktopDTraitMediaContext,
} from './desktop-dtrait-media.js';
import {
  createDesktopDTraitSpeechCollector,
  type DesktopDTraitSpeechContext,
} from './desktop-dtrait-speech.js';
import {
  createDesktopDTraitSvgCollector,
  type DesktopDTraitSvgContext,
} from './desktop-dtrait-svg.js';
import { createDesktopDTraitMathCollector } from './desktop-dtrait-math.js';
import {
  createDesktopDTraitWebGLCollector,
  type DesktopDTraitWebGLContext,
} from './desktop-dtrait-webgl.js';
import {
  createDesktopDTraitFontsCollector,
  type DesktopDTraitFontsContext,
} from './desktop-dtrait-fonts.js';
import {
  createDesktopDTraitAudioCollector,
  type DesktopDTraitAudioContext,
} from './desktop-dtrait-audio.js';
import {
  createDesktopDTraitTransportInstaller,
  type DesktopDTraitTransportRealm,
} from './desktop-dtrait-transport.js';

/** Structural browser boundary: accepts a real Window without requiring DOM globals in Node consumers. */
export interface DesktopDTraitBrowserRealm {
  readonly document: {
    readonly body: unknown;
    createElement(tag: string): unknown;
    createElementNS(namespace: string, tag: string): unknown;
    createDocumentFragment(): unknown;
    getElementById(id: string): unknown;
    querySelector(selector: string): unknown;
    querySelectorAll(selector: string): unknown;
    getElementsByClassName(name: string): unknown;
    createEvent(name: string): unknown;
    readonly fonts: unknown;
  };
  readonly navigator: DesktopDTraitBoolContext['navigator'] &
    DesktopDTraitEnvironmentContext['navigator'] & {
      readonly platform: unknown;
    };
  readonly window: DesktopDTraitEnvironmentContext['window'] & {
    gc?: (() => void) | undefined;
  };
  readonly screen: DesktopDTraitEnvironmentContext['screen'];
  readonly Math: Math;
  readonly Date: { now(): number };
  readonly performance: { now(): number };
  readonly TextEncoder: new () => { encode(value?: string): Uint8Array };
  readonly Audio: DesktopDTraitMediaContext['Audio'];
  readonly FontFace: DesktopDTraitFontsContext['FontFace'];
  readonly OfflineAudioContext?:
    | (new (channels: number, length: number, sampleRate: number) => unknown)
    | undefined;
  readonly RTCPeerConnection?: DesktopDTraitBoolContext['RTCPeerConnection'];
  readonly speechSynthesis?: DesktopDTraitSpeechContext['speechSynthesis'];
  readonly MediaSource?: DesktopDTraitMediaContext['MediaSource'];
  readonly MediaRecorder?: DesktopDTraitMediaContext['MediaRecorder'];
  getComputedStyle(node: unknown): unknown;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
  parseInt(value: string, radix: number): number;
  parseFloat(value: string): number;
  atob(value: string): string;
  btoa(value: string): string;
}

/** Installs all twelve real collectors, but performs no collection or network request until collect/start is called. */
export function createDesktopDTraitBrowserCollector(
  realm: DesktopDTraitBrowserRealm
) {
  const realmState: DesktopDTraitCoreRealmState = {
    hookLogCount: 0,
    collectionCount: 0,
    collectionErrors: [],
  };
  const diagnostic = (name: string) => {
    realmState.collectionErrors.push({ name });
  };
  const hash = createDesktopDTraitHash({
    encoder: new realm.TextEncoder(),
    onDiagnostic: diagnostic,
  });
  // The casts narrow native DOM operations to each collector's known element kind. No node wrappers/copies or capability defaults.
  const common = {
    get navigator() {
      return realm.navigator;
    },
    get window() {
      return realm.window;
    },
    get screen() {
      return realm.screen;
    },
    get Math() {
      return realm.Math;
    },
    get Date() {
      return realm.Date;
    },
    setTimeout: (callback: () => void, delay: number) =>
      realm.setTimeout(callback, delay),
    clearTimeout: (timer: unknown) => realm.clearTimeout(timer),
    parseInt: (value: string, radix: number) => realm.parseInt(value, radix),
    parseFloat: (value: string) => realm.parseFloat(value),
    hash,
    onDiagnostic: diagnostic,
  };
  // Preserve lazy browser property reads: object spread would invoke shared getters during module assembly.
  const bind = <T extends object>(own: T): T & typeof common =>
    Object.defineProperties(
      own,
      Object.getOwnPropertyDescriptors(common)
    ) as T & typeof common;
  const plugins: DesktopDTraitCollectionPlugins = {
    boolFeature: createDesktopDTraitBoolCollector(
      bind({
        get document() {
          return realm.document as DesktopDTraitBoolContext['document'];
        },
        get RTCPeerConnection() {
          return realm.RTCPeerConnection;
        },
      })
    ),
    strFeature: createDesktopDTraitEnvironmentCollector(common),
    canvas: createDesktopDTraitCanvasCollector(
      bind({
        get document() {
          return realm.document as DesktopDTraitCanvasContext['document'];
        },
      })
    ),
    audio: createDesktopDTraitAudioCollector(
      bind({
        get OfflineAudioContext() {
          return realm.OfflineAudioContext as DesktopDTraitAudioContext['OfflineAudioContext'];
        },
      })
    ),
    css: createDesktopDTraitCssCollector(
      bind({
        get document() {
          return realm.document as DesktopDTraitCssContext['document'];
        },
        getComputedStyle: (node: unknown) =>
          realm.getComputedStyle(node) as Record<string, unknown>,
      })
    ),
    domRect: createDesktopDTraitDomCollector(
      bind({
        get document() {
          return realm.document as DesktopDTraitDomContext['document'];
        },
      })
    ),
    mediaTypes: createDesktopDTraitMediaCollector(
      bind({
        get document() {
          return realm.document as DesktopDTraitMediaContext['document'];
        },
        get Audio() {
          return realm.Audio;
        },
        get MediaSource() {
          return realm.MediaSource;
        },
        get MediaRecorder() {
          return realm.MediaRecorder;
        },
      })
    ),
    speech: createDesktopDTraitSpeechCollector(
      bind({
        get speechSynthesis() {
          return realm.speechSynthesis;
        },
      })
    ),
    svgRect: createDesktopDTraitSvgCollector(
      bind({
        get document() {
          return realm.document as DesktopDTraitSvgContext['document'];
        },
      })
    ),
    math: createDesktopDTraitMathCollector(common),
    webGL: createDesktopDTraitWebGLCollector(
      bind({
        get document() {
          return realm.document as DesktopDTraitWebGLContext['document'];
        },
      })
    ),
    fonts: createDesktopDTraitFontsCollector(
      bind({
        get document() {
          return realm.document as DesktopDTraitFontsContext['document'];
        },
        get FontFace() {
          return realm.FontFace;
        },
        getComputedStyle: (node: unknown) =>
          realm.getComputedStyle(node) as ReturnType<
            DesktopDTraitFontsContext['getComputedStyle']
          >,
      })
    ),
  };
  return {
    collector: new DesktopDTraitCollector(common, plugins),
    hash,
    realmState,
  };
}

export interface DesktopDTraitBrowserCoreOptions {
  readonly crypto: DesktopDTraitCoreContext['crypto'];
  readonly getCryptoUtil: DesktopDTraitCoreContext['featureContext']['getCryptoUtil'];
  installHooks?: DesktopDTraitCoreContext['installHooks'];
  onBackgroundError?: DesktopDTraitCoreContext['onBackgroundError'];
}

/** Browser-owned assembly; transport/crypto must come from this same account realm. Not installed into default login. */
export function createDesktopDTraitBrowserCore(
  realm: DesktopDTraitBrowserRealm & DesktopDTraitTransportRealm,
  options: DesktopDTraitBrowserCoreOptions
): ReturnType<typeof createDesktopDTraitCore>;
export function createDesktopDTraitBrowserCore(
  realm: DesktopDTraitBrowserRealm,
  options: DesktopDTraitBrowserCoreOptions & {
    installHooks: DesktopDTraitCoreContext['installHooks'];
  }
): ReturnType<typeof createDesktopDTraitCore>;
export function createDesktopDTraitBrowserCore(
  realm: DesktopDTraitBrowserRealm,
  options: DesktopDTraitBrowserCoreOptions
) {
  const { collector, hash, realmState } =
    createDesktopDTraitBrowserCollector(realm);
  const installHooks =
    options.installHooks ??
    createDesktopDTraitTransportInstaller(
      realm as DesktopDTraitBrowserRealm & DesktopDTraitTransportRealm,
      { onBackgroundError: error => options.onBackgroundError?.(error) }
    );
  return createDesktopDTraitCore({
    get Date() {
      return realm.Date;
    },
    get performance() {
      return realm.performance;
    },
    atob: value => realm.atob(value),
    setTimeout: (callback, delay) => realm.setTimeout(callback, delay),
    crypto: options.crypto,
    featureContext: {
      hash,
      btoa: value => realm.btoa(value),
      getCryptoUtil: options.getCryptoUtil,
    },
    collect: () => collector.collect(),
    realmState,
    installHooks,
    onBackgroundError: error => options.onBackgroundError?.(error),
  });
}
