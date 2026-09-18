/** Values from one execution context; no fabricated screen or platform defaults. */
export interface DesktopFingerprintContext {
  readonly window: {
    readonly innerWidth?: number;
    readonly innerHeight?: number;
    readonly outerWidth?: number;
    readonly outerHeight?: number;
    readonly screenX?: number;
    readonly screenY?: number;
    readonly pageYOffset?: number;
    readonly screen: {
      readonly availWidth?: number;
      readonly availHeight?: number;
      readonly width?: number;
      readonly height?: number;
      readonly colorDepth?: number;
      readonly pixelDepth?: number;
      readonly orientation?: { readonly type?: string; readonly angle?: number } | null;
    };
  };
  readonly document: { readonly body?: { readonly clientWidth?: number | undefined; readonly clientHeight?: number | undefined } | null | undefined };
  readonly navigator: { readonly platform?: string };
}

export type DesktopScreenContext = Pick<DesktopFingerprintContext, 'window' | 'document'>;

/** BDMS .7 Y(): base geometry shared by the fingerprint and report screen. */
export function collectDesktopScreenGeometry(context: DesktopScreenContext) {
  // The original applies >> 0 even to absent fields (undefined becomes zero).
  const int32 = (value: number | undefined): number => (value as number) >> 0;
  return {
    innerWidth: int32(context.window.innerWidth), innerHeight: int32(context.window.innerHeight),
    outerWidth: int32(context.window.outerWidth), outerHeight: int32(context.window.outerHeight),
    screenX: int32(context.window.screenX), screenY: int32(context.window.screenY),
    // Both fields intentionally read pageYOffset, matching the installed source.
    pageXOffset: int32(context.window.pageYOffset), pageYOffset: int32(context.window.pageYOffset),
    availWidth: int32(context.window.screen.availWidth), availHeight: int32(context.window.screen.availHeight),
    sizeWidth: int32(context.window.screen.width), sizeHeight: int32(context.window.screen.height),
    clientWidth: context.document.body ? int32(context.document.body.clientWidth) : -1,
    clientHeight: context.document.body ? int32(context.document.body.clientHeight) : -1,
    colorDepth: int32(context.window.screen.colorDepth), pixelDepth: int32(context.window.screen.pixelDepth),
  };
}

/** X(): reports use the same Y geometry plus the original misspelled orientation keys. */
export function collectDesktopReportScreen(context: DesktopScreenContext) {
  return {
    ...collectDesktopScreenGeometry(context),
    orientaionType: context.window.screen?.orientation?.type || '',
    orientaionAngle: (context.window.screen?.orientation?.angle as number) >> 0,
  };
}

/** BDMS 1.0.1.7 Y() and core string serialization. Does not read global browser state. */
export function buildDesktopFingerprint(context: DesktopFingerprintContext): string {
  return [...Object.values(collectDesktopScreenGeometry(context)), context.navigator.platform].map(value => String(value)).join('|');
}
