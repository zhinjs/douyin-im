import { hasDesktopConversationRisk, readDesktopConversationRisk } from './conversation-risk.js';
import { ApiConnection } from '../../desktop/api-connection.js';
import { OutboundSender } from '../../sdk/messaging/outbound.js';
import { segment, type SendableMessage } from '../../sdk/messaging/message.js';

const riskExt = { 'a:sky_eye_dialog': '{"title":"risk"}' };

describe('Desktop conversation risk selection', () => {
  it.each([
    [undefined, undefined, undefined, false], ['', '', undefined, false], ['[]', '', undefined, false],
    ['[]', '{"single":1}', { single: 1 }, true], ['[{"list":1}]', '{"single":1}', { list: 1 }, true],
    ['[{}, {"list":1}]', '{"single":1}', {}, false], ['[null]', '{"single":1}', null, false],
    ['[false]', '{"single":1}', false, false], ['[1]', '', 1, false], ['[true]', '', true, false],
    ['[""]', '', '', false], ['["risk"]', '', 'risk', true], ['[[]]', '', [], false], ['[[0]]', '', [0], true],
    ['', '{}', {}, false], ['', 'null', undefined, false], ['', 'false', undefined, false], ['', '0', undefined, false],
    ['', 'true', true, false], ['', '1', 1, false], ['', '"risk"', 'risk', true], ['', '[]', [], false],
    ['"😀risk"', '', '😀', true], ['""', '{"single":1}', { single: 1 }, true],
    ['', '{"__proto__":1}', JSON.parse('{"__proto__":1}'), true],
  ])('preserves first-entry and JSON isEmpty semantics for list=%s single=%s', (list, single, expected, blocked) => {
    const ext = { ...(list !== undefined ? { 'a:sky_eye_dialog_list': list } : {}),
      ...(single !== undefined ? { 'a:sky_eye_dialog': single } : {}) } as Record<string, string>;
    expect(readDesktopConversationRisk(ext)).toEqual(expected);
    expect(hasDesktopConversationRisk(ext)).toBe(blocked);
  });

  it.each(['{', 'undefined', 'null', '{}', '0', 'false'])('does not silently allow malformed/non-iterable list %s', list => {
    expect(() => hasDesktopConversationRisk({ 'a:sky_eye_dialog_list': list })).toThrow();
  });

  it('parses both fields before list spread and never hides an invalid legacy entry behind a valid list', () => {
    expect(() => readDesktopConversationRisk({ 'a:sky_eye_dialog_list': 'null', 'a:sky_eye_dialog': '{' })).toThrow(SyntaxError);
    expect(() => readDesktopConversationRisk({ 'a:sky_eye_dialog_list': '[{}]', 'a:sky_eye_dialog': '{' })).toThrow(SyntaxError);
    expect(hasDesktopConversationRisk()).toBe(false);
  });
});

describe('Desktop risk gate outbound scope', () => {
  const messages: SendableMessage[] = ['text', [segment.at('12', 'name'), segment.text('hello')],
    segment.reply({ text: 'reply', referencedMessageId: '90', referencedUid: '12', referencedMessageType: 7 }),
    segment.emoji({ url: 'https://example.invalid/e.webp' }), segment.sticker({ id: '20' })];

  it.each(messages.map((message, index) => ({ message, index })))('blocks source-backed send entry $index before a request', async ({ message }) => {
    const sender = new OutboundSender(new ApiConnection(), { getConversationSettingExt: () => riskExt, getStickerEnabledStatus: () => 0 });
    const send = jest.spyOn(sender.imService, 'send');
    const upload = jest.spyOn(sender.imService, 'uploadImage');
    await expect(sender.sendMessage({ threadId: 't', conversationShortId: '1', conversationType: 2, message })).rejects.toThrow('当前会话存在风险');
    expect(send).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('uses the current conversation setting at each send, not a global/constructed snapshot', async () => {
    const ext = new Map<string, Record<string, string>>([['t', riskExt]]);
    const sender = new OutboundSender(new ApiConnection(), { getConversationSettingExt: id => ext.get(id) });
    const send = jest.spyOn(sender.imService, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '' });
    const opts = { threadId: 't', conversationShortId: '1', text: 'hello' };
    await expect(sender.sendText(opts)).rejects.toThrow('当前会话存在风险');
    await sender.sendText({ ...opts, threadId: 'other' });
    ext.set('t', { 'a:sky_eye_dialog_list': '[{}]', ...riskExt });
    await sender.sendText(opts);
    ext.set('t', { 'a:sky_eye_dialog_list': '{' });
    await expect(sender.sendText(opts)).rejects.toThrow(SyntaxError);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not turn an input-panel gate into a universal forward/card/media transport gate', async () => {
    const read = jest.fn(() => riskExt);
    const sender = new OutboundSender(new ApiConnection(), { getConversationSettingExt: read });
    const send = jest.spyOn(sender.imService, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '' });
    const opts = { threadId: 't', conversationShortId: '1' };
    await sender.forwardMessage({ ...opts, content: '{"aweType":501}', messageType: 5, serverMessageId: '90' });
    await sender.sendMessage({ ...opts, message: segment.image({ oid: 'o', skey: 's', md5: 'm', dataSize: 1, width: 1, height: 1 }) });
    await sender.sendMessage({ ...opts, message: segment.link({ url: 'https://example.invalid', title: 'title' }) });
    expect(read).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
