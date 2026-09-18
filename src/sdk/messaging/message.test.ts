import { ApiConnection } from '../../desktop/api-connection.js';
import { OutboundSender } from './outbound.js';
import { messageBrief, prepareTextMessage, segment } from './message.js';

describe('oicq-style text segments', () => {
  it('composes text and @ segments with desktop rich text offsets', () => {
    expect(prepareTextMessage([
      segment.text('你好 '),
      segment.at({ uid: '3138463854771706', displayName: '归雨' }),
      ' ping',
    ])).toEqual({
      text: '你好 @归雨 ping',
      mentions: [{
        uid: '3138463854771706', text: '@归雨', location: 3, length: 3,
      }],
    });
  });

  it('builds compact human-readable log briefs without payload data', () => {
    expect(messageBrief([segment.at('3138463854771706', '归雨'), '  ping\nnow']))
      .toBe('@归雨 ping now');
    expect(messageBrief(segment.image(Buffer.from('binary')))).toBe('[图片]');
    expect(messageBrief(segment.file(Buffer.from('report'), 'report.pdf'))).toBe('[文件] report.pdf');
  });

  it('passes mention metadata to Desktop HTTP send', async () => {
    const sender = new OutboundSender(new ApiConnection());
    const send = jest.spyOn(sender.imService, 'send')
      .mockResolvedValue({ statusCode: 0, statusMsg: 'OK', serverMessageId: '1' });

    await sender.sendMessage({
      threadId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      message: [segment.at('3138463854771706', '归雨'), ' ping'],
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      mentionedUsers: ['3138463854771706'],
      content: expect.stringContaining('richTextInfos'),
    }));
  });

  it('uses the desktop Cookie route for consecutive private and group text messages', async () => {
    const onMessage = jest.fn();
    const sender = new OutboundSender(new ApiConnection(), {
      deviceId: '3241234567',
      platformUid: '12',
      onMessage,
    });
    const send = jest.spyOn(sender.imService, 'send').mockResolvedValue({
      statusCode: 0,
      statusMsg: 'OK',
      serverMessageId: '1',
    });

    await sender.sendText({
      threadId: '0:1:12:34', conversationShortId: '77', conversationType: 1, text: 'private',
    });
    await sender.sendText({
      threadId: '70001', conversationShortId: '70001', conversationType: 2, text: 'group',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([request]) => request.content)).toEqual([
      JSON.stringify({ aweType: 700, type: 0, richTextInfos: [], text: 'private' }),
      JSON.stringify({ aweType: 700, type: 0, richTextInfos: [], text: 'group' }),
    ]);
    expect(onMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      msgId: '1', threadId: '0:1:12:34', senderUid: '12', msgType: 7,
    }));
    expect(onMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      msgId: '1', threadId: '70001', senderUid: '12', msgType: 7,
    }));
  });

  it('enforces the same text boundaries as the desktop composer', async () => {
    const sender = new OutboundSender(new ApiConnection(), { deviceId: '3241234567' });
    const send = jest.spyOn(sender.imService, 'send');

    await expect(sender.sendText({
      threadId: '0:1:12:34', conversationShortId: '77', text: ' \n\t ',
    })).rejects.toThrow('不能发送空白消息');
    await expect(sender.sendText({
      threadId: '0:1:12:34', conversationShortId: '77', text: 'a'.repeat(16_001),
    })).rejects.toThrow('消息太长');
    await expect(sender.sendMessage({
      threadId: '0:1:12:34', conversationShortId: '77',
      message: segment.reply({
        text: ' ', referencedMessageId: '88', referencedMessageType: 7,
        referencedUid: '34', referencedText: 'source',
      }),
    })).rejects.toThrow('不能发送空白消息');
    expect(send).not.toHaveBeenCalled();
  });
});
