import type { ImHttpClient } from './service.js';
import { ImFriendApi } from './friends.js';
import { ApiConnection } from '../../desktop/api-connection.js';

describe('ImFriendApi', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('new follower notification count', () => {
    function fixture(body: unknown) {
      const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(body) });
      const api = new ImFriendApi({ requestRaw, getUserAgent: () => 'fixture-UA', getDeviceId: () => '123',
        getInstallId: () => '456', hasBoundTicket: () => false } as unknown as ImHttpClient, 'stale', 'fixture-guid');
      return { api, requestRaw };
    }

    it('uses only the Desktop count query, not the mark-read notification list', async () => {
      const { api, requestRaw } = fixture({ status_code: 0, notice_count: [{ group: 400, count: 999 }, { group: 401, count: 7 }] });
      await expect(api.getNewFollowerCount()).resolves.toEqual({ statusCode: 0, statusMsg: '', count: 7 });
      expect(requestRaw).toHaveBeenCalledTimes(1);
      const [input, init, passport] = requestRaw.mock.calls[0]!;
      const url = new URL(input);
      expect(url.origin).toBe('https://imdesktop.douyin.com');
      expect(url.pathname).toBe('/aweme/v1/web/notice/count/');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        is_new_notice: '1', need_social_count: '1', version_code: '1.2.1', version_name: '1.2.1',
        aid: '339757', device_id: '123', did: '123', iid: '456', awemeim_guid: 'fixture-guid',
      });
      for (const key of ['is_mark_read', 'notice_group', 'count', 'cursor', 'max_time', 'min_time', 'user_id', 'secUid', 'verifyFp']) {
        expect(url.searchParams.has(key)).toBe(false);
      }
      expect(init).toMatchObject({ method: 'GET', headers: { Referer: 'https://imdesktop.douyin.com', 'User-Agent': 'fixture-UA' } });
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has('bgint_json_parser')).toBe(false);
      expect(passport).toBe(false);
    });

    it.each([0, 8, Number.MAX_SAFE_INTEGER])('preserves an explicit count %s without requiring status_code', async count => {
      const { api } = fixture({ notice_count: [{ group: '401', count }, { group: 401, count: 99 }] });
      await expect(api.getNewFollowerCount()).resolves.toEqual({ statusCode: 0, statusMsg: '', count });
    });

    it.each([{ notice_count: [] }, { notice_count: [{ group: 400, count: 12 }] }, { notice_count: [{ g: 401, c: 7 }] }])('does not invent zero or use push-channel aliases: %j', async ({ notice_count }) => {
      const { api } = fixture({ status_code: 0, notice_count });
      await expect(api.getNewFollowerCount()).resolves.toEqual({ statusCode: 0, statusMsg: '' });
    });

    it.each([
      {}, { notice_count: null }, { notice_count: {} }, { notice_count: [null] },
      { notice_count: [{ group: 401 }] }, { notice_count: [{ group: 401, count: '3' }] },
      { notice_count: [{ group: 401, count: -1 }] }, { notice_count: [{ group: 401, count: 1.5 }] },
      { notice_count: [{ group: 401, count: Number.MAX_SAFE_INTEGER + 1 }] },
      { status_code: null, notice_count: [] }, { status_code: '0', notice_count: [] },
    ])('rejects malformed data instead of reporting a successful zero: %j', async body => {
      const { api } = fixture(body);
      const result = await api.getNewFollowerCount();
      expect(result.statusCode).toBe(-3);
      expect(result.count).toBeUndefined();
    });

    it('preserves business failure and never accepts an accompanying count', async () => {
      const { api, requestRaw } = fixture({ status_code: 8, status_msg: '未登录', notice_count: [{ group: 401, count: 5 }] });
      await expect(api.getNewFollowerCount()).resolves.toEqual({ statusCode: 8, statusMsg: '未登录' });
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });

    it.each([
      [503, '', 'http'], [200, '', 'empty'], [200, '<html>failure</html>', 'invalid-json'],
    ])('preserves HTTP/parse failure without retry (%s)', async (status, rawText, kind) => {
      const { api, requestRaw } = fixture({});
      requestRaw.mockResolvedValue({ ok: status === 200, status, headers: new Headers(), rawText });
      await expect(api.getNewFollowerCount()).rejects.toMatchObject({ name: 'DouyinResponseError', kind });
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });

    it('does not swallow or retry transport failures', async () => {
      const { api, requestRaw } = fixture({});
      const failure = new Error('fixture connection lost');
      requestRaw.mockRejectedValue(failure);
      await expect(api.getNewFollowerCount()).rejects.toBe(failure);
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the account connection identity in both follow query and final HTTP headers', async () => {
    const sent: { query: URLSearchParams; headers: Headers }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push({ query: new URL(String(input)).searchParams, headers: new Headers(init?.headers) });
      return Response.json({ status_code: 0, follow_status: 1 });
    });
    for (const identity of ['first', 'second']) {
      const userAgent = `Mozilla/5.0 (${identity} synthetic Desktop) fixture/1.2.1`;
      const connection = new ApiConnection({ userAgent, enableABogus: false });
      // Only identity propagation is under test, not ticket issuance or server acceptance.
      jest.spyOn(connection, 'hasBoundTicket').mockReturnValue(true);
      await new ImFriendApi(connection, '123', 'fixture-guid').setFollowed({ uid: '456', secUid: 'fixture-sec', followed: true });
      expect(sent.at(-1)!.query.get('browser_version')).toBe(userAgent.replace(/^Mozilla\//, ''));
      expect(sent.at(-1)!.headers.get('user-agent')).toBe(userAgent);
    }
    expect(sent).toHaveLength(2);
  });
  const followOptions = { uid: '3138463854771706', secUid: 'MS4peer', followed: true };

  it.each([true, false])('preserves Desktop empty POST headers through the final Request (%s)', async followed => {
    const requests: Request[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push(new Request(String(input), init));
      return Response.json({ status_code: 0, follow_status: followed ? 1 : 0 });
    });
    const connection = new ApiConnection({ deviceId: '10002', installId: '10003' });
    // This checks request construction, not actual ticket issuance/acceptance.
    jest.spyOn(connection, 'hasBoundTicket').mockReturnValue(true);
    await new ImFriendApi(connection).setFollowed({ ...followOptions, followed });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(request.headers.get('accept')).toBe('application/json, text/plain, */*');
    expect(request.headers.has('bgint_json_parser')).toBe(false);
    expect(await request.text()).toBe('');
    expect(new URL(request.url).searchParams.get('type')).toBe(followed ? '1' : '0');
  });

  function followFixture(body: unknown, headers = new Headers(), bound = true) {
    const requestRaw = jest.fn().mockResolvedValue({
      ok: true, status: 200, headers, rawText: JSON.stringify(body),
    });
    const api = new ImFriendApi({
      requestRaw, getUserAgent: () => 'fixture-UA', hasBoundTicket: () => bound, getInstallId: () => 'installed-id',
    } as unknown as ImHttpClient, '3241234567', 'my-guid');
    return { api, requestRaw };
  }

  it('sends follow as a signed Desktop empty-body POST with camel-case secUid', async () => {
    const { api, requestRaw } = followFixture({ status_code: 0, follow_status: 2 });
    await expect(api.setFollowed(followOptions)).resolves.toEqual({ statusCode: 0, statusMsg: '', followStatus: 2 });
    const [input, init, passport] = requestRaw.mock.calls[0]!;
    const url = new URL(input);
    expect(url.origin).toBe('https://imdesktop.douyin.com');
    expect(url.pathname).toBe('/aweme/v1/web/commit/follow/user/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      aid: '339757', iid: 'installed-id', awemeim_guid: 'my-guid', user_id: followOptions.uid,
      secUid: 'MS4peer', type: '1', tag: 'frienddetail', verifyFp: 'verify_3241234567',
    });
    expect(url.searchParams.has('sec_user_id')).toBe(false);
    expect(init).toMatchObject({ method: 'POST', body: '' });
    expect(passport).toBe(false);
  });

  it.each([0, 1, 2, 4])('preserves server follow_status=%s, including pending requests', async (followStatus) => {
    const { api, requestRaw } = followFixture({ status_code: 0, follow_status: followStatus });
    await expect(api.setFollowed({ ...followOptions, followed: false })).resolves.toMatchObject({ statusCode: 0, followStatus });
    expect(new URL(requestRaw.mock.calls[0]![0]).searchParams.get('type')).toBe('0');
  });

  it.each([
    {}, { status_code: 0 }, { status_code: 0, follow_status: 3 },
    { status_code: 0, follow_status: '1' }, { status_code: 3058, follow_status: 1 },
  ])('never claims an incomplete or rejected response succeeded: %j', async (body) => {
    const { api } = followFixture(body);
    const result = await api.setFollowed(followOptions);
    expect(result.statusCode).not.toBe(0);
    expect(result.followStatus).toBeUndefined();
  });

  it.each([
    ['x-tt-verify-passport-decision', 'passport-decision'],
    ['bdturing-verify', 'bdturing'],
  ])('recognizes %s even with a successful-looking JSON body; never auto-retries', async (header, source) => {
    const { api, requestRaw } = followFixture({ status_code: 0, follow_status: 1 }, new Headers({ [header]: '{"detail":"challenge-private-data"}' }));
    await expect(api.setFollowed(followOptions)).rejects.toMatchObject({ source });
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects unbound Sessions before any relationship mutation', async () => {
    const { api, requestRaw } = followFixture({}, new Headers(), false);
    await expect(api.setFollowed(followOptions)).rejects.toThrow('安全票据');
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it.each(['', '{broken', 'false', '0', '"text"'].flatMap(rawText =>
    [false, true].map(passport => ({ rawText, passport }))))(
    'rejects primitive BDTuring response before either challenge ($rawText, passport=$passport)', async ({ rawText, passport }) => {
      const headers = new Headers({ 'bdturing-verify': '{"detail":"private-captcha"}' });
      if (passport) headers.set('x-tt-verify-passport-decision', '{"detail":"private-decision"}');
      const { api, requestRaw } = followFixture({});
      requestRaw.mockResolvedValue({ ok: true, status: 200, headers, rawText });
      await expect(api.setFollowed(followOptions)).rejects.toMatchObject({
        name: 'DouyinResponseError', kind: rawText ? 'invalid-json' : 'empty',
      });
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });

  it('does not turn null plus a BDTuring header into a resumable challenge', async () => {
    const { api, requestRaw } = followFixture(null, new Headers({ 'bdturing-verify': '{"detail":"private-captcha"}' }));
    await expect(api.setFollowed(followOptions)).rejects.toMatchObject({ name: 'DouyinResponseError', kind: 'invalid-json' });
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it.each(['', '{broken', 'null', 'false', '0', '"text"', '{}', '[]'])(
    'preserves Passport-only handling before body validation (%s)', async rawText => {
      const { api, requestRaw } = followFixture({});
      requestRaw.mockResolvedValue({ ok: true, status: 200, rawText,
        headers: new Headers({ 'x-tt-verify-passport-decision': '{"detail":"private-decision"}' }) });
      await expect(api.setFollowed(followOptions)).rejects.toMatchObject({ source: 'passport-decision' });
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });

  it.each([null, {}, []])('preserves Passport priority for both headers on %j', async body => {
    const { api } = followFixture(body, new Headers({
      'x-tt-verify-passport-decision': '{"detail":"private-decision"}',
      'bdturing-verify': '{"detail":"private-captcha"}',
    }));
    await expect(api.setFollowed(followOptions)).rejects.toMatchObject({ source: 'passport-decision' });
  });

  it.each([302, 401, 429, 503])('rejects HTTP %s before entering follow verification or accepting relationship state', async status => {
    const { api, requestRaw } = followFixture({ status_code: 0, follow_status: 1 });
    requestRaw.mockResolvedValue({
      ok: false, status,
      headers: new Headers({
        'x-tt-verify-passport-decision': '{"detail":"fixture-decision"}',
        'bdturing-verify': '{"detail":"fixture-captcha"}',
      }),
      rawText: status === 503 ? '' : '{"status_code":0,"follow_status":1}',
    });
    await expect(api.setFollowed(followOptions)).rejects.toMatchObject({
      name: 'DouyinResponseError', kind: 'http', status,
    });
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('does not demand a ticket when the Desktop startup policy does not protect follow', async () => {
    const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(),
      rawText: '{"status_code":8,"status_msg":"not logged in"}' });
    const requiresTicket = jest.fn().mockReturnValue(false);
    const api = new ImFriendApi({ requestRaw, getUserAgent: () => 'fixture-UA', requiresTicket, hasBoundTicket: () => false } as unknown as ImHttpClient);
    await expect(api.setFollowed(followOptions)).resolves.toMatchObject({ statusCode: 8 });
    expect(requiresTicket).toHaveBeenCalledWith('https://imdesktop.douyin.com/aweme/v1/web/commit/follow/user/');
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('uses the Desktop familiar-list endpoint and its exact paging fields', async () => {
    const requestRaw = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      rawText: JSON.stringify({
        status_code: 0,
        status_msg: '',
        cursor: 9007199254740991,
        has_more: 1,
        user_list: [{
          uid: '3138463854771706',
          sec_uid: 'MS4peer',
          nickname: '昵称',
          remark_name: '备注名',
          signature: '签名',
          user_canceled: 0,
          avatar_thumb: { url_list: ['https://example.com/avatar.webp'] },
        }, {
          uid: '999',
          nickname: '非好友候选',
          user_canceled: 0,
        }],
        friend_list: ['3138463854771706'],
        close_friend_list: [],
      }),
    });
    const api = new ImFriendApi(
      { requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient,
      '3241234567',
    );

    await expect(api.list({ cursor: '123', count: 100 })).resolves.toEqual({
      statusCode: 0,
      statusMsg: '',
      hasMore: true,
      cursor: '9007199254740991',
      total: '0',
      friendUids: ['3138463854771706'],
      closeFriendUids: [],
      userList: [{
        uid: '3138463854771706',
        nickname: '昵称',
        avatar: 'https://example.com/avatar.webp',
        secUid: 'MS4peer',
        remark: '备注名',
        signature: '签名',
      }, { uid: '999', nickname: '非好友候选' }],
    });

    const url = new URL(requestRaw.mock.calls[0]![0]);
    expect(url.origin).toBe('https://imdesktop.douyin.com');
    expect(url.pathname).toBe('/aweme/v1/web/familiar/list/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      aid: '339757',
      version_name: '1.2.1',
      version_code: '21.6.0',
      device_platform: process.platform,
      device_id: '3241234567',
      did: '3241234567',
      awemeim_guid: '0',
      screen_width: '1728',
      screen_height: '1117',
      cursor: '123',
      count: '100',
      vcd_count: '0',
      hotsoon_has_more: '0',
      only_total: '0',
      order_by: '1',
      need_all_friend: '1',
      recommend_type: '22',
    });
    expect(requestRaw.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
    expect(requestRaw.mock.calls[0]![2]).toBe(false);
  });

  it('preserves explicit cleared profile fields and close-friend false but not absent fields', async () => {
    const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify({
      status_code: 0, user_list: [{ uid: '22', nickname: 'name', remark_name: '', signature: '' }], friend_list: ['22'], close_friend_list: [],
    }) });
    const api = new ImFriendApi({ requestRaw, getUserAgent: () => 'fixture-UA', getInstallId: () => '1234' } as unknown as ImHttpClient, 'device');
    await expect(api.list()).resolves.toMatchObject({ userList: [{ uid: '22', remark: '', signature: '' }], friendUids: ['22'], closeFriendUids: [] });
    expect(new URL(requestRaw.mock.calls[0]![0]).searchParams.get('iid')).toBe('1234');
    requestRaw.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify({
      status_code: 0, user_list: [{ uid: '22', nickname: 'name' }], friend_list: ['22'],
    }) });
    const page = await api.list();
    const entry = page.userList[0];
    expect(entry).not.toHaveProperty('remark');
    expect(entry).not.toHaveProperty('signature');
    expect(page).not.toHaveProperty('closeFriendUids');
  });

  it('does not treat an HTTP 200 body without status_code as success', async () => {
    const requestRaw = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      rawText: JSON.stringify({ status_msg: 'missing status' }),
    });
    const api = new ImFriendApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, '3241234567');

    await expect(api.list()).resolves.toMatchObject({
      statusCode: -1,
      userList: [],
      friendUids: [],
    });
  });

  describe('Desktop remark confirmation', () => {
    function fixture(body: unknown) {
      const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(body) });
      const api = new ImFriendApi({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient);
      return { api, requestRaw };
    }
    const options = { uid: '22', secUid: 'fixture-sec', remark: '新备注' };

    it.each([null, 0, {}])('rejects non-text remark %j before any request', async remark => {
      const { api, requestRaw } = fixture({ status_code: 0, remark_name: '' });
      await expect(api.setRemark({ ...options, remark: remark as unknown as string })).rejects.toThrow('remark must be a string');
      expect(requestRaw).not.toHaveBeenCalled();
    });

    it('keeps the 20 UTF-16 unit input limit rather than counting visible glyphs', async () => {
      const remark = '😀'.repeat(10);
      const { api, requestRaw } = fixture({ status_code: 0, remark_name: remark });
      await expect(api.setRemark({ ...options, remark })).resolves.toMatchObject({ statusCode: 0, remark });
      await expect(api.setRemark({ ...options, remark: `${remark}a` })).rejects.toThrow('20');
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });

    it.each([0, 200, '0', '200'])('accepts matching echo with status %j', async status => {
      const { api } = fixture({ status_code: status, remark_name: options.remark });
      await expect(api.setRemark(options)).resolves.toEqual({ statusCode: 0, statusMsg: '', remark: options.remark });
    });

    it.each(['', ' \t\n', '\u3000'])('normalizes only wholly blank input %j to an empty remark', async remark => {
      const { api, requestRaw } = fixture({ status_code: 0, remark_name: '' });
      await expect(api.setRemark({ ...options, remark })).resolves.toMatchObject({ statusCode: 0, remark: '' });
      expect((requestRaw.mock.calls[0]![1].body as FormData).get('remark_name')).toBe('');
    });

    it('preserves whitespace around nonblank remarks and accepts the exact echo', async () => {
      const remark = '  新备注  ';
      const { api, requestRaw } = fixture({ status_code: 0, remark_name: remark });
      await expect(api.setRemark({ ...options, remark })).resolves.toMatchObject({ statusCode: 0, remark });
      expect((requestRaw.mock.calls[0]![1].body as FormData).get('remark_name')).toBe(remark);
    });

    it.each([undefined, null, false, 0, {}, [], 'different', ''])('does not confirm a missing or different echo %j', async remark_name => {
      const { api, requestRaw } = fixture({ status_code: 0, remark_name });
      const result = await api.setRemark(options);
      expect(result.statusCode).not.toBe(0);
      expect(result).not.toHaveProperty('remark');
      expect(requestRaw).toHaveBeenCalledTimes(1);
    });

    it.each([false, true, '', [], {}, null, undefined])('does not coerce malformed status %j into success', async status_code => {
      const { api } = fixture({ status_code, remark_name: options.remark });
      const result = await api.setRemark(options);
      expect(result.statusCode).not.toBe(0);
      expect(Number.isSafeInteger(result.statusCode)).toBe(true);
      expect(result).not.toHaveProperty('remark');
    });

    it('preserves a platform rejection without exposing its echo as confirmed state', async () => {
      const { api } = fixture({ status_code: 8, status_msg: '未登录', remark_name: options.remark });
      await expect(api.setRemark(options)).resolves.toEqual({ statusCode: 8, statusMsg: '未登录' });
    });
  });

  it('matches the desktop form fields for remark updates', async () => {
    const requestRaw = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      rawText: JSON.stringify({ status_code: 0, remark_name: '新备注' }),
    });
    const api = new ImFriendApi(
      { requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient,
      '3241234567',
    );

    await expect(api.setRemark({
      uid: '3138463854771706', secUid: 'MS4peer', remark: '新备注',
    })).resolves.toMatchObject({ statusCode: 0, remark: '新备注' });
    const remarkUrl = new URL(requestRaw.mock.calls[0]![0]);
    const remarkBody = requestRaw.mock.calls[0]![1].body as FormData;
    expect(remarkUrl.pathname).toBe('/aweme/v1/web/user/remark/name/');
    expect(Object.fromEntries(remarkUrl.searchParams)).toMatchObject({
      aid: '339757', device_id: '3241234567', did: '3241234567', iid: '0',
      version_code: '1.2.1', browser_version: 'fixture-UA',
    });
    expect(Object.fromEntries(remarkBody.entries())).toEqual({
      user_id: '3138463854771706', sec_user_id: 'MS4peer', remark_name: '新备注',
    });
  });
});
