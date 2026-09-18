import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AccountStore } from '../store/account-store.js';
import { DESKTOP_LOGIN_USER_AGENT } from '../desktop/constants.js';
import type { StoredAccount } from '../store/types.js';
import { Friend } from './contacts/friend.js';
import {
  GroupMessageEvent,
  MessageEvent,
  PrivateMessageEvent,
  StrangerMessageEvent,
} from './events/message.js';
import { Client, createClient } from './client.js';
import { SendMessageError } from './errors.js';

function storedAccount(platformUid: string, passportUidTt: string): StoredAccount {
  return {
    platformUid,
    passportUidTt,
    session: { cookies: `sessionid=${platformUid}` },
    deviceProfile: {
      userAgent: 'test',
      deviceId: `324${platformUid.slice(-7).padStart(7, '0')}`,
      bizTraceId: `trace-${platformUid}`,
    },
    meta: {
      screenName: `account-${platformUid}`,
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
  };
}

describe('multi-account Client', () => {
  let dataDir = '';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'douyin-im-client-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('loads every stored account and resolves all persisted aliases', () => {
    const store = new AccountStore({ dataDir });
    store.save(storedAccount('10001', 'passport-a'));
    store.save(storedAccount('10002', 'passport-b'));

    const client = new Client({ dataDir });

    expect(client.accounts).toHaveLength(2);
    expect(client.pickAccount('10001')).toBeDefined();
    expect(client.pickAccount('passport-a')).toBe(client.pickAccount('10001'));
    expect(client.createAccount({ accountId: 'passport-a' })).toBe(client.pickAccount('10001'));
    expect(client.accounts).toHaveLength(2);
    expect(store.load('10001')?.deviceProfile.userAgent).toBe(DESKTOP_LOGIN_USER_AGENT);
  });

  it('provides an oicq-style createClient entry', () => {
    const client = createClient({ dataDir, autoLoad: false });
    expect(client).toBeInstanceOf(Client);
  });

  it('gives each account an isolated transport and forwards source account with events', () => {
    const client = new Client({ dataDir, autoLoad: false });
    const first = client.createAccount({ accountId: '13800000001' });
    const second = client.createAccount({ accountId: '13800000002' });
    const received: Array<{ account: typeof first; cmd: number }> = [];
    client.on('message.raw', ({ account, cmd }) => {
      received.push({ account, cmd });
    });

    first.emit('message.raw', { cmd: 100, response: {} });

    expect(first).not.toBe(second);
    expect(received).toEqual([{ account: first, cmd: 100 }]);
  });

  it('puts the receiving account on passive message events and replies through its sender', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    const sendMessage = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: 'OK',
      serverMessageId: 'server-1',
      clientMessageId: 'client-1',
    });
    jest.spyOn(account, 'outbound', 'get').mockReturnValue({ sendMessage } as never);
    const event = PrivateMessageEvent.fromInbound(
      {
        threadId: '0:1:10001:20002',
        conversationShortId: '90001',
        conversationType: 1,
        senderUid: '20002',
        text: 'ping',
        rawContent: '{"text":"ping"}',
        messageType: 7,
        raw: {},
      },
      account,
    );
    let received: MessageEvent | undefined;
    client.on('message', (message) => {
      received = message;
    });

    account.emit('message', event);
    await event.reply('pong');

    expect(received).toBe(event);
    expect(event.account).toBe(account);
    expect(event.friend.account).toBe(account);
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: '0:1:10001:20002',
      conversationShortId: '90001',
      conversationType: 1,
      inboxType: 0,
      message: 'pong',
    });
  });

  it('binds group events to their receiving account and group conversation', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    const sendMessage = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: 'OK', serverMessageId: '1' });
    jest.spyOn(account, 'outbound', 'get').mockReturnValue({ sendMessage } as never);
    const event = GroupMessageEvent.fromInbound({
      threadId: '7681236801654178341', conversationShortId: '7681236801654178341',
      conversationType: 2, senderUid: '20002', senderSecUid: 'MS4sender', text: 'ping',
      rawContent: '{"text":"ping"}', messageType: 7, raw: {},
    }, account);
    let received: GroupMessageEvent | undefined;
    client.on('message.group', (message) => { received = message; });

    account.emit('message.group', event);
    await event.reply('pong');

    expect(received).toBe(event);
    expect(event.isGroup).toBe(true);
    expect(event.group.groupId).toBe('7681236801654178341');
    expect(event.member).toMatchObject({ uid: '20002', secUid: 'MS4sender' });
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: '7681236801654178341',
      conversationShortId: '7681236801654178341',
      conversationType: 2,
      inboxType: 0,
      message: 'pong',
    });
  });

  it('keeps known stranger-box messages as Stranger events instead of polluting Friend semantics', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    const sendMessage = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '1' });
    jest.spyOn(account, 'outbound', 'get').mockReturnValue({ sendMessage } as never);
    account.rememberStranger(account.bindStranger('30003', '0:1:10001:30003', '90003'));
    const event = MessageEvent.fromInbound({
      inboxType: 1,
      threadId: '0:1:10001:30003',
      conversationShortId: '90003',
      conversationType: 1,
      senderUid: '30003',
      text: 'hello',
      rawContent: '{"text":"hello"}',
      messageType: 7,
      raw: {},
    }, account);
    let received: StrangerMessageEvent | undefined;
    client.on('message.stranger', (message) => { received = message; });

    account.emit('message.stranger', event as StrangerMessageEvent);
    await event.reply('world');

    expect(event).toBeInstanceOf(StrangerMessageEvent);
    expect((event as StrangerMessageEvent).stranger).toMatchObject({ uid: '30003', inboxType: 1 });
    expect(received).toBe(event);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inboxType: 1, message: 'world' }),
    );
  });

  it('quotes through the receiving account with jumpbyte reply content fields', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    const sendMessage = jest.fn().mockResolvedValue({ statusCode: 0, serverMessageId: '2' });
    jest.spyOn(account, 'outbound', 'get').mockReturnValue({ sendMessage } as never);
    const event = PrivateMessageEvent.fromInbound({
      threadId: '0:1:10001:20002', conversationShortId: '90001', conversationType: 1,
      senderUid: '20002', senderSecUid: 'MS4sender', serverMessageId: '9988', text: 'parent',
      rawContent: '{"aweType":700,"text":"parent"}', messageType: 7, raw: {},
    }, account);

    await event.quote('child');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: '0:1:10001:20002',
        conversationType: 1,
        message: {
        type: 'reply',
        text: 'child',
        referencedMessageId: '9988',
        referencedMessageType: 7,
        referencedUid: '20002',
        referencedSecUid: 'MS4sender',
        referencedText: 'parent',
        },
      }),
    );
  });

  it('binds message read and delete actions to the receiving account protocol service', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    const markRead = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '' });
    const deleteMessage = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '' });
    jest.spyOn(account, 'cachedConversation').mockReturnValue({ conversationId: '0:1:10001:20002', conversationShortId: '90001',
      conversationType: 1, isGroup: false, name: '', members: [], lastMessageTime: 0 });
    jest.spyOn(account, 'cachedMessage').mockReturnValue({ msgId: '9988', clientMessageId: 'client', threadId: '0:1:10001:20002',
      senderUid: '20002', content: '{"text":"parent"}', msgType: 7, createTime: 1, status: 0 });
    jest.spyOn(account, 'deleteCachedMessageByClientId').mockReturnValue(true);
    jest.spyOn(account, 'im', 'get').mockReturnValue({
      markConversationRead: markRead,
      deleteMessage,
    } as never);
    const event = PrivateMessageEvent.fromInbound({
      threadId: '0:1:10001:20002', conversationShortId: '90001', conversationType: 1,
      senderUid: '20002', serverMessageId: '9988', indexInConversation: '12',
      indexInConversationV2: '34', text: 'parent', rawContent: '{"text":"parent"}',
      messageType: 7, raw: {},
    }, account);

    await event.markRead();
    await event.delete();

    expect(markRead).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: '0:1:10001:20002',
        serverMessageId: '9988',
        indexInConversation: '12',
        indexInConversationV2: '34',
        readBadgeCount: 1,
      }),
    );
    expect(deleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: '0:1:10001:20002',
        serverMessageId: '9988',
      }),
    );
  });

  it('forwards passive notices with their source account intact', () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    const notice = {
      type: 'friend.marked-read' as const,
      account,
      friend: Friend.bind(
        '20002',
        '0:1:10001:20002',
        '90001',
        account,
      ),
      conversationId: '0:1:10001:20002',
      readMessageIndex: '12',
      readMessageIndexV2: '34',
      raw: {},
    };
    let received: import('./events/notice.js').FriendMarkedReadNoticeEvent | undefined;
    client.on('notice.friend.marked-read', (event) => { received = event; });

    account.emit('notice.friend.marked-read', notice);

    expect(received).toBe(notice);
    expect(received?.account).toBe(account);
  });

  it('requires an account id for active operations when several accounts exist', () => {
    const client = new Client({ dataDir, autoLoad: false });
    const first = client.createAccount({ accountId: '13800000001' });
    client.createAccount({ accountId: '13800000002' });

    expect(client.pickAccount('13800000001')).toBe(first);
    expect(() => client.pickAccount()).toThrow('存在多个账号');
    expect(() => client.pickAccount('missing')).toThrow('账号不存在');
  });

  it.each(['notice.conversation.read-summary', 'notice.message.update', 'notice.message.batch-update',
    'notice.message.delete', 'notice.message.reaction'] as const)('forwards %s without replacing the event instance', name => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    const event = Object.freeze({ account, type: name.slice(7), postType: 'notice' as const });
    const received = jest.fn();
    client.on(name, received);
    account.emit(name, event);
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]![0]).toBe(event);
  });

  it('reports rejected async handlers with the source account', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    const event = MessageEvent.fromInbound(
      {
        threadId: '0:1:10001:20002',
        conversationShortId: '90001',
        conversationType: 1,
        senderUid: '20002',
        text: 'ping',
        rawContent: '{"text":"ping"}',
        messageType: 7,
        raw: {},
      },
      account,
    );
    const failure = new Error('handler exploded');
    const reported = new Promise<{ account: typeof account; event: string | symbol; error: Error }>(
      (resolve) => client.once('system.handler.error', resolve),
    );
    client.on('message', async () => {
      throw failure;
    });

    account.emit('message', event);

    await expect(reported).resolves.toEqual({
      account,
      event: 'message',
      error: failure,
    });
  });

  it('throws SendMessageError when the protocol does not confirm delivery', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    jest.spyOn(account, 'outbound', 'get').mockReturnValue({
      sendMessage: jest.fn().mockResolvedValue({
        statusCode: 3,
        statusMsg: 'OK',
        serverMessageId: '0',
        clientMessageId: 'client-1',
        checkCode: 8611,
      }),
    } as never);
    const event = MessageEvent.fromInbound(
      {
        threadId: '0:1:10001:20002',
        conversationShortId: '90001',
        conversationType: 1,
        senderUid: '20002',
        text: 'ping',
        rawContent: '{"text":"ping"}',
        messageType: 7,
        raw: {},
      },
      account,
    );

    await expect(event.reply('pong')).rejects.toMatchObject<Partial<SendMessageError>>({
      name: 'SendMessageError',
      statusCode: 3,
      checkCode: 8611,
    });
  });

  it('logs accounts in registration order', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const first = client.createAccount({ accountId: '13800000001' });
    const second = client.createAccount({ accountId: '13800000002' });
    const order: string[] = [];
    jest.spyOn(first, 'login').mockImplementation(async () => {
      order.push('first:start');
      first.emit('system.online', { platformUid: '10001' });
      order.push('first:end');
    });
    jest.spyOn(second, 'login').mockImplementation(async () => {
      order.push('second:start');
      second.emit('system.online', { platformUid: '10002' });
      order.push('second:end');
    });

    const login = client.login();
    expect(client.login()).toBe(login);
    await login;

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(client.pickAccount('10001')).toBe(first);
    expect(client.pickAccount('10002')).toBe(second);
  });

  it('reuses client logout and asks every registered account to stop', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const first = client.createAccount({ accountId: '13800000001' });
    const second = client.createAccount({ accountId: '13800000002' });
    const firstLogout = jest.spyOn(first, 'logout').mockResolvedValue(undefined);
    const secondLogout = jest.spyOn(second, 'logout').mockResolvedValue(undefined);

    const logout = client.logout();

    expect(client.logout()).toBe(logout);
    await logout;
    expect(firstLogout).toHaveBeenCalledTimes(1);
    expect(secondLogout).toHaveBeenCalledTimes(1);
  });

  it('removes a stopped account and emits its concrete source instance', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    jest.spyOn(account, 'logout').mockResolvedValue(undefined);
    const removed = jest.fn();
    const rawMessage = jest.fn();
    client.on('account.removed', removed);
    client.on('message.raw', rawMessage);

    await expect(client.removeAccount('13800000001')).resolves.toBe(true);

    expect(client.accounts).toEqual([]);
    expect(removed).toHaveBeenCalledWith({ account });
    account.emit('message.raw', { cmd: 100, response: {} });
    expect(rawMessage).not.toHaveBeenCalled();
    await expect(client.removeAccount('13800000001')).resolves.toBe(false);
  });

  it('does not continue logging later accounts in after logout starts', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const first = client.createAccount({ accountId: '13800000001' });
    const second = client.createAccount({ accountId: '13800000002' });
    let release!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(first, 'login').mockReturnValue(firstPending);
    const secondLogin = jest.spyOn(second, 'login').mockResolvedValue(undefined);
    jest.spyOn(first, 'logout').mockResolvedValue(undefined);
    jest.spyOn(second, 'logout').mockResolvedValue(undefined);

    const login = client.login();
    const rejected = expect(login).rejects.toThrow('Client 登录已取消');
    const logout = client.logout();
    release();

    await logout;
    await rejected;
    expect(secondLogin).not.toHaveBeenCalled();
  });

  it('waits for logout before starting a new login', async () => {
    const client = new Client({ dataDir, autoLoad: false });
    const account = client.createAccount({ accountId: '13800000001' });
    let release!: () => void;
    const pendingLogout = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(account, 'logout').mockReturnValue(pendingLogout);
    const accountLogin = jest.spyOn(account, 'login').mockResolvedValue(undefined);

    const logout = client.logout();
    const login = client.login();
    expect(client.login()).toBe(login);
    expect(accountLogin).not.toHaveBeenCalled();
    release();

    await logout;
    await login;
    expect(accountLogin).toHaveBeenCalledTimes(1);
  });
});
