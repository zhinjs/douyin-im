import protobuf from 'protobufjs';
import { extractProtoNotices, noticeFromPush, messageDeletionCommand } from './notifications.js';
import { decodeResponseRaw } from './codec.js';
import { pushFromResponse } from './ws-client.js';

describe('IM notifications', () => {
  it('routes deletion using body conversation/server identity without rounding or confusing recall fields', () => {
    const push = { cmd: 500, conversationId: 'outer', conversationShortId: '77', conversationType: 2, senderUid: '22',
      content: '{"command_type":2,"conversation_id":"target","message_id":9007199254740993}', messageType: 50001,
      ext: { 's:target_server_message_id': 'wrong' }, raw: { source: 'wire' } };
    expect(noticeFromPush(push)).toEqual({ type: 'message.delete', conversationId: 'target', serverMessageId: '9007199254740993', raw: push.raw });
    expect(messageDeletionCommand(7, push.content)).toBeUndefined();
    expect(messageDeletionCommand(50001, '{"command_type":4294967298,"conversation_id":"target","message_id":18446744073709551615}'))
      .toEqual({ conversationId: 'target', serverMessageId: '-1' });
  });
  it.each([
    '{"command_type":"2","conversation_id":"700","message_id":99}',
    '{"command_type":2.0,"conversation_id":"700","message_id":99}',
    '{"command_type":2,"conversation_id":700,"message_id":99}',
    '{"command_type":2,"conversation_id":"700","message_id":"9007199254740993"}',
    '{"command_type":2,"conversation_id":"700","message_id":99.0}',
    '{"command_type":2,"conversation_id":"700"}',
    '{"command_type":3,"conversation_id":"700","message_id":99}',
    '{"command_type":2,"conversation_id":"700","message_id":99,"command_type":null}',
    '{"nested":{"command_type":2},"conversation_id":"700","message_id":99}',
    '{"command_type":2,"conversation_id":"","message_id":99}',
    'null', '[]', '{bad',
  ])('does not convert malformed or unrelated commands into deletion: %s', content => {
    expect(messageDeletionCommand(50001, content)).toBeUndefined();
    expect(noticeFromPush({ cmd: 500, conversationId: '700', conversationShortId: '700', conversationType: 2,
      senderUid: '22', content, messageType: 50001, raw: {} })).toMatchObject({ type: 'im.command' });
  });
  it('routes native flat cmd504/type50013 without sendType to participant read notice, not message or recall', async () => {
    const root = await protobuf.load('src/services/im/proto/im.proto');
    const type = root.lookupType('im_proto.Response');
    const decoded = await decodeResponseRaw(type.encode(type.fromObject({ cmd: 504, body: { hasNewP2pMessageNotify: {
      conversationId: '70001', conversationType: 2, sender: '10001', messageType: 50013,
      content: Buffer.from('{"UserId":33,"P2PSender":9007199254740995,"MessageId":999,"ConShortId":123,"P2PSenderReadIndex":9007199254740997}'),
    } } })).finish());
    const push = pushFromResponse(504, decoded)!;
    expect(extractProtoNotices(decoded)).toEqual([]);
    expect(noticeFromPush(push)).toEqual({ type: 'conversation.read', conversationId: '70001', conversationType: 2,
      readerUid: '9007199254740995', readMessageIndex: '9007199254740997', raw: push.raw });
    expect(noticeFromPush({ ...push, messageType: 50015 })).toMatchObject({ type: 'im.command' });
    expect(noticeFromPush({ ...push, cmd: 500 })).toMatchObject({ type: 'im.command' });
    expect(noticeFromPush({ ...push, content: '{"P2PSender":"22"}' })).toMatchObject({ type: 'im.command' });
  });
  it('decodes read notifications without inventing a conversation update from an unused wire body', () => {
    const response = {
      body: {
        markConversationReadNotify: {
          conversationId: '0:1:12:34',
          conversationType: 1,
          readIndex: '9',
          readIndexV2: '10',
        },
        conversationInfoUpdatedNotify: {
          conversation: {
            conversationId: '7423010390826582565',
            conversationType: 2,
          },
        },
      },
    };

    expect(extractProtoNotices(response)).toEqual([
      expect.objectContaining({
        type: 'conversation.read',
        conversationId: '0:1:12:34',
        readMessageIndexV2: '10',
      }),
    ]);
  });

  it('retains cmd502 in the actual wire schema and raw decoder without emitting a state-update notice', async () => {
    const root = await protobuf.load('src/services/im/proto/im.proto');
    const response = root.lookupType('im_proto.Response');
    const raw = await decodeResponseRaw(response.encode(response.fromObject({ cmd: 502,
      body: { conversationInfoUpdatedNotify: { conversation: { conversationId: '700', conversationType: 2 } } },
    })).finish());
    expect(raw).toMatchObject({ cmd: 502, body: { conversationInfoUpdatedNotify: { conversation: { conversationId: '700' } } } });
    expect(extractProtoNotices(raw)).toEqual([]);
    expect(pushFromResponse(502, raw)).toBeNull();
  });

  it.each([
    [1, 'friend.add-request'],
    [2, 'friend.decrease'],
    [3, 'friend.increase'],
  ])('projects cmd508 friend notification type %i as %s', (messageType, type) => {
    expect(extractProtoNotices({
      body: {
        newFriendMessageNotify: {
          messageType,
          fromId: '22',
          toId: '11',
          content: 'hello',
          ext: { source: 'profile' },
        },
      },
    })).toEqual([expect.objectContaining({
      type,
      ...(messageType === 1 ? { applicantUid: '22' } : { peerUid: '22' }),
      content: 'hello',
    })]);
  });

  it('turns protocol command messages into notices', () => {
    expect(noticeFromPush({
      cmd: 500,
      conversationId: '0:1:12:34',
      conversationShortId: '77',
      conversationType: 1,
      senderUid: '12',
      content: '{"server_message_id":"wrong-content-id"}',
      ext: { 's:target_server_message_id': '9988', 's:target_client_message_id': 'target-client' },
      createTime: '123',
      messageType: 40001,
      raw: {},
    })).toMatchObject({
      type: 'message.recall',
      conversationId: '0:1:12:34',
      serverMessageId: '9988',
      clientMessageId: 'target-client',
      createTime: '123',
    });
  });

  it.each([50000, 50006, 99999])('keeps unknown native non-ordinary type %i observable as a command', messageType => {
    expect(noticeFromPush({ cmd: 500, conversationId: '700', conversationShortId: '700', conversationType: 2,
      senderUid: '22', content: '{}', messageType, raw: {} })).toMatchObject({ type: 'im.command', messageType });
  });

  it.each([
    [70001, 0, true],
    [70002, 1, false],
  ])('decodes Desktop message property %i as a reaction notice', async (messageType, status, enabled) => {
    const root = await protobuf.load('src/services/im/proto/im.proto');
    const MessagePropertyContent = root.lookupType('im_proto.MessagePropertyContent');
    const contentBytes = MessagePropertyContent.encode(MessagePropertyContent.create({
      type: 0,
      reactionContent: {
        id: 1,
        name: '赞',
        status,
        targetMessageId: '9007199254740993',
        targetClientMessageId: '00000000-0000-0000-0000-000000000001',
      },
    })).finish();

    expect(noticeFromPush({
      cmd: 500,
      conversationId: '0:1:12:34',
      conversationShortId: '77',
      conversationType: 1,
      senderUid: '34',
      content: new TextDecoder().decode(contentBytes),
      contentBytes,
      messageType,
      raw: {},
    })).toMatchObject({
      type: 'message.reaction',
      conversationId: '0:1:12:34',
      operatorUid: '34',
      emoji: '赞',
      enabled,
      serverMessageId: '9007199254740993',
      clientMessageId: '00000000-0000-0000-0000-000000000001',
    });
  });

  it('projects conversation apply commands as join-request signals', () => {
    expect(noticeFromPush({
      cmd: 500,
      conversationId: '7423010390826582565',
      conversationShortId: '7423010390826582565',
      conversationType: 2,
      senderUid: '3138463854771706',
      content: '{"apply_id":"9001"}',
      messageType: 90001,
      raw: {},
    })).toMatchObject({
      type: 'group.join-request',
      conversationShortId: '7423010390826582565',
      requestId: '9001',
    });
  });

  it('projects audited group joins with their member and operator identities', () => {
    expect(noticeFromPush({
      cmd: 500,
      conversationId: '7423010390826582565',
      conversationShortId: '7423010390826582565',
      conversationType: 2,
      senderUid: '11',
      content: JSON.stringify({
        aweType: 100109,
        active_users: [{ uid: '11', sec_uid: 'MS4operator', nickname: '管理员' }],
        passive_users: [{ uid: '22', sec_uid: 'MS4member', nickname: '新成员' }],
      }),
      messageType: 7,
      raw: {},
    })).toMatchObject({
      type: 'group.member-increase',
      source: 'apply',
      operators: [{ uid: '11', secUid: 'MS4operator', nickname: '管理员' }],
      members: [{ uid: '22', secUid: 'MS4member', nickname: '新成员' }],
    });
  });

  it('projects kicked members from passive_users and keeps active_users as operators', () => {
    expect(noticeFromPush({
      cmd: 500,
      conversationId: '7423010390826582565',
      conversationShortId: '7423010390826582565',
      conversationType: 2,
      senderUid: '11',
      content: JSON.stringify({
        aweType: 100104,
        active_users: [{ uid: '11', nickname: '管理员' }],
        passive_users: [{ uid: '22', nickname: '离群成员' }],
      }),
      messageType: 7,
      raw: {},
    })).toMatchObject({
      type: 'group.member-decrease',
      source: 'kick',
      operators: [{ uid: '11', nickname: '管理员' }],
      members: [{ uid: '22', nickname: '离群成员' }],
    });
  });

  it('projects voluntary exits from active_users without inventing a protocol operator', () => {
    expect(noticeFromPush({
      cmd: 500,
      conversationId: '7423010390826582565',
      conversationShortId: '7423010390826582565',
      conversationType: 2,
      senderUid: '22',
      content: JSON.stringify({
        aweType: 100105,
        active_users: [{ uid: '22', nickname: '退出成员' }],
        passive_users: [],
      }),
      messageType: 7,
      raw: {},
    })).toMatchObject({
      type: 'group.member-decrease',
      source: 'leave',
      operators: [],
      members: [{ uid: '22', nickname: '退出成员' }],
    });
  });

  it.each([
    [100106, 'group.name-change', { new_name: '新群名' }, { name: '新群名' }],
    [100115, 'group.avatar-change', { avatar_url: 'https://example.com/group.webp' }, {
      avatar: 'https://example.com/group.webp',
    }],
  ])('projects group metadata aweType=%i as %s', (aweType, type, extra, expected) => {
    expect(noticeFromPush({
      cmd: 500,
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      senderUid: '11',
      content: JSON.stringify({
        aweType,
        active_users: [{ uid: '11', nickname: '群主' }],
        ...extra,
      }),
      messageType: 7,
      raw: {},
    })).toMatchObject({
      type,
      operators: [{ uid: '11', nickname: '群主' }],
      ...expected,
    });
  });

  it('projects administrator assignment with the affected member', () => {
    expect(noticeFromPush({
      cmd: 500,
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      senderUid: '11',
      content: JSON.stringify({
        aweType: 100110,
        active_users: [{ uid: '11', nickname: '群主' }],
        passive_users: [{ uid: '22', nickname: '新管理员' }],
      }),
      messageType: 7,
      raw: {},
    })).toMatchObject({
      type: 'group.admin',
      enabled: true,
      operators: [{ uid: '11' }],
      members: [{ uid: '22' }],
    });
  });

  it('keeps 50005 as a participation command rather than deleting the conversation', () => {
    const base = {
      cmd: 500,
      conversationId: '7423010390826582565',
      conversationShortId: '7423010390826582565',
      conversationType: 2,
      senderUid: '11',
      content: '{}',
      raw: {},
    };
    expect(noticeFromPush({ ...base, messageType: 50005 })).toMatchObject({
      type: 'im.command', messageType: 50005,
    });
    expect(noticeFromPush({ ...base, messageType: 50005, content: '{"aweType":100104}' }))
      .toMatchObject({ type: 'im.command', messageType: 50005 });
    expect(noticeFromPush({ ...base, messageType: 50010 })).toMatchObject({
      type: 'im.command',
    });
  });
});
