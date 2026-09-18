import type { DesktopPropertyClassifier } from './desktop-device-properties.js';

type ClassifiedField = 'ActiveXObject' | 'BluetoothUUID' | 'external' | 'Image' | 'indexDB' |
  'isSecureContext' | 'localStorage' | 'locationbar' | 'mozRTCPeerConnection' | 'netscape' |
  'postMessage' | 'sessionStorage' | 'toolbar' | 'webkitRequestAnimationFrame';

export interface DesktopWindowContext {
  readonly window: Partial<Record<ClassifiedField, unknown>> & {
    readonly devicePixelRatio?: unknown;
    readonly location?: { readonly href?: unknown } | null;
  };
  readonly Math: { floor(value: number): number };
}

/** $ uses cross-VM G classification; caught property reads never alias its result to window. */
export class DesktopWindowCollector {
  private readonly math: DesktopWindowContext['Math'];
  constructor(private readonly context: DesktopWindowContext, private readonly properties: DesktopPropertyClassifier) {
    this.math = context.Math;
  }

  collect() {
    const classify = (key: ClassifiedField) => this.properties.classify(this.context.window, key);
    return {
      ActiveXObject: classify('ActiveXObject'),
      BluetoothUUID: classify('BluetoothUUID'),
      devicePixelRatio: this.context.window.devicePixelRatio ? this.math.floor(this.context.window.devicePixelRatio as number) : -1,
      external: classify('external'),
      Image: classify('Image'),
      indexDB: classify('indexDB'),
      isSecureContext: classify('isSecureContext'),
      localStorage: classify('localStorage'),
      location: this.context.window.location?.href || '',
      locationbar: classify('locationbar'),
      mozRTCPeerConnection: classify('mozRTCPeerConnection'),
      netscape: classify('netscape'),
      postMessage: classify('postMessage'),
      sessionStorage: classify('sessionStorage'),
      toolbar: classify('toolbar'),
      webkitRequestAnimationFrame: classify('webkitRequestAnimationFrame'),
    };
  }
}
