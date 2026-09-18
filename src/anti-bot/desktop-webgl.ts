import { setDesktopProperty } from './desktop-property-write.js';
type Parameter = 'BLUE_BITS' | 'DEPTH_BITS' | 'GREEN_BITS' | 'MAX_COMBINED_TEXTURE_IMAGE_UNITS' |
  'MAX_CUBE_MAP_TEXTURE_SIZE' | 'MAX_FRAGMENT_UNIFORM_VECTORS' | 'MAX_RENDERBUFFER_SIZE' |
  'MAX_TEXTURE_IMAGE_UNITS' | 'MAX_TEXTURE_SIZE' | 'MAX_VARYING_VECTORS' | 'MAX_VERTEX_ATTRIBS' |
  'MAX_VERTEX_TEXTURE_IMAGE_UNITS' | 'MAX_VERTEX_UNIFORM_VECTORS' | 'SHADING_LANGUAGE_VERSION' |
  'STENCIL_BITS' | 'VERSION';

export type DesktopWebGl = Partial<Record<Parameter, number>> & {
  getContextAttributes(): { readonly antialias?: unknown } | null | undefined;
  getParameter(parameter: number): unknown;
  getExtension(name: string): {
    readonly MAX_TEXTURE_MAX_ANISOTROPY_EXT?: number;
    readonly UNMASKED_RENDERER_WEBGL?: number;
    readonly UNMASKED_VENDOR_WEBGL?: number;
  } | null | undefined;
};

export interface DesktopWebGlContext {
  readonly document: { createElement(name: 'canvas'): { getContext(name: 'webgl'): DesktopWebGl | null | undefined } };
}

/** K: only initialization falls back; all post-context collection errors propagate. */
export function collectDesktopWebGl(context: DesktopWebGlContext): Record<string, unknown> {
  let gl: DesktopWebGl | null | undefined;
  try {
    gl = context.document.createElement('canvas').getContext('webgl');
    if (!gl) return {};
  } catch { return {}; }
  const result: Record<string, unknown> = {
    antialias: gl.getContextAttributes()?.antialias ? 1 : 2,
    blueBits: gl.getParameter(gl.BLUE_BITS!),
    depthBits: gl.getParameter(gl.DEPTH_BITS!),
    greenBits: gl.getParameter(gl.GREEN_BITS!),
    maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS!),
    maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE!),
    maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS!),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE!),
    maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS!),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE!),
    maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS!),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS!),
    maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS!),
    maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS!),
    shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION!),
    stencilBits: gl.getParameter(gl.STENCIL_BITS!),
    version: gl.getParameter(gl.VERSION!),
  };
  const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
  if (anisotropy) {
    const value = gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT!);
    setDesktopProperty(result, 'maxAnisotropy', value === 0 ? 2 : value);
  }
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  if (debug) {
    setDesktopProperty(result, 'renderer', gl.getParameter(debug.UNMASKED_RENDERER_WEBGL!));
    setDesktopProperty(result, 'vendor', gl.getParameter(debug.UNMASKED_VENDOR_WEBGL!));
  }
  return result;
}
