import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationDeletionCommand, conversationDeletionPlan, maxStoredMessageIndex, signedMessageIndex } from './conversation-delete.js';
import { createImStateStore } from './state-store.js';
import type { ImConversation, PrivateMessage } from './types.js';

const conversation: ImConversation = { conversationId: '700', conversationShortId: '700', conversationType: 2,
  isGroup: true, name: 'fixture', members: [], lastMessageTime: 0, minIndex: '0', isInStrangerBox: true, sortOrder: '1' };
function message(index: string): PrivateMessage {
  return { threadId: '700', msgId: index, senderUid: '22', clientMessageId: `c${index}`, indexInConversation: index,
    indexInConversationV2: '999', orderInConversation: index, status: 0, content: '{"text":"fixture"}', msgType: 7, createTime: 1 };
}

describe('Desktop conversation deletion boundary', () => {
  it.each([3, 620, 1010, 4294967299])('parses exact native command %s without losing index bits', command => {
    expect(conversationDeletionCommand(50001,
      `{"command_type":${command},"conversation_id":"target","last_message_index":9007199254740993}`))
      .toEqual({ conversationId: 'target', lastMessageIndex: '9007199254740993' });
  });
  it('keeps native signed uint64 bit patterns and last duplicate key semantics', () => {
    expect(conversationDeletionCommand(50001, '{"command_type":3,"conversation_id":"target","last_message_index":18446744073709551615}'))
      .toMatchObject({ lastMessageIndex: '-1' });
    expect(conversationDeletionCommand(50001, '{"command_type":3,"conversation_id":"target","last_message_index":1,"last_message_index":"2"}'))
      .toBeUndefined();
  });
  it.each([
    '{', '[]', '{"command_type":"3","conversation_id":"target","last_message_index":1}',
    '{"command_type":3.0,"conversation_id":"target","last_message_index":1}',
    '{"command_type":2,"conversation_id":"target","last_message_index":1}',
    '{"command_type":3,"conversation_id":"target","last_message_index":"1"}',
    '{"command_type":3,"conversation_id":"target","last_message_index":1.0}',
    '{"command_type":3,"conversation_id":"target","last_message_index":18446744073709551616}',
    '{"command_type":3,"conversation_id":"target"}', '{"command_type":3,"last_message_index":1}',
    '{"command_type":3,"conversation_id":700,"last_message_index":1}',
  ])('safely rejects malformed or nonmatching command %s', content => {
    expect(conversationDeletionCommand(50001, content)).toBeUndefined();
    expect(conversationDeletionCommand(50005, content)).toBeUndefined();
  });
  it.each([
    ['0', '11', false, false, '10'], ['0', '10', true, true, '10'],
    ['10', '11', true, false, '10'], ['20', '11', true, false, '20'],
  ])('plans native min=%s last=%s branch', (minIndex, lastMessageIndex, deleted, all, minimum) => {
    expect(conversationDeletionPlan({ ...conversation, minIndex, lastMessageIndex }, '10'))
      .toEqual({ minIndex: minimum, deleteConversation: deleted, deleteAllMessages: all });
  });
  it('takes the indexV1 maximum including deleted rows, signed values and empty SQL aggregate', () => {
    expect(maxStoredMessageIndex([])).toBe('0');
    expect(maxStoredMessageIndex([message('-3'), message('-2')])).toBe('-2');
    expect(maxStoredMessageIndex([message('9007199254740992'), { ...message('9007199254740993'), deleted: true }]))
      .toBe('9007199254740993');
  });
  it.each(['no', '1.5', '9223372036854775808', '-9223372036854775809'])('rejects invalid boundary %s', value => {
    expect(() => signedMessageIndex(value)).toThrow();
  });
});

describe.each(['sqlite', 'json'] as const)('persisted Desktop delete (%s)', backend => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douyin-delete-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it.each(['retained', 'all', 'already-min'] as const)('commits the %s branch without physically erasing records', scenario => {
    const options = { accountDir: directory, backend };
    let store = createImStateStore(options);
    store.upsertConversations([{ ...conversation, minIndex: scenario === 'already-min' ? '10' : '0' }], 'local');
    store.upsertMessages([message('5'), message('10')]);
    const boundary = store.getConversationDeletionBoundary('700');
    expect(boundary).toBe('10');
    if (scenario !== 'all') store.upsertMessages([message('11')]); // Arrives after request dispatch.
    expect(store.applyConversationDeletion('700', boundary)).toBe(scenario === 'retained' ? 'retained' : 'deleted');
    for (let pass = 0; pass < 2; pass++) {
      expect(store.getMessage('700', '5', 'server')).toMatchObject({ deleted: true, content: '{"text":"fixture"}' });
      expect(store.getMessage('700', '10', 'server')).toMatchObject({ deleted: true });
      expect(store.listMessages('700').map(item => item.msgId)).toEqual(scenario === 'all' ? [] : ['11']);
      if (scenario === 'retained') expect(store.getConversation('700')).toMatchObject({ minIndex: '10', lastMessageIndex: '11' });
      else { expect(store.getConversation('700')).toBeUndefined(); expect(store.queryStrangerConversations()).toEqual([]); }
      expect(store.getConversationDeletionBoundary('700')).toBe(scenario === 'all' ? '10' : '11');
      if (pass === 0) { store.close(); store = createImStateStore(options); }
    }
    store.close();
  });

  it('does nothing for a missing conversation or invalid index', () => {
    const store = createImStateStore({ accountDir: directory, backend });
    try {
      expect(store.applyConversationDeletion('missing', '1')).toBe('missing');
      store.upsertConversations([conversation], 'local'); store.upsertMessages([message('1')]);
      expect(() => store.applyConversationDeletion('700', 'bad')).toThrow();
      expect(store.listMessages('700')).toHaveLength(1);
      expect(store.getConversation('700')).toBeDefined();
    } finally { store.close(); }
  });

  it('does not publish half a deletion when the durable write fails', () => {
    const options = { accountDir: directory, backend };
    const store = createImStateStore(options);
    store.upsertConversations([conversation], 'local'); store.upsertMessages([message('5')]);
    let database: DatabaseSync | undefined;
    if (backend === 'json') mkdirSync(join(directory, 'im-state.json.tmp'));
    else {
      database = new DatabaseSync(join(directory, 'im-state.sqlite'));
      database.exec("CREATE TRIGGER reject_deletion BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    }
    try {
      expect(() => store.applyConversationDeletion('700', '5')).toThrow();
      expect(store.getConversation('700')).toMatchObject({ minIndex: '0' });
      expect(store.listMessages('700').map(item => item.msgId)).toEqual(['5']);
      store.close();
      const restored = createImStateStore(options);
      expect(restored.getConversation('700')).toMatchObject({ minIndex: '0' });
      expect(restored.listMessages('700')).toHaveLength(1); restored.close();
    } finally { database?.close(); }
  });
});
