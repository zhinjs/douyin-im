import { collectDesktopPlugins, type DesktopPlugin, type DesktopPluginMime } from './desktop-plugins.js';

describe('Desktop Z plugins collector', () => {
  function context(mimes: (DesktopPluginMime | null)[], filename: unknown = 'file') {
    const plugin: DesktopPlugin = { filename, get length() { return mimes.length; }, item(index) { expect(this).toBe(plugin); return mimes[index]; } };
    const plugins = { length: 1, item() { expect(this).toBe(plugins); return plugin; } };
    return { navigator: { plugins } };
  }
  it('keeps MIME order/duplicates and produces no placeholder for empty plugins or MIME holes', () => {
    expect(collectDesktopPlugins(context([{ type: 'a', suffixes: 'x' }, null, { type: 'a', suffixes: 'x' }]))).toEqual({ plugin: ['file|a|x', 'file|a|x'], pv: '0' });
    expect(collectDesktopPlugins(context([]))).toEqual({ plugin: [], pv: '0' });
  });
  it('uses concat string hints rather than text/default conversion', () => {
    const hints: string[] = [];
    const value = { [Symbol.toPrimitive](hint: string) { hints.push(hint); return 'v'; } };
    expect(collectDesktopPlugins(context([{ type: value, suffixes: value }], value))).toEqual({ plugin: ['v|v|v'], pv: '0' });
    expect(hints).toEqual(['string', 'string', 'string']);
    expect(collectDesktopPlugins(context([{}], Symbol('bad')))).toEqual({ plugin: [], pv: '0' });
  });
  it('preserves already pushed values, then stops the whole traversal on failure', () => {
    let visited = false;
    const data = [{ type: 'first' }, { get type(): never { throw Error('bad'); } }, { get type() { visited = true; return 'third'; } }];
    expect(collectDesktopPlugins(context(data))).toEqual({ plugin: ['file|first|undefined'], pv: '0' });
    expect(visited).toBe(false);
  });
  it('re-evaluates changing lengths and repeats navigator.plugins reads', () => {
    const data: DesktopPluginMime[] = [{ get type() { data.push({ type: 'second' }); return 'first'; } }];
    const base = context(data);
    let reads = 0;
    expect(collectDesktopPlugins({ get navigator() { reads++; return base.navigator; } })).toEqual({ plugin: ['file|first|undefined', 'file|second|undefined'], pv: '0' });
    expect(reads).toBe(5);
  });
  it('returns fresh empty arrays for missing or throwing navigator inputs', () => {
    const first = collectDesktopPlugins({ navigator: {} });
    expect(first).toEqual({ plugin: [], pv: '0' });
    expect(collectDesktopPlugins({ navigator: {} }).plugin).not.toBe(first.plugin);
    expect(collectDesktopPlugins({ get navigator(): never { throw Error('nav'); } })).toEqual(first);
  });
});
