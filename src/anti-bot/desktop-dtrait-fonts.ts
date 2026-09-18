import {
  APPLE_FONTS,
  CANDIDATE_FONTS,
  EMOJI,
  FONT_STYLE,
  WINDOWS_FONTS,
} from './desktop-dtrait-font-data.js';

export interface DesktopDTraitFontNode {
  id: string;
  className: string;
  textContent: string | null;
  readonly firstChild: DesktopDTraitFontNode | null;
  readonly parentNode: DesktopDTraitFontNode | null;
  setAttribute(name: string, value: string): void;
  appendChild(node: DesktopDTraitFontNode): unknown;
  removeChild(node: DesktopDTraitFontNode): unknown;
  replaceChild(
    node: DesktopDTraitFontNode,
    old: DesktopDTraitFontNode
  ): unknown;
}
export interface DesktopDTraitFontFace {
  readonly family: string;
  load(): Promise<DesktopDTraitFontFace>;
}
export interface DesktopDTraitFontsContext {
  readonly document: {
    readonly body: DesktopDTraitFontNode;
    readonly fonts: { check(font: string): boolean };
    createElement(tag: string): DesktopDTraitFontNode;
    createDocumentFragment(): DesktopDTraitFontNode;
    getElementById(id: string): DesktopDTraitFontNode | null;
    querySelectorAll(
      selector: string
    ): ArrayLike<DesktopDTraitFontNode> | Iterable<DesktopDTraitFontNode>;
  };
  readonly navigator: { readonly platform: unknown };
  readonly window: { gc?: (() => void) | undefined };
  readonly Math: Pick<Math, 'random'>;
  readonly FontFace: new (
    family: string,
    source: string
  ) => DesktopDTraitFontFace;
  getComputedStyle(node: DesktopDTraitFontNode): {
    inlineSize: unknown;
    blockSize: unknown;
  };
  parseFloat(value: string): number;
  hash(value: unknown): number;
  onDiagnostic(code: 'ft' | 'font-detection'): void;
}

function systemVersion(fonts: readonly string[]): string | undefined {
  const windows: Record<string, unknown> = {
    '11': WINDOWS_FONTS['11'].find(font => fonts.includes(font)),
    '10': WINDOWS_FONTS['10'].find(font => fonts.includes(font)),
    '8.1': WINDOWS_FONTS['8.1'].find(font => fonts.includes(font)),
    '8': WINDOWS_FONTS['8'].find(font => fonts.includes(font)),
    '7': WINDOWS_FONTS['7'].every(font => fonts.includes(font)),
  };
  const signature = Object.keys(windows)
    .sort()
    .filter(key => Boolean(windows[key]))
    .join(',');
  const windowsVersions: Record<string, string> = {
    '10,11,7,8,8.1': '11',
    '10,7,8,8.1': '10',
    '7,8,8.1': '8.1',
  };
  if (windowsVersions[signature])
    return 'Windows '.concat(windowsVersions[signature]!);
  const apple: Record<string, unknown> = {
    '13': APPLE_FONTS['13'].find(font => fonts.includes(font)),
    '12': APPLE_FONTS['12'].find(font => fonts.includes(font)),
    '10.15-11': APPLE_FONTS['10.15-11'].find(font => fonts.includes(font)),
  };
  const appleSignature = Object.keys(apple)
    .sort()
    .filter(key => Boolean(apple[key]))
    .join(',');
  // F358's lookup contains more keys than its three checks can produce. Preserve this source behavior.
  const appleVersions: Record<string, string> = {
    '10.10,10.11,10.12,10.13-10.14,10.15-11,10.9,12,13': 'Ventura',
    '10.10,10.11,10.12,10.13-10.14,10.15-11,10.9,12': 'Monterey',
  };
  return appleVersions[appleSignature]
    ? 'macOS '.concat(appleVersions[appleSignature]!)
    : undefined;
}

/** F309–365 public collector path. Use an account-owned isolated document: original cleanup leaves the style node. */
export function createDesktopDTraitFontsCollector(
  context: DesktopDTraitFontsContext
) {
  const detect = async () => {
    try {
      const random =
        String.fromCharCode(context.Math.random() * 26 + 97) +
        context.Math.random().toString(36).slice(-7);
      if (!context.document.fonts.check('0px "'.concat(random, '"')))
        return CANDIDATE_FONTS.filter(font =>
          context.document.fonts.check('0px "'.concat(font, '"'))
        );
      const faces = CANDIDATE_FONTS.map(
        font => new context.FontFace(font, 'local("'.concat(font, '")'))
      );
      const loaded = await Promise.all(
        faces.map(face => face.load().catch(() => null))
      );
      return loaded?.filter(face => face !== null).map(face => face?.family);
    } catch {
      context.onDiagnostic('font-detection');
      return [];
    }
  };
  return async (): Promise<
    Record<'str_10' | 'str_17' | 'str_7' | 'str_21', number>
  > => {
    let root: DesktopDTraitFontNode | null = null;
    let container: DesktopDTraitFontNode | null = null;
    try {
      const document = context.document;
      root = document.createElement('div');
      root.setAttribute('id', 'font-fingerprint');
      document.body.appendChild(root);
      const emojiFragment = context.document.createDocumentFragment();
      EMOJI.forEach(text => {
        const node = context.document.createElement('div');
        node.className = 'pixel-emoji';
        node.textContent = text;
        emojiFragment.appendChild(node);
      });
      const style = context.document.createElement('style');
      style.textContent =
        '\n      .pixel-emoji {\n        font-family: '.concat(
          FONT_STYLE,
          ';\n        font-size: 200px !important;\n        height: auto;\n        position: absolute !important;\n        transform: scale(1.000999);\n      }\n    '
        );
      const fragment = context.document.createDocumentFragment();
      fragment.appendChild(style);
      container = context.document.createElement('div');
      container.id = 'pixel-emoji-container';
      container.appendChild(emojiFragment);
      fragment.appendChild(container);
      const found = document.getElementById('font-fingerprint');
      if (found) found.parentNode?.replaceChild(fragment, found);
      const nodes = Array.from(document.querySelectorAll('.pixel-emoji'));
      const sizes = new Set<string>(),
        emojiSet = new Set<string | undefined>();
      nodes.forEach((node, index) => {
        const measured = context.getComputedStyle(node);
        const emoji = EMOJI[index];
        const size = ''
          .concat(measured.inlineSize as string, ',')
          .concat(measured.blockSize as string);
        if (!sizes.has(size)) {
          sizes.add(size);
          emojiSet.add(emoji);
        }
      });
      const sum =
        [...sizes]
          .map(size =>
            size
              .split(',')
              .map(value => context.parseFloat(value))
              .reduce((a, b) => a + b, 0)
          )
          .reduce((a, b) => a + b, 0) * 0.00001;
      const foundFonts = await detect();
      const system = systemVersion(foundFonts as string[]);
      return {
        str_10: context.hash((foundFonts || []).join(',')),
        str_17: context.hash(
          ''
            .concat(context.navigator.platform as string, ',')
            .concat(system as string)
        ),
        str_7: context.hash([...emojiSet].join(',')),
        str_21: context.hash(''.concat(sum as unknown as string)),
      };
    } catch {
      context.onDiagnostic('ft');
      return {
        str_10: context.hash(''),
        str_17: context.hash(''),
        str_7: context.hash(''),
        str_21: context.hash(''),
      };
    } finally {
      if (container) {
        while (container.firstChild)
          container.removeChild(container.firstChild);
        container = null;
      }
      if (root && root.parentNode) {
        root.parentNode.removeChild(root);
        root = null;
      }
      if (typeof context.window.gc === 'function') context.window.gc();
    }
  };
}
