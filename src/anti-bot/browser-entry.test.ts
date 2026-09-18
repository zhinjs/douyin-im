import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const requireBuild = createRequire(join(process.cwd(), 'package.json'));
const { buildDesktopBdmsAsset, compileBrowserModules } = requireBuild('./scripts/build/browser-bundle.cjs') as {
  buildDesktopBdmsAsset(root: string): string;
  compileBrowserModules(root: string, entries: string[]): string;
};
const root = join(process.cwd(), 'src/anti-bot');
const script = buildDesktopBdmsAsset(root);

function fixture() {
  const frames: unknown[] = [], stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key), removeItem: (key: string) => { stored.delete(key); } };
  class Xhr { open() {} send() {} setRequestHeader() {} addEventListener() {} }
  const window: Record<string, unknown> = {
    requestAnimationFrame: (callback: unknown) => frames.push(callback), localStorage: storage, sessionStorage: storage,
  };
  const context = {
    window, Object, Symbol, Array, RegExp, Reflect, Proxy, Boolean, TypeError, Math, Date, JSON, URL,
    navigator: Object.create(null) as object, document: { cookie: '', referrer: '' },
    performance: { now: () => 0 }, XMLHttpRequest: Xhr, localStorage: storage, sessionStorage: storage,
  };
  return { context, window, Xhr, frames, stored };
}
const evaluate = (context: object) => runInNewContext(script, context, {
  timeout: 3000, contextCodeGeneration: { strings: false, wasm: false },
});

describe('packaged Desktop browser entry', () => {
  it('builds deterministically from a closed browser-only module graph', () => {
    expect(buildDesktopBdmsAsset(root)).toBe(script);
    expect(() => compileBrowserModules(join(process.cwd(), 'src/desktop'), ['api-connection'])).toThrow('Non-browser dependency');
    expect(() => compileBrowserModules(root, ['../desktop/api-connection'])).toThrow('Invalid browser module name');
  });
  it('loads without Node globals, runtime eval, or a dynamic script loader', () => {
    const f = fixture(); f.stored.set('__ac_referer', 'source');
    const originalOpen = f.Xhr.prototype.open;
    evaluate(f.context);
    const module = f.window['bdms'] as { init(options: object): void; getReferer(): unknown };
    expect(Object.keys(module)).toEqual(['getReferer', 'init']);
    expect(module.getReferer()).toBe('source'); expect(f.stored.has('__ac_referer')).toBe(false);
    expect(f.Xhr.prototype.open).not.toBe(originalOpen); expect(f.frames).toHaveLength(1);
    expect(f.window['_sdkGlueVersionMap']).toEqual({ bdmsVersion: '1.0.1.7' });
    module.init({ track: { mode: 1 }, dump: false });
    expect(f.window['onwheelx']).toEqual({ _Ax: '0X21' });
  });
  it('preserves an existing truthy module without requiring browser APIs', () => {
    const existing = { implementation: 'already installed' };
    const window = { bdms: existing };
    evaluate({ window }); expect(window.bdms).toBe(existing);
  });
  it('does not install twice when its classic script is loaded twice', () => {
    const f = fixture(); evaluate(f.context);
    const module = f.window['bdms'], open = f.Xhr.prototype.open;
    evaluate(f.context);
    expect(f.window['bdms']).toBe(module); expect(f.Xhr.prototype.open).toBe(open); expect(f.frames).toHaveLength(1);
  });
});
