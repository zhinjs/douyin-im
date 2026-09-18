import type { ImHttpClient } from './service.js';
import { ImUserDirectory } from './user-directory.js';

describe('ImUserDirectory', () => {
  describe('explicit activity query', () => {
    function fixture(body: unknown) {
      const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(body) });
      const directory = new ImUserDirectory({ requestRaw, getUserAgent: () => 'fixture-UA', getDeviceId: () => '123',
        getInstallId: () => '456', getGuid: () => 'fixture-guid' } as unknown as ImHttpClient, 'stale');
      return { directory, requestRaw };
    }

    it('sends the exact multipart status query without activity reports or implicit batching', async () => {
      const { directory, requestRaw } = fixture({ status_code: 0, data: [], conv_data: [] });
      const secUids = Object.freeze(['sec+"一', 'sec-two', 'sec-two']);
      const convIds = Object.freeze(['0:1:10:20', '9007199254740993123']);
      await expect(directory.getActiveStatus(secUids, convIds)).resolves.toEqual({ statusCode: 0, statusMsg: '', users: [], conversations: [] });
      expect(requestRaw).toHaveBeenCalledTimes(1);
      const [input, init, passport] = requestRaw.mock.calls[0]!;
      const url = new URL(input);
      expect(url.origin + url.pathname).toBe('https://imdesktop.douyin.com/aweme/v1/web/im/user/active/status/');
      expect(Object.fromEntries((init.body as FormData).entries())).toEqual({ source: 'session_list', sec_user_ids: JSON.stringify(secUids), conv_ids: JSON.stringify(convIds) });
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ device_id: '123', did: '123', iid: '456', version_code: '1.2.1' });
      for (const key of ['action', 'new_user_login', 'source', 'sec_user_ids', 'conv_ids']) expect(url.searchParams.has(key)).toBe(false);
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).has('content-type')).toBe(false); // fetch owns the multipart boundary
      expect(new Headers(init.headers).has('bgint_json_parser')).toBe(false);
      expect(passport).toBe(false);
    });

    it('keeps server timestamps, flags and multilingual hints without claiming who is currently online', async () => {
      const { directory } = fixture({ data: [
        { sec_user_id: 'a', last_active_time: 0 }, { sec_user_id: 'b', last_active_time: -1 },
        { sec_user_id: 'c', last_active_time: 9999999999 }, { sec_user_id: 'missing' },
      ], conv_data: [
        { conv_id: '700', online: true, toast: [{ lang: 'zh', content: '群内有人在线' }, { lang: 'en', content: 'active' }] },
        { conv_id: '701', online: 0, toast: [] }, { conv_id: '702', online: 2 }, { conv_id: '703', online: false },
      ] });
      await expect(directory.getActiveStatus(['a', 'b', 'c', 'missing'], ['700', '701', '702', '703'])).resolves.toEqual({
        statusCode: 0, statusMsg: '', users: [
          { secUid: 'a', lastActiveTime: 0 }, { secUid: 'b', lastActiveTime: -1 }, { secUid: 'c', lastActiveTime: 9999999999 }, { secUid: 'missing' },
        ], conversations: [
          { conversationId: '700', online: true, toast: [{ lang: 'zh', content: '群内有人在线' }, { lang: 'en', content: 'active' }] },
          { conversationId: '701', online: 0, toast: [] }, { conversationId: '702', online: 2 }, { conversationId: '703', online: false },
        ],
      });
    });

    it.each([
      [{ data: [] }, { users: [] }], [{ conv_data: [] }, { conversations: [] }],
      [{ data: null, conv_data: null }, {}],
      [{ data: [{ sec_user_id: 'a', last_active_time: null }], conv_data: [{ conv_id: '700', online: null, toast: null }] },
        { users: [{ secUid: 'a' }], conversations: [{ conversationId: '700' }] }],
    ])('preserves partial/unknown categories without synthesizing missing targets: %j', async (body, fields) => {
      const { directory } = fixture(body);
      await expect(directory.getActiveStatus(['a', 'absent'], ['700', 'absent-conv'])).resolves.toEqual({ statusCode: 0, statusMsg: '', ...fields });
    });

    it('preserves large conversation IDs from the wire without precision loss', async () => {
      const { directory, requestRaw } = fixture({});
      requestRaw.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: '{"conv_data":[{"conv_id":9007199254740993123,"online":1}]}' });
      await expect(directory.getActiveStatus([], ['9007199254740993123'])).resolves.toEqual({ statusCode: 0, statusMsg: '', conversations: [{ conversationId: '9007199254740993123', online: 1 }] });
    });

    it.each([{ ids: null }, { ids: [''] }, { ids: [' '] }, { ids: [1] }, { ids: new Array(1) }])('rejects malformed target lists before sending: %j', async ({ ids }) => {
      const { directory, requestRaw } = fixture({});
      await expect(directory.getActiveStatus(ids as unknown as string[])).rejects.toThrow('IDs');
      await expect(directory.getActiveStatus([], ids as unknown as string[])).rejects.toThrow('IDs');
      expect(requestRaw).not.toHaveBeenCalled();
    });

    it.each([
      {}, { status_code: null, data: [] }, { data: {} }, { conv_data: {} }, { data: [null] },
      { data: [{ sec_user_id: 22 }] }, { data: [{ sec_user_id: 'a', last_active_time: '123' }] },
      { conv_data: [{ online: true }] }, { conv_data: [{ conv_id: '700', online: '1' }] },
      { conv_data: [{ conv_id: '700', toast: [{ lang: 'zh' }] }] },
    ])('rejects malformed payloads without publishing partial states: %j', async body => {
      const { directory } = fixture(body);
      const result = await directory.getActiveStatus(['a']);
      expect(result.statusCode).toBe(-3); expect(result.users).toBeUndefined(); expect(result.conversations).toBeUndefined();
    });

    it('keeps business failure even when successful-looking state accompanies it', async () => {
      const { directory } = fixture({ status_code: 8, status_msg: '未登录', data: [{ sec_user_id: 'a', last_active_time: 123 }] });
      await expect(directory.getActiveStatus(['a'])).resolves.toEqual({ statusCode: 8, statusMsg: '未登录' });
    });

    it.each([[503, '', 'http'], [200, '', 'empty'], [200, '<html>failed</html>', 'invalid-json']])('does not retry HTTP/parse failure (%s)', async (status, rawText, kind) => {
      const { directory, requestRaw } = fixture({});
      requestRaw.mockResolvedValue({ ok: status === 200, status, headers: new Headers(), rawText });
      await expect(directory.getActiveStatus(['a'])).rejects.toMatchObject({ name: 'DouyinResponseError', kind });
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('remote user search', () => {
    const user = { uid: '22', sec_uid: 'sec22', nickname: '凉菜', unique_id: 'test_handle',
      avatar_thumb: { url_list: ['', 'https://example.invalid/avatar'] }, follow_status: 4, follower_status: 1 };
    function fixture(body: unknown = { input_keyword: '凉菜', has_more: 1, user_list: [{ user_info: user }] }) {
      const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(body) });
      const directory = new ImUserDirectory({ requestRaw, getUserAgent: () => 'fixture-UA',
        getDeviceId: () => '123', getInstallId: () => '456', getGuid: () => 'fixture-guid' } as unknown as ImHttpClient, 'stale');
      return { directory, requestRaw };
    }

    it('uses Desktop user-search origin, exact parameters and 30-offset paging instead of response cursor', async () => {
      const { directory, requestRaw } = fixture({ status_code: 0, input_keyword: '凉菜', has_more: 1, cursor: 999, user_list: [{ user_info: user }] });
      await expect(directory.searchUsers('凉菜', 30)).resolves.toEqual({
        statusCode: 0, statusMsg: '', keyword: '凉菜', cursor: 30, nextCursor: 60, hasMore: true,
        users: [{ uid: '22', secUid: 'sec22', nickname: '凉菜', uniqueId: 'test_handle',
          avatarThumb: 'https://example.invalid/avatar', followStatus: 4, followerStatus: 1 }],
      });
      expect(requestRaw).toHaveBeenCalledTimes(1);
      const [input, init, passport] = requestRaw.mock.calls[0]!;
      const url = new URL(input);
      expect(url.origin).toBe('https://www.douyin.com');
      expect(url.pathname).toBe('/aweme/v1/web/discover/search/');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        keyword: '凉菜', search_source: 'search_sug', count: '30', cursor: '30', type: '1', search_scene: 'douyin_search',
        enter_from: 'homepage_hot', version_code: '21.6.0', version_name: '1.2.1', aid: '339757',
        device_id: '123', did: '123', iid: '456', awemeim_guid: 'fixture-guid',
      });
      for (const key of ['need_all_friend', 'is_mark_read', 'sec_user_id', 'notice_group', 'verifyFp']) expect(url.searchParams.has(key)).toBe(false);
      expect(init).toMatchObject({ method: 'GET', headers: { Referer: 'https://imdesktop.douyin.com', 'User-Agent': 'fixture-UA' } });
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has('bgint_json_parser')).toBe(false);
      expect(passport).toBe(false);
    });

    it.each(['', '  凉菜 & +?#🌱  '])('preserves keyword bytes through query encoding: %j', async keyword => {
      const { directory, requestRaw } = fixture({ input_keyword: keyword, has_more: 0, user_list: [] });
      await expect(directory.searchUsers(keyword)).resolves.toEqual({ statusCode: 0, statusMsg: '', keyword, cursor: 0, hasMore: false, users: [] });
      expect(new URL(requestRaw.mock.calls[0]![0]).searchParams.get('keyword')).toBe(keyword);
    });

    it('retains exact integer IDs and server result order/duplicates', async () => {
      const { directory, requestRaw } = fixture();
      requestRaw.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText:
        '{"input_keyword":"x","has_more":0,"user_list":[{"user_info":{"uid":9007199254740993123,"sec_uid":"sec-large","nickname":"one"}},{"user_info":{"uid":9007199254740993123,"sec_uid":"sec-large","nickname":"two"}}]}' });
      const result = await directory.searchUsers('x');
      expect(result.users.map(value => [value.uid, value.nickname])).toEqual([
        ['9007199254740993123', 'one'], ['9007199254740993123', 'two'],
      ]);
      expect(result.nextCursor).toBeUndefined();
    });

    it('does not seed the profile cache from search results', async () => {
      const { directory, requestRaw } = fixture();
      await directory.searchUsers('凉菜');
      requestRaw.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify({ status_code: 0, data: [user] }) });
      await directory.resolve(['sec22']);
      expect(requestRaw).toHaveBeenCalledTimes(2);
      expect(new URL(requestRaw.mock.calls[1]![0]).pathname).toBe('/aweme/v1/web/im/user/info/');
    });

    it.each([-30, 1, 29, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid cursor %s before dispatch', async cursor => {
      const { directory, requestRaw } = fixture();
      await expect(directory.searchUsers('凉菜', cursor)).rejects.toThrow('cursor');
      expect(requestRaw).not.toHaveBeenCalled();
    });

    it('does not coerce non-string keywords into a request', async () => {
      const { directory, requestRaw } = fixture();
      await expect(directory.searchUsers(null as unknown as string)).rejects.toThrow('keyword');
      expect(requestRaw).not.toHaveBeenCalled();
    });

    it.each([
      {}, { input_keyword: 'other', has_more: 0, user_list: [] },
      { input_keyword: '凉菜', user_list: [] }, { input_keyword: '凉菜', has_more: '1', user_list: [] },
      { input_keyword: '凉菜', has_more: -1, user_list: [] }, { input_keyword: '凉菜', has_more: 0, user_list: null },
      { input_keyword: '凉菜', has_more: 0, user_list: [null] },
      { input_keyword: '凉菜', has_more: 0, user_list: [{ user_info: { uid: '22' } }] },
      { input_keyword: '凉菜', has_more: 0, user_list: [{ user_info: { uid: '0', sec_uid: 'sec0' } }] },
      { status_code: '0', input_keyword: '凉菜', has_more: 0, user_list: [] },
    ])('does not pretend a mismatched or malformed page is a successful empty search: %j', async body => {
      const { directory } = fixture(body);
      await expect(directory.searchUsers('凉菜')).resolves.toMatchObject({ statusCode: -3, hasMore: false, users: [] });
    });

    it('returns business errors without leaking result data', async () => {
      const { directory, requestRaw } = fixture({ status_code: 8, status_msg: '未登录', input_keyword: '凉菜', has_more: 1, user_list: [{ user_info: user }] });
      await expect(directory.searchUsers('凉菜')).resolves.toEqual({ statusCode: 8, statusMsg: '未登录', keyword: '凉菜', cursor: 0, hasMore: false, users: [] });
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });

    it.each([[503, '', 'http'], [200, '', 'empty'], [200, '<html>challenge</html>', 'invalid-json']])('does not retry HTTP/parse failure (%s)', async (status, rawText, kind) => {
      const { directory, requestRaw } = fixture();
      requestRaw.mockResolvedValue({ ok: status === 200, status, headers: new Headers(), rawText });
      await expect(directory.searchUsers('凉菜')).rejects.toMatchObject({ name: 'DouyinResponseError', kind });
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });
  });

  it('resolves and caches nickname/avatar with Desktop batched IM user info', async () => {
    const requestRaw = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      rawText: JSON.stringify({
        status_code: 0,
        data: [{
          uid: '3138463854771706',
          sec_uid: 'MS4peer',
          nickname: '对端昵称',
          avatar_thumb: { url_list: ['https://example.com/avatar.jpeg'] },
        }],
      }),
    });
    const client = {
      getUserAgent: () => 'fixture-UA',
      getCookies: () => 'sessionid=<REDACTED>',
      getInstallId: () => 'installed-id',
      requestRaw,
    } as unknown as ImHttpClient;
    const directory = new ImUserDirectory(client, '3241234567');

    const first = await directory.resolve(['MS4peer', 'MS4peer']);
    const second = await directory.resolve(['MS4peer']);

    expect(first).toEqual([{
      uid: '3138463854771706',
      secUid: 'MS4peer',
      nickname: '对端昵称',
      avatarThumb: 'https://example.com/avatar.jpeg',
    }]);
    expect(second).toEqual(first);
    expect(requestRaw).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = requestRaw.mock.calls[0]!;
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe(
      'https://imdesktop.douyin.com/aweme/v1/web/im/user/info/',
    );
    expect(url.searchParams.get('aid')).toBe('339757');
    expect(url.searchParams.get('iid')).toBe('installed-id');
    expect(url.searchParams.get('device_id')).toBe('3241234567');
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({ sec_user_ids: '["MS4peer"]' });
    expect(init.method).toBe('POST');
  });

  it('batches by 50, ignores foreign/unsafe identities and retries missing enrichment on later reads', async () => {
    const requestRaw = jest.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce({ ok: true, status: 200, rawText: JSON.stringify({ status_code: 0, data: [
        { uid: '51', sec_uid: 'sec50', nickname: 'last' },
        { uid: '3', sec_uid: 'foreign', nickname: 'foreign' },
        { uid: 9007199254740992, sec_uid: 'sec0', nickname: 'rounded' },
      ] }) })
      .mockResolvedValue({ ok: true, status: 200, rawText: JSON.stringify({ status_code: 0, data: [
        { uid: '1', sec_uid: 'sec0', nickname: 'first' },
      ] }) });
    const directory = new ImUserDirectory({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    const input = Array.from({ length: 51 }, (_, i) => `sec${i}`);
    expect(await directory.resolve(input)).toEqual([{ uid: '51', secUid: 'sec50', nickname: 'last' }]);
    expect(JSON.parse(requestRaw.mock.calls[0]![1].body.get('sec_user_ids'))).toHaveLength(50);
    expect(JSON.parse(requestRaw.mock.calls[1]![1].body.get('sec_user_ids'))).toEqual(['sec50']);
    expect(await directory.resolve(['sec0', 'sec50'])).toEqual([
      { uid: '1', secUid: 'sec0', nickname: 'first' }, { uid: '51', secUid: 'sec50', nickname: 'last' },
    ]);
  });

  it('reads a fresh Desktop profile with source=together and preserves relation states', async () => {
    const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, rawText: JSON.stringify({
      status_code: 0, user: { uid: '22', sec_uid: 'sec22', follow_status: 4, follower_status: 1, nickname: 'peer' },
    }) });
    const directory = new ImUserDirectory({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');
    await expect(directory.getProfile('sec22')).resolves.toMatchObject({ followStatus: 4, followerStatus: 1 });
    const url = new URL(requestRaw.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe('https://imdesktop.douyin.com/aweme/v1/web/user/profile/other/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ aid: '339757', sec_user_id: 'sec22', source: 'together' });
    expect(requestRaw.mock.calls[0]![1].method).toBe('GET');
  });

  it('uses the desktop relationship endpoint for block and unblock', async () => {
    const requestRaw = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      rawText: JSON.stringify({ status_code: 0, status_msg: 'ok' }),
    });
    const directory = new ImUserDirectory({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, 'device');

    await expect(directory.setBlocked({
      uid: '3138463854771706',
      secUid: 'MS4peer',
      blocked: true,
    })).resolves.toEqual({ statusCode: 0, statusMsg: 'ok' });

    const url = new URL(requestRaw.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://imdesktop.douyin.com/aweme/v1/web/user/block/',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      aid: '339757',
      user_id: '3138463854771706',
      sec_user_id: 'MS4peer',
      block_type: '1',
      source: '0',
    });
  });
});
