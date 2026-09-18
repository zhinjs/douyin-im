import { ImUserSettingsApi, filterReadReceipt, type MessageReadPrivacyQuery, type MessageReadPrivacyResponse } from './user-settings.js';
import type { ImHttpClient } from './service.js';

const query: MessageReadPrivacyQuery = { serverMessageId: '7684206858655056411', conversationId: '7684206858655056410',
  conversationShortId: '7684206858655056410', conversationType: 2, createTime: 1789123456789 };
const response = (rawText: string) => ({ ok: true, status: 200, headers: new Headers(), rawText });

describe('message read privacy transport', () => {
  it('sends unquoted intact int64 IDs and keeps response IDs lossless', async () => {
    const requestRaw = jest.fn().mockResolvedValue(response(`{"current_user_switch":0,"msg_ids_resp":[{"msg_id":${query.serverMessageId},"err_code":0,"on":[9007199254740993,22],"off":[]}]}`));
    const api = new ImUserSettingsApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    await expect(api.getMessageReadPrivacy([query])).resolves.toEqual({ statusCode: 0, statusMsg: '', currentUserSwitch: 0, enableReadState: true,
      messages: [{ serverMessageId: query.serverMessageId, errorCode: 0, on: ['9007199254740993', '22'], off: [] }] });
    const [url, init] = requestRaw.mock.calls[0]!;
    expect(new URL(url).pathname).toBe('/aweme/v1/im_communication/msg_read_switch/');
    expect(init.body).toBe(`{"source":"msg_tab","is_retry":false,"msg_ids":[{"msg_id":${query.serverMessageId},"conv_id":"${query.conversationId}","conv_short_id":${query.conversationShortId},"create_time":1789123456789,"conv_type":2}]}`);
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json;charset=utf-8', bgint_json_parser: '2' });
  });

  it('deduplicates, omits unsent IDs, splits 51 messages into 50+1, and retries reads with is_retry', async () => {
    const requestRaw = jest.fn().mockRejectedValueOnce(new Error('network')).mockImplementation(async (_url, init) => {
      const ids = [...String(init.body).matchAll(/"msg_id":(\d+)/g)].map(match => match[1]);
      return response(JSON.stringify({ current_user_switch: 0, msg_ids_resp: ids.map(msg_id => ({ msg_id, err_code: 0 })) }));
    });
    const api = new ImUserSettingsApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    const queries = Array.from({ length: 51 }, (_, i) => ({ ...query, serverMessageId: String(1000 + i) }));
    const result = await api.getMessageReadPrivacy([...queries, queries[0]!, { ...query, serverMessageId: '0' }]);
    expect(result.messages).toHaveLength(51);
    expect(requestRaw).toHaveBeenCalledTimes(3);
    const bodies = requestRaw.mock.calls.map(call => JSON.parse(call[1].body));
    expect(bodies.map(body => body.msg_ids.length)).toEqual([50, 50, 1]);
    expect(bodies.map(body => body.is_retry)).toEqual([false, true, false]);
    requestRaw.mockClear();
    await expect(api.getMessageReadPrivacy([])).resolves.toEqual({ statusCode: 0, statusMsg: '', messages: [] });
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it('validates the whole batch before requesting and safely quotes conversation IDs', async () => {
    const requestRaw = jest.fn().mockResolvedValue(response('{"current_user_switch":-1,"msg_ids_resp":[]}'));
    const api = new ImUserSettingsApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    for (const invalid of [{ ...query, serverMessageId: '01' }, { ...query, createTime: NaN },
      { ...query, conversationShortId: '9223372036854775808' }, { ...query, serverMessageId: 123 }]) {
      await expect(api.getMessageReadPrivacy([query, invalid as MessageReadPrivacyQuery])).rejects.toThrow('Invalid');
    }
    await expect(api.getMessageReadPrivacy([query, { ...query, createTime: 0 }])).rejects.toThrow('Conflicting');
    expect(requestRaw).not.toHaveBeenCalled();
    const unusual = { ...query, conversationId: 'x"\\\nmsg_id:999' };
    await api.getMessageReadPrivacy([unusual]);
    expect(JSON.parse(requestRaw.mock.calls[0]![1].body).msg_ids[0].conv_id).toBe(unusual.conversationId);
  });

  it('caps transport retries at five and never retries business rejection', async () => {
    const requestRaw = jest.fn().mockRejectedValue(new Error('network'));
    const api = new ImUserSettingsApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    await expect(api.getMessageReadPrivacy([query])).rejects.toThrow('network');
    expect(requestRaw).toHaveBeenCalledTimes(5);
    requestRaw.mockReset().mockResolvedValue(response('{"status_code":8,"status_msg":"not logged in"}'));
    await expect(api.getMessageReadPrivacy([query])).resolves.toEqual({ statusCode: 8, statusMsg: 'not logged in', messages: [] });
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('does not return policies when display is disabled or retain them on a later query', async () => {
    const requestRaw = jest.fn().mockResolvedValue(response('{"current_user_switch":-1,"msg_ids_resp":[]}'));
    const api = new ImUserSettingsApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    await expect(api.getMessageReadPrivacy([query])).resolves.toMatchObject({ statusCode: 0, enableReadState: false, messages: [] });
    requestRaw.mockResolvedValue(response(JSON.stringify({ current_user_switch: 0, msg_ids_resp: [{ msg_id: query.serverMessageId, err_code: 0 }] })));
    await expect(api.getMessageReadPrivacy([query])).resolves.toMatchObject({ enableReadState: true, messages: [{ serverMessageId: query.serverMessageId }] });
    expect(requestRaw).toHaveBeenCalledTimes(2);
  });

  it('uses the final current-user switch after all batches, not an earlier page value', async () => {
    const requestRaw = jest.fn().mockImplementation(async (_url, init) => {
      const ids = [...String(init.body).matchAll(/"msg_id":(\d+)/g)].map(match => match[1]);
      return response(JSON.stringify({ current_user_switch: ids.length === 50 ? -1 : 0,
        msg_ids_resp: ids.map(msg_id => ({ msg_id, err_code: 0 })) }));
    });
    const api = new ImUserSettingsApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    const result = await api.getMessageReadPrivacy(Array.from({ length: 51 }, (_, i) => ({ ...query, serverMessageId: String(100 + i) })));
    expect(result.enableReadState).toBe(true);
    expect(result.messages).toHaveLength(51);
    expect(requestRaw).toHaveBeenCalledTimes(2);
  });

  it.each([
    [], [{ msg_id: 'other', err_code: 0 }], [{ msg_id: query.serverMessageId, err_code: 0, on: ['invalid'] }],
    [{ msg_id: query.serverMessageId, err_code: 0 }, { msg_id: query.serverMessageId, err_code: 0 }],
    [{ msg_id: query.serverMessageId }],
  ].map(items => ({ items })))('does not let malformed/incomplete responses permit display: %j', async ({ items }) => {
    const requestRaw = jest.fn().mockResolvedValue(response(JSON.stringify({ current_user_switch: 0, msg_ids_resp: items })));
    const api = new ImUserSettingsApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    await expect(api.getMessageReadPrivacy([query])).resolves.toMatchObject({ statusCode: -3, messages: [] });
  });
});

describe('Desktop read visibility projection (not receipt generation)', () => {
  const native = { serverMessageId: query.serverMessageId, readUsers: [{ uid: '11' }, { uid: '22' }, { uid: '33' }], isAllRead: true };
  function policy(on: string[] = [], off: string[] = []): MessageReadPrivacyResponse {
    return { statusCode: 0, statusMsg: '', enableReadState: true, currentUserSwitch: 0,
      messages: [{ serverMessageId: query.serverMessageId, errorCode: 0, on, off }] };
  }
  it('uses on before off, otherwise excludes off or preserves all, without mutating native readers', () => {
    expect(filterReadReceipt(native, policy(['22'], ['22']))).toEqual({ readUsers: [{ uid: '22' }], isAllRead: false });
    expect(filterReadReceipt(native, policy([], ['22']))).toEqual({ readUsers: [{ uid: '11' }, { uid: '33' }], isAllRead: false });
    expect(filterReadReceipt(native, policy())).toEqual({ readUsers: native.readUsers, isAllRead: true });
    expect(filterReadReceipt({ ...native, isAllRead: false }, policy()).isAllRead).toBe(false);
    expect(native.readUsers).toHaveLength(3);
  });
  it('hides readers for missing, failed or disabled policies, never inventing group readers', () => {
    const failed = policy(); failed.messages[0]!.errorCode = 3;
    const unknown = policy(); delete unknown.enableReadState;
    for (const response of [failed, { ...policy(), messages: [] }, { ...policy(), statusCode: -3 },
      { ...policy(), enableReadState: false }, unknown]) {
      expect(filterReadReceipt(native, response)).toEqual({ readUsers: [], isAllRead: false });
    }
  });
  it('preserves the renderer length-equality rule for an empty raw all-read input with no valid per-message policy', () => {
    // Normal local native aggregation does not produce empty+allRead; the projection itself adds no nonempty gate.
    const empty = { ...native, readUsers: [], isAllRead: true };
    expect(filterReadReceipt(empty, { ...policy(), messages: [] })).toEqual({ readUsers: [], isAllRead: true });
    const failed = policy(); failed.messages[0]!.errorCode = 3;
    expect(filterReadReceipt(empty, failed)).toEqual({ readUsers: [], isAllRead: true });
    expect(filterReadReceipt(empty, { ...failed, enableReadState: false })).toEqual({ readUsers: [], isAllRead: false });
  });
});
