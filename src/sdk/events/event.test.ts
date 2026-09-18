import type { Account } from '../account.js';
import { Client } from '../client.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inboundFromPush } from '../../base/raw/inbound-message.js';
import { MessageEvent, PrivateMessageEvent, GroupMessageEvent, StrangerMessageEvent } from './message.js';
import { EventAssembler } from './assembler.js';

let dataDir: string;
let account: Account;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'douyin-im-event-'));
  account = new Client({ dataDir, autoLoad: false }).createAccount();
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SDK event roots', () => {
  it.each([true, false])('uses explicit stranger-box state %s even when contact caches disagree', isInStrangerBox => {
    const threadId = '0:1:10001:20002';
    account.rememberFriend(account.bindFriend('20002', threadId, '90001'));
    account.rememberStranger(account.bindStranger('20002', threadId, '90001'));
    jest.spyOn(account, 'cachedConversation').mockReturnValue({
      conversationId: threadId, conversationShortId: '90001', conversationType: 1,
      inboxType: 1, isGroup: false, name: '', members: [], lastMessageTime: 0, isInStrangerBox,
    });
    const event = MessageEvent.fromInbound({ threadId, conversationShortId: '90001', conversationType: 1,
      inboxType: 1, senderUid: '20002', text: 'foo', rawContent: 'foo', messageType: 7, raw: {} }, account);
    expect(event).toBeInstanceOf(isInStrangerBox ? StrangerMessageEvent : PrivateMessageEvent);
  });

  it('does not infer stranger-box membership from desktop inbox 1 before contacts are loaded', () => {
    const event = MessageEvent.fromInbound({ threadId: '0:1:10001:20002', conversationShortId: '90001',
      conversationType: 1, inboxType: 1, senderUid: '20002', text: 'foo', rawContent: 'foo', messageType: 7, raw: {} }, account);
    expect(event).toBeInstanceOf(PrivateMessageEvent);
  });

  it('dispatches desktop inbox 1 messages from a loaded friend as private events with the cached name', () => {
    const friend = account.bindFriend('20002', '0:1:10001:20002', '90001', { nickname: '凉菜' });
    account.rememberFriend(friend);
    const onMessage = jest.fn();
    new EventAssembler(account, { onMessage }, '10001').receiveMessage({
      threadId: friend.threadId, conversationShortId: '90001', conversationType: 1, inboxType: 1,
      senderUid: '20002', text: 'foo', rawContent: 'foo', messageType: 7, raw: {},
    });
    const event = onMessage.mock.calls[0]![0];
    expect(event).toBeInstanceOf(PrivateMessageEvent);
    expect(event.friend).toBe(friend);
    expect(event.friend.nickname).toBe('凉菜');
    expect(account.sl.has('20002')).toBe(false);
  });

  it.each(['private', 'stranger', 'group'] as const)('deletes a %s message locally through its owning account', kind => {
    const remove = jest.spyOn(account, 'deleteCachedMessageByClientId').mockReturnValue(true);
    const inbound = { threadId: kind === 'group' ? '70001' : '0:1:10001:20002', conversationShortId: '90001',
      conversationType: kind === 'group' ? 2 : 1, inboxType: kind === 'stranger' ? 1 : 0,
      senderUid: '20002', text: 'hello', rawContent: 'hello', messageType: 7, raw: {} };
    jest.spyOn(account, 'cachedConversation').mockReturnValue({ conversationId: inbound.threadId, conversationShortId: '90001',
      conversationType: inbound.conversationType, isGroup: kind === 'group', isInStrangerBox: kind === 'stranger',
      name: '', members: [], lastMessageTime: 0 });
    const lookup = jest.spyOn(account, 'cachedMessage').mockReturnValue({ msgId: '99', clientMessageId: 'client',
      threadId: inbound.threadId, senderUid: '20002', content: 'hello', msgType: 7, createTime: 1, status: 0 });
    const event = MessageEvent.fromInbound({ ...inbound, serverMessageId: '99' }, account);
    expect(event.deleteLocal()).toBe(true);
    expect(remove).toHaveBeenCalledWith(inbound.threadId, 'client', false);
    expect(MessageEvent.fromInbound({ ...inbound, clientMessageId: 'client' }, account).deleteLocal()).toBe(true);
    expect(lookup).toHaveBeenLastCalledWith(inbound.threadId, 'client', 'client');
    remove.mockReturnValue(false);
    expect(event.deleteLocal()).toBe(false);
    expect(() => MessageEvent.fromInbound(inbound, account).deleteLocal()).toThrow('no server message id');
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it.each([1, 2] as const)('binds message privacy to its account and raw timestamp for conversation type %i', async conversationType => {
    const get = jest.spyOn(account, 'getMessageReadPrivacy').mockResolvedValue({ statusCode: 0, statusMsg: '', messages: [] });
    const event = MessageEvent.fromInbound({
      threadId: conversationType === 2 ? '70001' : '0:1:10001:20002', conversationShortId: '90001', conversationType,
      senderUid: '20002', text: 'hello', rawContent: '{"text":"hello"}', messageType: 7,
      serverMessageId: '9007199254740993', createTime: '1789123456789', raw: {},
    }, account);
    expect(event.time).toBe(1789123456);
    await event.getReadPrivacy();
    expect(get).toHaveBeenCalledWith([{ serverMessageId: '9007199254740993', conversationId: event.threadId,
      conversationShortId: '90001', conversationType, createTime: 1789123456789 }], false);
  });

  it.each(['private', 'stranger', 'group'] as const)('reuses %s contacts and merges event metadata before dispatch', (kind) => {
    const threadId = kind === 'group' ? '70001' : '0:1:10001:20002';
    const contact = kind === 'group'
      ? account.bindGroup(threadId, '90001', { name: '测试群', members: [{ uid: '20002', role: 2 }] })
      : kind === 'private'
        ? account.bindFriend('20002', threadId, '90001', { nickname: '好友' })
        : account.bindStranger('20002', threadId, '90001', { nickname: '陌生人' });
    if (kind === 'group') account.rememberGroup(contact as ReturnType<typeof account.bindGroup>);
    else if (kind === 'private') account.rememberFriend(contact as ReturnType<typeof account.bindFriend>);
    else account.rememberStranger(contact as ReturnType<typeof account.bindStranger>);
    const onMessage = jest.fn((event: MessageEvent) => {
      const cached = kind === 'group' ? account.gl.get(threadId)
        : kind === 'private' ? account.fl.get('20002') : account.sl.get('20002');
      expect(cached).toBe(contact);
      if (event instanceof PrivateMessageEvent) expect(event.friend).toBe(contact);
      else if (event instanceof GroupMessageEvent) expect(event.group).toBe(contact);
      else if (event instanceof StrangerMessageEvent) expect(event.stranger).toBe(contact);
      else throw new Error('unexpected message category');
    });
    const assembler = new EventAssembler(account, { onMessage }, '10001');
    const raw = {
      threadId, conversationShortId: '90001', conversationType: kind === 'group' ? 2 as const : 1 as const,
      inboxType: kind === 'stranger' ? 1 : 0,
      senderUid: '20002', senderSecUid: 'sec-new', text: 'hi', rawContent: '{"text":"hi"}',
      messageType: 7, raw: {},
    };
    assembler.receiveMessage(raw);
    assembler.receiveMessage(raw);
    expect(onMessage).toHaveBeenCalledTimes(2);
    if (kind === 'group') {
      expect(account.gl.get(threadId)?.pickMember('20002')).toMatchObject({ role: 2, secUid: 'sec-new' });
    } else {
      expect(contact).toMatchObject({ secUid: 'sec-new', nickname: kind === 'private' ? '好友' : '陌生人' });
    }
  });

  it('preserves raw message context and normalizes its timestamp', () => {
    const raw = { createTime: '1720000000000' };
    const inbound = inboundFromPush({
      cmd: 500,
      conversationId: '0:1:10001:20002',
      conversationShortId: '90001',
      conversationType: 1,
      senderUid: '20002',
      content: JSON.stringify({ text: 'hello' }),
      messageType: 7,
      raw,
    });
    if (!inbound) throw new Error('expected inbound message');

    const event = MessageEvent.fromInbound(inbound, account);

    expect(event).toBeInstanceOf(PrivateMessageEvent);
    expect(event).toMatchObject({
      postType: 'message',
      type: 'message.private',
      time: 1_720_000_000,
      raw,
      account,
    });
  });

  it('uses the normalized push createTime and exposes desktop delivery metadata', () => {
    const inbound = inboundFromPush({
      cmd: 500,
      conversationId: '0:1:10001:20002',
      conversationShortId: '90001',
      conversationType: 1,
      senderUid: '20002',
      content: JSON.stringify({ text: 'hello' }),
      messageType: 7,
      createTime: '1720000000000',
      clientMessageId: 'client-1',
      status: 0,
      version: '2',
      orderInConversation: '8',
      ext: { 's:client_message_id': 'client-1' },
      referenceInfo: {
        refMessageId: '88', hint: '{"content":"source"}',
        refMessageType: 7, refMessageStatus: 0,
      },
      raw: {},
    });
    if (!inbound) throw new Error('expected inbound message');

    const event = MessageEvent.fromInbound(inbound, account);

    expect(event).toMatchObject({
      time: 1_720_000_000,
      createTime: '1720000000000',
      clientMessageId: 'client-1',
      status: 0,
      version: '2',
      orderInConversation: '8',
      ext: { 's:client_message_id': 'client-1' },
      referenceInfo: { refMessageId: '88', refMessageType: 7 },
    });
  });

  it('projects rich text mentions and identifies the current account exactly', () => {
    Object.defineProperty(account, 'imUid', { value: '10001' });
    const inbound = inboundFromPush({
      cmd: 500,
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      senderUid: '20002',
      content: JSON.stringify({
        aweType: 700,
        text: '@机器人 ping',
        richTextInfos: [{
          infoType: 1, location: 0, length: 4, info: { uid: '10001' },
        }],
      }),
      messageType: 7,
      raw: {},
    });
    if (!inbound) throw new Error('expected inbound message');

    const event = MessageEvent.fromInbound(inbound, account);

    expect(event.isMentionMe).toBe(true);
    expect(event.mentions).toEqual([
      { uid: '10001', text: '@机器人', location: 0, length: 4 },
    ]);
    expect(Object.isFrozen(event.mentions)).toBe(true);
  });

});
