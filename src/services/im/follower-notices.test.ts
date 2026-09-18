import { ImFriendApi } from './friends.js';
import type { ImHttpClient } from './service.js';

function notice(uid = '22') {
  return { create_time: 123, has_read: 0, follow: { content: '关注了你', from_user: {
    uid, sec_uid: `sec-${uid}`, nickname: '昵称', remark_name: '', follow_status: 4, follower_status: 1,
    avatar_300x300: { url_list: ['https://image.invalid/first', 'https://image.invalid/second'], uri: 'avatar-uri' },
  } } };
}
function fixture(body: unknown) {
  const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(body) });
  const client = { requestRaw, getUserAgent: () => 'fixture-UA', getDeviceId: () => '123', getInstallId: () => '456' } as unknown as ImHttpClient;
  return { api: new ImFriendApi(client, 'stale'), requestRaw };
}

it('uses the Desktop read-marking query and current identity without a count or follow request', async () => {
  const { api, requestRaw } = fixture({ notice_list_v2: [notice()], has_more: 0 });
  await expect(api.readFollowerNoticePage()).resolves.toEqual({ statusCode: 0, statusMsg: '', hasMore: false, notices: [{
    uid: '22', secUid: 'sec-22', nickname: '昵称', remark: '', avatar: 'https://image.invalid/first', avatarUri: 'avatar-uri',
    createTime: 123, hasRead: 0, followStatus: 4, followerStatus: 1, content: '关注了你',
  }] });
  const [target, init, passport] = requestRaw.mock.calls[0]!;
  const url = new URL(target);
  expect(url.origin + url.pathname).toBe('https://imdesktop.douyin.com/aweme/v1/web/notice/');
  for (const [key, value] of Object.entries({ address_book_access: '1', appTheme: 'light', count: '20', gps_access: '0',
    is_mark_read: '1', is_new_notice: '1', max_time: '0', min_time: '1', notice_group: '401', top_group: '0',
    user_avatar_shrink: '144_144', video_cover_shrink: '192_192', device_id: '123', iid: '456', version_code: '1.2.1' })) {
    expect(url.searchParams.get(key)).toBe(value);
  }
  expect(init).toMatchObject({ method: 'GET', headers: { 'User-Agent': 'fixture-UA', Referer: 'https://imdesktop.douyin.com' } });
  expect(new Headers(init.headers).has('bgint_json_parser')).toBe(false);
  expect(init.body).toBeUndefined(); expect(passport).toBe(false); expect(requestRaw).toHaveBeenCalledTimes(1);
});

it('retains exact cursors, repeated users, empty text and first avatar selection in a page', async () => {
  const { api, requestRaw } = fixture({ notice_list_v2: [notice(), notice()], has_more: '1', max_time: '9007199254740993', min_time: 0 });
  const result = await api.readFollowerNoticePage('9007199254740992', '10');
  expect(result.notices).toHaveLength(2);
  expect(result).toMatchObject({ hasMore: true, maxTime: '9007199254740993', minTime: '0' });
  expect(new URL(requestRaw.mock.calls[0]![0]).searchParams.get('max_time')).toBe('9007199254740992');
});

it('parses a numeric UID larger than Number.MAX_SAFE_INTEGER losslessly', async () => {
  const body = { notice_list_v2: [notice('9007199254740993')], has_more: 0 };
  const { api, requestRaw } = fixture(body);
  requestRaw.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(body).replace('"uid":"9007199254740993"', '"uid":9007199254740993') });
  expect((await api.readFollowerNoticePage()).notices[0]?.uid).toBe('9007199254740993');
});

it.each([
  {}, { notice_list_v2: [], has_more: 2 }, { notice_list_v2: {}, has_more: 0 },
  { notice_list_v2: [null], has_more: 0 }, { notice_list_v2: [notice(), { follow: {} }], has_more: 0 },
  { notice_list_v2: [], has_more: 1 }, { notice_list_v2: [], has_more: 1, max_time: -1, min_time: 1 },
])('rejects an invalid page without reporting partial success (%p)', async body => {
  const { api, requestRaw } = fixture(body);
  await expect(api.readFollowerNoticePage()).resolves.toMatchObject({ statusCode: -3, notices: [], hasMore: false });
  expect(requestRaw).toHaveBeenCalledTimes(1);
});

it.each(['nickname', 'sec_uid', 'avatar_300x300', 'uid'])('rejects a malformed required user field %s', async field => {
  const item = notice();
  Object.assign(item.follow.from_user, { [field]: null });
  const { api } = fixture({ notice_list_v2: [item], has_more: 0 });
  expect((await api.readFollowerNoticePage()).statusCode).toBe(-3);
});

it('preserves missing optional fields and does not infer that mark-read was applied', async () => {
  const { api } = fixture({ has_more: 0, notice_list_v2: [{ follow: { from_user: {
    uid: 22, sec_uid: 'sec22', nickname: '', avatar_300x300: { url_list: [] },
  } } }] });
  expect((await api.readFollowerNoticePage()).notices).toEqual([{ uid: '22', secUid: 'sec22', nickname: '' }]);
});

it('preserves business rejection over an otherwise valid notification page', async () => {
  const { api } = fixture({ status_code: 8, status_msg: '未登录', notice_list_v2: [notice()], has_more: 0 });
  await expect(api.readFollowerNoticePage()).resolves.toEqual({ statusCode: 8, statusMsg: '未登录', notices: [], hasMore: false });
});

it.each([['-1', '1'], ['1.5', '1'], ['0', ''], ['0', 'NaN']])('rejects invalid cursor %s/%s before dispatch', async (max, min) => {
  const { api, requestRaw } = fixture({});
  await expect(api.readFollowerNoticePage(max, min)).rejects.toThrow('cursors');
  expect(requestRaw).not.toHaveBeenCalled();
});

it.each([[503, '', 'http'], [200, '', 'empty'], [200, '<html>', 'invalid-json']])('never retries failed HTTP/body reads (%s)', async (status, rawText, kind) => {
  const { api, requestRaw } = fixture({});
  requestRaw.mockResolvedValue({ ok: status === 200, status, headers: new Headers(), rawText });
  await expect(api.readFollowerNoticePage()).rejects.toMatchObject({ kind });
  expect(requestRaw).toHaveBeenCalledTimes(1);
});

it('does not retry an ambiguous network failure that may already have marked notices read', async () => {
  const { api, requestRaw } = fixture({});
  const failure = new Error('connection lost after send'); requestRaw.mockRejectedValue(failure);
  await expect(api.readFollowerNoticePage()).rejects.toBe(failure);
  expect(requestRaw).toHaveBeenCalledTimes(1);
});
