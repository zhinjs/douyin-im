import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImConversation, PrivateMessage } from './types.js';
import {
  createImStateStore,
  type ImStateStoreBackend,
} from './state-store.js';

function group(id: string, name: string): ImConversation {
  return {
    conversationId: id,
    conversationShortId: id,
    conversationType: 2,
    isGroup: true,
    name,
    lastMessageTime: 0,
    members: [],
  };
}

function message(id: string, createTime: number): PrivateMessage {
  return {
    msgId: id,
    threadId: '70001',
    senderUid: '10',
    content: JSON.stringify({ text: id }),
    msgType: 7,
    createTime,
    status: 0,
    indexInConversationV2: String(createTime),
  };
}

describe.each<ImStateStoreBackend>(['sqlite', 'json'])('IM state store: %s', (backend) => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'douyin-im-state-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('queries persisted stranger rows locally with the same predicates and order after reopening', () => {
    const options = { accountDir: directory, backend };
    let store = createImStateStore(options);
    store.upsertConversations([
      { ...group('group', 'group'), inboxType: 4, isInStrangerBox: true, sortOrder: '9007199254740993' },
      { ...group('private', 'private'), conversationType: 1, isGroup: false, isInStrangerBox: true, sortOrder: '9007199254740992' },
      { ...group('deleted', 'deleted'), isInStrangerBox: true, sortOrder: '99', deleted: true },
      { ...group('zero', 'zero'), isInStrangerBox: true, sortOrder: '0' },
      { ...group('out', 'out'), isInStrangerBox: false, sortOrder: '99' },
    ], 'local');
    try {
      for (let pass = 0; pass < 2; pass++) {
        const selected = store.queryStrangerConversations();
        expect(selected.map(item => item.conversationId)).toEqual(['group', 'private']);
        expect(selected[0]).toMatchObject({ inboxType: 4, isGroup: true, lastMessage: null, hintMessage: null });
        selected[0]!.name = 'caller mutation';
        expect(store.getConversation('group')!.name).toBe('group');
        if (pass === 0) { store.close(); store = createImStateStore(options); }
      }
    } finally { store.close(); }
  });

  it('persists independent setting and per-key versions without rounding or aliasing maps', () => {
    const options = { accountDir: directory, backend };
    const store = createImStateStore(options);
    const info = { ...group('70001', 'settings'), settingVersion: '9007199254740993',
      settingExt: { 'a:sky_eye_dialog': '{"risk":1}' },
      settingExtVersions: { 'a:sky_eye_dialog': '9007199254740995' } };
    store.upsertConversations([info]);
    info.settingExtVersions['a:sky_eye_dialog'] = '1';
    expect(store.getConversation('70001')?.settingExtVersions?.['a:sky_eye_dialog']).toBe('9007199254740995');
    store.close();
    const restored = createImStateStore(options);
    expect(restored.getConversation('70001')).toMatchObject({ settingVersion: '9007199254740993',
      settingExtVersions: { 'a:sky_eye_dialog': '9007199254740995' } });
    restored.upsertConversations([{ ...group('70001', 'cleared'), settingVersion: '9007199254740996', settingExt: {}, settingExtVersions: {} }]);
    expect(restored.getConversation('70001')).toMatchObject({ settingVersion: '9007199254740996', settingExt: {}, settingExtVersions: {} });
    restored.close();
  });

  it('rejects stale settings across upsert, group replacement and restart while accepting new core fields', () => {
    const options = { accountDir: directory, backend };
    const store = createImStateStore(options);
    store.upsertConversations([{ ...group('70001', 'initial'), settingVersion: '9007199254740993', pinned: true,
      readIndex: '80', readIndexV2: '90', readBadgeCount: 20, setTopTime: '9007199254740997',
      settingExt: { risk: 'present' }, settingExtVersions: { risk: '9' } }]);
    store.upsertConversations([{ ...group('70001', 'new core'), settingVersion: '9007199254740992', readIndexV2: '999' }]);
    store.replaceGroups([{ ...group('70001', 'list core'), settingVersion: '0' }]);
    expect(store.listGroups()![0]).toMatchObject({ name: 'list core', pinned: true,
      settingVersion: '9007199254740993', readIndex: '80', readIndexV2: '90', readBadgeCount: 20,
      setTopTime: '9007199254740997', settingExt: { risk: 'present' }, settingExtVersions: { risk: '9' } });
    store.close();
    const restored = createImStateStore(options);
    restored.replaceGroups([{ ...group('70001', 'equal version'), settingVersion: '9007199254740993', readIndex: '1' }]);
    expect(restored.getConversation('70001')).toMatchObject({ name: 'equal version', pinned: false,
      readIndex: '1', readIndexV2: '90', readBadgeCount: 20, setTopTime: '0', settingExt: {}, settingExtVersions: {} });
    // A local patch is not a full network settings snapshot.
    restored.patchConversation('70001', { readIndex: '2', settingExt: { local: 'value' } });
    expect(restored.getConversation('70001')).toMatchObject({ readIndex: '2', readIndexV2: '90',
      settingVersion: '9007199254740993', settingExt: { local: 'value' } });
    restored.upsertConversations([group('70001', 'no setting submessage')]);
    expect(restored.getConversation('70001')).toMatchObject({ settingVersion: '9007199254740993', readIndex: '0',
      readIndexV2: '90', readBadgeCount: 20, settingExt: {}, settingExtVersions: {} });
    restored.replaceGroups([]);
    restored.upsertConversations([group('70001', 'recreated')]);
    expect(restored.getConversation('70001')).toMatchObject({ settingVersion: '0', readIndexV2: '0', readBadgeCount: 0 });
    restored.close();
  });

  it('computes raw read summaries from partial participant joins and restores them without manufacturing missing rows', () => {
    const options = { accountDir: directory, backend };
    const store = createImStateStore(options);
    expect(store.getReadSummary('70001', '10')).toBeUndefined();
    const sent = { ...message('1', 1000), orderInConversation: '99', indexInConversation: '50',
      conversationType: 2, conversationShortId: '70001', ext: { 's:client_message_id': 'CLIENT' } };
    store.upsertMessages([sent]);
    expect(store.getReadSummary('70001', '10')).toMatchObject({ readUsers: [], isAllRead: false });
    store.upsertGroupMembers('70001', [{ uid: '20', role: 0, secUid: 'member-sec' }, { uid: '30', role: 0 }]);
    expect(store.listGroupMembers('70001')).toBeUndefined(); // No full snapshot; native join still sees rows.
    store.saveReadCursors('70001', [{ uid: '20', readIndex: '50', minIndex: '-1' }, { uid: '40', readIndex: '999', minIndex: '0' }]);
    const summary = store.getReadSummary('70001', '10')!;
    expect(summary).toEqual({ conversationId: '70001', conversationType: 2, conversationShortId: '70001',
      serverMessageId: '1', clientMessageId: 'client', createTime: '1000',
      readUsers: [{ uid: '20', secUid: 'member-sec', readIndex: '50', minIndex: '-1' }], isAllRead: true });
    summary.readUsers[0]!.secUid = 'mutated';
    store.close();
    const restored = createImStateStore(options);
    expect(restored.getReadSummary('70001', '10')!.readUsers[0]!.secUid).toBe('member-sec');
    restored.removeGroupMembers('70001', ['20']);
    expect(restored.getReadSummary('70001', '10')).toMatchObject({ readUsers: [], isAllRead: false });
    restored.deleteMessage('70001', '1', 'server');
    expect(restored.getReadSummary('70001', '10')).toBeUndefined();
    restored.close();
  });

  it('selects last self message across the retained cache, not just the latest history page or last incoming message', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const own = { ...message('1', 1), orderInConversation: '999', ext: { 's:client_message_id': 'own' } };
    store.upsertMessages([own, ...Array.from({ length: 60 }, (_, index) => ({ ...message(String(index + 2), index + 2), senderUid: '20', orderInConversation: String(index + 2) }))]);
    expect(store.listMessages('70001', 50).some(row => row.msgId === '1')).toBe(false);
    expect(store.getReadSummary('70001', '10')!.serverMessageId).toBe('1');
    store.upsertMessages([{ ...own, ext: { ...own.ext, 's:is_recalled': 'true' } }], 'local-update');
    expect(store.getReadSummary('70001', '10')).toBeUndefined();
    expect(store.getReadSummary('70001', '20')!.serverMessageId).toBe('61');
    store.close();
  });

  it('persists selection IDs apart from network snapshots and restores/clears them with the conversation', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    store.replaceGroups([group('70001', 'old name')]);
    const first = { ...message('1', 1), clientMessageId: 'first', orderInConversation: '100', indexInConversation: '91' };
    const last = { ...message('2', 2), clientMessageId: 'last', orderInConversation: '101', indexInConversation: '92' };
    store.upsertMessages([first, last]);
    expect(store.getConversation('70001')).toMatchObject({ lastMessageIndex: '92', lastMessage: { msgId: '2' }, hintMessage: { msgId: '2' } });
    store.upsertConversations([group('70001', 'fresh')]);
    store.replaceGroups([group('70001', 'new name')]);
    expect(store.listGroups()![0]).toMatchObject({ name: 'new name', lastMessage: { msgId: '2' } });
    store.getConversation('70001')!.lastMessage!.content = 'mutated';
    expect(store.getMessage('70001', '2', 'server')!.content).toBe(last.content);
    expect(store.deleteMessage('70001', 'last', 'client')).toBe(true);
    expect(store.getConversation('70001')).toMatchObject({ lastMessageIndex: '91', lastMessage: { msgId: '1' }, lastMessageTime: 2 });
    store.close();
    const restored = createImStateStore({ accountDir: directory, backend });
    expect(restored.getConversation('70001')).toMatchObject({ lastMessageIndex: '91', lastMessage: { msgId: '1' } });
    restored.replaceGroups([]);
    restored.upsertConversations([group('70001', 'new identity')]);
    expect(restored.getConversation('70001')).not.toHaveProperty('lastMessage');
    restored.close();
  });

  it('takes an independent native hint configuration snapshot at construction', () => {
    const config = { enable: true, notHintMessages: { 7: [-1] } };
    const store = createImStateStore({ accountDir: directory, backend, floatHintConfig: config });
    config.enable = false; config.notHintMessages[7].length = 0;
    store.upsertConversations([group('70001', 'group')]);
    store.upsertMessages([{ ...message('1', 1), clientMessageId: 'one', orderInConversation: '1' }]);
    expect(store.getConversation('70001')).toMatchObject({ lastMessage: { msgId: '1' }, hintMessage: null });
    store.close();
  });

  it.each(['none', 'upsert', 'replace'] as const)('saves cleared live selectors on full server merge only: %s', operation => {
    const options = { accountDir: directory, backend };
    let store = createImStateStore(options);
    try {
      store.replaceGroups([group('70001', 'group')]);
      store.upsertMessages([{ ...message('1', 1), clientMessageId: 'one', orderInConversation: '1', indexInConversation: '91' }]);
      expect(store.getConversation('70001')!.lastMessageIndex).toBe('91');
      expect(store.deleteMessage('70001', 'one', 'client')).toBe(true);
      expect(store.getConversation('70001')).toMatchObject({ lastMessageIndex: '0', lastMessage: null, hintMessage: null });
      if (operation === 'upsert') store.upsertConversations([group('70001', 'updated')]);
      if (operation === 'replace') store.replaceGroups([group('70001', 'updated')]);
      store.close();
      store = createImStateStore(options);
      expect(store.getConversation('70001')).toMatchObject({
        lastMessageIndex: operation === 'none' ? '91' : '0', lastMessage: null, hintMessage: null,
      });
    } finally { store.close(); }
  });

  it('persists property info separately from its message and clears only the runtime pointer on property-only deletion', () => {
    const options = { accountDir: directory, backend, userId: '10' };
    const store = createImStateStore(options);
    store.upsertConversations([group('70001', 'group')]);
    const one = { ...message('1', 1000), clientMessageId: 'one', orderInConversation: '1' };
    const two = { ...message('2', 2000), clientMessageId: 'two', orderInConversation: '2' };
    store.upsertMessages([one, two]);
    store.upsertMessages([{ ...one, propertyList: { 'se:ok': [{ uid: '20', secUid: '', createTime: '5', value: '', idempotentId: '' }] } }]);
    expect(store.getConversation('70001')).toMatchObject({ propertyInfo: { clientId: 'one', createdAt: '5' }, propertyMessage: { msgId: '1' }, sortOrder: '5000' });
    store.close();
    const restored = createImStateStore(options);
    expect(restored.getConversation('70001')!.propertyMessage!.msgId).toBe('1');
    restored.replaceGroups([group('70001', 'renamed')]);
    expect(restored.deleteMessage('70001', 'one', 'client')).toBe(false);
    expect(restored.getConversation('70001')).toMatchObject({ propertyMessage: null, propertyInfo: { clientId: 'one' }, lastMessage: { msgId: '2' }, sortOrder: '5000' });
    restored.close();
  });

  it('persists property read independently and makes a later reaction unread again', () => {
    const options = { accountDir: directory, backend, userId: '10' };
    const store = createImStateStore(options);
    expect(store.markPropertyRead('missing')).toBe(false);
    store.upsertConversations([group('70001', 'group')]);
    expect(store.markPropertyRead('70001')).toBe(false);
    const one = { ...message('1', 1000), clientMessageId: 'one', orderInConversation: '1' };
    const two = { ...message('2', 2000), clientMessageId: 'two', orderInConversation: '2' };
    const reaction = (time: string) => ({ ...one, propertyList: { 'se:ok': [{ uid: '20', secUid: '', createTime: time, value: '', idempotentId: '' }] } });
    store.upsertMessages([one, two, reaction('5')]);
    expect(store.markPropertyRead('70001')).toBe(true);
    expect(store.markPropertyRead('70001')).toBe(false);
    const read = store.getConversation('70001');
    expect(read).toMatchObject({ propertyInfo: { markRead: true, createdAt: '5' }, propertyMessage: { msgId: '1' }, lastMessage: { msgId: '2' }, hintMessage: { msgId: '2' }, sortOrder: '5000' });
    store.close();
    const restored = createImStateStore(options);
    expect(restored.getConversation('70001')).toEqual(read);
    expect(restored.markPropertyRead('70001')).toBe(false);
    restored.upsertMessages([reaction('6')]);
    expect(restored.getConversation('70001')).toMatchObject({ propertyInfo: { markRead: false, createdAt: '6' }, sortOrder: '6000' });
    restored.close();
  });

  it('persists float/order counters across network refresh and restart, with account-specific notice exceptions', () => {
    const floatHintConfig = { enable: true, notHintMessages: {}, notFloatMessages: { 1001: [100140] } };
    const options = { accountDir: directory, backend, userId: '9007199254740993', floatHintConfig };
    const store = createImStateStore(options);
    store.upsertConversations([{ ...group('70001', 'group'), pinned: true }]);
    store.upsertMessages([{ ...message('1', 1), clientMessageId: 'one', orderInConversation: '1' }]);
    const notice = { ...message('2', 10), msgType: 1001, clientMessageId: 'two', orderInConversation: '2', indexInConversation: '30',
      content: '{"aweType":100140,"passive_users":[{"uid":9007199254740993}]}' };
    store.upsertMessages([notice]);
    expect(store.getConversation('70001')).toMatchObject({ lastMessageTime: 10, sortOrder: '500000000000010', maxIndex: '30', maxOrder: '2' });
    floatHintConfig.enable = false; // The store keeps its initialization snapshot.
    store.upsertMessages([{ ...notice, msgId: '3', clientMessageId: 'three', orderInConversation: '3', createTime: 20,
      content: '{"aweType":100140,"passive_users":[{"uid":123}]}' }]);
    store.replaceGroups([{ ...group('70001', 'renamed'), pinned: true }]);
    expect(store.listGroups()![0]).toMatchObject({ lastMessageTime: 10, maxOrder: '3', lastMessage: { msgId: '3' } });
    store.close();
    const restored = createImStateStore(options);
    expect(restored.getConversation('70001')).toMatchObject({ lastMessageTime: 10, sortOrder: '500000000000010', maxIndex: '30', maxOrder: '3' });
    restored.upsertConversations([{ ...group('70001', 'unpinned'), pinned: false, settingExt: { 'a:cell_sort_time': '8' } }]);
    restored.upsertMessages([{ ...message('4', 30), clientMessageId: 'four', orderInConversation: '4' }]);
    expect(restored.getConversation('70001')).toMatchObject({ lastMessageTime: 30, sortOrder: '8000', maxIndex: '30', maxOrder: '4' });
    restored.close();
  });

  it('recomputes recall without treating reference-only local writes as incoming messages', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    store.upsertConversations([group('70001', 'group')]);
    const latest = { ...message('1', 1), clientMessageId: 'one', orderInConversation: '1', indexInConversation: '9' };
    store.upsertMessages([latest]);
    store.upsertMessages([{ ...latest, content: 'local update only' }], 'local-update');
    expect(store.getConversation('70001')!.lastMessage!.content).toBe(latest.content);
    store.upsertMessages([{ ...latest, ext: { 's:is_recalled': 'true' } }], 'local-update');
    store.refreshRecalledSummary('70001', 'one');
    expect(store.getConversation('70001')!.lastMessage!.ext).toEqual({ 's:is_recalled': 'true' });
    store.close();
    const restored = createImStateStore({ accountDir: directory, backend });
    expect(restored.getConversation('70001')!.hintMessage!.ext).toEqual({ 's:is_recalled': 'true' });
    restored.close();
  });

  it('looks up server and client identities across the whole bounded cache, with isolated copies and restart recovery', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const rows = Array.from({ length: 60 }, (_, index) => ({ ...message(String(index + 1), index + 1), clientMessageId: `client-${index}` }));
    store.upsertMessages(rows);
    expect(store.listMessages('70001')).toHaveLength(50);
    expect(store.getMessage('70001', '1', 'server')).toEqual(rows[0]);
    expect(store.getMessage('70001', 'CLIENT-0', 'client')).toEqual(rows[0]);
    expect(store.getMessage('other', '1', 'server')).toBeUndefined();
    expect(store.getMessage('70001', '0', 'server')).toBeUndefined();
    expect(store.getMessage('70001', '', 'client')).toBeUndefined();
    expect(store.getMessage('70001', 'missing', 'client')).toBeUndefined();
    store.getMessage('70001', '1', 'server')!.content = 'changed';
    expect(store.getMessage('70001', 'client-0', 'client')!.content).toBe(rows[0]!.content);
    const other = createImStateStore({ accountDir: join(directory, 'other-account'), backend });
    expect(other.getMessage('70001', 'client-0', 'client')).toBeUndefined(); other.close();
    store.close();
    const restored = createImStateStore({ accountDir: directory, backend });
    expect(restored.getMessage('70001', 'CLIENT-0', 'client')).toEqual(rows[0]);
    restored.deleteMessage('70001', '1');
    expect(restored.getMessage('70001', 'client-0', 'client')).toBeUndefined();
    restored.deleteConversation('70001');
    expect(restored.getMessage('70001', '2', 'server')).toBeUndefined(); restored.close();
  });

  it('deletes a client-only message without a synthetic server ID or touching other conversations', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const pending = { ...message('0', 1), clientMessageId: 'PENDING' };
    store.upsertMessages([pending, { ...pending, clientMessageId: 'other' }, { ...pending, threadId: 'elsewhere' }]);
    store.deleteMessage('70001', 'PENDING', 'client');
    expect(store.getMessage('70001', 'pending', 'client')).toBeUndefined();
    expect(store.listMessages('70001')).toEqual([expect.objectContaining({ clientMessageId: 'other' })]);
    expect(store.getMessage('elsewhere', 'pending', 'client')).toBeDefined();
    store.deleteMessage('70001', 'unknown', 'client');
    store.close();
    const restored = createImStateStore({ accountDir: directory, backend });
    expect(restored.getMessage('70001', 'pending', 'client')).toBeUndefined();
    expect(restored.listMessages('70001')).toHaveLength(1);
    restored.close();
  });

  it('reads individual conversation snapshots before any group-list snapshot, including private conversations', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const conversation = { ...group('0:1:11:22', 'private'), isGroup: false, conversationType: 1, members: [{ uid: '22', role: 0 }] };
    store.upsertConversations([conversation]);
    expect(store.listGroups()).toBeUndefined();
    expect(store.getConversation(conversation.conversationId)).toMatchObject({ ...conversation,
      settingVersion: '0', readIndex: '0', readIndexV2: '0', settingExt: {}, settingExtVersions: {} });
    store.getConversation(conversation.conversationId)!.members[0]!.uid = 'changed';
    expect(store.getConversation(conversation.conversationId)!.members[0]!.uid).toBe('22');
    expect(store.getConversation('missing')).toBeUndefined();
    store.close();
    const reopened = createImStateStore({ accountDir: directory, backend });
    expect(reopened.getConversation(conversation.conversationId)).toMatchObject({ ...conversation,
      settingVersion: '0', readIndex: '0', readIndexV2: '0', settingExt: {}, settingExtVersions: {} });
    reopened.deleteConversation(conversation.conversationId);
    expect(reopened.getConversation(conversation.conversationId)).toBeUndefined();
    reopened.close();
  });

  it('finds only live direct references across the whole retained conversation, with isolated copies', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const referenceInfo = { refMessageId: '9007199254740993', hint: 'kept', refMessageType: 7, refMessageStatus: 0 };
    const rows = Array.from({ length: 60 }, (_, index) => ({ ...message(String(index + 1), index + 1), referenceInfo }));
    store.upsertMessages([...rows,
      { ...message('61', 61), referenceInfo: { ...referenceInfo, refMessageId: 'other', rootMessageId: referenceInfo.refMessageId } },
      { ...message('62', 62), referenceInfo, threadId: 'other' },
      { ...message('63', 63), referenceInfo, ext: { 's:is_recalled': 'true' } },
    ]);
    store.deleteMessage('70001', '60');
    expect(store.getReferencingMessages('70001', referenceInfo.refMessageId)).toHaveLength(60);
    expect(store.getReferencingMessages('70001', referenceInfo.refMessageId).map(row => row.msgId).sort((a, b) => Number(a) - Number(b))).toEqual([
      ...Array.from({ length: 59 }, (_, index) => String(index + 1)), '63',
    ]);
    store.getReferencingMessages('70001', referenceInfo.refMessageId)[0]!.referenceInfo!.hint = 'changed';
    expect(store.getMessage('70001', '1', 'server')!.referenceInfo!.hint).toBe('kept');
    expect(store.getReferencingMessages('70001', '9007199254740992')).toEqual([]);
    expect(store.getReferencingMessages('70001', '')).toEqual([]);
    expect(store.getReferencingMessages('70001', '0')).toEqual([]);
    store.close();
    const reopened = createImStateStore({ accountDir: directory, backend });
    expect(reopened.getReferencingMessages('70001', referenceInfo.refMessageId)).toHaveLength(60);
    reopened.close();
  });

  it('does not apply ordinary merges to recall, command or unknown non-ordinary message types', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const old = { ...message('1', 1), clientMessageId: 'same', localExt: { local: 'retained', changed: 'old' } };
    store.upsertMessages([old]);
    for (const msgType of [40001, 50000, 50001, 50002, 50005, 50006, 70002]) {
      expect(store.upsertMessages([{ ...old, content: 'command', msgType }])).toEqual([]);
    }
    expect(store.getMessage('70001', '1', 'server')).toEqual(old);
    store.upsertMessages([{ ...old, msgType: 49999, localExt: { changed: '' } }]);
    expect(store.getMessage('70001', '1', 'server')!.localExt).toEqual({ local: 'retained', changed: '' });
    store.close();
  });

  it('soft deletes without losing the server-ID record and excludes deleted rows before history limits', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const first = { ...message('1', 1), clientMessageId: 'first', ext: { retained: 'old' }, orderInConversation: '10' };
    const last = { ...message('2', 2), clientMessageId: 'last' };
    store.upsertMessages([first, last]);
    store.deleteMessage('70001', '2');
    expect(store.listMessages('70001', 1).map(message => message.msgId)).toEqual(['1']);
    expect(store.getMessage('70001', 'last', 'client')).toBeUndefined();
    expect(store.getMessage('70001', '2', 'server')).toEqual({ ...last, deleted: true });
    store.deleteMessage('70001', 'missing');
    expect(store.getMessage('70001', 'missing', 'server')).toBeUndefined();
    store.close();
    const reopened = createImStateStore({ accountDir: directory, backend });
    expect(reopened.getMessage('70001', '2', 'server')!.deleted).toBe(true);
    expect(reopened.getMessage('70001', 'last', 'client')).toBeUndefined();
    reopened.deleteMessage('70001', '1');
    // A sparse acknowledgement cannot revive a deleted row. This is the SDK ack boundary.
    reopened.upsertMessages([first], 'send-ack');
    expect(reopened.listMessages('70001')).toEqual([]);
    const incoming = { ...first, msgId: '3', content: '', ext: {}, orderInConversation: '20' };
    const update = reopened.upsertMessages([incoming]);
    expect(update[0]?.isNew).toBe(true);
    expect(reopened.getMessage('70001', 'first', 'client')).toEqual({ ...incoming, orderIndex: '20' });
    expect(reopened.getMessage('70001', '1', 'server')).toBeUndefined();
    reopened.close();
  });

  it('local updates can restore a server-ID deleted target without resetting its effective order', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const original = { ...message('1', 1), clientMessageId: 'client', orderInConversation: '10' };
    store.upsertMessages([original, { ...original, orderInConversation: '20' }]);
    store.deleteMessage('70001', '1');
    const deleted = store.getMessage('70001', '1', 'server')!;
    expect(deleted.orderIndex).toBe('10');
    store.upsertMessages([{ ...deleted, ext: { 's:is_recalled': 'true' }, localExt: { 's:text_recall_timestamp': '123' } }], 'local-update');
    expect(store.listMessages('70001')).toEqual([expect.objectContaining({ orderIndex: '10', orderInConversation: '20',
      ext: { 's:is_recalled': 'true' }, localExt: { 's:text_recall_timestamp': '123' } })]);
    expect(store.getMessage('70001', 'client', 'client')).not.toHaveProperty('deleted');
    expect(store.upsertMessages([{ ...original, msgId: 'missing', clientMessageId: 'missing' }], 'local-update')).toEqual([]);
    store.close();
  });

  it('distinguishes an absent group snapshot from a synchronized empty list', () => {
    const store = createImStateStore({ accountDir: directory, backend });

    expect(store.listGroups()).toBeUndefined();
    store.replaceGroups([]);
    expect(store.listGroups()).toEqual([]);
    store.close();

    const reopened = createImStateStore({ accountDir: directory, backend });
    expect(reopened.listGroups()).toEqual([]);
    reopened.close();
  });

  it('selects and evicts messages by conversation order before applying count, not by wall time', () => {
    const store = createImStateStore({ accountDir: directory, backend, maxMessagesPerConversation: 2 });
    const first = { ...message('1', 300), indexInConversationV2: '9007199254740993' };
    const second = { ...message('2', 200), indexInConversationV2: '9007199254740994' };
    const third = { ...message('3', 100), indexInConversationV2: '9007199254740995' };
    store.upsertMessages([first, second]);
    expect(store.listMessages('70001', 1).map(item => item.msgId)).toEqual(['2']);
    store.upsertMessages([third]);
    expect(store.listMessages('70001', 2).map(item => item.msgId)).toEqual(['2', '3']);
    store.close();
    const restored = createImStateStore({ accountDir: directory, backend, maxMessagesPerConversation: 2 });
    expect(restored.listMessages('70001', 1).map(item => item.msgId)).toEqual(['3']);
    restored.close();
  });

  it.each(['before', 'after'] as const)('keeps full server messages when they arrive %s a sparse send ack', arrival => {
    const store = createImStateStore({ accountDir: directory, backend });
    const full = { ...message('99', 123), orderInConversation: '9007199254740995', version: '8', ext: { 's:visible': '22' } };
    const ack = { msgId: '99', threadId: '70001', senderUid: '10', content: 'sent', msgType: 7, createTime: 999, status: 0 };
    if (arrival === 'before') store.upsertMessages([full]);
    store.upsertMessages([ack], 'send-ack');
    if (arrival === 'after') {
      expect(store.listMessages('70001')).toEqual([ack]);
      store.upsertMessages([full]);
    }
    // Repeat ack and reopen must not lose server metadata either.
    store.upsertMessages([ack], 'send-ack');
    expect(store.listMessages('70001')).toEqual([{ ...full, orderIndex: full.orderInConversation }]);
    store.upsertMessages([{ ...ack, threadId: 'other' }], 'send-ack');
    expect(store.listMessages('other')).toEqual([{ ...ack, threadId: 'other' }]);
    store.close();
    const restored = createImStateStore({ accountDir: directory, backend });
    expect(restored.listMessages('70001')).toEqual([{ ...full, orderIndex: full.orderInConversation }]);
    // An actual server update still replaces the older snapshot, including explicit empty ext.
    restored.upsertMessages([{ ...full, version: '9', ext: {} }]);
    expect(restored.listMessages('70001')).toEqual([{ ...full, version: '9', ext: {}, orderIndex: full.orderInConversation }]);
    restored.close();
  });

  it('merges by conversation/client ID, retains effective order and missing ext keys without changing wire data', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const old = { ...message('99', 123), clientMessageId: 'ABC-123', orderInConversation: '9007199254740995',
      version: '99', ext: { 's:client_message_id': 'ABC-123', kept: 'old', cleared: 'old' } };
    store.upsertMessages([old]);
    const incoming = { ...message('100', 456), clientMessageId: 'ignored-alias', content: '',
      orderInConversation: '9007199254740999', version: '1', status: 7,
      ext: { 's:client_message_id': 'abc-123', cleared: '' } };
    const original = structuredClone(incoming);
    store.upsertMessages([incoming]);
    const expected = { ...incoming, clientMessageId: 'abc-123', content: old.content,
      orderIndex: old.orderInConversation, ext: { ...old.ext, ...incoming.ext } };
    expect(store.listMessages('70001')).toEqual([expected]);
    expect(incoming).toEqual(original);
    // A late ack under the old server ID must not recreate an alias row.
    store.upsertMessages([old], 'send-ack');
    expect(store.listMessages('70001')).toEqual([expected]);
    store.upsertMessages([{ ...incoming, threadId: 'other' }]);
    expect(store.listMessages('other')[0]).toMatchObject({ content: '', orderIndex: incoming.orderInConversation });
    store.close();
    const restored = createImStateStore({ accountDir: directory, backend });
    expect(restored.listMessages('70001')).toEqual([expected]);
    restored.upsertMessages([{ ...incoming, msgId: '101', orderInConversation: '3', content: 'new' }]);
    expect(restored.listMessages('70001')[0]).toMatchObject({ msgId: '101', orderIndex: old.orderInConversation,
      orderInConversation: '3', content: 'new' });
    restored.deleteMessage('70001', '101');
    restored.upsertMessages([incoming]);
    expect(restored.listMessages('70001')[0]).toMatchObject({ content: '', orderIndex: incoming.orderInConversation });
    restored.close();
  });

  it.each(['0', '-1', '9223372036854775808'])('does not preserve non-positive or invalid previous order %s', order => {
    const store = createImStateStore({ accountDir: directory, backend });
    const old = { ...message('1', 1), clientMessageId: 'id', orderInConversation: order };
    store.upsertMessages([old, { ...old, msgId: '2', orderInConversation: '9' }]);
    expect(store.listMessages('70001')).toEqual([{ ...old, msgId: '2', orderInConversation: '9', orderIndex: '9' }]);
    store.close();
  });

  it('promotes a client-only ack to a server message without duplicates or cross-client merging', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const ack = { ...message('', 1), clientMessageId: 'id', content: 'ack' };
    store.upsertMessages([ack], 'send-ack');
    store.upsertMessages([{ ...ack, msgId: '2', content: 'server', orderInConversation: '4' }]);
    expect(store.listMessages('70001')).toHaveLength(1);
    expect(store.listMessages('70001')[0]).toMatchObject({ msgId: '2', content: 'server', orderIndex: '4' });
    store.upsertMessages([{ ...ack, msgId: '2', clientMessageId: 'different', content: '' }]);
    expect(store.listMessages('70001')[0]).toMatchObject({ clientMessageId: 'different', content: '' });
    store.close();
  });

  it('does not treat an explicitly empty wire client ID as a matching DTO alias', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    store.upsertMessages([{ ...message('1', 1), clientMessageId: 'alias', orderInConversation: '8' }]);
    store.upsertMessages([{ ...message('2', 2), clientMessageId: 'alias', content: '', ext: { 's:client_message_id': '' } }]);
    expect(store.listMessages('70001')).toHaveLength(2);
    expect(store.listMessages('70001')[1]).toMatchObject({ msgId: '2', content: '' });
    expect(store.listMessages('70001')[1]).not.toHaveProperty('clientMessageId');
    store.close();
  });

  it('persists exact read cursors, isolates accounts and clears removed members and conversations', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const first = { uid: '9007199254740995', readIndex: '9223372036854775807', minIndex: '-9223372036854775808' };
    const other = { uid: '22', readIndex: '0', minIndex: '-2' };
    store.saveReadCursors('70001', [first, other]);
    store.listReadCursors('70001')[0]!.readIndex = '0';
    expect(store.listReadCursors('70001')[0]).toEqual(first);
    expect(() => store.saveReadCursors('70001', [{ ...first, readIndex: '1' }, { ...other, uid: '__proto__' }])).toThrow();
    expect(store.listReadCursors('70001')[0]).toEqual(first);
    store.close();
    const reopened = createImStateStore({ accountDir: directory, backend });
    expect(reopened.listReadCursors('70001')).toEqual([first, other]);
    const isolated = createImStateStore({ accountDir: join(directory, 'other-account'), backend });
    expect(isolated.listReadCursors('70001')).toEqual([]); isolated.close();
    // No member table entry is needed for explicit cursor cleanup.
    reopened.removeGroupMembers('70001', [first.uid]);
    expect(reopened.listReadCursors('70001')).toEqual([other]);
    reopened.saveReadCursors('70001', [first]);
    reopened.replaceGroupMembers('70001', [{ uid: '22', role: 0 }]);
    expect(reopened.listReadCursors('70001')).toEqual([other]);
    reopened.deleteConversation('70001');
    expect(reopened.listReadCursors('70001')).toEqual([]); reopened.close();
  });

  it('persists user relations independently of group or conversation deletion', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    expect(store.getUserRelation('22')).toBeUndefined();
    store.setUserRelation('22', { followStatus: 4, blocked: false, remark: '' });
    store.upsertConversations([group('70001', 'test')]);
    store.deleteConversation('70001');
    store.close();
    const reopened = createImStateStore({ accountDir: directory, backend });
    expect(reopened.getUserRelation('22')).toEqual({ followStatus: 4, blocked: false, remark: '' });
    const copy = reopened.getUserRelation('22')!; copy.followStatus = 0;
    expect(reopened.getUserRelation('22')!.followStatus).toBe(4);
    expect(() => reopened.setUserRelation('__proto__', { followStatus: 1 })).toThrow('Invalid');
    reopened.close();
  });

  it('persists isolated message privacy policies and cascades message/conversation deletion', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const entry = {
      query: { serverMessageId: '9007199254740993', conversationId: '70001', conversationShortId: '70001', conversationType: 2 as const, createTime: 123 },
      policy: { serverMessageId: '9007199254740993', errorCode: 0, on: ['9007199254740995'], off: [] },
    };
    store.upsertMessageReadPrivacy([entry]);
    entry.policy.on.push('22');
    expect(store.getMessageReadPrivacy('70001', entry.query.serverMessageId)?.policy.on).toEqual(['9007199254740995']);
    expect(store.getMessageReadPrivacy('other', entry.query.serverMessageId)).toBeUndefined();
    const other = createImStateStore({ accountDir: join(directory, 'other-account'), backend });
    expect(other.getMessageReadPrivacy('70001', entry.query.serverMessageId)).toBeUndefined(); other.close();
    store.close();
    const reopened = createImStateStore({ accountDir: directory, backend });
    const copy = reopened.getMessageReadPrivacy('70001', entry.query.serverMessageId)!;
    expect(copy.policy.on).toEqual(['9007199254740995']);
    (copy.policy.on as string[]).push('33');
    expect(reopened.getMessageReadPrivacy('70001', entry.query.serverMessageId)?.policy.on).toEqual(['9007199254740995']);
    reopened.deleteMessage('70001', entry.query.serverMessageId); // No cached message body is necessary.
    expect(reopened.getMessageReadPrivacy('70001', entry.query.serverMessageId)).toBeUndefined();
    reopened.upsertMessageReadPrivacy([entry]); reopened.deleteConversation('70001');
    expect(reopened.getMessageReadPrivacy('70001', entry.query.serverMessageId)).toBeUndefined();
    expect(() => reopened.upsertMessageReadPrivacy([entry, { ...entry, policy: { ...entry.policy, serverMessageId: '22' } }])).toThrow('Invalid');
    expect(reopened.getMessageReadPrivacy('70001', entry.query.serverMessageId)).toBeUndefined();
    reopened.close();
  });

  it('persists Frontier cursor files with lossless uint64 values and isolated namespaces', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    const key = JSON.stringify(['device-1', 'cursor-1']);
    const entries = [{ service: 1, name: 'im1', value: '18446744073709551615' }];
    store.setFrontierCursors(key, entries);
    store.close();
    const reopened = createImStateStore({ accountDir: directory, backend });
    expect(reopened.getFrontierCursors(key)).toEqual(entries);
    expect(reopened.getFrontierCursors(JSON.stringify(['device-2', 'cursor-1']))).toBeUndefined();
    reopened.close();
  });

  it('replaces group inventory while preserving int64 ids as strings', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    store.replaceGroups([
      group('7489066986215981605', '第一群'),
      group('7423010390826582565', '第二群'),
    ]);
    store.replaceGroups([group('7423010390826582565', '已更新')]);
    store.patchConversation('7423010390826582565', { muted: true });

    expect(store.listGroups()).toEqual([
      expect.objectContaining({
        conversationId: '7423010390826582565',
        name: '已更新',
        muted: true,
      }),
    ]);
    store.close();
  });

  it('keeps incremental members separate from a complete snapshot', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    store.upsertGroupMembers('70001', [{ uid: '10', role: 0, nickname: '发言人' }]);
    expect(store.listGroupMembers('70001')).toBeUndefined();

    store.replaceGroupMembers('70001', [
      { uid: '10', role: 0, nickname: '成员甲' },
      { uid: '20', role: 2, nickname: '管理员' },
    ]);
    store.removeGroupMembers('70001', ['10']);

    expect(store.listGroupMembers('70001')).toEqual([
      { uid: '20', role: 2, nickname: '管理员' },
    ]);
    store.close();
  });

  it('deduplicates and caps messages per conversation', () => {
    const store = createImStateStore({
      accountDir: directory,
      backend,
      maxMessagesPerConversation: 2,
    });
    store.upsertMessages([message('1', 1), message('2', 2), message('3', 3)]);
    store.upsertMessages([{ ...message('3', 3), content: '{"text":"updated"}' }]);

    expect(store.listMessages('70001', 10)).toEqual([
      expect.objectContaining({ msgId: '2' }),
      expect.objectContaining({ msgId: '3', content: '{"text":"updated"}' }),
    ]);
    store.deleteMessage('70001', '2');
    expect(store.listMessages('70001', 10)).toEqual([
      expect.objectContaining({ msgId: '3' }),
    ]);
    store.close();
  });
});
