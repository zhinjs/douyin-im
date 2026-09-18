// Pinned shader strings 612 and 613, including whitespace.
const VERTEX_SOURCE =
  '\n    attribute vec2 a_position;\n    attribute vec4 a_color;\n    uniform mat3 u_transform;\n    varying vec4 v_color;\n    void main() {\n      vec3 position = u_transform * vec3(a_position, 1.0);\n      gl_Position = vec4(position.xy, 0.0, 1.0);\n      v_color = a_color;\n    }\n  ';
const FRAGMENT_SOURCE =
  '\n    precision mediump float;\n    varying vec4 v_color;\n    void main() {\n      gl_FragColor = v_color;\n    }\n  ';

export interface DesktopDTraitWebGL {
  __canvas?: DesktopDTraitWebGLCanvas;
  readonly VERTEX_SHADER: number;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
  readonly LINK_STATUS: number;
  readonly ARRAY_BUFFER: number;
  readonly FLOAT: number;
  readonly STATIC_DRAW: number;
  readonly COLOR_BUFFER_BIT: number;
  readonly TRIANGLES: number;
  readonly TRIANGLE_FAN: number;
  readonly TRIANGLE_STRIP: number;
  readonly RGBA: number;
  readonly UNSIGNED_BYTE: number;
  createShader(type: number): unknown;
  shaderSource(shader: unknown, source: string): void;
  compileShader(shader: unknown): void;
  getShaderParameter(shader: unknown, parameter: number): unknown;
  getShaderInfoLog(shader: unknown): unknown;
  deleteShader(shader: unknown): void;
  createProgram(): unknown;
  attachShader(program: unknown, shader: unknown): void;
  linkProgram(program: unknown): void;
  getProgramParameter(program: unknown, parameter: number): unknown;
  getProgramInfoLog(program: unknown): unknown;
  deleteProgram(program: unknown): void;
  useProgram(program: unknown): void;
  getAttribLocation(program: unknown, name: string): number;
  getUniformLocation(program: unknown, name: string): unknown;
  createBuffer(): unknown;
  bindBuffer(target: number, buffer: unknown): void;
  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number
  ): void;
  enableVertexAttribArray(index: number): void;
  uniformMatrix3fv(
    location: unknown,
    transpose: boolean,
    value: Float32Array
  ): void;
  clearColor(red: number, green: number, blue: number, alpha: number): void;
  clear(mask: number): void;
  bufferData(target: number, values: Float32Array, usage: number): void;
  drawArrays(mode: number, first: number, count: number): void;
  readPixels(
    x: number,
    y: number,
    width: number,
    height: number,
    format: number,
    type: number,
    data: Uint8Array
  ): void;
  getExtension?(
    name: string
  ): { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
  getParameter(parameter: number): unknown;
}
export interface DesktopDTraitWebGLCanvas {
  width: number;
  height: number;
  getContext(
    name: string,
    options?: { preserveDrawingBuffer: boolean }
  ): DesktopDTraitWebGL | null;
}
export interface DesktopDTraitWebGLContext {
  readonly document?:
    | { createElement(tag: string): DesktopDTraitWebGLCanvas }
    | undefined;
  readonly Math: Pick<Math, 'PI' | 'sin' | 'cos' | 'abs'>;
  hash(value: unknown): number;
  onDiagnostic(
    code: 'webgl',
    reason: 'document' | 'context' | 'shader' | 'program'
  ): void;
}

/** F293–308: separate render/renderer/vendor contexts and nested metadata hashing are intentional. */
export function createDesktopDTraitWebGLCollector(
  context: DesktopDTraitWebGLContext
) {
  const createContext = () => {
    if (typeof context.document === 'undefined') {
      context.onDiagnostic('webgl', 'document');
      return null;
    }
    const canvas = context.document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (gl) gl.__canvas = canvas;
    return gl;
  };
  const compile = (gl: DesktopDTraitWebGL, source: string, type: number) => {
    const shader = gl.createShader(type);
    if (shader) {
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.getShaderInfoLog(shader);
        // Source console.error carries driver text; host diagnostics intentionally redact it.
        context.onDiagnostic('webgl', 'shader');
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }
    return undefined;
  };
  const program = (gl: DesktopDTraitWebGL) => {
    const vertex = compile(gl, VERTEX_SOURCE, gl.VERTEX_SHADER);
    const fragment = compile(gl, FRAGMENT_SOURCE, gl.FRAGMENT_SHADER);
    if (!vertex || !fragment) return null;
    const value = gl.createProgram();
    gl.attachShader(value, vertex);
    gl.attachShader(value, fragment);
    gl.linkProgram(value);
    if (!gl.getProgramParameter(value, gl.LINK_STATUS)) {
      void 'Program linking failed: '.concat(
        gl.getProgramInfoLog(value) as string
      );
      context.onDiagnostic('webgl', 'program');
      gl.deleteProgram(value);
      return null;
    }
    return value;
  };
  const vertices = () => {
    const triangle = [
      -0.8, -0.8, 1, 0, 0, 0.5, 0.8, -0.8, 0, 1, 0, 0.5, 0, 0.8, 0, 0, 1, 0.5,
    ];
    const rectangle = [
      -0.6, -0.3, 0.5, 0, 1, 0.5, 0.6, -0.3, 1, 0.5, 0, 0.5, 0.6, 0.3, 0, 1,
      0.5, 0.5, -0.6, 0.3, 1, 0, 1, 0.5,
    ];
    const ring: number[] = [];
    for (let index = 0; index <= 64; index++) {
      const angle = (index / 64) * context.Math.PI * 2;
      const cosine = context.Math.cos(angle),
        sine = context.Math.sin(angle);
      const red = context.Math.abs(context.Math.sin(angle));
      const green = context.Math.abs(context.Math.cos(angle));
      const blue = (red + green) / 2;
      ring.push(0 + cosine * 0.7, 0 + sine * 0.7, red, green, blue, 0.6);
      ring.push(0 + cosine * 0.4, 0 + sine * 0.4, green, blue, red, 0.6);
    }
    return new Float32Array([...triangle, ...rectangle, ...ring]);
  };
  const render = () => {
    const gl = createContext();
    if (!gl) {
      context.onDiagnostic('webgl', 'context');
      return '';
    }
    const value = program(gl);
    if (!value) return '';
    gl.useProgram(value);
    const position = gl.getAttribLocation(value, 'a_position');
    const color = gl.getAttribLocation(value, 'a_color');
    const transform = gl.getUniformLocation(value, 'u_transform');
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(color, 4, gl.FLOAT, false, 24, 8);
    gl.enableVertexAttribArray(position);
    gl.enableVertexAttribArray(color);
    const angle = context.Math.PI / 6;
    const cosine = context.Math.cos(angle),
      sine = context.Math.sin(angle);
    gl.uniformMatrix3fv(
      transform,
      false,
      new Float32Array([cosine, -sine, 0, sine, cosine, 0, 0, 0, 1])
    );
    gl.clearColor(0.9, 0.9, 0.9, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const data = vertices();
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.drawArrays(gl.TRIANGLE_FAN, 3, 4);
    gl.drawArrays(gl.TRIANGLE_STRIP, 7, 64 * 2);
    const pixels = new Uint8Array(400 * 200 * 4);
    gl.readPixels(0, 0, 400, 200, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const sampled: number[] = [];
    for (let index = 0; index < pixels.length; index += 100)
      sampled.push(pixels[index]!);
    return JSON.stringify(sampled) || '';
  };
  const metadata = (
    key: 'UNMASKED_RENDERER_WEBGL' | 'UNMASKED_VENDOR_WEBGL'
  ) => {
    const gl = createContext();
    const extension = gl?.getExtension?.call(gl, 'WEBGL_debug_renderer_info');
    return gl && extension ? gl.getParameter(extension[key]) || '' : '';
  };
  return () => ({
    str_26: context.hash(render()),
    str_33: context.hash(
      ''
        .concat(
          context.hash(
            metadata('UNMASKED_RENDERER_WEBGL')
          ) as unknown as string,
          ','
        )
        .concat(
          context.hash(metadata('UNMASKED_VENDOR_WEBGL')) as unknown as string
        )
    ),
  });
}
