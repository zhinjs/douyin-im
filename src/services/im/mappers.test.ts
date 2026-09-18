import {
  isGroupConversationId,
  mapProtoConversationListItem,
  mapProtoConversationMeta,
  mapProtoMessage,
} from './mappers.js';
import protobuf from 'protobufjs';

describe('conversation list mapping', () => {
  it('preserves decoded setting and per-key versions independently, including lossless int64 and duplicate keys', async () => {
    const root = await protobuf.load('src/services/im/proto/im.proto');
    const type = root.lookupType('im_proto.ConversationInfoV2');
    const wire = type.encode(type.fromObject({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      conversationCoreInfo: { version: '123' },
      conversationSettingInfo: { settingVersion: '9007199254740993', version: '456',
        setTopTime: '9007199254740996', setFavoriteTime: '-1', readBadgeCount: 2147483647,
        ext: { 'a:sky_eye_dialog': '{"risk":1}' },
        extVersion: [{ key: 'a:sky_eye_dialog', version: '9007199254740995' },
          { key: 'duplicate', version: '99' }, { key: 'duplicate', version: '2' },
          { key: '__proto__', version: '3' }, { key: 'missing-version' }],
      },
    })).finish();
    const decoded = type.toObject(type.decode(wire), { longs: String, defaults: false });
    const mapped = mapProtoConversationListItem(decoded);
    expect(mapped.settingVersion).toBe('9007199254740993');
    expect(mapped).toMatchObject({ setTopTime: '9007199254740996', setFavoriteTime: '-1', readBadgeCount: 2147483647 });
    expect(mapped.settingExtVersions).toEqual(JSON.parse('{"a:sky_eye_dialog":"9007199254740995","duplicate":"2","__proto__":"3","missing-version":"0"}'));
    expect(mapped.settingExt).toEqual({ 'a:sky_eye_dialog': '{"risk":1}' });
    expect(Object.getPrototypeOf(mapped.settingExtVersions)).toBe(Object.prototype);
  });

  it('keeps missing version fields distinct from explicit zero and an empty per-key version list', () => {
    const missing = mapProtoConversationListItem({ conversationSettingInfo: { ext: {} } });
    expect(missing).not.toHaveProperty('settingVersion');
    expect(missing).not.toHaveProperty('settingExtVersions');
    expect(mapProtoConversationListItem({ conversationSettingInfo: { settingVersion: 0, extVersion: [] } }))
      .toMatchObject({ settingVersion: '0', settingExtVersions: {} });
  });
  it('maps cmd2006 ConversationInfoV2 without losing int64 strings', () => {
    const group = mapProtoConversationListItem({
      conversationId: '7681236801654178341',
      conversationShortId: '7681236801654178341',
      conversationType: 2,
      firstPageParticipants: { participants: [
        { userId: '1150530166719210', role: 1, secUid: 'MS4owner' },
        { userId: '3138463854771706', role: 0, secUid: 'MS4member' },
      ] },
      conversationCoreInfo: {
        name: '测试群', icon: 'https://example.com/group.jpeg', owner: '1150530166719210',
      },
      conversationSettingInfo: { mute: 0 },
    });

    expect(group).toMatchObject({
      conversationId: '7681236801654178341',
      conversationShortId: '7681236801654178341',
      conversationType: 2,
      isGroup: true,
      name: '测试群',
      ownerUid: '1150530166719210',
    });
    expect(group.members).toEqual(expect.arrayContaining([
      { uid: '1150530166719210', role: 1, secUid: 'MS4owner' },
    ]));
  });

  it('only treats all-digit conversation ids as implicit groups', () => {
    expect(isGroupConversationId('7681236801654178341')).toBe(true);
    expect(isGroupConversationId('0:1:12:34')).toBe(false);
  });

  it('maps nested core, setting and participant fields from the native descriptor', () => {
    const group = mapProtoConversationListItem({
      conversationId: '7423010390826582565',
      conversationShortId: '7423010390826582565',
      conversationType: 2,
      isParticipant: true,
      participantsCount: 4,
      badgeCount: 3,
      conversationCoreInfo: {
        name: '代理人研究', desc: 'desc', notice: 'notice', owner: '10', inboxType: 1,
      },
      conversationSettingInfo: { mute: 1, stickOnTop: 0, favorite: 1, readIndex: '8', ext: { 'a:cell_sort_time': '9007199254740993', ignored: 5 } },
      firstPageParticipants: {
        participants: [{
          userId: '20', secUid: 'sec20', alias: '群名片', role: 2,
          sortOrder: '7', blocked: 0, leftBlockTime: '0',
        }],
      },
    });

    expect(group).toMatchObject({
      conversationId: '7423010390826582565',
      conversationShortId: '7423010390826582565',
      name: '代理人研究', description: 'desc', notice: 'notice', ownerUid: '10',
      inboxType: 1, isParticipant: true, participantsCount: 4,
      badgeCount: 3, muted: true, pinned: false, favorite: true, lastMessageTime: 0,
      settingExt: { 'a:cell_sort_time': '9007199254740993' },
      members: [{ uid: '20', secUid: 'sec20', alias: '群名片', role: 2 }],
    });
  });

  it('keeps the peer secUid from cmd203 conversation members', () => {
    const thread = mapProtoConversationMeta({
      conversationId: '0:1:100:200',
      conversationShortId: '900',
      conversationType: 1,
      firstPageParticipants: { participants: [
        { userId: '100', role: 0, secUid: 'MS4self' },
        { userId: '200', role: 0, secUid: 'MS4peer', alias: 'peer' },
      ] },
    }, [], '100');

    expect(thread.peer).toEqual({ uid: '200', secUid: 'MS4peer', nickname: 'peer' });
  });

  it('preserves desktop message delivery and reference metadata', () => {
    const message = mapProtoMessage({
      conversationId: '0:1:12:34',
      conversationShortId: '77',
      conversationType: 1,
      serverMessageId: '99',
      sender: '34',
      content: '{"text":"reply"}',
      messageType: 7,
      createTime: '1000',
      status: 0,
      version: '3',
      orderInConversation: '8',
      indexInConversation: '9',
      indexInConversationV2: '10',
      ext: { 's:client_message_id': 'client-1', ignored: 12 },
      referenceInfo: {
        referencedMessageId: '88', hint: '{"content":"source"}', refMessageType: '7',
        referencedMessageStatus: 0, rootMessageId: '87', rootMessageConvIndex: '6',
      },
    });

    expect(message).toMatchObject({
      conversationShortId: '77',
      conversationType: 1,
      clientMessageId: 'client-1',
      version: '3',
      orderInConversation: '8',
      ext: { 's:client_message_id': 'client-1' },
      referenceInfo: {
        refMessageId: '88', refMessageType: 7, rootMessageId: '87',
      },
    });
  });
});
