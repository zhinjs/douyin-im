import {
  createDesktopDTraitCanvasCollector,
  createDesktopDTraitDomCollector,
  type DesktopDTraitCanvas2D,
  type DesktopDTraitDomElement,
} from './desktop-dtrait-rendering.js';

function canvasFixture() {
  const gradient = { addColorStop: jest.fn() };
  const draw = {
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: '',
    strokeStyle: '',
    lineWidth: 0,
    createRadialGradient: jest.fn(() => gradient),
    fillRect: jest.fn(),
    beginPath: jest.fn(),
    arc: jest.fn(),
    fill: jest.fn(),
    fillText: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    stroke: jest.fn(),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: jest.fn((): DesktopDTraitCanvas2D | null => draw),
    toDataURL: jest.fn(() => 'data:image/png;base64,synthetic'),
  };
  const hash = jest.fn(() => 123),
    document = { createElement: jest.fn(() => canvas) };
  return {
    gradient,
    draw,
    canvas,
    hash,
    document,
    collect: createDesktopDTraitCanvasCollector({ document, Math, hash }),
  };
}

it('draws the exact radial gradient and source geometry without attaching to a document', () => {
  const f = canvasFixture();
  expect(f.collect()).toEqual({ str_3: 123 });
  expect([f.canvas.width, f.canvas.height]).toEqual([400, 200]);
  expect(f.canvas.getContext).toHaveBeenCalledWith('2d');
  expect(f.draw.createRadialGradient).toHaveBeenCalledWith(
    200,
    100,
    20,
    200,
    100,
    180
  );
  expect(f.gradient.addColorStop.mock.calls).toEqual([
    [0, 'rgba(255,0,0,0.5)'],
    [0.5, 'rgba(0,255,0,0.5)'],
    [1, 'rgba(0,0,255,0.5)'],
  ]);
  expect(f.draw.fillRect.mock.calls).toEqual([
    [0, 0, 400, 200],
    [50, 100, 100, 30],
  ]);
  expect(f.draw.arc).toHaveBeenCalledWith(150, 75, 40, 0, Math.PI * 2);
  expect(f.hash).toHaveBeenCalledWith('data:image/png;base64,synthetic');
});

it('renders all source text and forty diagonal strokes without resetting shadow offsets', () => {
  const f = canvasFixture();
  f.collect();
  expect(f.draw.fillText.mock.calls).toEqual([
    ['ABCDEFGHIJKL', 0, 40],
    ['MNOPQRSTUVWXYZ', 0, 80],
    ['abcdefghijklmn', 0, 120],
    ['opqrstuvwxyz', 0, 160],
  ]);
  expect(f.draw.stroke).toHaveBeenCalledTimes(40);
  expect(f.draw.moveTo.mock.calls.slice(-2)).toEqual([
    [380, 0],
    [380, 200],
  ]);
  expect(f.draw.lineTo.mock.calls.slice(-2)).toEqual([
    [400, 200],
    [400, 0],
  ]);
  expect([
    f.draw.shadowBlur,
    f.draw.shadowOffsetX,
    f.draw.shadowOffsetY,
  ]).toEqual([0, 4, 4]);
});

it('returns an un-hashed empty string if no 2d context exists', () => {
  const f = canvasFixture();
  f.canvas.getContext.mockReturnValue(null);
  expect(f.collect()).toEqual({ str_3: '' });
  expect(f.hash).not.toHaveBeenCalled();
  expect(f.canvas.toDataURL).not.toHaveBeenCalled();
});

it('preserves the source falsy-hash fallback for canvas', () => {
  const f = canvasFixture();
  f.hash.mockReturnValue(0);
  expect(f.collect()).toEqual({ str_3: '' });
});

it('propagates serialization errors instead of generating an empty successful canvas result', () => {
  const f = canvasFixture();
  f.canvas.toDataURL.mockImplementation(() => {
    throw Error('tainted');
  });
  expect(f.collect).toThrow('tainted');
  expect(f.hash).not.toHaveBeenCalled();
});

function domFixture() {
  const order: string[] = [];
  const element: DesktopDTraitDomElement = {
    id: '',
    style: { cssText: '' },
    parentNode: null,
    getBoundingClientRect: jest.fn(() => {
      order.push('measure');
      return { width: 1, height: 2, x: 3, y: 4 };
    }),
  };
  const body = {
    appendChild: jest.fn(() => {
      Reflect.set(element, 'parentNode', body);
    }),
    removeChild: jest.fn(() => {
      order.push('remove');
      Reflect.set(element, 'parentNode', null);
    }),
  };
  const document = {
    body,
    createElement: jest.fn(() => element),
    querySelector: jest.fn((): DesktopDTraitDomElement | null => null),
  };
  const hash = jest.fn((text: unknown) => {
    order.push(String(text));
    return 0;
  });
  return {
    element,
    body,
    document,
    hash,
    order,
    collect: createDesktopDTraitDomCollector({ document, hash }),
  };
}

it('hashes measured height,width,x,y after removing the transformed DOM node', () => {
  const f = domFixture();
  expect(f.collect()).toEqual({ str_2: 0 });
  expect(f.element.id).toBe('secure-collect-dom');
  expect(f.element.style.cssText).toContain(
    'transform: rotate(45deg) translateX(-200px);'
  );
  expect(f.order).toEqual(['measure', 'remove', '2,1,3,4']);
  expect(f.document.querySelector).not.toHaveBeenCalled();
});

it('preserves the DOM node on measurement failure and never hashes fake dimensions', () => {
  const f = domFixture();
  jest.spyOn(f.element, 'getBoundingClientRect').mockImplementation(() => {
    throw Error('geometry');
  });
  expect(f.collect).toThrow('geometry');
  expect(f.element.parentNode).toBe(f.body);
  expect(f.hash).not.toHaveBeenCalled();
});

it('uses the source id fallback cleanup when the measured node moved', () => {
  const f = domFixture(),
    other = { removeChild: jest.fn() };
  jest.spyOn(f.element, 'getBoundingClientRect').mockImplementation(() => {
    Reflect.set(f.element, 'parentNode', other);
    return { width: 1, height: 2, x: 3, y: 4 };
  });
  const found = { ...f.element, parentNode: other };
  f.document.querySelector.mockReturnValue(found);
  f.collect();
  expect(f.document.querySelector).toHaveBeenCalledWith('#secure-collect-dom');
  expect(other.removeChild).toHaveBeenCalledWith(found);
  expect(f.body.removeChild).not.toHaveBeenCalled();
});
