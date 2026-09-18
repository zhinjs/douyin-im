import { participantCommand, participantDecimalId } from './participant-command.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImStateStore } from './state-store.js';
import type { ImConversation } from './types.js';

const body = (fields = '') => `{"command_type":7,"conversation_id":"800","conversation_type":2,"inbox_type":3${fields}}`;

describe('native participant command7', () => {
  it('keeps exact int64 bits, duplicates and independent lists', () => {
    expect(participantCommand(50001, body(',"added_participant":[9007199254740993],"modified_participant":[10,10],"removed_participant":[18446744073709551615,0]')))
      .toEqual({ conversationId: '800', conversationType: 2, inboxType: 3, added: ['9007199254740993'], modified: ['10', '10'], removed: ['-1', '0'] });
  });
  it.each(['', ',"added_participant":null', ',"modified_participant":{}', ',"removed_participant":"1"'])('defaults nonarray lists to empty (%s)', fields => {
    expect(participantCommand(50001, body(fields))).toMatchObject({ added: [], modified: [], removed: [] });
  });
  it.each(['"1"', 'true', 'null', '{}', '[]', '1.0', '1e2', '18446744073709551616'])('refuses malformed or lossy UID token %s', token => {
    expect(participantCommand(50001, body(`,"removed_participant":[1,${token}]`))).toBeUndefined();
  });
  it.each(['{', '{}', '[]', 'null', body().replace('"800"', '800'), body().replace('"inbox_type":3', '"inbox_type":"3"')])('safely rejects invalid body %s', content => {
    expect(participantCommand(50001, content)).toBeUndefined();
  });
  it('requires the exact message and command type, with native int32 narrowing', () => {
    expect(participantCommand(7, body())).toBeUndefined();
    expect(participantCommand(50001, body().replace(':7,', ':4,'))).toBeUndefined();
    expect(participantCommand(50001, body().replace(':7,', ':4294967303,'))).toBeDefined();
  });
  it.each([
    ['0:1:20:30', '0'], ['  +123rest', '123'], ['-42', '-42'], ['nothing', '0'],
    ['9007199254740993', '9007199254740993'], ['9223372036854775808', '9223372036854775807'],
    ['-9223372036854775809', '-9223372036854775808'],
  ])('uses strtoll prefix semantics for %s', (value, expected) => {
    expect(participantDecimalId(value)).toBe(expected);
  });
});

describe.each(['sqlite', 'json'] as const)('command7 durable removal (%s)', backend => {
  let directory: string;
  const members = [{ uid: '20002', role: 0 }, { uid: '30003', role: 0 }];
  const conversation: ImConversation = { conversationId: '800', conversationShortId: '800', conversationType: 2,
    isGroup: true, name: 'fixture', lastMessageTime: 0, members, participantsCount: 10, isParticipant: true };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douyin-participants-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  function seed() {
    const store = createImStateStore({ accountDir: directory, backend });
    store.upsertConversations([conversation], 'local');
    store.replaceGroupMembers('800', members);
    store.saveReadCursors('800', members.map(member => ({ uid: member.uid, readIndex: '50', minIndex: '2' })));
    return store;
  }

  it('commits only matching member/cursor rows and preserves counts, participation and restart state', () => {
    let store = seed();
    expect(store.removeConversationMembers('800', ['20002', '20002', '99999'])).toBe(true);
    for (let pass = 0; pass < 2; pass++) {
      expect(store.getConversation('800')).toMatchObject({ members: [members[1]], participantsCount: 10, isParticipant: true });
      expect(store.listGroupMembers('800')).toEqual([members[1]]);
      expect(store.listReadCursors('800')).toEqual([{ uid: '30003', readIndex: '50', minIndex: '2' }]);
      expect(store.removeConversationMembers('800', ['20002'])).toBe(false);
      if (pass === 0) { store.close(); store = createImStateStore({ accountDir: directory, backend }); }
    }
    store.close();
  });

  it('does not clear orphan rows for a missing conversation or mutate an empty removal', () => {
    const store = seed();
    store.replaceGroupMembers('missing', members);
    store.saveReadCursors('missing', [{ uid: '20002', readIndex: '4', minIndex: '0' }]);
    expect(store.removeConversationMembers('missing', ['20002'])).toBeUndefined();
    expect(store.listGroupMembers('missing')).toEqual(members);
    expect(store.listReadCursors('missing')).toHaveLength(1);
    expect(store.removeConversationMembers('800', [])).toBe(false);
    expect(store.listGroupMembers('800')).toEqual(members);
    store.close();
  });

  it('rolls back all three views when the last cursor write fails', () => {
    const store = seed();
    let database: DatabaseSync | undefined;
    if (backend === 'json') mkdirSync(join(directory, 'im-state.json.tmp'));
    else {
      database = new DatabaseSync(join(directory, 'im-state.sqlite'));
      database.exec("CREATE TRIGGER reject_member_cursor BEFORE DELETE ON read_cursors BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    }
    try {
      expect(() => store.removeConversationMembers('800', ['20002'])).toThrow();
      expect(store.getConversation('800')?.members).toEqual(members);
      expect(store.listGroupMembers('800')).toEqual(members); expect(store.listReadCursors('800')).toHaveLength(2);
      store.close();
      const restored = createImStateStore({ accountDir: directory, backend });
      expect(restored.getConversation('800')?.members).toEqual(members);
      expect(restored.listGroupMembers('800')).toEqual(members); expect(restored.listReadCursors('800')).toHaveLength(2);
      restored.close();
    } finally { database?.close(); }
  });
});
