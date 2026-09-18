import { ConversationSummaryCache, isDesktopHintMessage, type ConversationSummaryRecord } from './conversation-summary.js';
import type { MessageFloatHintConfig } from '../../desktop/settings.js';
import type { ImConversation, PrivateMessage } from './types.js';
import { LATEST_MESSAGE_PROPERTY_KEY, serializeConversationPropertyInfo } from './message-property.js';

const conversation: ImConversation = { conversationId: '700', conversationShortId: '700', conversationType: 2,
  isGroup: true, name: 'group', members: [], lastMessageTime: 19, sortOrder: '81' };
function message(id: number, order = id): PrivateMessage {
  return { threadId: '700', msgId: String(id), clientMessageId: `c${id}`, senderUid: '22',
    msgType: 7, content: '{"text":"body"}', status: 0, createTime: 99, orderIndex: String(order), indexInConversation: String(id) };
}
function harness(rows: PrivateMessage[], config?: MessageFloatHintConfig, saved?: ConversationSummaryRecord, raw = conversation, userId = '') {
  let persisted = saved;
  const save = jest.fn((_id: string, value: ConversationSummaryRecord) => { persisted = structuredClone(value); });
  const cache = new ConversationSummaryCache({ conversation: id => id === '700' ? raw : undefined, load: () => persisted,
    save, commitLocalExt: (id, localExt) => save(id, { ...(persisted ?? { lastClientId: '', hintClientId: '', lastMessageIndex: '0' }), localExt }),
    messages: () => rows }, config, userId);
  return { cache, save, stored: () => persisted, snapshot: () => cache.project(raw) };
}

describe('native conversation summary selection', () => {
  it('commits query-hydrated live selectors when a full server merge saves the conversation', () => {
    const saved = { lastClientId: 'c1', hintClientId: 'c1', lastMessageIndex: '99',
      lastMessageTime: 19, sortOrder: '81', maxIndex: '20', maxOrder: '30', localExt: { other: 'keep' } };
    const { cache, stored, save } = harness([message(1)], undefined, saved);
    expect(cache.query(conversation).lastMessageIndex).toBe('1');
    expect(stored()).toEqual(saved);
    expect(save).not.toHaveBeenCalled();
    cache.saveMerged('700');
    expect(stored()).toEqual({ ...saved, lastMessageIndex: '1', sortOrder: '19' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('persists an existing live-only summary on merge, without manufacturing state for untouched rows', () => {
    const { cache, save, stored } = harness([]);
    cache.saveMerged('missing');
    cache.saveMerged('700');
    expect(save).not.toHaveBeenCalled();
    cache.prepare('700');
    cache.saveMerged('700');
    expect(stored()).toEqual({ lastMessageIndex: '0', lastClientId: '', hintClientId: '',
      lastMessageTime: 19, sortOrder: '19', maxIndex: '0', maxOrder: '0', localExt: {} });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('replaces the live cache from DB query input without saving hydrated index or retaining live sort', () => {
    const saved = { lastClientId: 'c1', hintClientId: 'c1', lastMessageIndex: '99',
      lastMessageTime: 19, sortOrder: '81', maxIndex: '0', maxOrder: '0' };
    const { cache, stored, save, snapshot } = harness([message(1)], undefined, saved);
    cache.query({ ...conversation, sortOrder: '500' });
    expect(snapshot()).toMatchObject({ lastMessageIndex: '1', sortOrder: '500' });
    expect(cache.query(conversation)).toMatchObject({ lastMessageIndex: '1', sortOrder: '81' });
    expect(snapshot()).toMatchObject({ lastMessageIndex: '1', sortOrder: '81' });
    expect(stored()).toEqual(saved);
    expect(save).not.toHaveBeenCalled();
  });

  it('restores persisted query selectors without filtering hits or persisting their index change', () => {
    const rows = [{ ...message(1), msgType: 50001 }, message(2)];
    const saved = { lastClientId: 'c1', hintClientId: 'c1', lastMessageIndex: '99', maxIndex: '0', maxOrder: '0' };
    const { cache, save, stored } = harness(rows, { enable: true, notHintMessages: { 50001: [-1] }, notFloatMessages: {} }, saved);
    expect(cache.query(conversation)).toMatchObject({ lastMessageIndex: '1', lastMessage: { msgId: '1' },
      hintMessage: { msgId: '1' }, sortOrder: '81', lastMessageTime: 19, maxIndex: '0', maxOrder: '0' });
    expect(save).not.toHaveBeenCalled();
    expect(stored()).toEqual(saved);
  });

  it('repairs both query slots when only one persisted selector is missing', () => {
    const { cache, save, stored } = harness([message(1), { ...message(2), deleted: true }, message(3)], undefined,
      { lastClientId: 'c1', hintClientId: 'c2', lastMessageIndex: '1' });
    expect(cache.query(conversation)).toMatchObject({ lastMessage: { msgId: '3' }, hintMessage: { msgId: '3' },
      sortOrder: '81', lastMessageTime: 19 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ lastClientId: 'c3', hintClientId: 'c3', lastMessageIndex: '3' });
  });

  it.each([2000, 3999, 4000])('limits query repair to 20 pages of 200 rows (hidden=%s)', hidden => {
    const rows = [message(1), ...Array.from({ length: hidden }, (_, i) => ({ ...message(i + 2), msgType: 50001 }))];
    const { cache } = harness(rows);
    const result = cache.query(conversation);
    expect(result.lastMessage?.msgId ?? null).toBe(hidden < 4000 ? '1' : null);
    expect(result.hintMessage?.msgId ?? null).toBe(hidden < 4000 ? '1' : null);
    expect(result.sortOrder).toBe('81');
  });

  it.each([
    { rows: [] as PrivateMessage[], oldIndex: '-1', oldOrder: '-1', index: '0', order: '0', writes: 1 },
    { rows: [{ ...message(9), deleted: true }], oldIndex: '-1', oldOrder: '20', index: '9', order: '20', writes: 1 },
    { rows: [{ ...message(-3, -2), deleted: true }], oldIndex: '-5', oldOrder: '-4', index: '-3', order: '-2', writes: 1 },
    { rows: [{ ...message(9), deleted: true }], oldIndex: '0', oldOrder: '0', index: '0', order: '0', writes: 0 },
  ])('repairs DB-backed maxima independently, only for negative stored values: $oldIndex/$oldOrder', fixture => {
    const { cache, save } = harness(fixture.rows, undefined, { lastClientId: '', hintClientId: '', lastMessageIndex: '0',
      maxIndex: fixture.oldIndex, maxOrder: fixture.oldOrder });
    expect(cache.query(conversation)).toMatchObject({ maxIndex: fixture.index, maxOrder: fixture.order });
    expect(save).toHaveBeenCalledTimes(fixture.writes);
  });

  function reactionMessage(id: number, seconds?: string, emoji = 'ok'): PrivateMessage {
    return { ...message(id), senderUid: '11', createTime: id * 1000,
      propertyList: seconds === undefined ? {} : { [`se:${emoji}`]: [{ uid: '22', secUid: '', createTime: seconds, value: '', idempotentId: '' }] } };
  }

  it('marks only unread property info, retaining pointers, other localExt and sort fields', () => {
    const rows = [reactionMessage(1), reactionMessage(2)];
    const localExt = { other: 'keep', [LATEST_MESSAGE_PROPERTY_KEY]: serializeConversationPropertyInfo({ clientId: 'c1', emoji: 'ok', sender: '22', createdAt: '5', markRead: false }) };
    const saved = { lastMessageIndex: '2', lastClientId: 'c2', hintClientId: 'c2', localExt,
      lastMessageTime: 5000, sortOrder: '5000', maxIndex: '2', maxOrder: '2' };
    const { cache, snapshot, stored, save } = harness(rows, undefined, saved, conversation, '11');
    const before = snapshot();
    expect(cache.markPropertyRead('700')).toBe(true);
    expect(snapshot()).toEqual({ ...before, localExt: { ...localExt, [LATEST_MESSAGE_PROPERTY_KEY]: serializeConversationPropertyInfo({ ...before.propertyInfo!, markRead: true }) }, propertyInfo: { ...before.propertyInfo!, markRead: true } });
    expect(stored()).toEqual({ ...saved, localExt: snapshot().localExt });
    expect(cache.markPropertyRead('700')).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    cache.saved(reactionMessage(1, '6'));
    expect(snapshot().propertyInfo).toMatchObject({ createdAt: '6', markRead: false });
  });

  it('does not create state for absent, empty or malformed property info', () => {
    for (const encoded of [undefined, '{}', 'bad', '{"clientId":"c1","markRead":false}', serializeConversationPropertyInfo({ clientId: '', emoji: '', sender: '', createdAt: '0', markRead: false })]) {
      const raw = { ...conversation, localExt: encoded === undefined ? {} : { [LATEST_MESSAGE_PROPERTY_KEY]: encoded } };
      const { cache, save, stored } = harness([], undefined, undefined, raw);
      expect(cache.markPropertyRead('')).toBe(false);
      expect(cache.markPropertyRead('missing')).toBe(false);
      expect(cache.markPropertyRead('700')).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(stored()).toBeUndefined();
    }
  });

  it('persists only localExt after deletion cleared unsaved runtime selectors', () => {
    const rows = [reactionMessage(1)];
    const localExt = { [LATEST_MESSAGE_PROPERTY_KEY]: serializeConversationPropertyInfo({ clientId: 'c1', emoji: 'ok', sender: '22', createdAt: '5', markRead: false }) };
    const saved = { lastMessageIndex: '1', lastClientId: 'c1', hintClientId: 'c1', localExt };
    const { cache, snapshot, stored } = harness(rows, undefined, saved);
    cache.prepare('700'); rows[0]!.deleted = true;
    expect(cache.removed('700', 'c1')).toBe(true);
    expect(snapshot()).toMatchObject({ lastMessageIndex: '0', lastMessage: null, hintMessage: null, propertyMessage: null });
    expect(cache.markPropertyRead('700')).toBe(true);
    expect(stored()).toEqual({ ...saved, localExt: snapshot().localExt });
    expect(snapshot()).toMatchObject({ lastMessageIndex: '0', lastMessage: null, hintMessage: null, propertyMessage: null, propertyInfo: { markRead: true } });
  });

  it('can read raw localExt without a retained property message or existing summary record', () => {
    const raw = { ...conversation, localExt: { other: 'keep', [LATEST_MESSAGE_PROPERTY_KEY]: serializeConversationPropertyInfo({ clientId: 'evicted', emoji: 'ok', sender: '22', createdAt: '9223372036854775807', markRead: false }) } };
    const { cache, snapshot, stored } = harness([], undefined, undefined, raw);
    expect(cache.markPropertyRead('700')).toBe(true);
    expect(snapshot()).toMatchObject({ propertyMessage: null, propertyInfo: { clientId: 'evicted', createdAt: '9223372036854775807', markRead: true }, localExt: { other: 'keep' }, lastMessageTime: 19, sortOrder: '81' });
    expect(stored()).toEqual({ lastMessageIndex: '0', lastClientId: '', hintClientId: '', localExt: snapshot().localExt });
  });

  it('keeps property selection independent and requires self, complete slots and strict hint time', () => {
    const rows = [reactionMessage(1, '5')];
    const { cache, snapshot } = harness(rows, { enable: true, notHintMessages: {}, notFloatMessages: { 7: [-1] } }, undefined, conversation, '11');
    cache.saved(rows[0]!);
    expect(snapshot().propertyMessage).toBeNull(); // Missing slots cause recalc and early return.
    rows.push(reactionMessage(2)); cache.saved(rows[1]!);
    cache.saved({ ...reactionMessage(1, '9'), status: 1 });
    cache.saved({ ...reactionMessage(1, '9'), ext: { 's:is_recalled': 'true' } });
    expect(snapshot().propertyMessage).toBeNull();
    cache.saved({ ...reactionMessage(1, '9'), senderUid: '22' });
    expect(snapshot().propertyMessage).toBeNull();
    cache.saved(reactionMessage(1, '2'));
    expect(snapshot().propertyMessage).toBeNull(); // Equal to hintTime/1000, not greater.
    cache.saved(reactionMessage(1, '5'));
    expect(snapshot()).toMatchObject({ lastMessage: { msgId: '2' }, hintMessage: { msgId: '2' },
      propertyMessage: { msgId: '1' }, propertyInfo: { clientId: 'c1', sender: '22', emoji: 'ok', createdAt: '5', markRead: false }, lastMessageTime: 5000, sortOrder: '5000' });
  });

  it('rolls back only the selected message reaction, without rewinding sort or searching other messages', () => {
    const rows = [reactionMessage(1), reactionMessage(2)];
    const { cache, snapshot } = harness(rows, undefined, undefined, conversation, '11');
    cache.saved(rows[0]!); cache.saved(reactionMessage(1, '5'));
    cache.saved(reactionMessage(3, '1'));
    expect(snapshot().propertyInfo!.clientId).toBe('c1');
    cache.saved(reactionMessage(1, '1'));
    expect(snapshot()).toMatchObject({ propertyInfo: { createdAt: '1' }, propertyMessage: { msgId: '1' }, lastMessageTime: 5000 });
    cache.saved(reactionMessage(1));
    expect(snapshot()).toMatchObject({ propertyInfo: { clientId: '', createdAt: '0', markRead: false }, propertyMessage: null, sortOrder: '5000' });
    expect(snapshot().localExt![LATEST_MESSAGE_PROPERTY_KEY]).toContain('"createdAt":0');
  });

  it('refreshes same-UUID property pointer without replacing equal-time info or its read flag', () => {
    const rows = [reactionMessage(1), reactionMessage(2)];
    const localExt = { other: 'keep', [LATEST_MESSAGE_PROPERTY_KEY]: serializeConversationPropertyInfo({ clientId: 'c1', emoji: 'old', sender: '22', createdAt: '5', markRead: true }) };
    const { cache, snapshot, save } = harness(rows, undefined, { lastMessageIndex: '2', lastClientId: 'c2', hintClientId: 'c2', localExt }, conversation, '11');
    cache.saved(reactionMessage(1, '5', 'new'));
    expect(snapshot()).toMatchObject({ propertyInfo: { emoji: 'old', markRead: true }, propertyMessage: { propertyList: { 'se:new': [{ uid: '22', createTime: '5' }] } }, localExt: { other: 'keep' } });
    expect(save).toHaveBeenCalledTimes(1);
    save.mockClear();
    expect(cache.removed('700', 'c1')).toBe(false);
    expect(snapshot()).toMatchObject({ propertyMessage: null, propertyInfo: { clientId: 'c1', emoji: 'old' } });
    expect(save).not.toHaveBeenCalled();
  });

  it('separates first-slot recalc, hint selection, monotonic indexes and floating', () => {
    const rows = [message(1)];
    const { cache, snapshot } = harness(rows, { enable: true, notHintMessages: { 7: [42] }, notFloatMessages: { 7: [42] } });
    cache.saved(rows[0]!);
    expect(snapshot()).toMatchObject({ lastMessageTime: 19, sortOrder: '81', maxIndex: '0', maxOrder: '0' });
    const excluded = { ...message(5), content: '{"aweType":42}', createTime: 200 };
    rows.push(excluded); cache.saved(excluded);
    expect(snapshot()).toMatchObject({ lastMessage: { msgId: '5' }, hintMessage: { msgId: '1' }, maxIndex: '5', maxOrder: '5', lastMessageTime: 19, sortOrder: '81' });
    const oldOrder = { ...message(2, 2), createTime: 300, indexInConversation: '20' };
    rows.push(oldOrder); cache.saved(oldOrder);
    expect(snapshot()).toMatchObject({ lastMessage: { msgId: '5' }, hintMessage: { msgId: '2' }, maxIndex: '20', maxOrder: '5', lastMessageTime: 300, sortOrder: '300' });
    cache.saved({ ...message(6), indexInConversation: '1', createTime: 299 });
    expect(snapshot()).toMatchObject({ maxIndex: '20', maxOrder: '6', lastMessageTime: 300 });
  });

  it('does not float when either slot is missing, or on recalled/invisible writes', () => {
    const rows = [message(1)];
    const noHint = harness(rows, { enable: true, notHintMessages: { 7: [-1] } });
    noHint.cache.saved(rows[0]!); rows.push(message(2)); noHint.cache.saved(rows[1]!);
    expect(noHint.snapshot()).toMatchObject({ hintMessage: null, lastMessageTime: 19, maxOrder: '0' });
    const normal = harness(rows); normal.cache.saved(rows[0]!);
    normal.cache.saved({ ...message(3), ext: { 's:is_recalled': 'true' } });
    normal.cache.saved({ ...message(4), status: 1 });
    expect(normal.snapshot()).toMatchObject({ lastMessageTime: 19, maxOrder: '0' });
  });

  it('reads current pin/settings independently of persisted derived fields and saves invalid-time float attempts', () => {
    const rows = [message(10)];
    const raw = { ...conversation, settingExt: { 'a:cell_sort_time': '5' }, pinned: true };
    const { cache, snapshot, save } = harness(rows, undefined, undefined, raw);
    cache.saved(rows[0]!);
    cache.saved({ ...message(11), createTime: 100 });
    expect(snapshot()).toMatchObject({ lastMessageTime: 100, sortOrder: '500000000000100' });
    raw.pinned = false;
    cache.saved({ ...message(12), createTime: 200 });
    expect(snapshot()).toMatchObject({ lastMessageTime: 200, sortOrder: '5000' });
    cache.saved({ ...message(1), createTime: 300 });
    expect(snapshot()).toMatchObject({ lastMessageTime: 300, sortOrder: '5000' });
    save.mockClear();
    cache.saved({ ...message(1), createTime: 500000000000001 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(snapshot()).toMatchObject({ lastMessageTime: 300, sortOrder: '5000', maxIndex: '12', maxOrder: '12' });
  });

  it('keeps absent conversations absent and does not manufacture a summary on a read', () => {
    const { cache, snapshot, save } = harness([]);
    expect(snapshot()).toEqual(conversation);
    cache.saved({ ...message(1), threadId: 'other' });
    expect(cache.removed('other', 'c1')).toBe(false);
    expect(cache.removed('700', '')).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('uses order, then visibility and hint, while preserving conversation time and sort order', () => {
    const rows = [message(1, 50), { ...message(2, 51), content: '{"aweType":42}', indexInConversationV2: '9999' },
      { ...message(3, 100), status: 1 }];
    const { cache, snapshot } = harness(rows, { enable: true, notHintMessages: { 7: [42] } });
    cache.saved(rows[0]!);
    expect(snapshot()).toMatchObject({ lastMessageIndex: '2', lastMessage: { msgId: '2' }, hintMessage: { msgId: '1' }, lastMessageTime: 19, sortOrder: '81' });
    snapshot().lastMessage!.content = 'mutated';
    expect(snapshot().lastMessage!.content).toBe('{"aweType":42}');
  });

  it('selects empty-content messages natively but projects a null last/hint in JS', () => {
    const rows = [{ ...message(1), content: '' }];
    const { cache, snapshot, stored } = harness(rows);
    cache.saved(rows[0]!);
    expect(snapshot()).toMatchObject({ lastMessageIndex: '1', lastMessage: null, hintMessage: null });
    expect(stored()).toMatchObject({ lastMessageIndex: '1', lastClientId: 'c1', hintClientId: 'c1' });
  });

  it('does not impose recalled, server ID or send-success restrictions on selection', () => {
    const rows = [{ ...message(1), msgId: '0', status: 3, ext: { 's:is_recalled': 'true' } }];
    const { cache, snapshot } = harness(rows);
    // A normal trigger initializes from all retained candidates, including recalled rows.
    cache.saved(message(2, 0));
    expect(snapshot().lastMessage).toEqual(rows[0]);
  });

  it('preserves native per-page resets when finding a hint on a later page', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ ...message(index + 2), content: '{"aweType":42}' }));
    rows.push(message(1));
    const { cache, snapshot, save } = harness(rows, { enable: true, notHintMessages: { 7: [42] } });
    cache.saved(rows[0]!);
    expect(snapshot()).toMatchObject({ lastMessage: { msgId: '1' }, hintMessage: { msgId: '1' } });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('stops after ten pages, filtering status after LIMIT rather than scanning unboundedly', () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ ...message(index + 2), status: 1 }));
    rows.push(message(1));
    const { cache, snapshot, save } = harness(rows);
    cache.saved(rows[0]!);
    expect(snapshot()).toMatchObject({ lastMessageIndex: '0', lastMessage: null, hintMessage: null });
    expect(save).not.toHaveBeenCalled();
  });

  it('excludes deleted rows before LIMIT and uses strict signed order bounds, never V2/time', () => {
    const rows: PrivateMessage[] = Array.from({ length: 2100 }, (_, index) => ({ ...message(index + 2), deleted: true }));
    rows.push({ ...message(3000), orderIndex: '9223372036854775807' },
      { ...message(3001), orderIndex: '0', indexInConversationV2: '999999', createTime: 999999 }, message(1));
    const { cache, snapshot } = harness(rows);
    cache.saved(message(1));
    expect(snapshot().lastMessage!.msgId).toBe('1');
  });

  it('applies SQL LIMIT before same-order map collapse, without claiming native tie determinism', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ ...message(index + 2, 2), status: 1 }));
    rows.push(message(999, 2), message(1));
    const { cache, snapshot } = harness(rows);
    cache.saved(rows[0]!);
    // The 201st equal-order row was outside LIMIT and is excluded by the next strict cursor.
    expect(snapshot().lastMessage!.msgId).toBe('1');
  });

  it('allows equal-order incremental replacement without sorting by createTime', () => {
    const rows = [message(1, 100)];
    const { cache, snapshot } = harness(rows);
    cache.saved(rows[0]!);
    const olderTime = { ...message(2, 100), createTime: 1 };
    rows.push(olderTime); cache.saved(olderTime);
    expect(snapshot().lastMessage!.msgId).toBe('2');
    const lowerOrder = { ...message(3, 99), createTime: 999999 };
    rows.push(lowerOrder); cache.saved(lowerOrder);
    expect(snapshot().lastMessage!.msgId).toBe('2');
  });

  it('distinguishes cleared runtime slots from unchanged persisted IDs on an empty deletion page', () => {
    const rows = [message(1)];
    const { cache, snapshot, stored, save } = harness(rows);
    cache.saved(rows[0]!); save.mockClear();
    rows[0]!.deleted = true;
    expect(cache.removed('700', 'unrelated')).toBe(false);
    expect(cache.removed('700', 'c1')).toBe(true);
    expect(snapshot()).toMatchObject({ lastMessageIndex: '0', lastMessage: null, hintMessage: null });
    expect(save).not.toHaveBeenCalled();
    expect(stored()!.lastClientId).toBe('c1');
    expect(cache.removed('700', 'c1')).toBe(false);
  });

  it('reselects a recalled target and persists even if its final IDs match those before clearing', () => {
    const rows = [message(1)];
    const { cache, snapshot, save } = harness(rows);
    cache.saved(rows[0]!); save.mockClear();
    rows[0]!.ext = { 's:is_recalled': 'true' };
    cache.saved(rows[0]!);
    expect(snapshot().hintMessage!.ext).toEqual({ 's:is_recalled': 'true' });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('native hint configuration', () => {
  it.each([
    ['{}', -1], ['{"aweType":"42"}', -1], ['{"aweType":42.0}', -1], ['{"aweType":4.2e1}', -1],
    ['{"awe_type":42}', -1], ['{"aweType":42}', 42], ['{"aweType":4294967338}', 42],
    ['{"aweType":42,"aweType":1}', 1], ['{"awe\\u0054ype":42}', 42], ['', -1],
  ])('matches exact integer type for %s', (content, value) => {
    const row = { ...message(1), content };
    expect(isDesktopHintMessage(row, { enable: true, notHintMessages: { 7: [value] } })).toBe(false);
    expect(isDesktopHintMessage(row, { enable: false, notHintMessages: { 7: [value] } })).toBe(true);
    expect(isDesktopHintMessage(row, { enable: true, notHintMessages: { 8: [value] } })).toBe(true);
    expect(isDesktopHintMessage(row)).toBe(true);
  });
});
