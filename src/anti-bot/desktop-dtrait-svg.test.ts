import {
  createDesktopDTraitSvgCollector,
  type DesktopDTraitSvgElement,
  type DesktopDTraitSvgParent,
} from './desktop-dtrait-svg.js';

function fixture() {
  const order: string[] = [];
  class Element implements DesktopDTraitSvgElement {
    id = '';
    parentNode: DesktopDTraitSvgParent | null = null;
    constructor(readonly tag: string) {}
    setAttribute = jest.fn();
    appendChild = jest.fn((node: DesktopDTraitSvgElement) => node);
    getBBox = jest.fn(() => {
      order.push('bbox');
      return { x: 10.5, y: 20.25, width: 123.45, height: 67.89 };
    });
  }
  const svg = new Element('svg'),
    rect = new Element('rect');
  const body = {
    appendChild: jest.fn((node: DesktopDTraitSvgElement) => {
      svg.parentNode = body;
      return node;
    }),
    removeChild: jest.fn((node: DesktopDTraitSvgElement) => {
      order.push('remove');
      svg.parentNode = null;
      return node;
    }),
  };
  const document = {
    body,
    createElementNS: jest.fn((namespace: string, tag: string) => {
      void namespace;
      return tag === 'svg' ? svg : rect;
    }),
    querySelector: jest.fn((): DesktopDTraitSvgElement | null => null),
  };
  const hash = jest.fn((text: unknown) => {
    order.push('hash');
    return String(text).length;
  });
  return {
    svg,
    rect,
    body,
    document,
    hash,
    order,
    collect: createDesktopDTraitSvgCollector({ document, hash }),
  };
}

it('creates the source geometry and cleans it before hashing the measured, not requested, rectangle', () => {
  const f = fixture();
  f.rect.getBBox.mockImplementation(() => {
    f.order.push('bbox');
    return { x: 1.1, y: 2.2, width: 3.3, height: 4.4 };
  });
  f.collect();
  expect(f.document.createElementNS.mock.calls).toEqual([
    ['http://www.w3.org/2000/svg', 'svg'],
    ['http://www.w3.org/2000/svg', 'rect'],
  ]);
  expect(f.svg.id).toBe('secure-collect-svg');
  expect(f.svg.setAttribute.mock.calls).toEqual([
    ['width', '200'],
    ['height', '100'],
    [
      'style',
      'opacity: 0;position: absolute;top: 0;left: 0;transform: translateX(-200px)',
    ],
  ]);
  expect(f.rect.setAttribute.mock.calls).toEqual([
    ['x', '10.5'],
    ['y', '20.25'],
    ['width', '123.45'],
    ['height', '67.89'],
  ]);
  expect(f.hash).toHaveBeenCalledWith('1.1,2.2,3.3,4.4');
  expect(f.order).toEqual(['bbox', 'remove', 'hash']);
  expect(f.document.querySelector).not.toHaveBeenCalled();
});

it('uses the source id lookup cleanup branch when the measured node no longer belongs to body', () => {
  const f = fixture(),
    removeChild = jest.fn();
  f.rect.getBBox.mockImplementation(() => {
    f.svg.parentNode = null;
    return { x: 1, y: 2, width: 3, height: 4 };
  });
  const found = { ...f.svg, parentNode: { removeChild } };
  f.document.querySelector.mockReturnValue(found);
  f.collect();
  expect(f.body.removeChild).not.toHaveBeenCalled();
  expect(f.document.querySelector).toHaveBeenCalledWith('#secure-collect-svg');
  expect(removeChild).toHaveBeenCalledWith(found);
});

it('does not add finally cleanup on measurement failure or fabricate a successful hash', () => {
  const f = fixture();
  f.rect.getBBox.mockImplementation(() => {
    throw Error('bbox');
  });
  expect(f.collect).toThrow('bbox');
  expect(f.svg.parentNode).toBe(f.body);
  expect(f.body.removeChild).not.toHaveBeenCalled();
  expect(f.hash).not.toHaveBeenCalled();
});

it('propagates cleanup failure before reading or hashing geometry', () => {
  const f = fixture();
  f.body.removeChild.mockImplementation(() => {
    throw Error('remove');
  });
  expect(f.collect).toThrow('remove');
  expect(f.hash).not.toHaveBeenCalled();
});

it('cleans up before a later hashing failure', () => {
  const f = fixture();
  f.hash.mockImplementation(() => {
    throw Error('hash');
  });
  expect(f.collect).toThrow('hash');
  expect(f.svg.parentNode).toBeNull();
});
