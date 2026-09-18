import type { ApiConnection } from '../../desktop/api-connection.js';
import { GroupJoinRequestStatus } from '../../services/im/types.js';
import type { Account } from '../account.js';
import { Client } from '../client.js';
import { OutboundSender } from '../messaging/outbound.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MessageEvent } from './message.js';
import { Group } from '../contacts/group.js';
import type { AnyNoticeEvent } from '../events/notice.js';
import { EventAssembler } from './assembler.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'douyin-im-events-')); });
afterEach(() => { jest.restoreAllMocks(); rmSync(dataDir, { recursive: true, force: true }); });

function accountStub(overrides: Record<string, unknown> = {}): Account {
  const account = new Client({ dataDir, autoLoad: false }).createAccount({ accountId: '10001' });
  Object.defineProperty(account, 'uid', { value: '10001', configurable: true });
  Object.defineProperty(account, 'sender', { value: new OutboundSender({} as ApiConnection, { platformUid: '10001' }) });
  jest.spyOn(account, 'online', 'get').mockReturnValue(true);
  const fields = {
    cachedGroup: jest.fn(),
    cachedFriend: jest.fn(),
    cachedFriendByThreadId: jest.fn(),
    cachedStranger: jest.fn(),
    rememberGroup: jest.fn(),
    rememberFriend: jest.fn(),
    rememberStranger: jest.fn(),
    forgetGroup: jest.fn(),
    forgetFriend: jest.fn(),
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(account, key, { value, configurable: true });
  }
  return account;
}

describe('Account actions and EventAssembler projection', () => {
  it('projects deletes without native display gates but retains main mapper gates and target snapshots', () => {
    const account = accountStub();
    const onNotice = jest.fn(); const onMessage = jest.fn();
    const assembler = new EventAssembler(account, { onNotice, onMessage }, '10001');
    const message = { msgId: '99', clientMessageId: 'client', threadId: '700', conversationType: 2,
      senderUid: '10001', content: 'body', msgType: 50001, createTime: 1, status: 1 };
    assembler.receiveMessageDelete({ ...message, clientMessageId: '' }, {});
    assembler.receiveMessageDelete({ ...message, content: '' }, {});
    expect(onNotice).not.toHaveBeenCalled();
    assembler.receiveMessageDelete(message, { source: 'command' });
    expect(onNotice).toHaveBeenCalledTimes(1);
    const event = onNotice.mock.calls[0]![0];
    expect(event).toMatchObject({ type: 'message.delete', account, conversationId: '700', conversationType: 2,
      clientMessageId: 'client', serverMessageId: '99', message });
    expect(event.message).not.toBe(message);
    expect(event.message).not.toHaveProperty('deleted');
    expect(event).not.toHaveProperty('reply'); expect(onMessage).not.toHaveBeenCalled();
    message.content = 'changed'; expect(event.message.content).toBe('body');
    assembler.clear(); assembler.receiveMessageDelete(message, {});
    expect(onNotice).toHaveBeenCalledTimes(1);
  });
  it('projects batch snapshots by conversation/client ID before filtering and keeps deleted client identities', () => {
    const snapshot = { conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true, name: 'group', lastMessageTime: 0, members: [] };
    const account = accountStub({ cachedConversation: jest.fn((id: string) => id === 'missing' ? undefined : { ...snapshot, conversationId: id }) });
    const onNotice = jest.fn();
    const onMessage = jest.fn();
    const assembler = new EventAssembler(account, { onNotice, onMessage }, '10001');
    const message = { msgId: '99', clientMessageId: 'CLIENT', threadId: '700', senderUid: '22', content: 'body', msgType: 7, createTime: 1, status: 0 };
    assembler.receiveMessageBatch([message, { ...message, msgId: '100', clientMessageId: 'client', content: 'latest' },
      { ...message, threadId: '800', status: 1 }, { ...message, threadId: 'missing' }], ['deleted-client', 'deleted-client']);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]![0]).toMatchObject({ type: 'message.batch-update', deletedClientMessageIds: ['deleted-client', 'deleted-client'], updates: [
      { conversation: { conversationId: '700' }, messages: [{ msgId: '100', content: 'latest' }] },
      { conversation: { conversationId: '800' }, messages: [] },
    ] });
    expect(onMessage).not.toHaveBeenCalled();
    assembler.receiveMessageBatch([]);
    expect(onNotice).toHaveBeenCalledTimes(1);
    assembler.receiveMessageBatch([{ ...message, threadId: 'missing' }]);
    expect(onNotice.mock.calls[1]![0]).toMatchObject({ updates: [], deletedClientMessageIds: [] });
    assembler.receiveMessageBatch([], ['deleted-client']);
    expect(onNotice.mock.calls[2]![0]).toMatchObject({ updates: [], deletedClientMessageIds: ['deleted-client'] });
    assembler.clear();
    assembler.receiveMessageBatch([message]);
    expect(onNotice).toHaveBeenCalledTimes(3);
  });

  it('requires client identity and content for update projection, but not a server ID', () => {
    const account = accountStub();
    const onNotice = jest.fn();
    const onMessage = jest.fn();
    const assembler = new EventAssembler(account, { onMessage, onNotice }, '10001');
    const inbound = { threadId: '700', conversationShortId: '700', conversationType: 2, senderUid: '22',
      serverMessageId: '0', clientMessageId: 'client', rawContent: 'content', text: 'content', messageType: 7, raw: {} };
    const message = { msgId: '0', threadId: '700', clientMessageId: 'client', senderUid: '22', content: 'content', msgType: 7, createTime: 0, status: 0 };
    assembler.receiveMessageUpdate(inbound, { ...message, clientMessageId: '' });
    assembler.receiveMessageUpdate(inbound, { ...message, content: '' });
    assembler.receiveMessageUpdate(inbound, { ...message, status: 1 });
    assembler.receiveMessageUpdate(inbound, { ...message, msgType: 2000 });
    assembler.receiveMessageUpdate(inbound, { ...message, msgType: 1002, content: '{"aweType":100200}' });
    assembler.receiveMessageUpdate(inbound, { ...message, msgType: 1, content: '{"pc_filter_min_version":"1.0"}' });
    expect(onNotice).not.toHaveBeenCalled();
    assembler.receiveMessageUpdate(inbound, message);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]![0]).toMatchObject({ type: 'message.update', message });
    expect(onMessage).not.toHaveBeenCalled();
    expect(account.rememberGroup).not.toHaveBeenCalled();
    assembler.clear();
    assembler.receiveMessageUpdate(inbound, message);
    expect(onNotice).toHaveBeenCalledTimes(1);
  });

  it('persists participant read updates before dispatch and ignores self, equal and lower cursors', () => {
    const account = accountStub();
    const notices: AnyNoticeEvent[] = [];
    const assembler = new EventAssembler(account, { onMessage: jest.fn(), onNotice: event => {
      expect(account.cachedReadCursors('70001')).toEqual([{ uid: '20002', readIndex: '9007199254740997', minIndex: '0' }]);
      notices.push(event);
    } }, '10001');
    const notice = { type: 'conversation.read' as const, conversationId: '70001', conversationType: 2,
      readerUid: '20002', readMessageIndex: '9007199254740997', raw: {} };
    assembler.receiveNotice({ ...notice, readerUid: '10001' });
    assembler.receiveNotice(notice);
    assembler.receiveNotice(notice);
    assembler.receiveNotice({ ...notice, readMessageIndex: '2' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'group.marked-read', account, readerUid: '20002', readMessageIndex: '9007199254740997' });
    expect(notices[0]).toHaveProperty('readMessageIndexV2', undefined);
    assembler.clear();
  });
  it('splits batch reads by inbox and keeps failed contact refreshes out of stable caches', async () => {
    const account = accountStub({
      cachedGroup: jest.fn(),
      rememberGroup: jest.fn(),
    });
    const markRead = jest.spyOn(account.im, 'markConversationsRead')
      .mockResolvedValue({ statusCode: 0, statusMsg: '', failed: [] });

    await account.markMessagesRead([
      {
        threadId: '70001', conversationShortId: '70001', conversationType: 2,
        inboxType: 0, serverMessageId: '101',
      },
      {
        threadId: '0:1:10001:20002', conversationShortId: '80001', conversationType: 1,
        inboxType: 1, serverMessageId: '102',
      },
    ].map((target) => ({ ...target, account }) as MessageEvent));

    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead.mock.calls.map(([items]) => items.map((item) => item.inboxType))).toEqual([[0], [1]]);

    jest.spyOn(account.im, 'getConversationInfos')
      .mockResolvedValueOnce({
        statusCode: 0,
        statusMsg: '',
        conversations: [{
          conversationId: '70001', conversationShortId: '70001', conversationType: 2,
          isGroup: true, name: '不应写入', lastMessageTime: 0, members: [],
        }],
      })
      .mockResolvedValueOnce({ statusCode: 500, statusMsg: 'failed', conversations: [] });

    const refreshed = await account.refreshContactAddresses([
      { threadId: '70001', conversationShortId: '70001', conversationType: 2, inboxType: 0 },
      { threadId: '0:1:10001:20002', conversationShortId: '80001', conversationType: 1, inboxType: 1 },
    ]);

    expect(refreshed.statusCode).toBe(500);
    expect(account.rememberGroup).not.toHaveBeenCalled();
  });

  it('creates and caches a stable Group from the cmd609 result', async () => {
    const account = accountStub({
      cachedGroup: jest.fn(),
      rememberGroup: jest.fn(),
    });
    const createConversation = jest.spyOn(account.im, 'createGroupConversation').mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      conversation: {
        conversationId: '70001',
        conversationShortId: '70001',
        conversationType: 2,
        isGroup: true,
        name: '新群',
        ownerUid: '10001',
        lastMessageTime: 0,
        members: [{ uid: '10001', role: 1 }, { uid: '20002', role: 0 }],
      },
    });

    const group = await account.createGroup(['20002', '20002']);

    expect(createConversation).toHaveBeenCalledWith(['10001', '20002'], {});
    expect(group).toMatchObject({ groupId: '70001', name: '新群', ownerUid: '10001' });
    expect(group.pickMember('20002')).toBeDefined();
    expect(account.rememberGroup).toHaveBeenCalledWith(group);
  });
  it('refreshes a 90001 signal into one deduplicated actionable group request', async () => {
    const account = accountStub({
      cachedGroup: jest.fn(),
    });
    const onRequest = jest.fn();
    const assembler = new EventAssembler(account, {
      onMessage: jest.fn(),
      onRequest,
    }, account.uid ?? '10001');
    jest.spyOn(account.im, 'listGroupJoinRequests').mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      requests: [{
        requestId: '9001',
        applicantUid: '22',
        groupShortId: '70001',
        conversationType: 2,
        status: GroupJoinRequestStatus.PENDING,
        reason: '申请加入',
      }],
    });
    jest.spyOn(account.im, 'resolveUsers').mockResolvedValue([]);
    const signal = {
      type: 'group.join-request' as const,
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      requestId: '9001',
      content: '{"apply_id":"9001"}',
      raw: {},
    };

    assembler.receiveNotice(signal);
    assembler.receiveNotice(signal);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest.mock.calls[0]?.[0]).toMatchObject({
      type: 'group.join',
      requestId: '9001',
      applicantUid: '22',
      reason: '申请加入',
      isPending: true,
      account,
      group: { groupId: '70001' },
    });
  });

  it('binds member-increase notices to cached Group and Member objects', () => {
    const cachedGroup = jest.fn();
    const rememberGroup = jest.fn();
    const account = accountStub({ cachedGroup, rememberGroup });
    const onNotice = jest.fn((event: AnyNoticeEvent) => {
      if ('group' in event) expect(rememberGroup).toHaveBeenCalledWith(event.group);
    });
    const assembler = new EventAssembler(account, {
      onMessage: jest.fn(),
      onNotice,
    }, account.uid ?? '10001');
    const group = Group.bind(
      '70001',
      '70001',
      account,
      { members: [{ uid: '11', role: 2 }] },
    );
    cachedGroup.mockReturnValue(group);

    assembler.receiveNotice({
      type: 'group.member-increase',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      source: 'invite',
      operators: [{ uid: '11', nickname: '管理员' }],
      members: [{ uid: '22', nickname: '新成员' }],
      raw: {},
    });

    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({
      type: 'group.invite',
      account,
      group,
      member: group.pickMember('22'),
      operator: group.pickMember('11'),
      source: 'invite',
    }));
  });

  it('binds member-decrease notices and detaches the member before dispatch', () => {
    const cachedGroup = jest.fn();
    const account = accountStub({
      cachedGroup,
      uid: '10001',
      imUid: '10001',
    });
    const onNotice = jest.fn();
    const assembler = new EventAssembler(account, { onMessage: jest.fn(), onNotice }, account.uid ?? '10001');
    const group = Group.bind(
      '70001',
      '70001',
      account,
      { members: [{ uid: '11', role: 2 }, { uid: '22', role: 0 }] },
    );
    const removed = group.pickMember('22');
    cachedGroup.mockReturnValue(group);

    assembler.receiveNotice({
      type: 'group.member-decrease',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      source: 'kick',
      operators: [{ uid: '11' }],
      members: [{ uid: '22' }],
      raw: {},
    });

    expect(group.pickMember('22')).toBeUndefined();
    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({
      type: 'group.member-decrease',
      group,
      member: removed,
      operator: group.pickMember('11'),
      source: 'kick',
    }));
  });

  it('projects mark-read syncs onto their Friend or Group object', () => {
    const cachedGroup = jest.fn();
    const account = accountStub({
      cachedGroup,
      cachedFriend: jest.fn(),
      cachedFriendByThreadId: jest.fn(),
      uid: 'sender-uid',
      imUid: '10001',
    });
    const onNotice = jest.fn();
    const assembler = new EventAssembler(account, { onMessage: jest.fn(), onNotice }, account.uid ?? '10001');
    const group = Group.bind('70001', '70001', account);
    cachedGroup.mockReturnValue(group);

    assembler.receiveNotice({
      type: 'conversation.read',
      conversationId: '0:1:10001:20002',
      conversationType: 1,
      readMessageIndex: '12',
      readMessageIndexV2: '34',
      raw: {},
    });
    assembler.receiveNotice({
      type: 'conversation.read',
      conversationId: '70001',
      conversationType: 2,
      readMessageIndex: '56',
      readMessageIndexV2: '78',
      raw: {},
    });

    expect(onNotice.mock.calls[0]?.[0]).toMatchObject({
      type: 'friend.marked-read',
      friend: { uid: '20002', threadId: '0:1:10001:20002' },
      readMessageIndexV2: '34',
    });
    expect(onNotice.mock.calls[1]?.[0]).toMatchObject({
      type: 'group.marked-read',
      group,
      readMessageIndexV2: '78',
    });
  });

  it('updates group metadata and member role before dispatching group notices', () => {
    const cachedGroup = jest.fn();
    const account = accountStub({ cachedGroup });
    const onNotice = jest.fn();
    const assembler = new EventAssembler(account, { onMessage: jest.fn(), onNotice }, account.uid ?? '10001');
    const group = Group.bind('70001', '70001', account, {
      name: '旧群名',
      avatar: 'old.webp',
      members: [{ uid: '11', role: 1 }, { uid: '22', role: 0 }],
    });
    cachedGroup.mockReturnValue(group);

    assembler.receiveNotice({
      type: 'group.admin',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      members: [{ uid: '22' }],
      operators: [{ uid: '11' }],
      enabled: true,
      raw: {},
    });
    assembler.receiveNotice({
      type: 'group.name-change',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      name: '新群名',
      operators: [{ uid: '11' }],
      raw: {},
    });
    assembler.receiveNotice({
      type: 'group.avatar-change',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      avatar: 'new.webp',
      operators: [{ uid: '11' }],
      raw: {},
    });

    expect(group.pickMember('22')).toMatchObject({ role: 2, isAdmin: true });
    expect(group).toMatchObject({ name: '新群名', avatar: 'new.webp' });
    expect(onNotice.mock.calls.map(([event]) => event.type)).toEqual([
      'group.admin', 'group.name-change', 'group.avatar-change',
    ]);
    expect(onNotice.mock.calls[0]?.[0]).toMatchObject({
      member: group.pickMember('22'),
      operator: group.pickMember('11'),
    });
  });

  it('projects cmd508 directly as a non-actionable friend request notice', () => {
    const account = accountStub();
    const onNotice = jest.fn();
    const assembler = new EventAssembler(account, { onMessage: jest.fn(), onNotice }, account.uid ?? '10001');
    const signal = {
      type: 'friend.add-request' as const,
      applicantUid: '22',
      fromUid: '22',
      toUid: '10001',
      content: '认识一下',
      ext: { source: 'cmd508' },
      raw: {},
    };

    assembler.receiveNotice(signal);

    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({
      type: 'friend.add-request',
      applicantUid: '22',
      fromUid: '22',
      toUid: '10001',
      content: '认识一下',
      ext: { source: 'cmd508' },
      account,
    }));
  });
});
