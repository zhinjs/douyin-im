import type { BaseAccount } from '../../base/account.js';
import { Contact, type ConversationAddress } from '../../base/contact.js';
import type { Account } from '../account.js';
import { Friend } from './friend.js';
import { Group } from './group.js';
import { Stranger } from './stranger.js';

class TestContact extends Contact<BaseAccount> {
  constructor(account: BaseAccount, id: string, address: ConversationAddress) {
    super(account, id, address);
  }

}

describe('Contact hierarchy', () => {
  it('logs current contact names and IDs for private, group and stranger sends, including failures', async () => {
    const info = jest.fn(); const error = jest.fn();
    const sendMessage = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: 'OK', serverMessageId: '1' });
    const account = { online: true, im: {}, outbound: { sendMessage },
      logger: { info, error, debug: jest.fn() }, getUserRelation: jest.fn(),
      resolveShortId: (_id: string, hint: string) => hint,
    } as unknown as Account;
    const friend = Friend.bind('22', '0:1:11:22', '9001', account, { nickname: '凉菜' });
    const group = Group.bind('700', '700', account, { name: '测试群' });
    const stranger = Stranger.bind('33', '0:1:11:33', '9002', account, { nickname: '访客' });
    for (const [contact, label] of [[friend, '[Private: 凉菜(22)]'], [group, '[Group: 测试群(700)]'],
      [stranger, '[Stranger: 访客(33)]']] as const) {
      await contact.sendMsg('foo');
      expect(info).toHaveBeenLastCalledWith('succeed to send: %s %s', label, 'foo');
    }
    friend.updateMetadata({ nickname: '新昵称' });
    await friend.sendMsg('bar');
    expect(info).toHaveBeenLastCalledWith('succeed to send: %s %s', '[Private: 新昵称(22)]', 'bar');
    sendMessage.mockResolvedValue({ statusCode: 3, statusMsg: 'rejected', serverMessageId: '0' });
    await expect(friend.sendMsg('fail')).rejects.toThrow();
    expect(error).toHaveBeenCalledWith('failed to send: %s %s(%s)%s', '[Private: 新昵称(22)]', 'rejected', 3, '');
  });

  it('keeps the stranger conversation address when refreshing inbox metadata', () => {
    const account = {} as Account;
    const stranger = Stranger.bind('22', '0:1:11:22', '9001', account, { inboxType: 3 });
    const original = stranger.address;
    stranger.updateMetadata({ inboxType: 4, nickname: 'fixture' });
    expect(stranger.address).toEqual({ threadId: '0:1:11:22', conversationShortId: '9001', conversationType: 1, inboxType: 4 });
    expect(original.inboxType).toBe(3);
    expect(Object.isFrozen(stranger.address)).toBe(true);
    stranger.updateMetadata({ nickname: 'renamed' });
    expect(stranger.inboxType).toBe(4);
  });
  it('reads raw summaries through the same account without preparing addresses or network', () => {
    const cachedReadSummary = jest.fn();
    const account = { cachedReadSummary } as unknown as Account;
    for (const contact of [Group.bind('700', '700', account), Friend.bind('22', '0:1:11:22', '', account), Stranger.bind('33', '0:1:11:33', '', account)]) {
      expect(contact.getCachedReadSummary()).toBeUndefined();
      expect(cachedReadSummary).toHaveBeenLastCalledWith(contact.threadId);
    }
  });
  it('does not replace confirmed group settings with requested values after an acknowledgement', async () => {
    const setConversationSettings = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '' });
    const patchCachedConversation = jest.fn();
    const account = { online: true, im: { setConversationSettings }, patchCachedConversation,
      resolveShortId: (_id: string, hint: string) => hint } as unknown as Account;
    const group = Group.bind('700', '700', account, { pinned: false, muted: false });
    await expect(group.setPinned()).resolves.toEqual({ statusCode: 0, statusMsg: '' });
    await group.setMute();
    expect(setConversationSettings).toHaveBeenCalledTimes(2);
    expect(group.pinned).toBe(false); expect(group.muted).toBe(false);
    expect(patchCachedConversation).not.toHaveBeenCalled();
    group.updateMetadata({ pinned: true, muted: true });
    expect(group.pinned).toBe(true); expect(group.muted).toBe(true);
  });

  it.each(['setPinned', 'setMute'] as const)('rejects stale %s acknowledgements across contact kinds without patching new login state', async action => {
    for (const kind of ['group', 'friend', 'stranger']) {
      let resolve!: (value: { statusCode: number; statusMsg: string }) => void;
      const setConversationSettings = jest.fn(() => new Promise(done => { resolve = done; }));
      const account = { online: true, im: { setConversationSettings }, resolveShortId: (_id: string, hint: string) => hint,
        ensureFriendConversation: jest.fn().mockResolvedValue({ conversationId: '0:1:11:22', conversationShortId: '9001', conversationType: 1 }) } as unknown as Account;
      const contact = kind === 'group' ? Group.bind('700', '700', account) : kind === 'friend' ? Friend.bind('22', '0:1:11:22', '9001', account) : Stranger.bind('22', '0:1:11:22', '9001', account);
      const pending = contact[action]();
      // prepareAddress includes Friend's lazy address step; wait until the mocked request is dispatched.
      for (let turn = 0; turn < 10 && !resolve; turn++) await Promise.resolve();
      expect(setConversationSettings).toHaveBeenCalledTimes(1);
      Object.assign(account, { im: {} });
      resolve({ statusCode: 0, statusMsg: '' });
      await expect(pending).rejects.toThrow('账号连接已变化');
    }
  });
  it('uses the same cached client identity and native delete route for friend, group and stranger', async () => {
    const deleteMessage = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '' });
    const remove = jest.fn().mockReturnValue(true);
    const account = { online: true, im: { deleteMessage }, deleteCachedMessageByClientId: remove,
      cachedConversation: (id: string) => ({ conversationId: id, conversationShortId: '9001', conversationType: id === '700' ? 2 : 1, inboxType: 3 }),
      cachedMessage: (id: string) => ({ msgId: '99', threadId: id, clientMessageId: 'client' }),
    } as unknown as Account;
    const contacts = [Friend.bind('22', '0:1:11:22', '', account), Group.bind('700', '700', account), Stranger.bind('33', '0:1:11:33', '', account)];
    for (const contact of contacts) {
      await expect(contact.deleteMsg({ clientMessageId: 'client' })).resolves.toEqual({ statusCode: 0, statusMsg: '' });
      expect(deleteMessage).toHaveBeenLastCalledWith({ threadId: contact.threadId, conversationShortId: '9001',
        conversationType: contact.threadId === '700' ? 2 : 1, inboxType: 3, serverMessageId: '99' });
      expect(remove).toHaveBeenLastCalledWith(contact.threadId, 'client', true);
    }
  });
  it('shares synchronous local identity lookups across friend, group and stranger without network or address preparation', () => {
    const cached = { msgId: '99', clientMessageId: 'client', content: 'local' };
    const cachedMessage = jest.fn().mockReturnValue(cached);
    const deleteCachedMessageByClientId = jest.fn().mockReturnValue(true);
    const account = { online: false, cachedMessage, deleteCachedMessageByClientId, cachedConversation: jest.fn().mockReturnValue({}), ensureFriendConversation: jest.fn(), im: {} } as unknown as Account;
    const contacts = [Friend.bind('22', '0:1:11:22', '', account), Group.bind('700', '700', account),
      Stranger.bind('33', '0:1:11:33', '', account)];
    for (const contact of contacts) {
      expect(contact.getCachedMessage('99')).toBe(cached);
      expect(cachedMessage).toHaveBeenLastCalledWith(contact.threadId, '99', 'server');
      expect(contact.getCachedMessageByClientId('client')).toBe(cached);
      expect(cachedMessage).toHaveBeenLastCalledWith(contact.threadId, 'client', 'client');
      expect(contact.deleteLocalMsg('99')).toBe(true);
      expect(deleteCachedMessageByClientId).toHaveBeenLastCalledWith(contact.threadId, 'client', false);
    }
    expect(account.ensureFriendConversation).not.toHaveBeenCalled();
    cachedMessage.mockReturnValue(undefined);
    expect(contacts[0]!.getCachedMessage('unknown')).toBeUndefined();
    deleteCachedMessageByClientId.mockReturnValue(false);
    expect(contacts[0]!.deleteLocalMsg('unknown')).toBe(false);
  });
  it('queries read state from the owning account without implicitly creating a private conversation', async () => {
    const result = { statusCode: 0, statusMsg: '', readIndexes: [{ uid: '22', index: '10' }], minIndexes: [{ uid: '22', index: '0' }] };
    const getConversationReadState = jest.fn().mockResolvedValue(result);
    const account = { online: true, resolveShortId: (_id: string, hint: string) => hint,
      ensureFriendConversation: jest.fn(), readConversationState: getConversationReadState,
      cachedReadCursors: jest.fn().mockReturnValue([{ uid: '22', readIndex: '10', minIndex: '0' }]) } as unknown as Account;
    const friend = Friend.bind('22', '0:1:11:22', '9001', account);
    await expect(friend.getReadState()).resolves.toEqual(result);
    expect(getConversationReadState).toHaveBeenCalledWith({ threadId: '0:1:11:22', conversationShortId: '9001', conversationType: 1, inboxType: 0 });
    expect(account.ensureFriendConversation).not.toHaveBeenCalled();
    expect(friend.getCachedReadState()).toEqual([{ uid: '22', readIndex: '10', minIndex: '0' }]);
    expect(account.cachedReadCursors).toHaveBeenCalledWith('0:1:11:22');
    const missing = Friend.bind('33', '0:1:11:33', '', account);
    await expect(missing.getReadState()).rejects.toThrow('尚无可查询');
    expect(getConversationReadState).toHaveBeenCalledTimes(1);
    Object.assign(account, { online: false });
    await expect(friend.getReadState()).rejects.toThrow('账号未上线');
    expect(getConversationReadState).toHaveBeenCalledTimes(1);
  });

  it('keeps immutable protocol identity and its owning account', () => {
    const account = { toString: () => 'account' } as unknown as BaseAccount;
    const contact = new TestContact(account, '22', {
      threadId: '0:1:11:22',
      conversationShortId: '9001',
      conversationType: 1,
      inboxType: 0,
    });

    expect(contact).toMatchObject({
      account,
      id: '22',
      threadId: '0:1:11:22',
      conversationShortId: '9001',
      conversationType: 1,
      inboxType: 0,
    });
    expect(Object.isFrozen(contact.address)).toBe(true);
    expect(() => Object.assign(contact.address, { threadId: 'other' })).toThrow(TypeError);
  });

  it('makes concrete chat entities real Contact instances and resolves short ids at invocation time', async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      serverMessageId: '1',
    });
    const account = {
      resolveShortId: () => 'resolved-short-id',
      getUserRelation: jest.fn(),
      ensureFriendConversation: jest.fn().mockResolvedValue(undefined),
      online: true, im: {},
      outbound: { sendMessage },
    } as unknown as Account;
    const friend = Friend.bind('22', '0:1:11:22', '', account);

    expect(friend).toBeInstanceOf(Contact);
    expect(friend.id).toBe('22');
    await friend.sendMsg('hello');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationShortId: 'resolved-short-id', message: 'hello' }),
    );
  });

  it('loads history from the contact-owned conversation address', async () => {
    const getMessages = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      hasMore: false,
      messages: [
        { msgId: '2', threadId: '0:1:11:22', senderUid: '22', content: 'later', msgType: 7, createTime: 2, status: 0, indexInConversationV2: '12' },
        { msgId: '1', threadId: '0:1:11:22', senderUid: '22', content: 'earlier', msgType: 7, createTime: 1, status: 0, indexInConversationV2: '11' },
      ],
      cursor: '0',
      direction: 'older',
    });
    const account = {
      resolveShortId: () => 'resolved-short-id',
      ensureFriendConversation: jest.fn().mockResolvedValue(undefined),
      cacheMessages: jest.fn(),
      online: true,
      im: { getMessages },
    } as unknown as Account;
    const friend = Friend.bind('22', '0:1:11:22', '', account);

    await expect(friend.getHistory({ cursor: 99, count: 10 })).resolves.toMatchObject({
      statusCode: 0,
      messages: [{ msgId: '1' }, { msgId: '2' }],
    });
    expect(getMessages).toHaveBeenCalledWith({
      threadId: '0:1:11:22',
      conversationShortId: 'resolved-short-id',
      conversationType: 1,
      inboxType: 0,
      cursor: 99,
      count: 10,
    });
    expect(account.cacheMessages).toHaveBeenCalledWith([
      expect.objectContaining({ msgId: '2' }),
      expect.objectContaining({ msgId: '1' }),
    ]);
  });

  it('does not dispatch a history request after the connection changes during address preparation', async () => {
    let release!: () => void;
    const prepared = new Promise<void>(resolve => { release = resolve; });
    const oldConnection = { getMessages: jest.fn() };
    const newConnection = { getMessages: jest.fn() };
    const account = {
      online: true, im: oldConnection, resolveShortId: () => '',
      ensureFriendConversation: jest.fn(async () => { await prepared; }), cacheMessages: jest.fn(),
    } as unknown as Account;
    const friend = Friend.bind('22', '0:1:11:22', '', account);
    const task = friend.getHistory();
    Object.assign(account, { im: newConnection });
    release();
    await expect(task).rejects.toThrow('账号连接已变化');
    expect(oldConnection.getMessages).not.toHaveBeenCalled();
    expect(newConnection.getMessages).not.toHaveBeenCalled();
    expect(account.cacheMessages).not.toHaveBeenCalled();
  });

  it('lazily creates a missing private conversation only once for concurrent actions', async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      statusCode: 0, statusMsg: '', serverMessageId: '1',
    });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const ensureFriendConversation = jest.fn(async (friend: Friend) => {
      await ready;
      friend.bindConversation('0:1:10:20', '900');
    });
    const account = {
      resolveShortId: (_threadId: string, hint: string) => hint,
      ensureFriendConversation,
      getUserRelation: jest.fn(),
      online: true, im: {},
      outbound: { sendMessage },
    } as unknown as Account;
    const friend = Friend.bind('20', '0:1:10:20', '', account);

    const first = friend.sendMsg('one');
    const second = friend.sendMsg('two');
    release();
    await Promise.all([first, second]);

    expect(ensureFriendConversation).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationShortId: '900' }));
  });
});
