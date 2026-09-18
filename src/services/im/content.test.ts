import {
  buildEmojiContent,
  buildDesktopTextContent,
  buildImageContent,
  buildReplyPayload,
  isMessageDelivered,
  normalizeDesktopTextMessageContent,
  parseMessageContent,
  parseSendMessageResponse,
} from './content.js';

describe('IM rich message content', () => {
  it('matches Douyin Chat desktop text JSON exactly', () => {
    expect(buildDesktopTextContent('qwq')).toBe(
      '{"aweType":700,"type":0,"richTextInfos":[],"text":"qwq"}',
    );
  });

  it('encodes and parses desktop clickable mentions with UTF-16 locations', () => {
    const content = buildDesktopTextContent('你好 @成员 ok', [{
      uid: '9007199254740993', text: '@成员', location: 3, length: 3,
    }]);

    expect(JSON.parse(content)).toMatchObject({
      richTextInfos: [{
        infoType: 1,
        location: 3,
        length: 3,
        info: { uid: '9007199254740993' },
      }],
    });
    expect(parseMessageContent(content)).toMatchObject({
      kind: 'text',
      mentions: [{ uid: '9007199254740993', text: '@成员', location: 3, length: 3 }],
    });
  });

  it('round-trips an image asset into a typed resource', () => {
    const content = buildImageContent({
      oid: 'tos/object', skey: 'secret', md5: 'abc', dataSize: 12, width: 640, height: 480,
    });
    expect(parseMessageContent(content)).toMatchObject({
      kind: 'image', aweType: 2702,
      image: { oid: 'tos/object', skey: 'secret', width: 640, height: 480 },
    });
    expect(JSON.parse(content)).toMatchObject({ from_gallery: 1 });
  });

  it('uses the desktop GIF aweType for GIF uploads', () => {
    const content = buildImageContent({
      oid: 'tos/gif', skey: 'secret', md5: 'gif-md5', dataSize: 12,
      width: 1, height: 1, format: 'gif',
    });

    expect(JSON.parse(content)).toMatchObject({ aweType: 2703, cover_width: 1, cover_height: 1 });
  });

  it('builds emoji and a desktop-compatible quoted reply payload', () => {
    const emojiContent = buildEmojiContent({ url: 'https://example.test/e.png' });
    expect(parseMessageContent(emojiContent)).toMatchObject({
      kind: 'emoji', url: 'https://example.test/e.png', aweType: 507,
    });
    expect(JSON.parse(emojiContent)).toMatchObject({ url: { height: 0, width: 0, data_size: 0 } });
    const options = {
      text: '收到',
      referencedMessageId: '9988',
      referencedMessageType: 7,
      referencedUid: '42',
      referencedSecUid: 'MS4ref',
      referencedText: '在吗',
    };
    expect(buildReplyPayload(options)).toEqual({
      content: '{"aweType":700,"type":0,"richTextInfos":[],"text":"收到"}',
      reference: {
        referencedMessageId: '9988',
        hint:
          '{"refmsg_type":7,"content":"在吗","refmsg_uid":"42","refmsg_sec_uid":"MS4ref",' +
          '"nickname":"","refmsg_content":"","version":0,"itemId":"","scene_type":0,"is_edit":false}',
      },
    });
  });

  it('keeps desktop rich-text mentions while normalizing old plain text', () => {
    const current = buildDesktopTextContent('@归雨 hi', [{
      uid: '42', text: '@归雨', location: 0, length: 3,
    }]);
    expect(normalizeDesktopTextMessageContent(current, 7)).toBe(current);
    expect(JSON.parse(normalizeDesktopTextMessageContent('{"text":"hi","aweType":774}', 7)))
      .toEqual({ aweType: 700, type: 0, richTextInfos: [], text: 'hi' });
  });

  it('does not report serverMessageId=0 as a successful receipt', () => {
    const result = parseSendMessageResponse({
      statusCode: 0,
      errorDesc: 'OK',
      body: { sendMessageBody: { status: 0, serverMessageId: '0' } },
    }, 'client-id');
    expect(result).toMatchObject({ statusCode: -3, serverMessageId: '0' });
    expect(isMessageDelivered(result)).toBe(false);
  });

  it('keeps a protobuf check code when the server omits check_message', () => {
    expect(parseSendMessageResponse({
      statusCode: 0,
      errorDesc: 'OK',
      body: { sendMessageBody: { status: 3, serverMessageId: '0', checkCode: 7523 } },
    }, 'client-id')).toMatchObject({
      statusCode: 3,
      serverMessageId: '0',
      checkCode: 7523,
      statusMsg: 'content audit code=7523',
    });
  });
});
