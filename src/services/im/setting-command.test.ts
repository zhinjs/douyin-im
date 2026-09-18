import { applySettingExt, conversationIsFolded, settingCommand } from './setting-command.js';

describe('Desktop command4', () => {
  it('retains integer lexical types, signed narrowing and exact strings', () => {
    expect(settingCommand(50001, '{"command_type":4294967300,"conversation_id":" 700 ","conversation_version":18446744073709551615,"ext_data":[{"key":"k","value":" v ","version":9007199254740993,"op_type":4294967297}]}'))
      .toEqual({ conversationId: ' 700 ', version: '-1', entries: [{ key: 'k', value: ' v ', version: '9007199254740993', op: 1 }] });
    expect(settingCommand(50001, '{"command_type":4,"conversation_id":700,"conversation_version":"9","ext_data":[{"key":5,"value":true,"version":1.0,"op_type":"1"},null]}'))
      .toEqual({ conversationId: '', version: '0', entries: [{ key: '', value: '', version: '0', op: 0 }, { key: '', value: '', version: '0', op: 0 }] });
  });
  it.each(['"4"', '4.0', '4e0', 'true', '18446744073709551616'])('does not coerce command_type=%s', token => {
    expect(settingCommand(50001, `{"command_type":${token}}`)).toBeUndefined();
  });
  it('keeps the last duplicate key and treats nonarray ext_data as empty', () => {
    expect(settingCommand(50001, '{"command_type":4,"command_type":6}')).toBeUndefined();
    expect(settingCommand(50001, '{"command_type":4,"ext_data":{}}')).toEqual({ conversationId: '', version: '0', entries: [] });
    expect(settingCommand(7, '{"command_type":4}')).toBeUndefined();
    expect(settingCommand(50001, '{bad')).toBeUndefined();
  });
  it('requires existing key-version state, and empty data does not claim to be handled', () => {
    expect(applySettingExt({}, [{ key: 'k', value: 'v', version: '1', op: 1 }])).toMatchObject({ handled: false, changed: false });
    expect(applySettingExt({ settingExtVersions: { k: '1' } }, [])).toMatchObject({ handled: false, changed: false });
  });
  it('processes upsert/delete in order and deletes the version too, without a tombstone', () => {
    const current = { settingExt: { k: 'old' }, settingExtVersions: { k: '9007199254740993' } };
    expect(applySettingExt(current, [
      { key: 'k', value: '', version: '9007199254740994', op: 2 },
      { key: 'k', value: 'new', version: '1', op: 1 },
    ])).toEqual({ handled: true, changed: true, state: { settingExt: { k: 'new' }, settingExtVersions: { k: '1' } } });
    expect(current.settingExt.k).toBe('old');
  });
  it('retains earlier mutations when a later zero version fails and skips remaining entries', () => {
    const result = applySettingExt({ settingExtVersions: { seed: '1' } }, [
      { key: 'a:s_is_folded', value: '1', version: '2', op: 1 },
      { key: 'bad', value: 'x', version: '0', op: 1 },
      { key: 'later', value: 'x', version: '9', op: 1 },
    ]);
    expect(result).toEqual({ handled: false, changed: true, state: {
      settingExt: { 'a:s_is_folded': '1' }, settingExtVersions: { seed: '1', 'a:s_is_folded': '2' },
    } });
  });
  it('handles stale nonzero and unknown ops without changes, but allows zero over a negative local version', () => {
    expect(applySettingExt({ settingExtVersions: { k: '5' } }, [
      { key: 'k', value: '', version: '5', op: 1 }, { key: 'k', value: '', version: '0', op: 7 },
    ])).toMatchObject({ handled: true, changed: false });
    expect(applySettingExt({ settingExtVersions: { k: '-1' } }, [{ key: 'k', value: 'zero', version: '0', op: 1 }]))
      .toMatchObject({ handled: true, changed: true, state: { settingExt: { k: 'zero' }, settingExtVersions: { k: '0' } } });
  });
  it('preserves prototype-like map keys without reading inherited keys as versions', () => {
    const result = applySettingExt({ settingExtVersions: { seed: '1' } }, [{ key: '__proto__', value: 'x', version: '2', op: 1 }]);
    expect(Object.entries(result.state.settingExt!)).toEqual([['__proto__', 'x']]);
    expect(Object.getPrototypeOf(result.state.settingExt)).toBe(Object.prototype);
  });
  it.each(['', '0', 'true', '01', '1.0', ' 1', '1 ', '１', '1\0'])('does not coerce folded value %j', value => {
    expect(conversationIsFolded({ 'a:s_is_folded': value })).toBe(false);
  });
  it('folds only for its own exact string key', () => {
    expect(conversationIsFolded({ 'a:s_is_folded': '1' })).toBe(true);
    expect(conversationIsFolded(undefined)).toBe(false);
    expect(conversationIsFolded(Object.create({ 'a:s_is_folded': '1' }))).toBe(false);
  });
});
