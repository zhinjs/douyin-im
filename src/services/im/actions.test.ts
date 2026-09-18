import type { ImProtoTransport } from './transport.js';
import { ImConversationActions } from './actions.js';
import { decodeRequestRaw, encodeRequest } from './codec.js';
import { decodeWire } from './wire.js';
import protobuf from 'protobufjs';
import { decodeResponseRaw } from './codec.js';

describe('desktop conversation actions', () => {
  const address = {
    threadId: '7423010390826582565',
    conversationShortId: '7423010390826582565',
    conversationType: 2 as const,
  };

  it.each([undefined, {}, { status: 1, checkCode: '2', checkMessage: 'not a cmd651 consumer',
    failedParticipants: ['22'], failedSecParticipants: [{ uid: '33', secUid: 'sec33' }] }])(
    'handles cmd651 as an envelope acknowledgement without inferring participant outcomes (%p)', async body => {
      const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, errorDesc: 'OK',
        ...(body ? { body: { conversationRemoveParticipantsBody: body } } : {}) });
      const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
      await expect(actions.removeParticipants({ ...address, inboxType: 3, uids: ['22', '33'] }))
        .resolves.toEqual({ statusCode: 0, statusMsg: 'OK' });
      expect(sendCookieProto).toHaveBeenCalledTimes(1);
    });

  it.each([7, 200, 500])('preserves cmd651 envelope rejection %s without treating 200 as success', async statusCode => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode, errorDesc: 'envelope rejection', body: {
      conversationRemoveParticipantsBody: { status: 0, checkCode: '2', checkMessage: 'ignored body' },
    } });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
    await expect(actions.removeParticipants({ ...address, uids: ['22'] })).resolves.toEqual({ statusCode, statusMsg: 'envelope rejection' });
    expect(sendCookieProto).toHaveBeenCalledTimes(1);
  });

  it('encodes cmd651 with actual address and ordered participant IDs, without PURE invitation metadata', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0 });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
    await actions.removeParticipants({ ...address, inboxType: 3, uids: ['22', '9007199254740993', '22'] });
    expect(sendCookieProto.mock.calls[0]!.slice(0, 3)).toEqual([651, 3, '/v1/conversation/remove_participants']);
    const request = await decodeRequestRaw(await encodeRequest({ cmd: 651, inboxType: 3, token: '', body: sendCookieProto.mock.calls[0]![3] }));
    expect(request['body']).toEqual({ conversationRemoveParticipantsBody: {
      conversationId: address.threadId, conversationShortId: address.conversationShortId, conversationType: 2,
      participants: ['22', '9007199254740993', '22'],
    } });
    expect(sendCookieProto).toHaveBeenCalledTimes(1);
  });

  it('propagates a lost cmd651 response without retrying a potentially applied removal', async () => {
    const failure = new Error('fixture response lost');
    const sendCookieProto = jest.fn().mockRejectedValue(failure);
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
    await expect(actions.removeParticipants({ ...address, uids: ['22'] })).rejects.toBe(failure);
    expect(sendCookieProto).toHaveBeenCalledTimes(1);
  });

  it('encodes leave cmd652 with only the current conversation address, not the cleanup boundary', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0 });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    await expect(actions.leave({ ...address, inboxType: 3 })).resolves.toEqual({ statusCode: 0, statusMsg: '' });
    expect(sendCookieProto).toHaveBeenCalledWith(652, 3, '/v1/conversation/leave', { leaveConversationBody: {
      conversationId: address.threadId, conversationShortId: expect.anything(), conversationType: 2,
    } }, expect.any(Object));
    const body = sendCookieProto.mock.calls[0]![3];
    expect((await decodeRequestRaw(await encodeRequest({ cmd: 652, inboxType: 3, token: '', body })))['body'])
      .toEqual({ leaveConversationBody: { conversationId: address.threadId, conversationShortId: address.conversationShortId, conversationType: 2 } });
  });

  it('sends the captured indexV1 boundary in shared delete cmd603 without v2 or badge fields', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0 });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    const options = { ...address, inboxType: 3, lastMessageIndex: '9007199254740993' };
    await actions.deleteConversation(options);
    expect(sendCookieProto).toHaveBeenCalledWith(603, 3, '/v1/conversation/delete', expect.any(Object), expect.any(Object));
    const decoded = await decodeRequestRaw(await encodeRequest({ cmd: 603, token: '', body: sendCookieProto.mock.calls[0]![3] }));
    expect(decoded['body']).toEqual({ deleteConversationBody: { conversationId: address.threadId,
      conversationShortId: address.conversationShortId, conversationType: 2, lastMessageIndex: '9007199254740993' } });
  });

  it('encodes native delete cmd701 with caller inbox and the four exact wire fields', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0 });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    await expect(actions.deleteMessage({ ...address, inboxType: 3, serverMessageId: '9007199254740993' }))
      .resolves.toEqual({ statusCode: 0, statusMsg: '' });
    expect(sendCookieProto).toHaveBeenCalledWith(701, 3, '/v1/message/delete', { deleteMessageBody: {
      conversationId: address.threadId, conversationShortId: expect.anything(), conversationType: 2, messageId: expect.anything(),
    } }, expect.any(Object));
    const body = sendCookieProto.mock.calls[0]![3];
    const decoded = await decodeRequestRaw(await encodeRequest({ cmd: 701, inboxType: 3, token: '', body }));
    expect(decoded['body']).toEqual({ deleteMessageBody: { conversationId: address.threadId,
      conversationShortId: address.conversationShortId, conversationType: 2, messageId: '9007199254740993' } });
    // No response-body requirement/checkCode inference: sync native transport uses the outer status.
    sendCookieProto.mockResolvedValue({ statusCode: 200, errorDesc: 'outer failure' });
    await expect(actions.deleteMessage({ ...address, serverMessageId: '99' }))
      .resolves.toEqual({ statusCode: 200, statusMsg: 'outer failure' });
  });

  it('uses distinct audit cmds with the SAME native HTTP path and empty account-wide bodies', async () => {
    const sendCookieProto = jest.fn()
      .mockResolvedValueOnce({ statusCode: 0, body: { getConversationAuditUnreadBody: {
        unreadCount: '9007199254740993',
        lastApplyInfo: { userId: '22', convShortId: '70001', conversationType: 2, applyStatus: 1, applyId: '9001' },
      } } })
      .mockResolvedValueOnce({ statusCode: 0, body: { clearConversationAuditUnreadBody: {} } });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    await expect(actions.getJoinRequestUnread()).resolves.toMatchObject({
      statusCode: 0, unreadCount: '9007199254740993', lastRequest: { requestId: '9001', applicantUid: '22' },
    });
    await expect(actions.clearJoinRequestUnread()).resolves.toEqual({ statusCode: 0, statusMsg: '' });
    expect(sendCookieProto).toHaveBeenNthCalledWith(1, 2028, 1, '/v1/conversation/get_audit_unread',
      { getConversationAuditUnreadBody: {} }, expect.any(Object));
    expect(sendCookieProto).toHaveBeenNthCalledWith(2, 2029, 1, '/v1/conversation/get_audit_unread',
      { clearConversationAuditUnreadBody: {} }, expect.any(Object));
    for (const [index, cmd, key] of [
      [0, 2028, 'getConversationAuditUnreadBody'],
      [1, 2029, 'clearConversationAuditUnreadBody'],
    ] as const) {
      const decoded = await decodeRequestRaw(await encodeRequest({ token: '', cmd,
        body: sendCookieProto.mock.calls[index]?.[3] as Record<string, unknown>,
      }));
      expect(decoded['body']).toEqual(expect.objectContaining({ [key]: {} }));
    }
  });

  it('does not disguise missing/rejected audit responses as zero or successful clear', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, body: {} });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    await expect(actions.getJoinRequestUnread()).resolves.toEqual({ statusCode: -3, statusMsg: expect.stringContaining('missing') });
    await expect(actions.clearJoinRequestUnread()).resolves.toEqual({ statusCode: -3, statusMsg: expect.stringContaining('missing') });
    sendCookieProto.mockResolvedValue({ statusCode: 4, errorDesc: 'INVALID_REQUEST' });
    await expect(actions.getJoinRequestUnread()).resolves.toEqual({ statusCode: 4, statusMsg: 'INVALID_REQUEST' });
    await expect(actions.clearJoinRequestUnread()).resolves.toEqual({ statusCode: 4, statusMsg: 'INVALID_REQUEST' });
    sendCookieProto.mockResolvedValue({ statusCode: 0, body: { getConversationAuditUnreadBody: {} } });
    await expect(actions.getJoinRequestUnread()).resolves.toEqual({ statusCode: 0, statusMsg: '', unreadCount: '0' });
    for (const unreadCount of [-1, Number.MAX_SAFE_INTEGER + 1, '9223372036854775808', 'oops']) {
      sendCookieProto.mockResolvedValue({ statusCode: 0, body: { getConversationAuditUnreadBody: { unreadCount } } });
      await expect(actions.getJoinRequestUnread()).resolves.toEqual({ statusCode: -3, statusMsg: expect.stringContaining('invalid') });
    }
  });

  it('creates a group with the desktop cmd609 v2 contract and maps the returned conversation', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: {
        createConversationV2Body: {
          status: 0,
          conversation: {
            conversationId: '70001',
            conversationShortId: '70001',
            conversationType: 2,
            conversationCoreInfo: { name: '新群', owner: '11' },
            firstPageParticipants: {
              participants: [{ uid: '11', role: 1 }, { uid: '22', role: 0 }],
            },
          },
        },
      },
    });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '11',
    );

    await expect(actions.createConversation(['11', '22', '22'], 2, {
      name: '新群',
      avatarUrl: 'https://example.com/group.webp',
      description: '群描述',
    })).resolves.toEqual({
      statusCode: 0,
      statusMsg: '',
      conversation: expect.objectContaining({
        conversationId: '70001',
        conversationShortId: '70001',
        isGroup: true,
        name: '新群',
        ownerUid: '11',
      }),
    });
    expect(sendCookieProto).toHaveBeenCalledWith(
      609,
      0,
      '/v2/conversation/create',
      {
        createConversationV2Body: {
          conversationType: 2,
          participants: expect.any(Array),
          name: '新群',
          avatarUrl: 'https://example.com/group.webp',
          description: '群描述',
          bizExt: {
            create: JSON.stringify({ source_app_id: 339757, source_type: 6 }),
            group_create_type: '0',
          },
        },
      },
      expect.any(Object),
    );
    const request = sendCookieProto.mock.calls[0]?.[3] as Record<string, unknown>;
    const encoded = await encodeRequest({ token: '', cmd: 609, body: request });
    const decoded = await decodeRequestRaw(encoded);
    expect(decoded['body']).toMatchObject({
      createConversationV2Body: {
        conversationType: 2,
        participants: ['11', '22'],
        name: '新群',
        avatarUrl: 'https://example.com/group.webp',
        description: '群描述',
        bizExt: {
          create: JSON.stringify({ source_app_id: 339757, source_type: 6 }),
          group_create_type: '0',
        },
      },
    });
  });

  it('marks the exact message read with native cmd2002 and body field 604', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, errorDesc: '' });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '1150530166719210',
    );

    await expect(actions.markRead({
      ...address,
      serverMessageId: '9988',
      indexInConversation: '12',
      indexInConversationV2: '34',
      readBadgeCount: 1,
    })).resolves.toEqual({ statusCode: 0, statusMsg: '' });

    expect(sendCookieProto).toHaveBeenCalledWith(
      2002,
      1,
      '/v1/conversation/mark_read',
      {
        markConversationReadBody: expect.objectContaining({
          conversationId: address.threadId,
          conversationType: 2,
          conversationShortId: expect.anything(),
          serverMessageId: expect.anything(),
          readMessageIndex: expect.anything(),
          readMessageIndexV2: expect.anything(),
          readBadgeCount: expect.anything(),
        }),
      },
      expect.objectContaining({
        deviceId: 'device-1', devicePlatform: 'mac', access: 'cpp_sdk', sdkVersion: '1.2.1',
      }),
    );
    const request = sendCookieProto.mock.calls[0]?.[3] as Record<string, unknown>;
    const encoded = await encodeRequest({ token: '', cmd: 2002, inboxType: 1, body: request });
    await expect(decodeRequestRaw(encoded)).resolves.toMatchObject({
      cmd: 2002,
      inboxType: 1,
      body: {
        markConversationReadBody: {
          conversationId: address.threadId,
          conversationShortId: address.conversationShortId,
          conversationType: 2,
          readMessageIndex: '12',
          readMessageIndexV2: '34',
          readBadgeCount: 1,
          serverMessageId: '9988',
        },
      },
    });
    const envelopeBody = decodeWire(encoded).find(
      (field) => field.field === 8 && field.type === 'message',
    );
    expect(envelopeBody?.type === 'message'
      ? envelopeBody.value.some((field) => field.field === 604)
      : false).toBe(true);
  });

  it('batches with the same single-message mark-read route Desktop exposes', async () => {
    const failed = {
      ...address,
      serverMessageId: '9989',
      indexInConversation: '13',
      indexInConversationV2: '35',
      readBadgeCount: 1,
    };
    const sendCookieProto = jest.fn()
      .mockResolvedValueOnce({ statusCode: 0 })
      .mockResolvedValueOnce({ statusCode: 3, errorDesc: 'mark read failed' });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
    );

    await expect(actions.markReadBatch([{
      ...address,
      serverMessageId: '9988',
      indexInConversation: '12',
      indexInConversationV2: '34',
    }, failed])).resolves.toEqual({
      statusCode: 3,
      statusMsg: 'mark read failed',
      failed: [failed],
    });

    expect(sendCookieProto).toHaveBeenNthCalledWith(
      1,
      2002,
      1,
      '/v1/conversation/mark_read',
      { markConversationReadBody: expect.objectContaining({ serverMessageId: expect.anything() }) },
      expect.any(Object),
    );
    expect(sendCookieProto).toHaveBeenNthCalledWith(
      2,
      2002,
      1,
      '/v1/conversation/mark_read',
      { markConversationReadBody: expect.objectContaining({ serverMessageId: expect.anything() }) },
      expect.any(Object),
    );
  });

  it('refreshes one or more conversations through Desktop cmd608 calls', async () => {
    const conversation = {
      conversationId: address.threadId,
      conversationShortId: address.conversationShortId,
      conversationType: 2,
      ticket: 'ticket-1',
      badgeCount: 3,
      participantsCount: 2,
      conversationCoreInfo: {
        name: '测试群', desc: '描述', notice: '公告', icon: 'avatar.webp', owner: '11',
      },
      conversationSettingInfo: {
        readIndex: '30', readIndexV2: '40', minIndex: '2', minIndexV2: '3',
      },
      firstPageParticipants: { participants: [{ userId: '11', role: 1 }] },
    };
    const sendCookieProto = jest.fn()
      .mockResolvedValueOnce({ statusCode: 0, body: { getConversationInfoV2Body: { conversationInfo: conversation } } })
      .mockResolvedValueOnce({ statusCode: 0, body: { getConversationInfoV2Body: { conversationInfo: conversation } } })
      .mockResolvedValueOnce({ statusCode: 0, body: { getConversationInfoV2Body: { conversationInfo: conversation } } });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
    );

    await expect(actions.getConversationInfos([address])).resolves.toEqual({
      statusCode: 0,
      statusMsg: '',
      conversations: [expect.objectContaining({
        conversationId: address.threadId,
        name: '测试群', description: '描述', notice: '公告', ticket: 'ticket-1',
        badgeCount: 3, readIndex: '30', readIndexV2: '40',
      })],
    });
    await actions.getConversationInfos([address, { ...address, threadId: '70002', conversationShortId: '70002' }]);

    expect(sendCookieProto).toHaveBeenNthCalledWith(
      1, 608, 0, '/v2/conversation/get_info',
      { getConversationInfoV2Body: expect.objectContaining({ conversationId: address.threadId }) },
      expect.any(Object),
    );
    expect(sendCookieProto).toHaveBeenNthCalledWith(
      2, 608, 0, '/v2/conversation/get_info',
      { getConversationInfoV2Body: expect.objectContaining({ conversationId: address.threadId }) },
      expect.any(Object),
    );
    expect(sendCookieProto).toHaveBeenNthCalledWith(
      3, 608, 0, '/v2/conversation/get_info',
      { getConversationInfoV2Body: expect.objectContaining({ conversationId: '70002' }) },
      expect.any(Object),
    );
  });

  it.each([0, 200])('accepts cmd608 status %s only with its response body, without inventing an inner conversation', async statusCode => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode, body: {
      getConversationInfoV2Body: { conversationInfo: { conversationId: address.threadId } },
    } });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
    await expect(actions.getConversationInfos([address])).resolves.toMatchObject({ statusCode: 0,
      conversations: [{ conversationId: address.threadId }] });
    sendCookieProto.mockResolvedValue({ statusCode, body: { getConversationInfoV2Body: {} } });
    await expect(actions.getConversationInfos([address])).resolves.toMatchObject({ statusCode: 0, conversations: [] });
    sendCookieProto.mockResolvedValue({ statusCode, body: {} });
    await expect(actions.getConversationInfos([address])).resolves.toMatchObject({ statusCode: -3, conversations: [] });
  });

  it('does not expose a failed cmd608 response body as a refreshed conversation', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 4, errorDesc: 'INVALID_REQUEST', body: {
      getConversationInfoV2Body: { conversationInfo: { conversationId: address.threadId } },
    } });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
    await expect(actions.getConversationInfos([address])).resolves.toEqual({ statusCode: 4,
      statusMsg: 'INVALID_REQUEST', conversations: [] });
  });

  it.each(['0', '-1', '18446744073709551615', '9007199254740993'])('uses native positive signed short-id presence for cmd608 (%s)', async shortId => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, body: { getConversationInfoV2Body: {} } });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
    await actions.getConversationInfos([{ ...address, conversationShortId: shortId, inboxType: 3 }]);
    const body = sendCookieProto.mock.calls[0]![3];
    const decoded = await decodeRequestRaw(await encodeRequest({ cmd: 608, inboxType: 3, token: '', body }));
    expect(decoded['body']).toEqual({ getConversationInfoV2Body: {
      conversationId: address.threadId, conversationType: 2,
      ...(shortId === '9007199254740993' ? { conversationShortId: shortId } : {}),
    } });
    expect(sendCookieProto.mock.calls[0]!.slice(0, 3)).toEqual([608, 3, '/v2/conversation/get_info']);
  });

  it('changes only the requested optional setting without a cmd920 preflight', async () => {
    const sendCookieProto = jest.fn()
      .mockResolvedValueOnce({
        statusCode: 0,
        body: { setConversationSettingInfoBody: { status: 0 } },
      });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '1150530166719210',
    );

    await expect(actions.setSettings({ ...address, mute: true })).resolves.toEqual({
      statusCode: 0,
      statusMsg: '',
    });

    expect(sendCookieProto).toHaveBeenNthCalledWith(
      1,
      921,
      0,
      '/v1/conversation/set_setting_info',
      {
        setConversationSettingInfoBody: {
          conversationId: address.threadId,
          conversationShortId: expect.anything(),
          conversationType: 2,
          setMute: true,
        },
      },
      expect.any(Object),
    );
    expect(sendCookieProto).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 3, 500])('preserves native reaction enum status %s through wire decoding', async (status) => {
    const root = await protobuf.load('src/services/im/proto/im.proto');
    const response = root.lookupType('im_proto.Response');
    const bytes = response.encode(response.create({
      cmd: 705, statusCode: 0,
      body: { modifyMessagePropertyBody: { status } },
    })).finish();
    const sendCookieProto = jest.fn().mockResolvedValue(await decodeResponseRaw(bytes));
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
    const result = await actions.modifyReaction({ ...address, serverMessageId: '99', operatorUid: '11', emoji: '[爱心]', enabled: true });
    expect(result.statusCode).toBe(status === 1 ? 0 : status);
  });

  it('does not report participant rejection as success', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: {
        conversationAddParticipantsBody: {
          status: 0,
          checkCode: '7507',
          checkMessage: 'group is full',
          failedParticipants: ['22'],
        },
      },
    });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '1150530166719210',
    );

    await expect(actions.inviteParticipants({ ...address, uids: ['22'] })).resolves.toEqual({
      statusCode: 7507,
      statusMsg: 'group is full',
      checkCode: 7507,
      succeededUids: [],
      failedUids: ['22'],
      details: expect.objectContaining({ status: 0, checkCode: '7507', checkMessage: 'group is full' }),
    });
  });

  it.each([0, 200])('uses cmd650 inbox1 and accepts native envelope %s without inferring unreported invitees', async statusCode => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode, errorDesc: 'OK', body: {
      conversationAddParticipantsBody: { status: 0, failedParticipants: ['33'] },
    } });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    await expect(actions.inviteParticipants({ ...address, inboxType: 3, uids: ['22', '33'] }))
      .resolves.toEqual({ statusCode: 0, statusMsg: 'OK', succeededUids: [], failedUids: ['33'],
        details: { status: 0, successParticipants: [], failedParticipants: ['33'], secSuccessParticipants: [], secFailedParticipants: [] } });
    expect(sendCookieProto.mock.calls[0]!.slice(0, 3)).toEqual([650, 1, '/v1/conversation/add_participants']);
    expect(sendCookieProto).toHaveBeenCalledTimes(1);
  });

  it('projects only explicit cmd650 participant IDs, retaining response order and multiplicity', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, body: {
      conversationAddParticipantsBody: { status: 0, successParticipants: ['22', '22'], failedParticipants: ['33'],
        secSuccessParticipants: [{ uid: '9007199254740993', secUid: 'fixture' }], secFailedParticipants: [{ uid: '44', secUid: 'fixture' }] },
    } });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    await expect(actions.inviteParticipants({ ...address, uids: ['22', '33', '55'] })).resolves.toEqual({
      statusCode: 0, statusMsg: '', succeededUids: ['22', '22', '9007199254740993'], failedUids: ['33', '44'],
      details: { status: 0, successParticipants: ['22', '22'], failedParticipants: ['33'],
        secSuccessParticipants: [{ uid: '9007199254740993', secUid: 'fixture' }], secFailedParticipants: [{ uid: '44', secUid: 'fixture' }] },
    });
  });

  it.each([7, 500])('does not consume a rejected cmd650 envelope body (%s)', async statusCode => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode, errorDesc: 'rejected', body: {
      conversationAddParticipantsBody: { status: 0, successParticipants: ['22'], failedParticipants: ['33'], checkMessage: 'must not win' },
    } });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    await expect(actions.inviteParticipants({ ...address, uids: ['22', '33'] })).resolves.toEqual({
      statusCode, statusMsg: 'rejected', succeededUids: [], failedUids: [],
    });
  });

  it('reports a missing cmd650 body even when native would accept envelope200 and then omit its callback', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 200, errorDesc: 'OK' });
    const actions = new ImConversationActions({ sendCookieProto } as unknown as ImProtoTransport, 'device-1', () => '11');
    await expect(actions.inviteParticipants({ ...address, uids: ['22'] })).resolves.toEqual({
      statusCode: -3, statusMsg: 'IM response missing conversationAddParticipantsBody', succeededUids: [], failedUids: [],
    });
  });

  it('adds participants with the same PURE invitation metadata as Douyin desktop', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: {
        conversationAddParticipantsBody: {
          status: 0,
          successParticipants: ['3138463854771706'],
        },
      },
    });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '1150530166719210',
    );

    await actions.inviteParticipants({ ...address, uids: ['3138463854771706'] });

    const request = sendCookieProto.mock.calls[0]?.[3] as {
      conversationAddParticipantsBody: { bizExt: Record<string, string> };
    };
    expect(request.conversationAddParticipantsBody.bizExt).toEqual({
      invitation: '{"invitee":{"source_app_id":339757},"invitor":{"im_user_id":1150530166719210},"source_type":6}',
      ticket: '',
    });
  });

  it('loads every participant page with cmd605', async () => {
    const sendCookieProto = jest.fn()
      .mockResolvedValueOnce({
        statusCode: 0,
        body: {
          conversationParticipantsBody: {
            participantsPage: {
              participants: [{ userId: '11', role: 1, secUid: 'owner', alias: '群主' }],
              hasMore: true,
              cursor: '100',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        statusCode: 0,
        body: {
          conversationParticipantsBody: {
            participantsPage: {
              participants: [{ userId: '22', role: 0, secUid: 'member', alias: '成员' }],
              hasMore: false,
              cursor: '200',
            },
          },
        },
      });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '11',
    );

    await expect(actions.listParticipants(address)).resolves.toEqual({
      statusCode: 0,
      statusMsg: '',
      members: [
        expect.objectContaining({ uid: '11', role: 1, secUid: 'owner', alias: '群主' }),
        expect.objectContaining({ uid: '22', role: 0, secUid: 'member', alias: '成员' }),
      ],
    });
    expect(sendCookieProto).toHaveBeenNthCalledWith(
      1,
      605,
      0,
      '/v1/conversation/participants_list',
      { conversationParticipantsBody: expect.objectContaining({ cursor: expect.anything(), limit: 100 }) },
      expect.any(Object),
    );
    expect(sendCookieProto).toHaveBeenNthCalledWith(
      2,
      605,
      0,
      '/v1/conversation/participants_list',
      { conversationParticipantsBody: expect.objectContaining({ cursor: expect.anything(), limit: 100 }) },
      expect.any(Object),
    );
  });

  it('surfaces checkMessage instead of the envelope OK text', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      errorDesc: 'OK',
      body: {
        conversationAddParticipantsBody: {
          status: 1,
          checkCode: '2',
          checkMessage: '{"status_code":7505,"status_msg":"邀请参数非法"}',
          failedParticipants: ['22'],
        },
      },
    });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '11',
    );

    await expect(actions.inviteParticipants({ ...address, uids: ['22'] })).resolves.toEqual({
      statusCode: 7505,
      statusMsg: '邀请参数非法',
      checkCode: 7505,
      succeededUids: [],
      failedUids: ['22'],
      details: expect.objectContaining({ status: 1, checkCode: '2', checkMessage: '{"status_code":7505,"status_msg":"邀请参数非法"}' }),
    });
  });

  it('does not treat checkCode as an error when parsed business status is zero', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      errorDesc: 'OK',
      body: {
        conversationAddParticipantsBody: {
          status: 0,
          checkCode: '2',
          checkMessage: '{"status_code":0,"status_msg":"success"}',
          successParticipants: ['22'],
        },
      },
    });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '11',
    );

    await expect(actions.inviteParticipants({ ...address, uids: ['22'] })).resolves.toEqual({
      statusCode: 0,
      statusMsg: 'success',
      succeededUids: ['22'],
      failedUids: [],
      details: expect.objectContaining({ status: 0, checkCode: '2', checkMessage: '{"status_code":0,"status_msg":"success"}' }),
    });
  });

  it('lists join requests with cmd2027 and reviews them with cmd2025', async () => {
    const sendCookieProto = jest.fn()
      .mockResolvedValueOnce({
        statusCode: 0,
        body: {
          getConversationAuditListBody: {
            applyInfoList: [{
              userId: '22',
              secUid: 'sec-22',
              convShortId: address.conversationShortId,
              conversationType: 2,
              applyStatus: 1,
              applyId: '9001',
              createTime: '1000',
              inviteUserId: '11',
              applyReason: '想加入',
              ext: { source: 'search' },
            }],
            nextCursor: '100',
            hasMore: false,
          },
        },
      })
      .mockResolvedValueOnce({
        statusCode: 0,
        body: {
          ackConversationApplyBody: {
            status: 0,
            applyInfo: {
              userId: '22',
              convShortId: address.conversationShortId,
              conversationType: 2,
              applyStatus: 2,
              applyId: '9001',
            },
          },
        },
      });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '11',
    );

    await expect(actions.listJoinRequests({ conversationShortId: address.conversationShortId }))
      .resolves.toEqual({
        statusCode: 0,
        statusMsg: '',
        requests: [expect.objectContaining({
          requestId: '9001',
          applicantUid: '22',
          applicantSecUid: 'sec-22',
          groupShortId: address.conversationShortId,
          status: 1,
          reason: '想加入',
        })],
      });
    expect(sendCookieProto).toHaveBeenNthCalledWith(
      1,
      2027,
      1,
      '/v1/conversation/get_audit_list',
      { getConversationAuditListBody: expect.objectContaining({
        cursor: expect.anything(),
        limit: 100,
      }) },
      expect.any(Object),
    );
    expect((sendCookieProto.mock.calls[0]?.[3] as {
      getConversationAuditListBody: Record<string, unknown>;
    }).getConversationAuditListBody).not.toHaveProperty('convShortId');

    await expect(actions.reviewJoinRequest({ requestId: '9001', status: 2 }))
      .resolves.toEqual({
        statusCode: 0,
        statusMsg: '',
        request: expect.objectContaining({ requestId: '9001', applicantUid: '22', status: 2 }),
      });
    expect(sendCookieProto).toHaveBeenNthCalledWith(
      2,
      2025,
      1,
      '/v1/conversation/ack_apply',
      { ackConversationApplyBody: {
        applyId: expect.anything(),
        applyStatus: 2,
        bizExt: {},
      } },
      expect.any(Object),
    );

    const listRequest = sendCookieProto.mock.calls[0]?.[3] as Record<string, unknown>;
    const decodedList = await decodeRequestRaw(
      await encodeRequest({ token: '', cmd: 2027, body: listRequest }),
    );
    expect(decodedList['body']).toEqual(expect.objectContaining({
      getConversationAuditListBody: expect.objectContaining({ limit: 100 }),
    }));
    const ackRequest = sendCookieProto.mock.calls[1]?.[3] as Record<string, unknown>;
    const decodedAck = await decodeRequestRaw(
      await encodeRequest({ token: '', cmd: 2025, body: ackRequest }),
    );
    expect(decodedAck['body']).toEqual(expect.objectContaining({
      ackConversationApplyBody: expect.objectContaining({ applyStatus: 'AGREE' }),
    }));
  });

  it('uses the desktop enter-conversation lifecycle contract', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0 });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '1150530166719210',
    );

    await actions.enterConversation(address);

    expect(sendCookieProto).toHaveBeenNthCalledWith(
      1, 410, 0, '/v1/client/user_action',
      { sendUserActionBody: expect.objectContaining({ actionType: 1, extra: {} }) },
      expect.any(Object),
    );
  });

  it('encodes desktop message reactions as cmd705 se properties', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({
      statusCode: 0,
      body: { modifyMessagePropertyBody: { status: 0, version: '2' } },
    });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '1150530166719210',
    );

    await expect(actions.modifyReaction({
      ...address,
      serverMessageId: '9988',
      operatorUid: '1150530166719210',
      emoji: '[爱心]',
      enabled: true,
    })).resolves.toEqual({ statusCode: 0, statusMsg: '' });

    const request = sendCookieProto.mock.calls[0]?.[3] as Record<string, unknown>;
    const decoded = await decodeRequestRaw(
      await encodeRequest({ token: '', cmd: 705, body: request }),
    );
    expect(decoded['body']).toEqual(expect.objectContaining({
      modifyMessagePropertyBody: {
        propertyList: expect.objectContaining({
          conversationId: address.threadId,
          serverMessageId: '9988',
          modifyPropertyContent: [{
            operation: 'ADD_PROPERTY_ITEM',
            key: 'se:[爱心]',
            value: '',
            idempotentId: '1150530166719210',
          }],
        }),
        ticket: '',
      },
    }));
  });

  it('does not report a missing participant-list body as an empty successful group', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, errorDesc: '' });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '11',
    );

    await expect(actions.listParticipants(address)).resolves.toEqual({
      statusCode: -3,
      statusMsg: 'IM response missing conversationParticipantsBody',
      members: [],
    });
  });

  it('rejects successful envelopes that omit a required action response body', async () => {
    const sendCookieProto = jest.fn().mockResolvedValue({ statusCode: 0, errorDesc: '' });
    const actions = new ImConversationActions(
      { sendCookieProto } as unknown as ImProtoTransport,
      'device-1',
      () => '11',
    );

    await expect(actions.createConversation(['11', '22'], 2)).resolves.toEqual({
      statusCode: -3,
      statusMsg: 'IM response missing createConversationV2Body',
    });
    await expect(actions.inviteParticipants({ ...address, uids: ['22'] })).resolves.toEqual({
      statusCode: -3,
      statusMsg: 'IM response missing conversationAddParticipantsBody',
      succeededUids: [],
      failedUids: [],
    });
    await expect(actions.modifyReaction({
      ...address,
      serverMessageId: '9988',
      operatorUid: '11',
      emoji: '[爱心]',
      enabled: true,
    })).resolves.toEqual({
      statusCode: -3,
      statusMsg: 'IM response missing modifyMessagePropertyBody',
    });
  });

});
