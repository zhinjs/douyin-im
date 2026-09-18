import {
  createDesktopDTraitCssCollector,
  type DesktopDTraitCssNode,
} from './desktop-dtrait-css.js';

function fixture() {
  const trace: string[] = [];
  const proto = { [Symbol.toStringTag]: 'SyntheticStyle' };
  const style = Object.assign(Object.create(proto), {
    0: 'a-b',
    1: '--custom',
    '--own': 'ignored',
  });
  Object.defineProperty(style, 'aB', { value: 'hidden' });
  const node = {
    parentNode: null as Exclude<DesktopDTraitCssNode['parentNode'], undefined>,
    setAttribute: jest.fn((_name: string, value: string) => {
      trace.push(value);
    }),
  };
  const body = {
    append: jest.fn(() => {
      node.parentNode = body;
    }),
    removeChild: jest.fn(() => {
      trace.push('remove');
      node.parentNode = null;
    }),
  };
  const computed = {
    backgroundColor: 'rgb(1, 2, 3)',
    fontSize: '12px',
    fontFamily: 'Fake Font',
  };
  const document = { body, createElement: jest.fn(() => node) };
  const getComputedStyle = jest.fn(
    (element: unknown): Record<string, unknown> =>
      element === body ? style : computed
  );
  const hash = jest.fn((value: unknown) => {
    trace.push('hash:' + String(value));
    return trace.length;
  });
  const onDiagnostic = jest.fn();
  return {
    node,
    style,
    computed,
    body,
    trace,
    hash,
    document,
    getComputedStyle,
    onDiagnostic,
    collect: createDesktopDTraitCssCollector({
      document,
      getComputedStyle,
      hash,
      onDiagnostic,
    }),
  };
}

describe('Desktop DTrait CSS collector', () => {
  it('hashes keys before interface, then ordered single-key color/font arrays after cleanup', () => {
    const f = fixture(),
      value = f.collect();
    expect(Object.keys(value)).toEqual(['str_1', 'str_4', 'str_5', 'str_6']);
    expect(f.hash.mock.calls[0]).toEqual(['a-b,aB']);
    expect(f.hash.mock.calls[1]).toEqual(['SyntheticStyle']);
    expect(value.str_4).toBeLessThan(value.str_1!);
    expect(f.node.setAttribute).toHaveBeenCalledTimes(44);
    expect(f.getComputedStyle).toHaveBeenCalledTimes(45);
    expect(f.node.setAttribute.mock.calls[0]).toEqual([
      'style',
      'background-color: ActiveBorder !important',
    ]);
    expect(f.node.setAttribute.mock.calls[37]).toEqual([
      'style',
      'background-color: WindowText !important',
    ]);
    expect(f.node.setAttribute.mock.calls[38]).toEqual([
      'style',
      'font: caption !important',
    ]);
    expect(f.node.setAttribute.mock.calls[43]).toEqual([
      'style',
      'font: status-bar !important',
    ]);
    const colors = JSON.parse(f.hash.mock.calls[2]![0] as string);
    const fonts = JSON.parse(f.hash.mock.calls[3]![0] as string);
    expect(colors).toHaveLength(38);
    expect(colors[0]).toEqual({ ActiveBorder: 'rgb(1, 2, 3)' });
    expect(fonts).toHaveLength(6);
    expect(fonts[0]).toEqual({ caption: '12px Fake Font' });
    expect(f.trace.indexOf('remove')).toBeLessThan(
      f.trace.findIndex(x => x.startsWith('hash:['))
    );
    expect(f.node.parentNode).toBeNull();
  });

  it('continues system collection after computed-style failure without empty-string hashes', () => {
    const f = fixture();
    f.getComputedStyle.mockImplementationOnce(() => {
      throw Error('body');
    });
    const value = f.collect();
    expect(value.str_1).toBeUndefined();
    expect(value.str_4).toBeUndefined();
    expect(value.str_5).toEqual(expect.any(Number));
    expect(f.hash).toHaveBeenCalledTimes(2);
    expect(f.onDiagnostic).not.toHaveBeenCalled();
  });

  it('leaves the mounted node after a color getter throws, preserving computed fields', () => {
    const f = fixture();
    Object.defineProperty(f.computed, 'backgroundColor', {
      get() {
        throw Error('color');
      },
    });
    const value = f.collect();
    expect(value.str_1).toEqual(expect.any(Number));
    expect(value.str_5).toBeUndefined();
    expect(value.str_6).toBeUndefined();
    expect(f.node.parentNode).toBe(f.body);
    expect(f.body.removeChild).not.toHaveBeenCalled();
    expect(f.onDiagnostic).not.toHaveBeenCalled();
  });

  it('swallows both helper hash errors, with cleanup preceding system hash', () => {
    const f = fixture();
    f.hash.mockImplementation(() => {
      throw Error('hash');
    });
    expect(f.collect()).toEqual({
      str_1: undefined,
      str_4: undefined,
      str_5: undefined,
      str_6: undefined,
    });
    expect(f.hash).toHaveBeenCalledTimes(2);
    expect(f.node.parentNode).toBeNull();
    expect(f.onDiagnostic).not.toHaveBeenCalled();
  });

  it('does not coerce non-string numeric-index values into property names', () => {
    const f = fixture();
    f.style[0] = 123;
    const value = f.collect();
    expect(value.str_1).toBeUndefined();
    expect(value.str_4).toBeUndefined();
    expect(value.str_5).toEqual(expect.any(Number));
  });

  it('keeps zero hashes rather than replacing them with empty strings', () => {
    const f = fixture();
    f.hash.mockReturnValue(0);
    expect(f.collect()).toEqual({ str_1: 0, str_4: 0, str_5: 0, str_6: 0 });
  });

  it('runs fresh system DOM collection on repeated calls', () => {
    const f = fixture();
    f.collect();
    f.collect();
    expect(f.document.createElement).toHaveBeenCalledTimes(2);
    expect(f.node.setAttribute).toHaveBeenCalledTimes(88);
    expect(f.hash).toHaveBeenCalledTimes(8);
  });
});
