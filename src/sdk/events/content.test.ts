import type { Account } from '../account.js';
import { Client } from '../client.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inboundFromPush, inboundFromThread } from '../../base/raw/inbound-message.js';
import { MessageEvent } from './message.js';
import { Friend } from '../contacts/friend.js';

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

describe('rich content across receiver and account boundaries', () => {

  it.each([1, 2])('preserves voice and shared work types in conversation type %i', (conversationType) => {
    const threadId = conversationType === 2 ? '70001' : '0:1:10001:20002';
    for (const [messageType, value, kind] of [
      [17, { resource_url: { uri: 'voice', url_list: ['https://example.test/audio'] } }, 'audio'],
      [8, { itemId: '7391234567890123456' }, 'share'],
      [27, { resource_url: { origin_url_list: ['https://example.test/image'] } }, 'image'],
    ] as const) {
      const content = JSON.stringify(value);
      const push = inboundFromPush({
        cmd: 500, conversationId: threadId, conversationShortId: '90001', conversationType,
        senderUid: '20002', content, messageType, raw: {},
      });
      const poll = inboundFromThread({
        threadId, conversationShortId: '90001', conversationType,
        peer: { uid: '20002', nickname: '' }, unreadCount: 1, updateTime: 0,
      }, {
        msgId: '99', threadId, senderUid: '20002', content,
        msgType: messageType, createTime: 0, status: 0,
      });
      for (const inbound of [push, poll]) {
        if (!inbound) throw new Error('expected inbound message');
        const event = MessageEvent.fromInbound(inbound, account);
        expect(event.content.kind).toBe(kind);
        expect(event.messageType).toBe(messageType);
        expect(event.chatType).toBe(conversationType === 2 ? 'group' : 'private');
      }
    }
  });

  it('binds work and comment instances to the source account and conversation', async () => {
    const getSharedWorkDetails = jest.fn().mockResolvedValue([{
      workId: '7391234567890123456', filtered: false,
      detail: { video_control: { allow_download: true } },
    }]);
    const getSharedCommentStatuses = jest.fn().mockResolvedValue([{
      commentId: '7400000000000000001', isShown: true,
      raw: { comment_id: '7400000000000000001', is_show: true },
    }]);
    const richAccount = account;
    Object.defineProperty(richAccount, 'im', { value: { getSharedWorkDetails, getSharedCommentStatuses } });
    const inbound = inboundFromPush({
      cmd: 500,
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      senderUid: '20002',
      messageType: 105,
      content: JSON.stringify({
        itemId: '7391234567890123456',
        comment_id: '7400000000000000001',
        comment: '评论正文',
      }),
      raw: {},
    });
    if (!inbound) throw new Error('expected inbound message');

    const event = MessageEvent.fromInbound(inbound, richAccount);
    expect(event.work?.account).toBe(richAccount);
    expect(event.comment?.account).toBe(richAccount);
    await expect(event.work?.getAccess()).resolves.toMatchObject({
      workId: '7391234567890123456', canDownload: true,
    });
    await expect(event.comment?.getStatus()).resolves.toMatchObject({
      commentId: '7400000000000000001', isShown: true,
    });
    expect(getSharedWorkDetails).toHaveBeenCalledWith('70001', ['7391234567890123456']);
    expect(getSharedCommentStatuses).toHaveBeenCalledWith('70001', ['7400000000000000001']);
  });

  it('forwards through the target contact while retaining source message identity', async () => {
    const forwardMessage = jest.fn().mockResolvedValue({
      statusCode: 0, statusMsg: 'OK', serverMessageId: '101',
    });
    const forwardAccount = account;
    jest.spyOn(forwardAccount, 'online', 'get').mockReturnValue(true);
    Object.defineProperty(forwardAccount, 'outbound', { value: { forwardMessage } });
    const inbound = inboundFromPush({
      cmd: 500,
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      senderUid: '20002',
      serverMessageId: '99',
      messageType: 8,
      content: JSON.stringify({ itemId: '7391234567890123456' }),
      raw: {},
    });
    if (!inbound) throw new Error('expected inbound message');
    const event = MessageEvent.fromInbound(inbound, forwardAccount);
    const target = Friend.bind('30003', '0:1:10001:30003', '80001', forwardAccount);

    await event.forwardTo(target);

    expect(forwardMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationShortId: '80001',
      content: JSON.stringify({ itemId: '7391234567890123456' }),
      messageType: 8,
      serverMessageId: '99',
    }));
  });
});
