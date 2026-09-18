// Synthetic browser interfaces for registry integration only. No browser, installed fonts, GPU, audio or network.
const { createHash } = require('node:crypto');
function createFixture(mode = 'normal') {
  const trace = [],
    timers = new Map();
  let timerId = 0,
    currentTime = 0,
    elementId = 0;
  const record = (...values) => {
    if (trace.length > 20000) throw Error('trace cap');
    trace.push(values);
  };
  const fingerprint = value =>
    createHash('sha256').update(String(value)).digest('hex');
  const summarize = value =>
    ArrayBuffer.isView(value)
      ? [
          'bytes',
          value.byteLength,
          fingerprint(
            Buffer.from(
              value.buffer,
              value.byteOffset,
              value.byteLength
            ).toString('hex')
          ),
        ]
      : value && typeof value === 'object'
        ? (value.key ?? 'object')
        : value;
  const drawing = Object.fromEntries(
    [
      'fillRect',
      'beginPath',
      'arc',
      'fill',
      'fillText',
      'moveTo',
      'lineTo',
      'stroke',
    ].map(name => [name, (...args) => record('2d', name, ...args)])
  );
  drawing.createRadialGradient = (...args) => {
    record('gradient', ...args);
    return { addColorStop: (...v) => record('stop', ...v) };
  };
  const gl = {};
  for (const [i, name] of [
    'VERTEX_SHADER',
    'FRAGMENT_SHADER',
    'COMPILE_STATUS',
    'LINK_STATUS',
    'ARRAY_BUFFER',
    'FLOAT',
    'STATIC_DRAW',
    'COLOR_BUFFER_BIT',
    'TRIANGLES',
    'TRIANGLE_FAN',
    'TRIANGLE_STRIP',
    'RGBA',
    'UNSIGNED_BYTE',
  ].entries())
    gl[name] = i + 1;
  for (const name of [
    'shaderSource',
    'compileShader',
    'deleteShader',
    'attachShader',
    'linkProgram',
    'deleteProgram',
    'useProgram',
    'bindBuffer',
    'vertexAttribPointer',
    'enableVertexAttribArray',
    'uniformMatrix3fv',
    'clearColor',
    'clear',
    'bufferData',
    'drawArrays',
  ])
    gl[name] = (...args) => record('gl', name, ...args.map(summarize));
  for (const name of ['createShader', 'createProgram', 'createBuffer'])
    gl[name] = () => {
      record('gl', name);
      return { key: name };
    };
  gl.getShaderParameter = gl.getProgramParameter = () => true;
  gl.getAttribLocation = (_, name) => {
    record('attrib', name);
    return 1;
  };
  gl.getUniformLocation = (_, name) => {
    record('uniform', name);
    return {};
  };
  gl.getExtension = name => {
    record('extension', name);
    return { UNMASKED_RENDERER_WEBGL: 101, UNMASKED_VENDOR_WEBGL: 102 };
  };
  gl.getParameter = value => {
    record('parameter', value);
    return value === 101 ? 'synthetic-renderer' : 'synthetic-vendor';
  };
  gl.readPixels = (...args) => {
    record('pixels', ...args.slice(0, -1), args.at(-1).length);
    args.at(-1).fill(17);
  };
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.key = ++elementId;
      this.children = [];
      this.parentNode = null;
      this.id = '';
      this.className = '';
      this.style = {};
      this.textContent = '';
    }
    setAttribute(name, value) {
      record('attr', this.key, name, value);
      this[name] = value;
    }
    get firstChild() {
      return this.children[0] ?? null;
    }
    appendChild(child) {
      record('append', this.key, child.key);
      if (mode === 'append-fail' && this.tag === 'body') throw Error('append');
      if (child.tag === 'fragment') {
        const nodes = child.children.splice(0);
        for (const node of nodes) {
          this.children.push(node);
          node.parentNode = this;
        }
      } else {
        this.children.push(child);
        child.parentNode = this;
      }
      return child;
    }
    append(child) {
      this.appendChild(child);
    }
    removeChild(child) {
      record('remove', this.key, child.key);
      const at = this.children.indexOf(child);
      if (at < 0) throw Error('missing child');
      this.children.splice(at, 1);
      child.parentNode = null;
      return child;
    }
    replaceChild(child, old) {
      record('replace', this.key, child.key, old.key);
      this.removeChild(old);
      this.appendChild(child);
      return old;
    }
    getBoundingClientRect() {
      record('rect', this.key);
      return { x: -20, y: 0, width: 123.45, height: 67.89 };
    }
    getBBox() {
      record('bbox', this.key);
      return { x: 10.5, y: 20.25, width: 123.45, height: 67.89 };
    }
    getContext(name, options) {
      record('context', name, options);
      if (mode === 'no-rendering') return null;
      return name === '2d' ? drawing : gl;
    }
    toDataURL() {
      record('data-url');
      return 'data:image/png;base64,c3ludGhldGlj';
    }
    canPlayType(type) {
      record('video', type);
      return type.includes('mp4') ? 'probably' : '';
    }
  }
  const body = new Element('body'),
    walk = root => root.children.flatMap(node => [node, ...walk(node)]);
  const document = {
    body,
    createElement(tag) {
      record('create', tag);
      return new Element(tag);
    },
    createElementNS(ns, tag) {
      record('createNS', ns, tag);
      return new Element(tag);
    },
    createDocumentFragment() {
      record('fragment');
      return new Element('fragment');
    },
    getElementById(id) {
      record('id', id);
      return walk(body).find(node => node.id === id) ?? null;
    },
    querySelector(selector) {
      record('query', selector);
      return walk(body).find(node => node.id === selector.slice(1)) ?? null;
    },
    querySelectorAll(selector) {
      record('queryAll', selector);
      return walk(body).filter(node => node.className === selector.slice(1));
    },
    getElementsByClassName(name) {
      record('class', name);
      return walk(body).filter(node => node.className === name);
    },
    createEvent(name) {
      record('event', name);
      if (mode === 'missing-capabilities') throw Error('touch');
      return {};
    },
    fonts: {
      check(name) {
        record('font-check', name);
        return (
          mode === 'font-load' ||
          name.includes('Cambria Math') ||
          name.includes('Lucida Console')
        );
      },
    },
  };
  class OfflineAudioContext {
    constructor(...args) {
      record('audio-new', ...args);
      this.destination = {};
    }
    createAnalyser() {
      record('analyser');
      return {
        frequencyBinCount: 4,
        fftSize: 4,
        getFloatFrequencyData: a => a.set([-1, 2, -3, 4]),
        getFloatTimeDomainData: a => a.set([0, 1, 0, -1]),
      };
    }
    createOscillator() {
      record('oscillator');
      return { frequency: {}, connect() {}, start() {} };
    }
    createDynamicsCompressor() {
      record('compressor');
      return { threshold: {}, knee: {}, attack: {}, connect() {} };
    }
    startRendering() {
      record('render');
    }
    set oncomplete(callback) {
      record('audio-handler');
      Promise.resolve().then(() =>
        callback({
          renderedBuffer: {
            getChannelData: () => new Float32Array([0, 1, 1, 2]),
          },
        })
      );
    }
  }
  const realm = {
    document,
    navigator: {
      platform: 'Synthetic',
      cookieEnabled: true,
      language: 'en',
      languages: ['en'],
      userAgent: 'synthetic',
      plugins: [],
      mimeTypes: [],
      maxTouchPoints: 0,
    },
    screen: { width: 1024, height: 768 },
    Math: Object.assign(Object.create(Math), { random: () => 0.25 }),
    Date: { now: () => currentTime },
    performance: { now: () => currentTime },
    TextEncoder: class extends TextEncoder {
      constructor() {
        super();
        record('encoder');
      }
      encode(value) {
        record('encode', String(value).length, fingerprint(value));
        return super.encode(value);
      }
    },
    Audio: class {
      constructor() {
        record('media-audio');
      }
      canPlayType(type) {
        record('audio-type', type);
        return '';
      }
    },
    FontFace: class {
      constructor(family, source) {
        record('font-face', family, source);
        this.family = family;
      }
      load() {
        record('font-load', this.family);
        return Promise.resolve(this);
      }
    },
    OfflineAudioContext,
    RTCPeerConnection: class {
      constructor() {
        record('rtc');
      }
    },
    speechSynthesis: {
      getVoices() {
        record('voices');
        return [
          {
            voiceURI: 'one',
            name: 'Synthetic',
            lang: 'en',
            localService: true,
            default: true,
          },
        ];
      },
      addEventListener(type) {
        record('voice-listener', type);
      },
    },
    MediaSource: {
      isTypeSupported(type) {
        record('source', type);
        return false;
      },
    },
    MediaRecorder: {
      isTypeSupported(type) {
        record('recorder', type);
        return false;
      },
    },
    Intl: {
      DateTimeFormat() {
        return { resolvedOptions: () => ({ locale: 'en', timeZone: 'UTC' }) };
      },
    },
    getComputedStyle(node) {
      record('style', node.key);
      if (mode === 'style-fail') throw Error('style');
      const style = Object.assign(
        Object.create({ toString: () => '[object CSSStyleDeclaration]' }),
        {
          backgroundColor: 'rgb(0, 0, 0)',
          fontSize: '12px',
          fontFamily: 'synthetic',
          inlineSize: '200px',
          blockSize: '200px',
        }
      );
      return style;
    },
    setTimeout(callback, delay) {
      record('timer', delay);
      timers.set(++timerId, { callback, at: currentTime + delay });
      return timerId;
    },
    clearTimeout(id) {
      record('clear', id);
      timers.delete(id);
    },
    parseInt,
    parseFloat,
    atob,
    btoa,
  };
  realm.window = realm;
  if (mode === 'missing-capabilities') {
    delete realm.OfflineAudioContext;
    delete realm.RTCPeerConnection;
    delete realm.speechSynthesis;
    delete realm.MediaSource;
    delete realm.MediaRecorder;
  }
  async function settle(promise) {
    let done = false,
      result,
      error;
    promise.then(
      v => {
        done = true;
        result = v;
      },
      e => {
        done = true;
        error = e;
      }
    );
    for (let round = 0; round < 40 && !done; round++) {
      for (let i = 0; i < 100; i++) await Promise.resolve();
      if (done) break;
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (next) {
        timers.delete(next[0]);
        currentTime = next[1].at;
        next[1].callback();
      }
    }
    if (!done) throw Error('synthetic collection did not settle');
    if (error) throw error;
    return result;
  }
  return {
    realm,
    trace,
    settle,
    remaining: () =>
      walk(body).map(node => [node.tag, node.id, node.children.length]),
    timers,
  };
}
module.exports = { createFixture };
