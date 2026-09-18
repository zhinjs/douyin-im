import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '../client.js';
import { Friend } from './friend.js';
import { Group } from './group.js';
import { Stranger } from './stranger.js';
import { EventAssembler } from '../events/assembler.js';
import { emitEventRoutes } from '../events/router.js';
import { MessageListUpdateNoticeEvent } from '../events/notice.js';
import { createImStateStore, type ImStateStoreBackend } from '../../services/im/state-store.js';
import type { PrivateMessage } from '../../services/im/types.js';

const message = (id = '1', conversationId = '700'): PrivateMessage => ({
  msgId: id, clientMessageId: `c${id}`, threadId: conversationId, senderUid: '22',
  msgType: 7, status: 0, content: '{"text":"body"}', createTime: 123,
  orderInConversation: id, indexInConversation: id, version: '5',
  ext: { remote: 'unchanged' }, localExt: { keep: 'old', replace: 'old' },
});

describe.each<ImStateStoreBackend>(['sqlite', 'json'])('local message ext: %s', backend => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'douyin-local-ext-'));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected network'); });
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture() {
    const store = createImStateStore({ accountDir: directory, backend });
    const account = new Client({ dataDir: join(directory, 'sdk'), autoLoad: false }).createAccount({ accountId: '11' });
    jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    // No authentication or runtime startup: only the real local action/assembler/storage seam.
    Object.assign(account, { sender: {}, stateStore: store });
    const onMessage = jest.fn();
    const assembler = new EventAssembler(account, { onMessage,
      onNotice: event => emitEventRoutes(account.emit.bind(account), event) }, '11');
    Object.assign(account, { assembler });
    for (const conversationId of ['700', 'friend', 'stranger']) store.upsertConversations([{
      conversationId, conversationShortId: '700', conversationType: conversationId === '700' ? 2 : 1,
      isGroup: conversationId === '700', name: 'fixture', members: [], lastMessageTime: 0,
    }]);
    const contacts = [Group.bind('700', '', account), Friend.bind('22', 'friend', '', account), Stranger.bind('33', 'stranger', '', account)];
    return { store, account, contacts, assembler, onMessage };
  }

  it('merges string fields for all contact kinds, saves before single notice, and survives reopen', () => {
    const f = fixture();
    const notices = jest.fn(event => {
      expect(f.store.getMessage(event.conversationId, 'c1', 'client')!.localExt).toEqual({ keep: 'old', replace: '', added: 'new' });
    });
    f.account.on('notice.message.update', notices);
    const batch = jest.fn(); f.account.on('notice.message.list-update', batch);
    try {
      for (const contact of f.contacts) {
        f.store.upsertMessages([message('1', contact.threadId)]);
        const original = f.store.getMessage(contact.threadId, 'c1', 'client')!;
        const summary = f.store.getConversation(contact.threadId);
        const patch = { replace: '', added: 'new' };
        expect(contact.modifyMessageLocalExt('C1', patch)).toBeUndefined();
        patch.added = 'caller mutation';
        expect(f.store.getMessage(contact.threadId, 'c1', 'client')).toEqual({ ...original, localExt: { keep: 'old', replace: '', added: 'new' } });
        expect(f.store.getConversation(contact.threadId)).toEqual(summary); // No forced summary re-selection/float.
        contact.modifyMessageLocalExt('c1', {}); // Empty/equal maps still notify.
      }
      expect(notices).toHaveBeenCalledTimes(6);
      expect(batch).not.toHaveBeenCalled(); expect(f.onMessage).not.toHaveBeenCalled();
    } finally { f.store.close(); }
    const reopened = createImStateStore({ accountDir: directory, backend });
    try { expect(reopened.getMessage('700', 'c1', 'client')!.localExt).toEqual({ keep: 'old', replace: '', added: 'new' }); }
    finally { reopened.close(); }
  });

  it('keeps batch input order and duplicates, rereads final values, and includes orphan messages', () => {
    const f = fixture();
    f.store.upsertMessages([message(), message('2', 'orphan')]);
    const notices: MessageListUpdateNoticeEvent[] = [];
    const parent = jest.fn(); f.account.on('notice.message', parent);
    const single = jest.fn(); f.account.on('notice.message.update', single);
    f.account.on('notice.message.list-update', event => { notices.push(event); });
    try {
      f.account.batchModifyMessageLocalExt([
        { conversationId: '700', clientMessageId: 'c1', ext: { replace: 'first' } },
        { conversationId: 'absent', clientMessageId: 'absent', ext: {} },
        { conversationId: 'orphan', clientMessageId: 'c2', ext: { orphan: 'yes' } },
        { conversationId: '700', clientMessageId: 'c1', ext: { replace: 'final' } },
      ]);
      expect(notices).toHaveLength(1);
      const event = notices[0]!;
      expect(event).toBeInstanceOf(MessageListUpdateNoticeEvent);
      expect(event.messages.map(row => row.clientMessageId)).toEqual(['c1', 'c2', 'c1']);
      expect(event.messages[0]!.localExt!['replace']).toBe('final');
      expect(event.messages[2]!.localExt!['replace']).toBe('final');
      expect(event.messages[1]!.threadId).toBe('orphan');
      expect(parent).toHaveBeenCalledWith(event);
      expect(single).not.toHaveBeenCalled(); expect(f.onMessage).not.toHaveBeenCalled();
      expect(event).not.toHaveProperty('conversationId'); expect(event).not.toHaveProperty('updates');
      expect(Object.isFrozen(event.messages)).toBe(true);
      Reflect.set(event.messages[0]!.localExt!, 'replace', 'listener mutation');
      expect(event.messages[2]!.localExt!['replace']).toBe('final');
      expect(f.store.getMessage('700', 'c1', 'client')!.localExt!['replace']).toBe('final');
    } finally { f.store.close(); }
  });

  it('distinguishes native visibility from the main empty-content gate in flat batch notices', () => {
    const f = fixture();
    const notices = jest.fn(); f.account.on('notice.message.list-update', notices);
    try {
      f.store.upsertMessages([{ ...message(), status: 1 }, { ...message('2'), content: '' }]);
      f.account.batchModifyMessageLocalExt([{ conversationId: '700', clientMessageId: 'c1', ext: {} }]);
      expect(notices).not.toHaveBeenCalled();
      expect(f.store.getMessage('700', 'c1', 'client')!.localExt).toBeDefined();
      f.account.batchModifyMessageLocalExt([{ conversationId: '700', clientMessageId: 'c2', ext: {} }]);
      expect(notices).toHaveBeenCalledTimes(1);
      expect(notices.mock.calls[0]![0].messages).toEqual([]);
      f.assembler.clear();
      f.account.batchModifyMessageLocalExt([{ conversationId: '700', clientMessageId: 'c2', ext: {} }]);
      expect(notices).toHaveBeenCalledTimes(1);
    } finally { f.store.close(); }
  });

  it('does not synthesize or revive rows, and single operations require the conversation', () => {
    const f = fixture();
    try {
      f.store.upsertMessages([message(), message('2', 'orphan')]);
      expect(() => f.contacts[0]!.modifyMessageLocalExt('missing', {})).toThrow('本地消息不存在');
      expect(() => Group.bind('orphan', '', f.account).modifyMessageLocalExt('c2', {})).toThrow('本地会话不存在');
      f.store.deleteMessage('700', 'c1', 'client');
      expect(() => f.contacts[0]!.modifyMessageLocalExt('c1', {})).toThrow('本地消息不存在');
      f.account.batchModifyMessageLocalExt([{ conversationId: '700', clientMessageId: 'c1', ext: { forbidden: 'yes' } }]);
      expect(f.store.getMessage('700', '1', 'server')).toMatchObject({ deleted: true, localExt: { keep: 'old', replace: 'old' } });
      expect(f.store.getMessage('700', 'missing', 'client')).toBeUndefined();
      f.contacts[0]!.modifyMessageLocalExt('', {});
      Object.assign(f.account, { stateStore: undefined });
      expect(() => f.contacts[0]!.modifyMessageLocalExt('c1', {})).toThrow('本地状态库');
      jest.spyOn(f.account, 'online', 'get').mockReturnValue(false);
      expect(() => f.account.batchModifyMessageLocalExt([])).toThrow('账号未上线');
    } finally { f.store.close(); }
  });

  it('validates the entire batch before writes and preserves prototype-like keys as data', () => {
    const f = fixture(); f.store.upsertMessages([message()]);
    try {
      expect(() => f.account.batchModifyMessageLocalExt([
        { conversationId: '700', clientMessageId: 'c1', ext: { replace: 'should not save' } },
        { conversationId: '700', clientMessageId: 'c1', ext: { bad: 1 } as unknown as Record<string, string> },
      ])).toThrow('字符串键值');
      expect(f.store.getMessage('700', 'c1', 'client')!.localExt!['replace']).toBe('old');
      f.contacts[0]!.modifyMessageLocalExt('c1', JSON.parse('{"__proto__":"safe","constructor":"value"}'));
      expect(f.store.getMessage('700', 'c1', 'client')!.localExt).toMatchObject(JSON.parse('{"__proto__":"safe","constructor":"value"}'));
    } finally { f.store.close(); }
  });

  it('does not notify or publish a local patch when its durable write fails', () => {
    const f = fixture(); f.store.upsertMessages([message()]);
    const notices = jest.fn(); f.account.on('notice', notices);
    let database: DatabaseSync | undefined;
    if (backend === 'json') mkdirSync(join(directory, 'im-state.json.tmp'));
    else {
      database = new DatabaseSync(join(directory, 'im-state.sqlite'));
      database.exec("CREATE TRIGGER reject_patch BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    }
    try {
      expect(() => f.contacts[0]!.modifyMessageLocalExt('c1', { replace: 'bad' })).toThrow();
      expect(f.store.getMessage('700', 'c1', 'client')!.localExt!['replace']).toBe('old');
      expect(notices).not.toHaveBeenCalled();
    } finally { database?.close(); f.store.close(); }
  });

  it('retains completed rows if a later batch write fails, without claiming a completed batch notice', () => {
    const f = fixture(); f.store.upsertMessages([message(), message('2')]);
    const notices = jest.fn(); f.account.on('notice', notices);
    const save = f.store.modifyMessageLocalExt.bind(f.store);
    jest.spyOn(f.store, 'modifyMessageLocalExt').mockImplementation(update => {
      if (update.clientMessageId === 'c2') throw new Error('second write failed');
      return save(update);
    });
    try {
      expect(() => f.account.batchModifyMessageLocalExt([
        { conversationId: '700', clientMessageId: 'c1', ext: { replace: 'saved' } },
        { conversationId: '700', clientMessageId: 'c2', ext: { replace: 'not saved' } },
      ])).toThrow('second write failed');
      expect(notices).not.toHaveBeenCalled();
    } finally { f.store.close(); }
    const reopened = createImStateStore({ accountDir: directory, backend });
    try {
      expect(reopened.getMessage('700', 'c1', 'client')!.localExt!['replace']).toBe('saved');
      expect(reopened.getMessage('700', 'c2', 'client')!.localExt!['replace']).toBe('old');
    } finally { reopened.close(); }
  });

  it('addresses client-only messages and keeps another account with the same IDs unchanged', () => {
    const f = fixture();
    const other = createImStateStore({ accountDir: join(directory, 'other-account'), backend });
    const unsent = { ...message(), msgId: '0' };
    f.store.upsertMessages([unsent]); other.upsertMessages([unsent]);
    try {
      f.contacts[0]!.modifyMessageLocalExt('c1', { replace: 'owned' });
      expect(f.store.getMessage('700', 'c1', 'client')).toMatchObject({ msgId: '0', localExt: { replace: 'owned' } });
      expect(other.getMessage('700', 'c1', 'client')!.localExt!['replace']).toBe('old');
    } finally { other.close(); f.store.close(); }
  });
});
