import protobuf from 'protobufjs';
import { decodeResponseRaw } from './codec.js';
import { mapProtoMessage } from './mappers.js';
import { pushFromResponse } from './ws-client.js';
import { inboundFromPush, inboundFromThread } from '../../base/raw/inbound-message.js';
import { latestMessageProperty, LATEST_MESSAGE_PROPERTY_KEY, readConversationPropertyInfo, serializeConversationPropertyInfo } from './message-property.js';
import type { PrivateMessage } from './types.js';

const property = (uid: string, createTime: string) => ({ uid, createTime, secUid: '', value: '', idempotentId: '' });
const selfMessage: PrivateMessage = { threadId: '700', msgId: '1', clientMessageId: 'CLIENT', senderUid: '11',
  msgType: 7, content: 'body', createTime: 1000, status: 0 };

describe('Desktop message properties', () => {
  it('preserves field15/Items through protobuf, history mapping and realtime inbound mapping', async () => {
    const root = await protobuf.load('src/services/im/proto/im.proto');
    const type = root.lookupType('im_proto.Response');
    const raw = { conversationId: '700', conversationShortId: '700', conversationType: 2, sender: '11', serverMessageId: '1',
      messageType: 7, content: 'body', propertyList: { 'se:test': { Items: [{ uid: '9007199254740993', createTime: '9007199254740995', secUid: 'sec', value: 'v', idempotentId: 'id' }] },
        'se:empty': { Items: [] } } };
    const decoded = await decodeResponseRaw(type.encode(type.create({ cmd: 500, body: { hasNewMessageNotify: { message: raw } } })).finish());
    const push = pushFromResponse(500, decoded)!;
    const expected = { 'se:test': [{ uid: '9007199254740993', createTime: '9007199254740995', secUid: 'sec', value: 'v', idempotentId: 'id' }], 'se:empty': [] };
    expect(push.propertyList).toEqual(expected);
    expect(inboundFromPush(push)!.propertyList).toEqual(expected);
    const mapped = mapProtoMessage(raw);
    expect(mapped.propertyList).toEqual(expected);
    expect(inboundFromThread({ threadId: '700', peer: { uid: '11', nickname: '' }, unreadCount: 0, updateTime: 0 }, mapped)!.propertyList).toEqual(expected);
    expect(mapProtoMessage({ ...raw, propertyList: {} }).propertyList).toEqual({});
  });

  it('selects only se: keys and non-self users with native key/list tie order', () => {
    const message = { ...selfMessage, propertyList: { 'se:z': [property('22', '8')], 'se:a': [property('33', '8'), property('44', '8'), property('11', '999')],
      'other:se:': [property('55', '999')], 'SE:': [property('55', '999')] } };
    expect(latestMessageProperty(message, '11')).toEqual({ clientId: 'client', sender: '33', emoji: 'a', createdAt: '8', markRead: false });
    message.propertyList['se:z'].push(property('55', '9'));
    expect(latestMessageProperty(message, '11')).toMatchObject({ emoji: 'z', sender: '55', createdAt: '9' });
    expect(latestMessageProperty({ ...selfMessage, propertyList: { 'se:': [property('22', '1')] } }, '11').emoji).toBe('');
    expect(latestMessageProperty({ ...selfMessage, propertyList: { 'se:se:x': [property('22', '1')] } }, '11').emoji).toBe('se:x');
    expect(latestMessageProperty({ ...selfMessage, propertyList: { 'se:a': [property('11', '9')] } }, '11'))
      .toEqual({ clientId: '', sender: '', emoji: '', createdAt: '0', markRead: false });
  });

  it('persists native numeric createdAt without rounding or accepting partial malformed local JSON', () => {
    const info = { clientId: 'quote"', sender: '9007199254740993', emoji: '😊', createdAt: '9007199254740995', markRead: true };
    const json = serializeConversationPropertyInfo(info);
    expect(json).toContain('"createdAt":9007199254740995');
    expect(readConversationPropertyInfo({ [LATEST_MESSAGE_PROPERTY_KEY]: json })).toEqual(info);
    for (const invalid of ['{}', '{', json.replace('true', '"true"'), json.replace('9007199254740995', '"9007199254740995"')]) {
      expect(readConversationPropertyInfo({ [LATEST_MESSAGE_PROPERTY_KEY]: invalid })).toEqual({ clientId: '', sender: '', emoji: '', createdAt: '0', markRead: false });
    }
  });
});
