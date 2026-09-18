export interface DesktopPluginMime {
  readonly type?: unknown;
  readonly suffixes?: unknown;
}

export interface DesktopPlugin {
  readonly filename?: unknown;
  readonly length: number;
  item(index: number): DesktopPluginMime | null | undefined;
}

export interface DesktopPluginsContext {
  readonly navigator: {
    readonly plugins?: { readonly length: number; item(index: number): DesktopPlugin | null | undefined } | null;
  };
}

/** Z traverses live item/length APIs, keeping the prefix collected before any failure. */
export function collectDesktopPlugins(context: DesktopPluginsContext): { plugin: string[]; pv: '0' } {
  const values: string[] = [];
  try {
    if (context.navigator.plugins && context.navigator.plugins.length) {
      for (let i = 0; i < context.navigator.plugins!.length; i++) {
        const plugin = context.navigator.plugins!.item(i);
        if (plugin && plugin.length) {
          for (let j = 0; j < plugin.length; j++) {
            const mime = plugin.item(j);
            if (mime) {
              // Casts only satisfy TS; concat keeps the original string ToPrimitive hint.
              values.push(''.concat(plugin.filename as string, '|')
                .concat(mime.type as string, '|').concat(mime.suffixes as string));
            }
          }
        }
      }
    }
  } catch { /* Original whole-loop catch retains already pushed values. */ }
  return { plugin: values, pv: '0' };
}
