import { buildCollectedStickerContent, buildEmojiContent, parseMessageContent, isCollectedStickerEnabled } from './content.js';
import { ApiConnection } from '../../desktop/api-connection.js';
import { OutboundSender } from '../../sdk/messaging/outbound.js';
import { segment, messageBrief } from '../../sdk/messaging/message.js';

const sticker = {
  id: '9007199254740993123', animate_type: 2, origin_package_id: '9007199254740993124',
  width: 180, height: 200,
  animate_url: { uri: 'animated-uri', url_list: ['https://example.invalid/animated.webp'] },
  static_url: { uri: 'static-uri', url_list: ['https://example.invalid/static.png'] },
};

describe('Desktop collected sticker message content', () => {
  it.each([0, '0', '', '  ', false, 1, '1', true, null, undefined])('uses the source scalar equality for group setting %j', value => {
    // Source selector Ge.XU uses loose equality; production must retain these scalar distinctions.
    expect(isCollectedStickerEnabled(value)).toBe(value == 0);
  });

  it('maps a server collection record to 501 with exact source field order and string ID types', () => {
    expect(buildCollectedStickerContent(sticker)).toBe(JSON.stringify({
      display_name: '', height: 200, width: 180, image_id: sticker.id, image_type: 2,
      package_id: sticker.origin_package_id, show_notice: false, resource_type: 0,
      updateConversationTime: true, createdAt: 0, is_card: false, msgHint: '', aweType: 501,
      url: { height: 0, data_size: 0, uri: 'animated-uri', url_list: sticker.animate_url.url_list, width: 0 },
    }));
    expect(parseMessageContent(buildCollectedStickerContent(sticker))).toMatchObject({ kind: 'emoji', aweType: 501, url: 'animated-uri' });
  });

  it('falls back URL fields separately and retains explicit empty values', () => {
    const partial = JSON.parse(buildCollectedStickerContent({ ...sticker, animate_url: { uri: '', url_list: null } }));
    expect(partial.url).toMatchObject({ uri: '', url_list: sticker.static_url.url_list });
    const other = JSON.parse(buildCollectedStickerContent({ ...sticker, animate_url: { uri: null, url_list: [] } }));
    expect(other.url).toMatchObject({ uri: 'static-uri', url_list: [] });
  });

  it('keeps numeric IDs numeric, uses zero size defaults and omits absent image/package/url metadata', () => {
    const value = JSON.parse(buildCollectedStickerContent({ id: 12, width: null }));
    expect(value).toMatchObject({ image_id: 12, width: 0, height: 0, aweType: 501, resource_type: 0 });
    expect(value).not.toHaveProperty('image_type');
    expect(value).not.toHaveProperty('package_id');
    expect(value.url).toEqual({ height: 0, data_size: 0, width: 0 });
  });

  it('does not copy unrelated entity metadata into the outgoing message', () => {
    const content = buildCollectedStickerContent({ ...sticker, secret: 'must-not-copy', status_code: 0, extra: { another: 1 } });
    expect(content).not.toContain('must-not-copy');
    expect(JSON.parse(content)).not.toHaveProperty('extra');
    expect(messageBrief(segment.sticker(sticker))).toBe('[收藏表情]');
  });

  it.each([{}, { id: '' }, { id: Number('9007199254740993123') }, { id: null }, { id: false }])('rejects missing/rounded IDs instead of inventing an image_id: %j', value => {
    expect(() => buildCollectedStickerContent(value)).toThrow('lossless platform ID');
  });

  it('does not rewrite the independent URL emoji route to the collection route', () => {
    expect(JSON.parse(buildEmojiContent({ url: 'https://example.invalid/a.gif' }))).toMatchObject({ aweType: 507, resource_type: 4, image_id: 0 });
  });
});

describe('Desktop collected sticker outbound routing', () => {
  it.each([1, 2])('uses existing HTTP messageType 5 for conversation type %i without uploading', async conversationType => {
    const onMessage = jest.fn();
    const sender = new OutboundSender(new ApiConnection(), { deviceId: 'did', platformUid: '11', getStickerEnabledStatus: () => 0, onMessage });
    const send = jest.spyOn(sender.imService, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '99' });
    const upload = jest.spyOn(sender.imService, 'uploadImage');
    await sender.sendMessage({ threadId: 'thread', conversationShortId: '50', conversationType, inboxType: 1, message: segment.sticker(sticker) });
    expect(send).toHaveBeenCalledWith({ threadId: 'thread', conversationShortId: '50', conversationType, inboxType: 1,
      content: buildCollectedStickerContent(sticker), msgType: 5 });
    expect(upload).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ msgType: 5, content: buildCollectedStickerContent(sticker) }));
  });

  it('reads the live account setting at each send, blocking unknown/disabled groups but not private sends', async () => {
    let enabled: number | undefined;
    const sender = new OutboundSender(new ApiConnection(), { getStickerEnabledStatus: () => enabled });
    const send = jest.spyOn(sender.imService, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '1' });
    const options = { threadId: 'group', conversationShortId: '50', conversationType: 2, message: segment.sticker(sticker) };
    await expect(sender.sendMessage(options)).rejects.toThrow('尚未允许');
    enabled = 1;
    await expect(sender.sendMessage(options)).rejects.toThrow('尚未允许');
    expect(send).not.toHaveBeenCalled();
    enabled = 0;
    await sender.sendMessage(options);
    enabled = 1;
    await sender.sendMessage({ ...options, conversationType: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('has no fallback upload, alternate emoji type or automatic retry on send rejection', async () => {
    const sender = new OutboundSender(new ApiConnection());
    const send = jest.spyOn(sender.imService, 'send').mockRejectedValue(new Error('unknown delivery'));
    await expect(sender.sendMessage({ threadId: 'friend', conversationShortId: '50', message: segment.sticker(sticker) })).rejects.toThrow('unknown delivery');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
