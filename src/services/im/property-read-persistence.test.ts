import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createImStateStore, type ImStateStoreBackend } from './state-store.js';
import { LATEST_MESSAGE_PROPERTY_KEY, serializeConversationPropertyInfo } from './message-property.js';
import type { ImConversation, PrivateMessage } from './types.js';

const conversation: ImConversation = {
  conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true,
  name: 'fixture', members: [], lastMessageTime: 1000, readIndex: '40',
  localExt: { other: 'retain', [LATEST_MESSAGE_PROPERTY_KEY]: serializeConversationPropertyInfo({
    clientId: 'one', emoji: 'ok', sender: '20', createdAt: '5', markRead: false,
  }) },
};
const message: PrivateMessage = {
  threadId: '700', msgId: '1', clientMessageId: 'one', senderUid: '10', msgType: 7,
  content: '{"text":"fixture"}', status: 0, createTime: 1000, orderIndex: '1', indexInConversation: '91',
};

describe.each([
  { backend: 'json' as const, failure: 'write' },
  { backend: 'json' as const, failure: 'rename' },
  { backend: 'sqlite' as const, failure: 'statement' },
  { backend: 'sqlite' as const, failure: 'commit' },
])('property read persistence: $backend/$failure', ({ backend, failure }) => {
  it.each([false, true])('does not publish failed writes or lose live selectors (deleted=%s)', deleted => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-property-read-'));
    const options = { accountDir: directory, backend, userId: '10' };
    const store = createImStateStore(options);
    let database: DatabaseSync | undefined;
    let restoreFailure: (() => void) | undefined;
    try {
      store.upsertConversations([conversation], 'local');
      store.upsertMessages([message]);
      if (deleted) store.deleteMessage('700', 'one', 'client');
      const before = store.getConversation('700');
      expect(before).toMatchObject({ propertyInfo: { markRead: false }, lastMessageIndex: deleted ? '0' : '91' });
      if (backend === 'json') {
        const target = join(directory, failure === 'write' ? 'im-state.json.tmp' : 'im-state.json');
        const backup = join(directory, 'saved-state.json');
        if (failure === 'rename') renameSync(target, backup);
        mkdirSync(target);
        restoreFailure = () => {
          rmSync(target, { recursive: true });
          if (failure === 'rename') renameSync(backup, target);
        };
      } else {
        database = new DatabaseSync(join(directory, 'im-state.sqlite'));
        if (failure === 'commit') {
          database.exec(`CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY);
            CREATE TABLE fixture_child (id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER reject_read AFTER UPDATE ON conversation_summaries
            BEGIN INSERT INTO fixture_child VALUES (1); END;`);
        } else {
          database.exec("CREATE TRIGGER reject_read BEFORE UPDATE ON conversation_summaries BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
        }
        restoreFailure = () => { database!.exec('DROP TRIGGER reject_read'); };
      }
      expect(() => store.markPropertyRead('700')).toThrow();
      expect(store.getConversation('700')).toEqual(before);
      restoreFailure(); restoreFailure = undefined;

      // A later unrelated flush must not leak a failed property write to disk.
      store.upsertConversations([{ ...conversation, conversationId: 'other', conversationShortId: '701' }], 'local');
      const unchanged = createImStateStore(options);
      try { expect(unchanged.getConversation('700')?.propertyInfo?.markRead).toBe(false); }
      finally { unchanged.close(); }

      expect(store.markPropertyRead('700')).toBe(true);
      expect(store.markPropertyRead('700')).toBe(false);
      expect(store.getConversation('700')).toMatchObject({ propertyInfo: { markRead: true },
        lastMessageIndex: deleted ? '0' : '91', readIndex: '40', localExt: { other: 'retain' } });
      const restored = createImStateStore(options);
      try {
        // Reading property localExt must not commit the unsaved deletion selector (91 -> 0).
        expect(restored.getConversation('700')).toMatchObject({ propertyInfo: { markRead: true }, lastMessageIndex: '91' });
        expect(restored.markPropertyRead('700')).toBe(false);
      } finally { restored.close(); }
    } finally {
      restoreFailure?.(); database?.close(); store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe.each<ImStateStoreBackend>(['json', 'sqlite'])('property read without a summary: %s', backend => {
  it('persists raw localExt without inventing retained messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-property-read-'));
    const options = { accountDir: directory, backend };
    const store = createImStateStore(options);
    try {
      store.upsertConversations([conversation], 'local');
      expect(store.markPropertyRead('700')).toBe(true);
      const restored = createImStateStore(options);
      try {
        expect(restored.getConversation('700')).toMatchObject({ propertyInfo: { markRead: true },
          propertyMessage: null, lastMessage: null, hintMessage: null, localExt: { other: 'retain' } });
        expect(restored.markPropertyRead('700')).toBe(false);
      } finally { restored.close(); }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
