import { buildStrangerConversation, mergeConversationSnapshot, strangerConversationMode } from './conversation-state.js';
import { mapProtoConversationListItem } from './mappers.js';
import type { ImConversation, RecentStrangerConversation } from './types.js';
import { inboundFromMessage } from '../../base/raw/inbound-message.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImStateStore } from './state-store.js';

const current = (): ImConversation => ({ conversationId: '0:1:10001:20002', conversationShortId: '700',
  conversationType: 1, inboxType: 1, isGroup: false, name: 'before', members: [], lastMessageTime: 123,
  coreVersion: '9007199254740993', mode: 2, coreExt: { stranger: '10001', extra: 'before' },
  isInStrangerBox: true, strangerVersion: '90', badgeCount: 7, localExt: { local: 'keep' } });
const mapped = (core?: Record<string, unknown>) => mapProtoConversationListItem({ conversationId: current().conversationId,
  conversationShortId: '700', conversationType: 1, inboxType: 1, badgeCount: 2,
  ...(core ? { conversationCoreInfo: core } : {}) });

it('retains core presence through the wire mapper, independently of setting/local metadata', () => {
  expect(mapped()).not.toHaveProperty('coreVersion');
  expect(mapped({ infoVersion: '9007199254740993', mode: 2, ext: { stranger: '10001' } })).toMatchObject({
    coreVersion: '9007199254740993', mode: 2, coreExt: { stranger: '10001' },
  });
});

it('rejects only an older core, not other fields or setting updates', () => {
  const result = mergeConversationSnapshot(current(), { ...mapped({ infoVersion: '9', name: 'wrong', mode: 0, ext: {} }),
    badgeCount: 10, settingVersion: '8', pinned: true }, '10001');
  expect(result).toMatchObject({ name: 'before', coreVersion: '9007199254740993', mode: 2,
    coreExt: { stranger: '10001', extra: 'before' }, isInStrangerBox: true, badgeCount: 10, pinned: true });
});

it.each([undefined, '9007199254740993', '9007199254740994'])('replaces the entire core ext with an absent/equal/new version (%s)', version => {
  const result = mergeConversationSnapshot(current(), mapped({ ...(version ? { infoVersion: version } : {}),
    mode: 1, ext: { stranger: '10001' } }), '10001');
  expect(result).toMatchObject({ coreVersion: version ?? '9007199254740993', mode: 1, coreExt: { stranger: '10001' },
    isInStrangerBox: true, strangerVersion: '90', badgeCount: 7, localExt: { local: 'keep' } });
  expect(result.coreExt).not.toHaveProperty('extra');
});

it.each([undefined, {}, { mode: 0, ext: { stranger: '10001' } }, { mode: 2, ext: { stranger: '20002' } }])(
  'clears box membership for a missing/default/other-owner core %j', core => {
    const result = mergeConversationSnapshot(current(), mapped(core), '10001');
    expect(result.isInStrangerBox).toBe(false);
    expect(result.strangerVersion).toBe('90'); expect(result.badgeCount).toBe(7);
    expect(result.coreVersion).toBe('9007199254740993');
  });

it('requires the exact current self UID, independently of inbox and stranger version', () => {
  const incoming = mapped({ mode: 2, ext: { stranger: '10001' } });
  expect(mergeConversationSnapshot(undefined, { ...incoming, inboxType: 0 }, '10001').isInStrangerBox).toBe(true);
  expect(mergeConversationSnapshot(undefined, incoming, '').isInStrangerBox).toBe(false);
  expect(mergeConversationSnapshot(undefined, incoming, '010001').isInStrangerBox).toBe(false);
});

it.each([
  ['10001', '0:1:10001:20002', 2], ['20002', '0:1:10001:20002', 1],
  ['10001', '0:1:10001:10001', 2], ['30003', '0:1:10001:20002', 0],
  ['', '0:1:10001:20002', 0], ['10001', '0:1:10001', 0],
  ['10001', 'xx:1:10001:20002', 0],
])('uses native stranger-mode string matching (%s, %s)', (uid, id, mode) => {
  expect(strangerConversationMode(uid, id)).toBe(mode);
});

it('builds a new skeleton from the last nested type and the outer version, not localExt or inbox guesses', () => {
  const row: RecentStrangerConversation = { conversationId: '0:1:10001:20002', conversationShortId: '700', version: '-2', badgeCount: 3,
    messages: [{ msgId: '1', threadId: 'different', senderUid: '20002', conversationType: 2,
      content: '', msgType: 7, createTime: 0, status: 0, version: '999' }] };
  const result = buildStrangerConversation(undefined, row, '10001', 1)!;
  expect(result).toMatchObject({ conversationType: 2, isGroup: true, isParticipant: true, participantsCount: 2,
    isInStrangerBox: true, strangerVersion: '-2', coreExt: { stranger: '10001' }, mode: 2 });
  expect(result.localExt).toBeUndefined();
  expect(buildStrangerConversation(undefined, { ...row, messages: [] }, '10001', 1)?.conversationType).toBe(1);
  expect(buildStrangerConversation(undefined, { ...row, conversationShortId: '0' }, '10001', 1)).toBeUndefined();
  expect(buildStrangerConversation(undefined, { ...row, conversationId: '' }, '10001', 1)).toBeUndefined();
});

it('existing skeletons change only box, outer version and MAX badge, without mutating the input', () => {
  const previous = current();
  const result = buildStrangerConversation(previous, { conversationId: previous.conversationId, conversationShortId: '999',
    version: '-1', badgeCount: 2, messages: [] }, 'other', 0)!;
  expect(result).toEqual({ ...previous, isInStrangerBox: true, strangerVersion: '-1' });
  expect(result.coreExt).not.toBe(previous.coreExt);
  expect(previous.strangerVersion).toBe('90');
});

it('recalculates sort order from the local last time and newly merged settings, not the detail DTO time', () => {
  const before = { ...current(), sortOrder: '123' };
  const pinned = mergeConversationSnapshot(before, { ...mapped(), pinned: true, lastMessageTime: 0 }, '10001');
  expect(pinned).toMatchObject({ lastMessageTime: 123, sortOrder: '500000000000123' });
  const unpinned = mergeConversationSnapshot(pinned, { ...mapped(), settingExt: { 'a:cell_sort_time': '5' } }, '10001');
  expect(unpinned).toMatchObject({ lastMessageTime: 123, sortOrder: '5000' });
});

it('maps grouped messages from their own identity and preserves explicit zero/default fields', () => {
  const message = { threadId: 'inner', conversationShortId: '8', conversationType: 2, inboxType: 1,
    msgId: '9', senderUid: '20002', content: '{"text":"test"}', msgType: 7, createTime: 0, status: 0,
    version: '0', orderInConversation: '0', indexInConversation: '0' };
  expect(inboundFromMessage(message)).toMatchObject({ threadId: 'inner', conversationShortId: '8', conversationType: 2,
    inboxType: 1, status: 0, version: '0', orderInConversation: '0', text: 'test' });
  expect(inboundFromMessage({ ...message, threadId: '' })).toBeNull();
  expect(inboundFromMessage({ ...message, senderUid: '' })).toBeNull();
});

it.each(['sqlite', 'json'] as const)('persists separate core/local/stranger state and updates existing summary order after details (%s)', backend => {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-core-state-'));
  let store = createImStateStore({ accountDir: directory, backend, userId: '10001' });
  try {
    const initial = current();
    store.upsertConversations([initial], 'local');
    store.upsertMessages([{ threadId: initial.conversationId, msgId: '8', senderUid: '20002', content: '{"text":"hello"}',
      msgType: 7, createTime: 1000, status: 0, indexInConversation: '1', orderInConversation: '1',
      clientMessageId: 'client-8', ext: { 's:client_message_id': 'client-8' } }]);
    // The first save initializes missing last/hint slots; a subsequent incremental save advances time.
    store.upsertMessages([{ threadId: initial.conversationId, msgId: '9', senderUid: '20002', content: '{"text":"later"}',
      msgType: 7, createTime: 1000, status: 0, indexInConversation: '2', orderInConversation: '2',
      clientMessageId: 'client-9', ext: { 's:client_message_id': 'client-9' } }]);
    store.upsertConversations([{ ...mapped({ mode: 2, ext: { stranger: '10001' } }), pinned: true }]);
    expect(store.getConversation(initial.conversationId)).toMatchObject({ isInStrangerBox: true,
      strangerVersion: '90', coreVersion: '9007199254740993', coreExt: { stranger: '10001' },
      localExt: { local: 'keep' }, badgeCount: 7, lastMessageTime: 1000, sortOrder: '500000000001000' });
    store.close(); store = createImStateStore({ accountDir: directory, backend, userId: '10001' });
    expect(store.getConversation(initial.conversationId)?.sortOrder).toBe('500000000001000');
    store.upsertConversations([{ ...mapped(), settingExt: { 'a:cell_sort_time': '5' } }]);
    expect(store.getConversation(initial.conversationId)).toMatchObject({ isInStrangerBox: false, coreExt: {},
      mode: 0, strangerVersion: '90', localExt: { local: 'keep' }, sortOrder: '5000', lastMessageTime: 1000 });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
