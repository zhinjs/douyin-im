import {
  createDesktopDTraitFontsCollector,
  type DesktopDTraitFontsContext,
  type DesktopDTraitFontNode,
} from './desktop-dtrait-fonts.js';
import { CANDIDATE_FONTS, EMOJI } from './desktop-dtrait-font-data.js';

class Node implements DesktopDTraitFontNode {
  id = '';
  className = '';
  textContent = '';
  parentNode: Node | null = null;
  children: Node[] = [];
  constructor(readonly tag: string) {}
  get firstChild(): Node | null {
    return this.children[0] ?? null;
  }
  setAttribute(name: string, value: string) {
    if (name === 'id') this.id = value;
  }
  appendChild(child: Node) {
    if (child.tag === 'fragment') {
      const nodes = child.children.splice(0);
      nodes.forEach(node => {
        this.children.push(node);
        node.parentNode = this;
      });
    } else {
      this.children.push(child);
      child.parentNode = this;
    }
  }
  removeChild(child: Node) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
  }
  replaceChild(child: Node, old: Node) {
    this.removeChild(old);
    this.appendChild(child);
  }
  all(): Node[] {
    return this.children.flatMap(child => [child, ...child.all()]);
  }
}
function fixture() {
  const body = new Node('body');
  const selected = [
    'Cambria Math',
    'Lucida Console',
    'Nirmala UI',
    'Leelawadee UI',
    'Ink Free',
    'Segoe Fluent Icons',
  ];
  const check = jest.fn((font: string) =>
    selected.some(name => font === '0px "' + name + '"')
  );
  const document = {
    body,
    fonts: { check },
    createElement: jest.fn((tag: string) => new Node(tag)),
    createDocumentFragment: jest.fn(() => new Node('fragment')),
    getElementById: jest.fn(
      (id: string) => body.all().find(node => node.id === id) ?? null
    ),
    querySelectorAll: jest.fn(() =>
      body.all().filter(node => node.className === 'pixel-emoji')
    ),
  };
  const created: string[] = [],
    loaded: string[] = [];
  class FontFace {
    constructor(
      readonly family: string,
      readonly source: string
    ) {
      created.push(family);
    }
    load() {
      loaded.push(this.family);
      return selected.includes(this.family)
        ? Promise.resolve(this)
        : Promise.reject(Error('unavailable'));
    }
  }
  let index = 0;
  const getComputedStyle = jest.fn(() => ({
    inlineSize: 20 + (index++ % 2) + 'px',
    blockSize: '30px',
  }));
  const hash = jest.fn((value: unknown): number => {
    void value;
    return hash.mock.calls.length;
  });
  const context: DesktopDTraitFontsContext = {
    document,
    navigator: { platform: 'Synthetic' },
    window: { gc: jest.fn() },
    Math: { random: jest.fn(() => 0.25) },
    FontFace,
    getComputedStyle,
    parseFloat,
    hash,
    onDiagnostic: jest.fn(),
  };
  return {
    context,
    document,
    body,
    check,
    selected,
    created,
    loaded,
    hash,
    getComputedStyle,
    collect: createDesktopDTraitFontsCollector(context),
  };
}

describe('Desktop DTrait fonts', () => {
  it('preserves source samples, candidate order, four hashes and cleanup leftovers', async () => {
    const f = fixture();
    expect(EMOJI).toHaveLength(92);
    expect(EMOJI.filter(value => value === '😀')).toHaveLength(2);
    expect(CANDIDATE_FONTS).toHaveLength(51);
    await expect(f.collect()).resolves.toEqual({
      str_10: 1,
      str_17: 2,
      str_7: 3,
      str_21: 4,
    });
    expect(f.context.Math.random).toHaveBeenCalledTimes(2);
    expect(f.check).toHaveBeenCalledTimes(52);
    expect(f.hash.mock.calls).toEqual([
      [CANDIDATE_FONTS.filter(font => f.selected.includes(font)).join(',')],
      ['Synthetic,Windows 11'],
      ['😀,☺'],
      [String(101 * 0.00001)],
    ]);
    expect(f.getComputedStyle).toHaveBeenCalledTimes(92);
    expect(f.created).toEqual([]);
    expect(
      f.body.children.map(node => [node.tag, node.id, node.children.length])
    ).toEqual([
      ['style', '', 0],
      ['div', 'pixel-emoji-container', 0],
    ]);
    expect(f.context.window.gc).toHaveBeenCalledTimes(1);
  });
  it('uses all FontFace constructions before any loads when the random font is reported present', async () => {
    const f = fixture();
    f.check.mockReturnValue(true);
    await f.collect();
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.created).toEqual([...CANDIDATE_FONTS]);
    expect(f.loaded).toEqual([...CANDIDATE_FONTS]);
    expect(f.context.onDiagnostic).not.toHaveBeenCalled();
    expect(f.hash.mock.calls[0]).toEqual([
      CANDIDATE_FONTS.filter(font => f.selected.includes(font)).join(','),
    ]);
  });
  it('keeps undefined load results while filtering only null rejection fallbacks', async () => {
    const f = fixture();
    f.check.mockReturnValue(true);
    f.context = {
      ...f.context,
      FontFace: class {
        family = '';
        load() {
          return Promise.resolve(undefined) as unknown as Promise<this>;
        }
      },
    };
    await createDesktopDTraitFontsCollector(f.context)();
    expect(f.hash.mock.calls[0]).toEqual([','.repeat(50)]);
    expect(f.hash.mock.calls[1]).toEqual(['Synthetic,undefined']);
  });
  it('treats detection check errors as an empty font list without discarding measured emoji', async () => {
    const f = fixture();
    f.check.mockImplementation(() => {
      throw Error('check');
    });
    await f.collect();
    expect(f.hash.mock.calls.slice(0, 3)).toEqual([
      [''],
      ['Synthetic,undefined'],
      ['😀,☺'],
    ]);
    expect(f.context.onDiagnostic).toHaveBeenCalledWith('font-detection');
    expect(f.context.onDiagnostic).not.toHaveBeenCalledWith('ft');
  });
  it('falls back for measurement errors, still running final cleanup', async () => {
    const f = fixture();
    f.getComputedStyle.mockImplementation(() => {
      throw Error('measurement');
    });
    await f.collect();
    expect(f.hash.mock.calls).toEqual([[''], [''], [''], ['']]);
    expect(f.context.onDiagnostic).toHaveBeenCalledWith('ft');
    expect(f.check).not.toHaveBeenCalled();
    expect(f.body.children[1]?.children).toEqual([]);
    expect(f.context.window.gc).toHaveBeenCalledTimes(1);
  });
  it('does not infer a macOS version absent from the original reachable lookup keys', async () => {
    const f = fixture();
    f.check.mockImplementation(font =>
      ['Galvji', 'Noto Serif Yezidi Regular', 'STIX Two Math Regular'].some(
        name => font === '0px "' + name + '"'
      )
    );
    await f.collect();
    expect(f.hash.mock.calls[1]).toEqual(['Synthetic,undefined']);
  });
  it('lets final gc failures override an otherwise successful result', async () => {
    const f = fixture();
    f.context.window.gc = () => {
      throw Error('gc');
    };
    await expect(f.collect()).rejects.toThrow('gc');
    expect(f.hash).toHaveBeenCalledTimes(4);
    expect(f.context.onDiagnostic).not.toHaveBeenCalled();
  });
  it('does not leave the original placeholder if failure occurs before replacement', async () => {
    const f = fixture();
    f.document.createDocumentFragment.mockImplementation(() => {
      throw Error('fragment');
    });
    await f.collect();
    expect(f.body.children).toEqual([]);
    expect(f.hash.mock.calls).toEqual([[''], [''], [''], ['']]);
  });
});
