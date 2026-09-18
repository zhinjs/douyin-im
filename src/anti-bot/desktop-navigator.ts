import { setDesktopProperty } from './desktop-property-write.js';
import type { DesktopPropertyClassifier } from './desktop-device-properties.js';

type TextField = 'appCodeName' | 'appMinorVersion' | 'appName' | 'appVersion' | 'buildID' |
  'cpuClass' | 'deviceMemory' | 'doNotTrack' | 'language' | 'languages' | 'msDoNotTrack' |
  'oscpu' | 'platform' | 'product' | 'productSub' | 'systemLanguage' | 'userLanguage' |
  'vendor' | 'vendorSub' | 'webdriver';
type ClassifiedField = 'bluetooth' | 'cookieEnabled' | 'credentials' | 'requestMediaKeySystemAccess' | 'storage' | 'vibrate';
type FloorField = 'hardwareConcurrency' | 'maxTouchPoints';

export interface DesktopNavigatorContext {
  readonly navigator: Partial<Record<TextField | ClassifiedField | FloorField, unknown>>;
  readonly document: { createEvent?(name: string): unknown };
  readonly window: object;
  readonly Math: { floor(value: number): number };
}

/** J shares the same G instance as document V; it does not capture a navigator snapshot. */
export class DesktopNavigatorCollector {
  private readonly math: DesktopNavigatorContext['Math'];
  constructor(private readonly context: DesktopNavigatorContext, private readonly properties: DesktopPropertyClassifier) {
    this.math = context.Math;
  }

  // Original PC32 helper has context lifetime and can itself become J's return value.
  private readonly touchstart = () => {
    try { return 'ontouchstart' in this.context.window ? 1 : 2; } catch { return 2; }
  };

  collect(): unknown {
    let result: unknown = {};
    const put = (key: string, value: unknown) => {
      if (result === null || result === undefined) throw new TypeError(`Cannot set properties of ${result}`);
      // Strict bundle writes reject primitive aliases and refused properties.
      setDesktopProperty(Object(result), key, value, result);
    };
    const text = (key: TextField) => put(key, (this.context.navigator[key] as string) + '');
    const classify = (key: ClassifiedField) => put(key, this.properties.classify(this.context.navigator, key));
    const floor = (key: FloorField) => put(key, this.context.navigator[key]
      ? this.math.floor(this.context.navigator[key] as number) : -1);
    text('appCodeName');
    text('appMinorVersion');
    text('appName');
    text('appVersion');
    classify('bluetooth');
    text('buildID');
    classify('cookieEnabled');
    text('cpuClass');
    classify('credentials');
    text('deviceMemory');
    text('doNotTrack');
    floor('hardwareConcurrency');
    text('language');
    text('languages');
    floor('maxTouchPoints');
    text('msDoNotTrack');
    text('oscpu');
    text('platform');
    text('product');
    text('productSub');
    classify('requestMediaKeySystemAccess');
    classify('storage');
    text('systemLanguage');

    // Keep the VM's exceptional operand-stack aliases, not merely helper return codes.
    let document: DesktopNavigatorContext['document'];
    let touchEvent = 2;
    try { document = this.context.document; } catch { result = null; }
    if (result !== null) {
      let createEvent: DesktopNavigatorContext['document']['createEvent'];
      let read = false;
      try { createEvent = document!.createEvent; read = true; } catch { result = document!; }
      if (read) {
        try { Reflect.apply(createEvent!, document!, ['TouchEvent']); touchEvent = 1; } catch { /* Probe failed. */ }
      }
    }
    put('touchEvent', touchEvent);

    let window: object;
    let read = false;
    let touchstart = 2;
    try { window = this.context.window; read = true; } catch { result = this.touchstart; }
    if (read) {
      try { touchstart = 'ontouchstart' in window! ? 1 : 2; } catch { result = 'ontouchstart'; }
    }
    put('touchstart', touchstart);
    text('userLanguage');
    text('vendor');
    text('vendorSub');
    classify('vibrate');
    text('webdriver');
    return result;
  }
}
