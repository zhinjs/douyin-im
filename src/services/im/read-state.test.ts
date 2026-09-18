import protobuf from 'protobufjs';
import { ImReadStateApi, mergeReadCursorState, readIndexFromP2PContent } from './read-state.js';
import type { ImProtoTransport } from './transport.js';
import { decodeRequestRaw, decodeResponseRaw, encodeRequest } from './codec.js';
import { decodeWire } from './wire.js';

const address = { threadId: '700', conversationShortId: '9007199254740993', conversationType: 2 as const, inboxType: 0 };

describe('Desktop native read-index queries', () => {
  it('merges native ordinary indexes with separate minimums without treating index_min or v2 as state', () => {
    expect(mergeReadCursorState([{ uid: '22', readIndex: '100', minIndex: '-2' }], {
      statusCode: 0, statusMsg: '', readIndexes: [{ uid: '22', index: '90', indexV2: '999', minIndex: '999' }, { uid: '33' }],
      minIndexes: [{ uid: '44', index: '-9223372036854775808' }],
    })).toEqual([{ uid: '22', readIndex: '90', minIndex: '-2' }, { uid: '33', readIndex: '0', minIndex: '0' },
      { uid: '44', readIndex: '0', minIndex: '-9223372036854775808' }]);
  });

  it('parses only numeric int64 P2PSender fields without Number rounding or quoted-integer confusion', () => {
    expect(readIndexFromP2PContent('{"P2PSender":9007199254740995,"P2PSenderReadIndex":9223372036854775807,"UserId":1,"MessageId":2}'))
      .toEqual({ uid: '9007199254740995', index: '9223372036854775807' });
    for (const sender of ['"22"', '22.0', '22e0', '0', '-22', '9223372036854775808']) {
      expect(readIndexFromP2PContent(`{"P2PSender":${sender},"P2PSenderReadIndex":10}`)).toBeUndefined();
    }
    for (const value of ['"12"', '12.0', '1.2e1', 'null', '9223372036854775808']) {
      expect(readIndexFromP2PContent(`{"P2PSender":22,"P2PSenderReadIndex":${value}}`)).toEqual({ uid: '22', index: '0' });
    }
    expect(readIndexFromP2PContent('{"P2PSender":22}')).toEqual({ uid: '22', index: '0' });
    expect(readIndexFromP2PContent('{"P2PSender":22,"P2PSenderReadIndex":-1}')).toEqual({ uid: '22', index: '-1' });
    expect(readIndexFromP2PContent('{"P2PSender":"__desktop_integer__22","P2PSenderReadIndex":10}')).toBeUndefined();
    expect(readIndexFromP2PContent('{"P2PSender":"\\u005f_desktop_integer__22"}')).toBeUndefined();
    expect(readIndexFromP2PContent('{"P2PSender":22,}')).toBeUndefined();
  });
  function setup() {
    const sendCookieProto = jest.fn();
    const api = new ImReadStateApi({ sendCookieProto } as unknown as ImProtoTransport, 'device-1');
    return { sendCookieProto, api };
  }

  it.each([
    [2000, 'participantsReadIndexBody', '/v3/conversation/get_read_index'],
    [2001, 'participantsMinIndexBody', '/v3/conversation/get_min_index'],
  ] as const)('encodes cmd %s and inbox 1 with exactly native address fields', async (cmd, key, path) => {
    const { api, sendCookieProto } = setup();
    sendCookieProto.mockResolvedValue({ statusCode: 0, body: { [key]: { indexes: [
      { userId: '9007199254740995', secUid: '', index: '-9223372036854775808', indexV2: '9223372036854775807', indexMin: '-22' },
      { userId: '22' },
    ] } } });
    const result = await (cmd === 2000 ? api.getReadIndexes(address) : api.getMinIndexes(address));
    expect(result).toEqual({ statusCode: 0, statusMsg: '', indexes: [
      { uid: '9007199254740995', secUid: '', index: '-9223372036854775808', indexV2: '9223372036854775807', ...(cmd === 2000 ? { minIndex: '-22' } : {}) },
      { uid: '22' },
    ] });
    expect(sendCookieProto).toHaveBeenCalledWith(cmd, 1, path, expect.any(Object), expect.objectContaining({ deviceId: 'device-1' }));
    const wire = await encodeRequest({ token: '', cmd, inboxType: 1, body: sendCookieProto.mock.calls[0]![3] });
    expect(await decodeRequestRaw(wire)).toMatchObject({ cmd, inboxType: 1, body: { [key]: {
      conversationId: '700', conversationShortId: '9007199254740993', conversationType: 2,
    } } });
    const outerBody = decodeWire(wire).find(field => field.field === 8);
    if (outerBody?.type !== 'message') throw new Error('missing body');
    expect(outerBody.value.map(field => field.field)).toEqual([cmd]);
  });

  it('round-trips actual response proto while retaining absent optional indexes', async () => {
    const { api, sendCookieProto } = setup();
    const root = await protobuf.load(new URL('./proto/im.proto', import.meta.url).pathname);
    const type = root.lookupType('im_proto.Response');
    const response = type.fromObject({ cmd: 2000, body: { participantsReadIndexBody: { indexes: [
      { userId: '9007199254740995', index: '9007199254740997', indexMin: '-99' }, { userId: '22', index: '0' },
    ] } } });
    sendCookieProto.mockResolvedValue(await decodeResponseRaw(type.encode(response).finish()));
    await expect(api.getReadIndexes(address)).resolves.toEqual({ statusCode: 0, statusMsg: '', indexes: [
      { uid: '9007199254740995', index: '9007199254740997', minIndex: '-99' }, { uid: '22', index: '0' },
    ] });
  });

  it('uses the native batch body and unpacked int64 pairs without min_index_required', async () => {
    const { api, sendCookieProto } = setup();
    sendCookieProto.mockResolvedValue({ statusCode: 0, body: { batchGetConversationParticipantsReadindex: { conversationParticipantsReadIndex: [
      { conversationId: '700', conversationShortId: address.conversationShortId, participantReadIndex: [{ userId: '22', index: '123' }] },
    ] } } });
    const other = { ...address, threadId: '701', conversationShortId: '701' };
    await expect(api.getBatchReadIndexes([address, other, address])).resolves.toEqual({ statusCode: 0, statusMsg: '',
      conversations: [{ conversationId: '700', conversationShortId: address.conversationShortId, indexes: [{ uid: '22', index: '123' }] }], missingConversationIds: ['701'] });
    expect(sendCookieProto).toHaveBeenCalledWith(2038, 1, '/v1/conversation/batch_get_conversation_participants_readindex', expect.any(Object), expect.any(Object));
    const wire = await encodeRequest({ token: '', cmd: 2038, body: sendCookieProto.mock.calls[0]![3] });
    const decoded = await decodeRequestRaw(wire);
    expect(decoded['body']).toEqual({ batchGetConversationParticipantsReadindex: {
      conversationId: ['700', '701'], conversationShortId: [address.conversationShortId, '701'], requestFrom: 'impc-chat',
    } });
    const body = decodeWire(wire).find(field => field.field === 8);
    if (body?.type !== 'message') throw new Error('missing body');
    const batch = body.value.find(field => field.field === 2038);
    if (batch?.type !== 'message') throw new Error('missing batch');
    expect(batch.value.map(field => field.field)).toEqual([1, 1, 2, 2, 3]);
    expect(batch.value.filter(field => field.field === 2).map(field => field.type)).toEqual(['varint', 'varint']);
  });

  it('distinguishes explicit empty lists from missing, malformed and rejected responses', async () => {
    const { api, sendCookieProto } = setup();
    sendCookieProto.mockResolvedValue({ statusCode: 0, body: { participantsReadIndexBody: {} } });
    await expect(api.getReadIndexes(address)).resolves.toEqual({ statusCode: 0, statusMsg: '', indexes: [] });
    for (const body of [{}, { participantsReadIndexBody: { indexes: {} } },
      { participantsReadIndexBody: { indexes: [{ userId: '22', index: 9007199254740992 }] } },
      { participantsReadIndexBody: { indexes: [{ userId: '22' }, { userId: '22' }] } }]) {
      sendCookieProto.mockResolvedValue({ statusCode: 0, body });
      await expect(api.getReadIndexes(address)).resolves.toMatchObject({ statusCode: -3, indexes: [] });
    }
    sendCookieProto.mockResolvedValue({ statusCode: 4, errorDesc: 'INVALID_REQUEST' });
    await expect(api.getReadIndexes(address)).resolves.toEqual({ statusCode: 4, statusMsg: 'INVALID_REQUEST', indexes: [] });
  });

  it('rejects invalid addresses before network and does not hide missing batch results', async () => {
    const { api, sendCookieProto } = setup();
    await expect(api.getBatchReadIndexes([])).resolves.toMatchObject({ statusCode: 0, conversations: [] });
    for (const conversationShortId of ['', '0', '1e3', '9223372036854775808']) {
      await expect(api.getReadIndexes({ ...address, conversationShortId })).rejects.toThrow();
    }
    await expect(api.getBatchReadIndexes([address, { ...address, conversationShortId: '1' }])).rejects.toThrow('冲突');
    expect(sendCookieProto).not.toHaveBeenCalled();
    sendCookieProto.mockResolvedValue({ statusCode: 0, body: { batchGetConversationParticipantsReadindex: {} } });
    await expect(api.getBatchReadIndexes([address])).resolves.toMatchObject({ statusCode: 0, conversations: [], missingConversationIds: ['700'] });
    sendCookieProto.mockResolvedValue({ statusCode: 0, body: { batchGetConversationParticipantsReadindex: { conversationParticipantsReadIndex: [
      { conversationId: 'other', conversationShortId: '1' },
    ] } } });
    await expect(api.getBatchReadIndexes([address])).resolves.toMatchObject({ statusCode: -3, conversations: [], missingConversationIds: ['700'] });
  });

  it('returns no combined snapshot when either source fails', async () => {
    const { api, sendCookieProto } = setup();
    sendCookieProto.mockResolvedValueOnce({ statusCode: 0, body: { participantsReadIndexBody: { indexes: [{ userId: '22', index: '10' }] } } })
      .mockResolvedValueOnce({ statusCode: 4, errorDesc: 'failed min' });
    await expect(api.getState(address)).resolves.toEqual({ statusCode: 4, statusMsg: 'failed min', readIndexes: [], minIndexes: [] });
    sendCookieProto.mockRejectedValue(new Error('network'));
    await expect(api.getState(address)).rejects.toThrow('network');
  });

  it('accepts native status 200 for both single-conversation sources but still requires each body', async () => {
    const { api, sendCookieProto } = setup();
    sendCookieProto.mockResolvedValueOnce({ statusCode: 200, body: { participantsReadIndexBody: { indexes: [{ userId: '22', index: '10' }] } } })
      .mockResolvedValueOnce({ statusCode: 200, body: { participantsMinIndexBody: { indexes: [{ userId: '22', index: '2' }] } } });
    await expect(api.getState(address)).resolves.toEqual({ statusCode: 0, statusMsg: '',
      readIndexes: [{ uid: '22', index: '10' }], minIndexes: [{ uid: '22', index: '2' }] });
    sendCookieProto.mockResolvedValue({ statusCode: 200, body: {} });
    await expect(api.getReadIndexes(address)).resolves.toMatchObject({ statusCode: -3, indexes: [] });
    await expect(api.getMinIndexes(address)).resolves.toMatchObject({ statusCode: -3, indexes: [] });
  });

  it('accepts native batch status 200 while retaining missing-conversation and malformed-body distinctions', async () => {
    const { api, sendCookieProto } = setup();
    sendCookieProto.mockResolvedValue({ statusCode: 200, body: { batchGetConversationParticipantsReadindex: {} } });
    await expect(api.getBatchReadIndexes([address])).resolves.toMatchObject({ statusCode: 0, conversations: [], missingConversationIds: ['700'] });
    sendCookieProto.mockResolvedValue({ statusCode: 200, body: {} });
    await expect(api.getBatchReadIndexes([address])).resolves.toMatchObject({ statusCode: -3, conversations: [], missingConversationIds: ['700'] });
  });
});
