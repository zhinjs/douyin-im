export interface DesktopDTraitCssNode {
  setAttribute(name: string, value: string): void;
  readonly parentNode?: {
    removeChild(node: DesktopDTraitCssNode): unknown;
  } | null;
}

export interface DesktopDTraitCssContext {
  readonly document: {
    readonly body: { append(node: DesktopDTraitCssNode): void };
    createElement(tag: string): DesktopDTraitCssNode;
  };
  getComputedStyle(node: unknown): Record<string, unknown>;
  hash(value: unknown): number;
  onDiagnostic(code: 'css'): void;
}

/** F209–224. Explicit account-owned DOM only; helper failures intentionally retain undefined fields. */
export function createDesktopDTraitCssCollector(
  context: DesktopDTraitCssContext
) {
  const computed = () => {
    try {
      const style = context.getComputedStyle(context.document.body);
      if (!style) throw new TypeError('invalid argument string');
      const proto = Object.getPrototypeOf(style);
      const prototypeKeys = Object.getOwnPropertyNames(proto);
      const propertyKeys: string[] = [];
      const custom = new RegExp('^--.*$');
      Object.keys(style).forEach(key => {
        const numeric = !isNaN(+key);
        const value = style[key] as string;
        const customKey = custom.test(key);
        const customValue = custom.test(value);
        if (numeric && !customValue) propertyKeys.push(value);
        else if (!numeric && !customKey) propertyKeys.push(key);
      });
      const aliases: Record<string, boolean> = {};
      const upper = new RegExp('[A-Z]', 'g');
      const upperFirst = (value: string) =>
        value.charAt(0).toUpperCase() + value.slice(1);
      const lowerFirst = (value: string) =>
        value.charAt(0).toLowerCase() + value.slice(1);
      propertyKeys.forEach(key => {
        if (aliases[key]) return;
        const hasHyphen = key.indexOf('-') > -1;
        const hasUpper = upper.test(key);
        const first = key.charAt(0);
        const initialHyphen = hasHyphen && first === '-';
        const initialUpper = hasUpper && first === first.toUpperCase();
        key = initialHyphen
          ? key.slice(1)
          : initialUpper
            ? lowerFirst(key)
            : key;
        if (hasHyphen) {
          const camel = key
            .split('-')
            .map((part, index) => (index === 0 ? part : upperFirst(part)))
            .join('');
          if (camel in style) aliases[camel] = true;
          else if (upperFirst(camel) in style)
            aliases[upperFirst(camel)] = true;
        } else if (hasUpper) {
          const dashed = key.replace(upper, letter =>
            '-'.concat(letter.toLowerCase())
          );
          if (dashed in style) aliases[dashed] = true;
          else if ('-'.concat(dashed) in style)
            aliases['-'.concat(dashed)] = true;
        }
      });
      const keys = Array.from(
        new Set([...prototypeKeys, ...propertyKeys, ...Object.keys(aliases)])
      );
      const interfaceName = ''
        .concat(proto)
        .match(new RegExp('\\[object (.+)\\]'))![1];
      return {
        keys: context.hash(keys.join(',')),
        interfaceName: context.hash(interfaceName),
      };
    } catch {
      return undefined;
    }
  };
  const system = () => {
    try {
      const colors = [
        'ActiveBorder',
        'ActiveCaption',
        'ActiveText',
        'AppWorkspace',
        'Background',
        'ButtonBorder',
        'ButtonFace',
        'ButtonHighlight',
        'ButtonShadow',
        'ButtonText',
        'Canvas',
        'CanvasText',
        'CaptionText',
        'Field',
        'FieldText',
        'GrayText',
        'Highlight',
        'HighlightText',
        'InactiveBorder',
        'InactiveCaption',
        'InactiveCaptionText',
        'InfoBackground',
        'InfoText',
        'LinkText',
        'Mark',
        'MarkText',
        'Menu',
        'MenuText',
        'Scrollbar',
        'ThreeDDarkShadow',
        'ThreeDFace',
        'ThreeDHighlight',
        'ThreeDLightShadow',
        'ThreeDShadow',
        'VisitedText',
        'Window',
        'WindowFrame',
        'WindowText',
      ];
      const fonts = [
        'caption',
        'icon',
        'menu',
        'message-box',
        'small-caption',
        'status-bar',
      ];
      const div = context.document.createElement('div');
      context.document.body.append(div);
      const colorValues = colors.map(color => {
        div.setAttribute(
          'style',
          'background-color: '.concat(color, ' !important')
        );
        return { [color]: context.getComputedStyle(div)['backgroundColor'] };
      });
      const fontValues = fonts.map(font => {
        div.setAttribute('style', 'font: '.concat(font, ' !important'));
        const value = context.getComputedStyle(div);
        return {
          [font]: ''
            .concat(value['fontSize'] as string, ' ')
            .concat(value['fontFamily'] as string),
        };
      });
      // Original helper has no finally: DOM ownership must provide eventual realm disposal.
      div?.parentNode?.removeChild(div);
      return {
        colors: context.hash(JSON.stringify(colorValues)),
        fonts: context.hash(JSON.stringify(fontValues)),
      };
    } catch {
      return undefined;
    }
  };
  return (): Record<
    'str_1' | 'str_4' | 'str_5' | 'str_6',
    number | undefined
  > => {
    try {
      const keys = computed();
      const values = system();
      return {
        str_1: keys?.interfaceName,
        str_4: keys?.keys,
        str_5: values?.colors,
        str_6: values?.fonts,
      };
    } catch {
      // Deliberate hosting difference: never log feature values or original error text.
      context.onDiagnostic('css');
      return {
        str_1: context.hash(''),
        str_4: context.hash(''),
        str_5: context.hash(''),
        str_6: context.hash(''),
      };
    }
  };
}
