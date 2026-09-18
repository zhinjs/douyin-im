import protobuf from 'protobufjs';

describe('Douyin Chat 1.2.1 protocol schema', () => {
  let root: protobuf.Root;

  beforeAll(async () => {
    root = await protobuf.load('src/services/im/proto/im.proto');
  });

  function type(name: string): protobuf.Type {
    return root.lookupType(`im_proto.${name}`);
  }

  function expectField(
    message: string,
    name: string,
    id: number,
    fieldType: string,
  ): void {
    expect(type(message).fields[name]).toMatchObject({ id, type: fieldType });
  }

  it('contains the complete native IM API descriptor', () => {
    const namespace = root.lookup('im_proto') as protobuf.Namespace;
    const values = Object.values(namespace.nested ?? {});
    // 316 native IM API messages plus the Frontier Frame envelope.
    expect(values.filter((value) => value instanceof protobuf.Type)).toHaveLength(317);
    expect(values.filter((value) => value instanceof protobuf.Enum)).toHaveLength(50);
  });

  it('matches the exact request and response envelopes', () => {
    expectField('Request', 'body', 8, 'RequestBody');
    expectField('Request', 'msgTrace', 19, 'MsgTrace');
    expectField('Request', 'retryCount', 20, 'int32');
    expectField('Request', 'biz', 21, 'string');
    expectField('Request', 'access', 22, 'string');
    expect(type('Request').fields['tsSign']).toBeUndefined();
    expect(type('Request').fields['sdkCert']).toBeUndefined();
    expect(type('Request').fields['reuqestSign']).toBeUndefined();
    expectField('Response', 'retryCount', 12, 'int32');
  });

  it('keeps network setting versions separate from the IPC setting schema', () => {
    expectField('ConversationSettingInfo', 'ext', 9, 'string');
    expectField('ConversationSettingInfo', 'settingVersion', 10, 'int64');
    expectField('ConversationSettingInfo', 'setTopTime', 12, 'int64');
    expectField('ConversationSettingInfo', 'setFavoriteTime', 13, 'int64');
    expectField('ConversationSettingInfo', 'readBadgeCount', 16, 'int32');
    expectField('ConversationSettingInfo', 'extVersion', 32, 'ExtVersion');
    expect(type('ConversationSettingInfo').fields['extVersion']?.repeated).toBe(true);
    expectField('ExtVersion', 'key', 1, 'string');
    expectField('ExtVersion', 'version', 2, 'int64');
    // The unused notification remains decodable as raw protocol, not a semantic update event.
    expectField('ResponseBody', 'conversationInfoUpdatedNotify', 502, 'ConversationInfoUpdatedNotify');
  });

  it('locks command body tags and message/reference field numbers', () => {
    expectField('RequestBody', 'sendMessageBody', 100, 'SendMessageRequestBody');
    expectField('RequestBody', 'messagesPerUserInitV2Body', 203, 'MessagesPerUserInitV2RequestBody');
    expectField('RequestBody', 'getConversationListBody', 2006, 'GetUserConversationListRequestBody');
    expectField('ResponseBody', 'hasNewMessageNotify', 500, 'NewMessageNotify');
    expectField('ResponseBody', 'strangerHasNewMessageNotify', 503, 'StrangerNewMessageNotify');
    expectField('ResponseBody', 'hasNewP2pMessageNotify', 504, 'NewP2PMessageNotify');
    expectField('MessageBody', 'content', 8, 'string');
    expectField('MessageBody', 'referenceInfo', 18, 'ReferenceInfo');
    expectField('ReferenceInfo', 'referencedMessageId', 1, 'int64');
    expectField('ReferenceInfo', 'referencedMessageStatus', 4, 'MessageStatus');
  });

  it('locks native cmd922 envelopes independently of cmd921 settings', () => {
    // rawUpsertSettingExt@0x17bb44; body serializers @0x3f3268 / @0x40a90c.
    // This layout does not resolve the native type->inbox argument anomaly.
    expectField('Request', 'inboxType', 6, 'int32');
    expectField('RequestBody', 'upsertConversationSettingExtInfoBody', 922, 'UpsertConversationSettingExtInfoRequestBody');
    expectField('ResponseBody', 'upsertConversationSettingExtInfoBody', 922, 'UpsertConversationSettingExtInfoResponseBody');
    expectField('RequestBody', 'setConversationSettingInfoBody', 921, 'SetConversationSettingInfoRequestBody');
  });

  it('decodes the independently assembled native setting-ext request tags', () => {
    // Native @0x378110: id=1, short=2, type=3, string map=4.
    // Fixed protobuf bytes, not a round trip constructed with the schema under test.
    const bytes = Buffer.from('0a0167101b180222120a0d613a735f69735f666f6c646564120130', 'hex');
    const message = type('UpsertConversationSettingExtInfoRequestBody');
    expect(message.toObject(message.decode(bytes), { longs: String })).toEqual({
      conversationId: 'g', conversationShortId: '27', conversationType: 2, ext: { 'a:s_is_folded': '0' },
    });
    expect(message.fields['ext']).toMatchObject({ id: 4, map: true, keyType: 'string', type: 'string' });
  });

  it('retains empty setting_info presence and body errors on cmd922 responses', () => {
    // Native parser @0x378d00–0x378ec8: setting=1, status=2, check=3, message=4, extra=5.
    // The native consumer ignores body status/check; decoding must not erase them.
    const message = type('UpsertConversationSettingExtInfoResponseBody');
    const bytes = Buffer.from('0a001003180222016d2a0165', 'hex');
    expect(message.toObject(message.decode(bytes), { longs: String })).toEqual({
      settingInfo: {}, status: 3, checkCode: '2', checkMessage: 'm', extraInfo: 'e',
    });
    expect(message.toObject(message.decode(Buffer.alloc(0)))).toEqual({});
  });

  it('distinguishes the active stranger sync cmd2047 from the legacy list cmd1001', () => {
    // Native rawGetRecentStrangerMessagesV2@0x17ae74; outer tags @0x3f5224/0x40cba8.
    const commands = root.lookupEnum('im_proto.IMCMD').values;
    expect(commands['GET_RECENT_STRANGER_MESSAGE']).toBe(2047);
    expect(commands['GET_STRANGER_CONVERSATION_LIST']).toBe(1001);
    expectField('RequestBody', 'getRecentStrangerMessage', 2047, 'GetRecentStrangerMessageReqBody');
    expectField('ResponseBody', 'getRecentStrangerMessage', 2047, 'GetRecentStrangerMessageRespBody');
    expectField('GetRecentStrangerMessageReqBody', 'latestStrangerVersion', 1, 'int64');
    expectField('GetRecentStrangerMessageReqBody', 'earliestStrangerVersion', 2, 'int64');
    expectField('GetRecentStrangerMessageReqBody', 'source', 3, 'string');
    expectField('GetRecentStrangerMessageReqBody', 'newUser', 4, 'int32');
    expect(type('GetRecentStrangerMessageReqBody').fields['ext']).toMatchObject({
      id: 5, map: true, keyType: 'string', type: 'string',
    });
    expectField('GetRecentStrangerMessageReqBody', 'bizInfo', 6, 'string');
  });

  it('encodes the native stranger refresh sentinel and explicit zero/empty fields', () => {
    // Native serializers @0x3d4100: 08/10/1a/20/32; outer tag is fa 7f.
    // Independent fixed wire vector, not an encode/decode round trip.
    const message = type('RequestBody');
    const request = message.fromObject({ getRecentStrangerMessage: {
      latestStrangerVersion: '9223372036854775807', earliestStrangerVersion: '0',
      source: 'code_up', newUser: 0, bizInfo: '',
    } });
    expect(Buffer.from(message.encode(request).finish()).toString('hex')).toBe(
      'fa7f19' + '08ffffffffffffffff7f10001a07636f64655f757020003200',
    );
  });

  it('decodes a stranger load-more request without inventing list pagination fields', () => {
    const message = type('RequestBody');
    const bytes = Buffer.from('fa7f11086f10001a07636f64655f757020003200', 'hex');
    expect(message.toObject(message.decode(bytes), { longs: String })).toEqual({
      getRecentStrangerMessage: {
        latestStrangerVersion: '111', earliestStrangerVersion: '0',
        source: 'code_up', newUser: 0, bizInfo: '',
      },
    });
    const fields = type('GetRecentStrangerMessageReqBody').fields;
    for (const name of ['cursor', 'count', 'resetUnreadCount', 'showTotalUnread']) {
      expect(fields[name]).toBeUndefined();
    }
  });

  it('keeps grouped stranger sync metadata separate from nested message versions', () => {
    // Response serializer @0x3d51a4: next=1, repeated ConversationRecentMessage=2, hasMore=3.
    // Group serializer @0x3c5884: short=1, messages=2, version=3, badge=4, id=5, strangerInfo=8.
    // Group has version 7, nested message has version 99. These are different cursors.
    const bytes = Buffer.from('fa7f18080b1212081b12055863420178180720022a016742001801', 'hex');
    const message = type('ResponseBody');
    expect(message.toObject(message.decode(bytes), { longs: String })).toEqual({
      getRecentStrangerMessage: {
        nextStrangerVersion: '11', hasMore: true,
        messages: [{
          conversationShortId: '27', messages: [{ version: '99', content: 'x' }],
          version: '7', badgeCount: 2, conversationId: 'g', strangerInfo: {},
        }],
      },
    });
    expect(type('GetRecentStrangerMessageRespBody').fields['messages']?.repeated).toBe(true);
    expectField('ConversationRecentMessage', 'strangerInfo', 8, 'StrangerInfo');
  });

  it('preserves the difference between an empty stranger page and a missing response body', () => {
    const message = type('ResponseBody');
    expect(message.toObject(message.decode(Buffer.from('fa7f0408001800', 'hex')), { longs: String })).toEqual({
      getRecentStrangerMessage: { nextStrangerVersion: '0', hasMore: false },
    });
    expect(message.toObject(message.decode(Buffer.alloc(0)))).toEqual({});
  });

  it('rejects stranger sync bodies missing the native required fields', () => {
    // doHttpRequestSync@0x17a65c calls ParseFromString, not ParsePartialFromString.
    expect(() => type('GetRecentStrangerMessageRespBody').decode(Buffer.from('0800', 'hex'))).toThrow();
    expect(() => type('GetRecentStrangerMessageRespBody').decode(Buffer.from('1800', 'hex'))).toThrow();
    expect(() => type('GetRecentStrangerMessageReqBody').decode(Buffer.from('1000', 'hex'))).toThrow();
  });

  it('locks list, reaction and Frontier schemas that previously drifted', () => {
    expect(Object.keys(type('MessagesPerUserInitV2RequestBody').fields)).toEqual([
      'cursor', 'newUser', 'initSubType',
    ]);
    expectField('MessagesPerUserInitV2ResponseBody', 'nextCursor', 4, 'int64');
    expectField('GetUserConversationListRequestBody', 'sortType', 1, 'SortType');
    expectField('GetUserConversationListRequestBody', 'conType', 3, 'ConversationType');
    expectField('GetUserConversationListResponseBody', 'list', 1, 'ConversationInfoV2');
    expect(type('ModifyMessagePropertyRequestBody').fields['propertyList']?.repeated).toBe(false);
    expectField('RecallMessageResponseBody', 'toast', 1, 'string');
    expectField('Frame', 'payload', 8, 'bytes');
    expectField('Frame', 'logIdNew', 9, 'string');
    expectField('Frame', 'frameType', 12, 'int32');
  });
});
