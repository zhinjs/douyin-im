import { mergeConversationSettings } from './conversation-settings.js';
import type { ImConversation } from './types.js';

const snapshot = (patch: Partial<ImConversation> = {}): ImConversation => ({
  conversationId: '700', conversationShortId: '700', conversationType: 2,
  isGroup: true, name: 'network', members: [], lastMessageTime: 0, ...patch,
});

describe('Desktop full conversation setting merge', () => {
  it('merges missing settings against a default native instance, without changing the network DTO', () => {
    const raw = snapshot();
    expect(mergeConversationSettings(undefined, raw)).toEqual({ ...raw,
      settingVersion: '0', settingExt: {}, settingExtVersions: {}, minIndex: '0', readIndex: '0',
      muted: false, pinned: false, favorite: false, setTopTime: '0', setFavoriteTime: '0',
      readIndexV2: '0', minIndexV2: '0', readBadgeCount: 0, isFolded: false });
    expect(raw).not.toHaveProperty('settingVersion');
  });

  it('rejects only the settings of older snapshots, using full signed int64 precision', () => {
    const current = snapshot({ settingVersion: '9007199254740993', muted: true, pinned: true, favorite: true,
      minIndex: '40', readIndex: '80', readIndexV2: '90', minIndexV2: '30', readBadgeCount: 20,
      setTopTime: '100', setFavoriteTime: '200', settingExt: { risk: 'present' }, settingExtVersions: { risk: '7' } });
    const incoming = snapshot({ name: 'new core', settingVersion: '9007199254740992', readIndexV2: '999', readBadgeCount: 999,
      settingExt: {}, settingExtVersions: {} });
    const result = mergeConversationSettings(current, incoming);
    expect(result).toEqual({ ...current, name: 'new core', isFolded: false });
    expect(result.settingExt).not.toBe(current.settingExt);
    expect(result.settingExtVersions).not.toBe(current.settingExtVersions);
  });

  it('allows equal versions and overwrites v1/min indexes while taking max only for v2/read badges', () => {
    const current = snapshot({ settingVersion: '8', readIndex: '99', minIndex: '80', minIndexV2: '70',
      readIndexV2: '9007199254740993', readBadgeCount: 2147483647, muted: true, pinned: true, favorite: true,
      settingExt: { old: 'x' }, settingExtVersions: { old: '100' }, setTopTime: '90', setFavoriteTime: '91' });
    const incoming = snapshot({ settingVersion: '8', readIndex: '-4', minIndex: '-2', minIndexV2: '-3',
      readIndexV2: '9007199254740992', readBadgeCount: -1, settingExt: { fresh: 'y' }, settingExtVersions: { fresh: '1' } });
    const result = mergeConversationSettings(current, incoming);
    expect(result).toMatchObject({ settingVersion: '8', readIndex: '-4', minIndex: '-2', minIndexV2: '-3',
      readIndexV2: '9007199254740993', readBadgeCount: 2147483647, muted: false, pinned: false, favorite: false,
      setTopTime: '0', setFavoriteTime: '0', settingExt: { fresh: 'y' }, settingExtVersions: { fresh: '1' } });
    expect(result.settingExt).not.toHaveProperty('old');
    expect(result.settingExtVersions).not.toHaveProperty('old');
    expect(result.settingExt).not.toBe(incoming.settingExt);
  });

  it('keeps the previous version when absent but still applies defaults and clears both maps', () => {
    const current = snapshot({ settingVersion: '12', readIndex: '30', readIndexV2: '40', readBadgeCount: 7,
      minIndex: '20', minIndexV2: '21', settingExt: { risk: 'x' }, settingExtVersions: { risk: '6' } });
    expect(mergeConversationSettings(current, snapshot())).toMatchObject({
      settingVersion: '12', readIndex: '0', minIndex: '0', minIndexV2: '0', readIndexV2: '40', readBadgeCount: 7,
      settingExt: {}, settingExtVersions: {} });
    expect(mergeConversationSettings(current, snapshot({ settingVersion: '0' })))
      .toMatchObject({ settingVersion: '12', readIndex: '30', settingExt: { risk: 'x' } });
  });

  it('handles negative versions and max comparisons as signed values', () => {
    const current = snapshot({ settingVersion: '-2', readIndexV2: '-5', readBadgeCount: -5 });
    expect(mergeConversationSettings(current, snapshot({ settingVersion: '-1', readIndexV2: '-3', readBadgeCount: -3 })))
      .toMatchObject({ settingVersion: '-1', readIndexV2: '-3', readBadgeCount: -3 });
    expect(mergeConversationSettings(undefined, snapshot({ settingVersion: '-1', muted: true })))
      .toMatchObject({ settingVersion: '0', muted: false });
  });

  it('raises high-water marks without rounding and preserves prototype-like map keys', () => {
    const ext = JSON.parse('{"__proto__":"risk","constructor":"value"}') as Record<string, string>;
    const versions = JSON.parse('{"__proto__":"9007199254740993"}') as Record<string, string>;
    const result = mergeConversationSettings(snapshot({ readIndexV2: '9007199254740992' }),
      snapshot({ readIndexV2: '9007199254740993', readBadgeCount: 20, settingExt: ext, settingExtVersions: versions }));
    expect(result).toMatchObject({ readIndexV2: '9007199254740993', readBadgeCount: 20 });
    expect(result.settingExt).toEqual(ext);
    expect(result.settingExtVersions).toEqual(versions);
    expect(Object.getPrototypeOf(result.settingExt)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.settingExtVersions)).toBe(Object.prototype);
  });
});
