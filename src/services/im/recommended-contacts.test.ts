import { ImFriendApi } from './friends.js';
import type { ImHttpClient } from './service.js';
import type { RecommendedContactsResponse } from '../../index.js';

function fixture(body: unknown) {
  const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(body) });
  const client = { requestRaw, getUserAgent: () => 'fixture-UA', getDeviceId: () => '123', getInstallId: () => '456' } as unknown as ImHttpClient;
  return { api: new ImFriendApi(client, 'stale-device', 'fixture-guid'), requestRaw };
}

it('queries the exact Desktop endpoint with current common identity and no pagination or special parser header', async () => {
  const { api, requestRaw } = fixture({ friends: [{ name: '推荐', url: 'https://image.invalid/avatar', sec_uid: 'sec22', active_time: 123 }] });
  const result: RecommendedContactsResponse = await api.getRecommendedContacts();
  expect(result).toEqual({ statusCode: 0, statusMsg: '', contacts: [{ name: '推荐', avatar: 'https://image.invalid/avatar', secUid: 'sec22', lastActiveTime: 123 }] });
  const [target, init, passport] = requestRaw.mock.calls[0]!;
  const url = new URL(target);
  expect(url.origin + url.pathname).toBe('https://imdesktop.douyin.com/aweme/v1/web/im/friend/recommend/');
  for (const [key, value] of Object.entries({ source: 'im_desktop', aid: '339757', version_code: '1.2.1', version_name: '1.2.1',
    device_id: '123', did: '123', iid: '456', awemeim_guid: 'fixture-guid' })) expect(url.searchParams.get(key)).toBe(value);
  for (const name of ['count', 'cursor', 'is_mark_read', 'user_id', 'sec_user_id', 'a_bogus']) expect(url.searchParams.has(name)).toBe(false);
  expect(init).toMatchObject({ method: 'GET', headers: { Accept: 'application/json, text/plain, */*', Referer: 'https://imdesktop.douyin.com', 'User-Agent': 'fixture-UA' } });
  expect(new Headers(init.headers).has('bgint_json_parser')).toBe(false);
  expect(init.body).toBeUndefined(); expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(passport).toBe(false); expect(requestRaw).toHaveBeenCalledTimes(1);
});

it('preserves source order, repeated contacts and raw activity, without inferring UID, group type or recommendation reason', async () => {
  const { api } = fixture({ friends: [
    { name: 'inactive', url: '', sec_uid: 'repeat', active_time: -1, uid: '22', follow_status: 2, recommend_reason: 'ignored' },
    { name: 'active', sec_uid: 'second', active_time: 123 },
    { name: 'again', sec_uid: 'repeat', active_time: 0 },
    { name: 'unknown', conversation_id: '700' },
    {},
  ] });
  expect((await api.getRecommendedContacts()).contacts).toEqual([
    { name: 'inactive', avatar: '', secUid: 'repeat', lastActiveTime: -1 },
    { name: 'active', secUid: 'second', lastActiveTime: 123 },
    { name: 'again', secUid: 'repeat', lastActiveTime: 0 },
    { name: 'unknown', conversationId: '700' }, {},
  ]);
});

it('keeps empty strings, omits nullable fields, and preserves a numeric conversation ID above 2^53', async () => {
  const { api, requestRaw } = fixture({});
  requestRaw.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText:
    '{"friends":[{"name":"","url":null,"sec_uid":"","active_time":null,"conversation_id":9007199254740993},{"conversation_id":700}]}' });
  expect((await api.getRecommendedContacts()).contacts).toEqual([{ name: '', secUid: '', conversationId: '9007199254740993' }, { conversationId: '700' }]);
});

it.each([{}, { friends: [] }, { friends: null }, { friends: false }, { friends: 0 }, { friends: '' }])(
  'uses an empty query result for an absent/falsy Desktop list (%p)', async body => {
    const { api, requestRaw } = fixture(body);
    await expect(api.getRecommendedContacts()).resolves.toEqual({ statusCode: 0, statusMsg: '', contacts: [] });
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

it.each([{ friends: {} }, { friends: 'wrong' }, { friends: [null] }, { friends: [[]] }, { friends: [{ name: 1 }] },
  { friends: [{ url: {} }] }, { friends: [{ sec_uid: 22 }] }, { friends: [{ active_time: '123' }] },
  { friends: [{ conversation_id: false }] }, { friends: [{ conversation_id: 1.5 }] },
])('rejects malformed present fields without returning partial contacts (%p)', async body => {
  const { api, requestRaw } = fixture(body);
  await expect(api.getRecommendedContacts()).resolves.toMatchObject({ statusCode: -3, contacts: [] });
  expect(requestRaw).toHaveBeenCalledTimes(1);
});

it('does not silently discard a valid prefix when a later item is invalid', async () => {
  const { api } = fixture({ friends: [{ name: 'valid', sec_uid: 'sec22' }, { active_time: {} }] });
  await expect(api.getRecommendedContacts()).resolves.toMatchObject({ statusCode: -3, contacts: [] });
});

it('keeps business failure visible even when the root includes a list', async () => {
  const { api } = fixture({ status_code: 8, status_msg: '未登录', friends: [{ sec_uid: 'sec22' }] });
  await expect(api.getRecommendedContacts()).resolves.toEqual({ statusCode: 8, statusMsg: '未登录', contacts: [] });
});

it.each(['0', false, null])('does not treat invalid status_code %p as a successful read', async status_code => {
  const { api } = fixture({ status_code, friends: [] });
  expect((await api.getRecommendedContacts()).statusCode).toBe(-3);
});

it.each([[503, '', 'http'], [200, '', 'empty'], [200, '<html>', 'invalid-json']])(
  'reports HTTP/body failure without detached retries (%s)', async (status, rawText, kind) => {
    const { api, requestRaw } = fixture({});
    requestRaw.mockResolvedValue({ ok: status === 200, status, headers: new Headers(), rawText });
    await expect(api.getRecommendedContacts()).rejects.toMatchObject({ kind });
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

it('does not convert a network failure to a successful empty list or start another request', async () => {
  const { api, requestRaw } = fixture({});
  const failure = new Error('fixture transport lost'); requestRaw.mockRejectedValue(failure);
  await expect(api.getRecommendedContacts()).rejects.toBe(failure);
  expect(requestRaw).toHaveBeenCalledTimes(1);
});
