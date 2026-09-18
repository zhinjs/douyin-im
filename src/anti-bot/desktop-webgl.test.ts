import { collectDesktopWebGl, type DesktopWebGl, type DesktopWebGlContext } from './desktop-webgl.js';

describe('Desktop K WebGL collector', () => {
  function context(gl: DesktopWebGl | null): DesktopWebGlContext {
    const canvas = { getContext(name: 'webgl') { expect(this).toBe(canvas); expect(name).toBe('webgl'); return gl; } };
    const document = { createElement(name: 'canvas') { expect(this).toBe(document); expect(name).toBe('canvas'); return canvas; } };
    return { document };
  }
  function renderer(value?: unknown): DesktopWebGl {
    return { getContextAttributes: () => ({ antialias: true }), getParameter: () => value, getExtension: () => null };
  }
  it('returns only the 17 original fields without extensions', () => {
    const result = collectDesktopWebGl(context(renderer(8)));
    expect(Object.keys(result)).toEqual(['antialias', 'blueBits', 'depthBits', 'greenBits', 'maxCombinedTextureImageUnits', 'maxCubeMapTextureSize', 'maxFragmentUniformVectors', 'maxRenderbufferSize', 'maxTextureImageUnits', 'maxTextureSize', 'maxVaryingVectors', 'maxVertexAttribs', 'maxVertexTextureImageUnits', 'maxVertexUniformVectors', 'shadingLanguageVersion', 'stencilBits', 'version']);
    expect(result['antialias']).toBe(1);
    expect(result['version']).toBe(8);
    expect(Object.hasOwn(result, 'renderer')).toBe(false);
  });
  it('reads the parameter method before its enum and preserves receiver/raw results', () => {
    const trace: string[] = [];
    const value = {};
    const gl: DesktopWebGl = { ...renderer(), get getParameter() { trace.push('method'); return function(this: unknown) { expect(this).toBe(gl); return value; }; }, get BLUE_BITS() { trace.push('enum'); return 7; } };
    const result = collectDesktopWebGl(context(gl));
    expect(trace.slice(0, 2)).toEqual(['method', 'enum']);
    expect(result['blueBits']).toBe(value);
    expect(result['version']).toBe(value);
  });
  it('only substitutes numeric zero in the optional anisotropy result', () => {
    for (const value of [0, -0, '0', false, null, undefined, NaN, 0n, {}]) {
      const extensions: string[] = [];
      const gl = renderer(value);
      gl.getExtension = name => { extensions.push(name); return {}; };
      const result = collectDesktopWebGl(context(gl));
      expect(result['maxAnisotropy']).toBe(value === 0 ? 2 : value);
      expect(result['renderer']).toBe(value);
      expect(result['vendor']).toBe(value);
      expect(extensions).toEqual(['EXT_texture_filter_anisotropic', 'WEBGL_debug_renderer_info']);
    }
  });
  it('returns fresh empty objects only for initialization failure or no context', () => {
    const c = context(null);
    const first = collectDesktopWebGl(c);
    expect(first).toEqual({});
    expect(collectDesktopWebGl(c)).not.toBe(first);
    expect(collectDesktopWebGl({ get document(): never { throw Error('document'); } })).toEqual({});
    expect(collectDesktopWebGl({ document: { createElement() { throw Error('canvas'); } } })).toEqual({});
  });
  it('propagates errors after context initialization, without masking or retrying', () => {
    const gl = renderer();
    gl.getContextAttributes = () => { throw Error('attributes'); };
    expect(() => collectDesktopWebGl(context(gl))).toThrow('attributes');
    gl.getContextAttributes = () => null;
    gl.getExtension = () => { throw Error('extension'); };
    expect(() => collectDesktopWebGl(context(gl))).toThrow('extension');
    gl.getParameter = () => { throw Error('parameter'); };
    expect(() => collectDesktopWebGl(context(gl))).toThrow('parameter');
  });
});
