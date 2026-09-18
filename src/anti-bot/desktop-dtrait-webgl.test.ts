import {
  createDesktopDTraitWebGLCollector,
  type DesktopDTraitWebGL,
  type DesktopDTraitWebGLCanvas,
} from './desktop-dtrait-webgl.js';

function fixture() {
  const gl: DesktopDTraitWebGL = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    FLOAT: 6,
    STATIC_DRAW: 7,
    COLOR_BUFFER_BIT: 8,
    TRIANGLES: 9,
    TRIANGLE_FAN: 10,
    TRIANGLE_STRIP: 11,
    RGBA: 12,
    UNSIGNED_BYTE: 13,
    createShader: jest.fn(type => ({ type })),
    shaderSource: jest.fn(),
    compileShader: jest.fn(),
    getShaderParameter: jest.fn(() => true),
    getShaderInfoLog: jest.fn(),
    deleteShader: jest.fn(),
    createProgram: jest.fn(() => ({})),
    attachShader: jest.fn(),
    linkProgram: jest.fn(),
    getProgramParameter: jest.fn(() => true),
    getProgramInfoLog: jest.fn(),
    deleteProgram: jest.fn(),
    useProgram: jest.fn(),
    getAttribLocation: jest.fn((_program, name) =>
      name === 'a_position' ? 20 : 21
    ),
    getUniformLocation: jest.fn(() => ({})),
    createBuffer: jest.fn(),
    bindBuffer: jest.fn(),
    vertexAttribPointer: jest.fn(),
    enableVertexAttribArray: jest.fn(),
    uniformMatrix3fv: jest.fn(),
    clearColor: jest.fn(),
    clear: jest.fn(),
    bufferData: jest.fn(),
    drawArrays: jest.fn(),
    readPixels: jest.fn((_x, _y, _w, _h, _f, _t, pixels) => {
      pixels[0] = 12;
      pixels[100] = 34;
      pixels[101] = 99;
    }),
    getExtension: jest.fn(() => ({
      UNMASKED_RENDERER_WEBGL: 100,
      UNMASKED_VENDOR_WEBGL: 101,
    })),
    getParameter: jest.fn(key => (key === 100 ? 'renderer' : 'vendor')),
  };
  const canvas: DesktopDTraitWebGLCanvas = {
    width: 0,
    height: 0,
    getContext: jest.fn(() => gl),
  };
  const document = { createElement: jest.fn(() => canvas) };
  const hash = jest.fn((value: unknown): number => {
    void value;
    return hash.mock.calls.length;
  });
  const onDiagnostic = jest.fn();
  return {
    gl,
    canvas,
    document,
    hash,
    onDiagnostic,
    collect: createDesktopDTraitWebGLCollector({
      document,
      Math,
      hash,
      onDiagnostic,
    }),
  };
}

describe('Desktop DTrait WebGL collector', () => {
  it('uses three contexts, exact drawing layout, sampled pixels and nested metadata hashes', () => {
    const f = fixture();
    expect(f.collect()).toEqual({ str_26: 1, str_33: 4 });
    expect(f.document.createElement).toHaveBeenCalledTimes(3);
    expect(f.canvas).toMatchObject({ width: 400, height: 200 });
    expect(f.canvas.getContext).toHaveBeenCalledWith('webgl2');
    expect(f.gl.__canvas).toBe(f.canvas);
    expect(f.gl.vertexAttribPointer).toHaveBeenCalledWith(
      20,
      2,
      6,
      false,
      24,
      0
    );
    expect(f.gl.vertexAttribPointer).toHaveBeenCalledWith(
      21,
      4,
      6,
      false,
      24,
      8
    );
    expect(f.gl.drawArrays).toHaveBeenNthCalledWith(1, 9, 0, 3);
    expect(f.gl.drawArrays).toHaveBeenNthCalledWith(2, 10, 3, 4);
    expect(f.gl.drawArrays).toHaveBeenNthCalledWith(3, 11, 7, 128);
    expect(f.gl.bufferData).toHaveBeenCalledWith(
      5,
      expect.any(Float32Array),
      7
    );
    const pixels = JSON.parse(f.hash.mock.calls[0]![0] as string);
    expect(pixels).toHaveLength(3200);
    expect(pixels.slice(0, 3)).toEqual([12, 34, 0]);
    expect(f.hash.mock.calls.slice(1)).toEqual([
      ['renderer'],
      ['vendor'],
      ['2,3'],
    ]);
    expect(f.gl.deleteProgram).not.toHaveBeenCalled();
    expect(f.gl.deleteShader).not.toHaveBeenCalled();
  });
  it('only supplies preserveDrawingBuffer on the webgl fallback', () => {
    const f = fixture();
    f.canvas.getContext = jest.fn(name => (name === 'webgl2' ? null : f.gl));
    f.collect();
    expect(f.canvas.getContext).toHaveBeenCalledTimes(6);
    expect(f.canvas.getContext).toHaveBeenCalledWith('webgl', {
      preserveDrawingBuffer: true,
    });
  });
  it('hashes empty fallbacks without abandoning the metadata calls when contexts are unavailable', () => {
    const f = fixture();
    f.canvas.getContext = jest.fn(() => null);
    f.collect();
    expect(f.hash.mock.calls).toEqual([[''], [''], [''], ['2,3']]);
    expect(f.onDiagnostic).toHaveBeenCalledWith('webgl', 'context');
  });
  it('still compiles the fragment shader after vertex compilation failure', () => {
    const f = fixture();
    f.gl.getShaderParameter = jest.fn(() => false);
    f.collect();
    expect(f.gl.createShader).toHaveBeenCalledTimes(2);
    expect(f.gl.getShaderInfoLog).toHaveBeenCalledTimes(2);
    expect(f.gl.deleteShader).toHaveBeenCalledTimes(2);
    expect(f.gl.createProgram).not.toHaveBeenCalled();
    expect(f.hash.mock.calls[0]).toEqual(['']);
    expect(f.onDiagnostic).toHaveBeenCalledWith('webgl', 'shader');
  });
  it('deletes only the program on failed linking and continues metadata sampling', () => {
    const f = fixture();
    f.gl.getProgramParameter = jest.fn(() => false);
    f.collect();
    expect(f.gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(f.gl.deleteShader).not.toHaveBeenCalled();
    expect(f.gl.drawArrays).not.toHaveBeenCalled();
    expect(f.document.createElement).toHaveBeenCalledTimes(3);
  });
  it('propagates pixel read exceptions without pretending an empty feature succeeded', () => {
    const f = fixture();
    f.gl.readPixels = jest.fn(() => {
      throw Error('pixels');
    });
    expect(f.collect).toThrow('pixels');
    expect(f.hash).not.toHaveBeenCalled();
    expect(f.document.createElement).toHaveBeenCalledTimes(1);
  });
  it('handles absent document explicitly and keeps zero hashes numeric', () => {
    const hash = jest.fn(() => 0),
      onDiagnostic = jest.fn();
    expect(
      createDesktopDTraitWebGLCollector({ Math, hash, onDiagnostic })()
    ).toEqual({ str_26: 0, str_33: 0 });
    expect(onDiagnostic.mock.calls).toEqual([
      ['webgl', 'document'],
      ['webgl', 'context'],
      ['webgl', 'document'],
      ['webgl', 'document'],
    ]);
    expect(hash.mock.calls).toHaveLength(4);
  });
});
