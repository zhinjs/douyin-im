export interface DesktopDTraitEnvironmentNavigator {
  connection?: { downlink?: unknown; effectiveType?: unknown } | null;
  language?: unknown;
  languages?: { join(separator: string): string } | null;
  vendor?: unknown;
  userAgent?: unknown;
  deviceMemory?: unknown;
  hardwareConcurrency?: unknown;
  maxTouchPoints?: unknown;
  msMaxTouchPoints?: unknown;
  plugins?: unknown;
  mimeTypes?: unknown;
}

export interface DesktopDTraitEnvironmentContext {
  readonly navigator: DesktopDTraitEnvironmentNavigator;
  readonly window: {
    Intl?: {
      DateTimeFormat(): {
        resolvedOptions(): { locale?: unknown; timeZone?: unknown } | null;
      } | null;
    } | null;
    Notification?: { permission?: unknown } | null;
    devicePixelRatio?: unknown;
  };
  readonly screen: {
    availHeight?: unknown;
    availLeft?: unknown;
    availTop?: unknown;
    availWidth?: unknown;
    height?: unknown;
    width?: unknown;
    colorDepth?: unknown;
    pixelDepth?: unknown;
  };
  parseInt(value: string, radix: number): number;
  hash(value: unknown): number;
  onDiagnostic(code: 'str'): void;
}

export type DesktopDTraitEnvironmentFeature =
  | 'str_14'
  | 'str_15'
  | 'str_16'
  | 'str_18'
  | 'str_19'
  | 'str_29'
  | 'str_27'
  | 'str_28'
  | 'str_30'
  | 'str_31'
  | 'str_32';

/** F286–290: collect live realm properties; no profile constants or inferred defaults. */
export function createDesktopDTraitEnvironmentCollector(
  context: DesktopDTraitEnvironmentContext
) {
  const touchPoints = () => {
    const navigator = context.navigator;
    let value: unknown = 0;
    if (navigator.maxTouchPoints !== undefined)
      value = context.parseInt(
        ''.concat(navigator.maxTouchPoints as string),
        10
      );
    else if (navigator.msMaxTouchPoints !== undefined)
      value = navigator.msMaxTouchPoints;
    return value;
  };
  const arrayValues = (items: unknown, key: 'name' | 'type'): unknown[] => {
    // Source explicitly requires Array.isArray, even for browser PluginArray/MimeTypeArray.
    if (!items || !Array.isArray(items) || !items?.length) return [];
    const values: unknown[] = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!item) continue;
      values.push(item[key]);
    }
    return values;
  };
  return (): Record<DesktopDTraitEnvironmentFeature, number> => {
    try {
      return {
        str_14: context.hash(
          ''
            .concat(context.navigator.connection?.downlink as string, ',')
            .concat(context.navigator.connection?.effectiveType as string)
        ),
        str_15: context.hash(
          ''
            .concat(context.navigator?.language as string, ',')
            .concat(context.navigator?.languages?.join(',') as string)
        ),
        str_16: context.hash(
          ''
            .concat(
              arrayValues(context.navigator.mimeTypes, 'type')?.join(','),
              ','
            )
            .concat(context.navigator?.vendor as string)
        ),
        str_18: context.hash(
          arrayValues(context.navigator.plugins, 'name')?.join(',')
        ),
        str_19: context.hash(''.concat(context.navigator?.userAgent as string)),
        str_29: context.hash(
          ''
            .concat(touchPoints() as string, ',')
            .concat(context.navigator?.deviceMemory as string, ',')
            .concat(context.navigator?.hardwareConcurrency as string, ',')
            .concat(context.navigator?.maxTouchPoints as string)
        ),
        // Two separate calls are intentional: locale and timeZone are not read from one cached object.
        str_27: context.hash(
          ''
            .concat(
              context.window?.Intl?.DateTimeFormat()?.resolvedOptions()
                ?.locale as string,
              '+'
            )
            .concat(
              context.window?.Intl?.DateTimeFormat()?.resolvedOptions()
                ?.timeZone as string
            )
        ),
        str_28: context.hash(context.window?.Notification?.permission),
        str_30: context.hash(
          ''
            .concat(context.screen.availHeight as string, ',')
            .concat(context.screen.availLeft as string, ',')
            .concat(context.screen.availTop as string, ',')
            .concat(context.screen.availWidth as string)
        ),
        str_31: context.hash(
          ''
            .concat(context.screen.height as string, ',')
            .concat(context.screen.width as string)
        ),
        str_32: context.hash(
          ''
            .concat(context.screen.colorDepth as string, ',')
            .concat(context.screen.pixelDepth as string, ',')
            .concat(context.window.devicePixelRatio as string)
        ),
      };
    } catch {
      // Source abandons all prior fields, not just the failed one. Diagnostic payload is deliberately redacted.
      context.onDiagnostic('str');
      return {
        str_14: context.hash(''),
        str_15: context.hash(''),
        str_16: context.hash(''),
        str_18: context.hash(''),
        str_19: context.hash(''),
        str_29: context.hash(''),
        str_27: context.hash(''),
        str_28: context.hash(''),
        str_30: context.hash(''),
        str_31: context.hash(''),
        str_32: context.hash(''),
      };
    }
  };
}
