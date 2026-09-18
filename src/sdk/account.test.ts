import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createImStateStore } from '../services/im/state-store.js';
import { ApiConnection } from '../desktop/api-connection.js';
import { AccountStore } from '../store/account-store.js';
import { Account } from './account.js';
import { ConnectionManager } from '../base/runtime/connection-manager.js';
import { ImInboxQueries } from './messaging/inbox-queries.js';
import { ImService } from '../services/im/service.js';
import { PrivateMessageEvent } from './events/message.js';
import { Friend } from './contacts/friend.js';
import { Stranger } from './contacts/stranger.js';
import { Member } from './contacts/member.js';
import { Group } from './contacts/group.js';
import { ActionChallengeError } from '../http/action-challenge.js';
import type { ActionVerification } from './auth/action-verification.js';
import { DesktopTicketGuard } from '../desktop/ticket-guard.js';
import { createPublicKey, verify } from 'node:crypto';
import { segment } from './messaging/message.js';
import { mapProtoConversationListItem } from '../services/im/mappers.js';

describe('Account lifecycle', () => {
  let dataDir = '';
  let unexpectedRequests: string[] = [];
  let loadContacts: jest.SpyInstance;

  beforeEach(() => {
    unexpectedRequests = [];
    // Existing scenarios exercise explicit actions against their own snapshots.
    // Startup loading is enabled separately by its lifecycle tests below.
    loadContacts = jest.spyOn(Account.prototype as unknown as { loadOnlineContacts(generation: number): Promise<void> },
      'loadOnlineContacts').mockResolvedValue(undefined);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      unexpectedRequests.push('unparsed request');
      unexpectedRequests[unexpectedRequests.length - 1] = new URL(input instanceof Request ? input.url : String(input)).pathname;
      throw new Error('Account fixture attempted an undeclared HTTP request');
    });
    dataDir = mkdtempSync(join(tmpdir(), 'douyin-im-lifecycle-'));
    // Certificate startup ordering has a dedicated real-connection offline suite.
    jest.spyOn(ApiConnection.prototype, 'startTicketGuard').mockImplementation(() => undefined);
    jest.spyOn(ApiConnection.prototype, 'startDeviceLifecycle').mockImplementation(function (this: ApiConnection) {
      return this.initializeDevice();
    });
    jest.spyOn(ApiConnection.prototype, 'getApplicationSettings').mockResolvedValue({});
    jest.spyOn(ApiConnection.prototype, 'sendPassportTokenBeat').mockResolvedValue({ message: 'success', data: {} });
    jest.spyOn(ApiConnection.prototype, 'initializeDevice').mockImplementation(async function (this: ApiConnection) {
      return { deviceId: this.getDeviceId(), installId: this.getInstallId() };
    });
    jest.spyOn(ConnectionManager.prototype, 'start').mockResolvedValue(undefined);
    jest.spyOn(ConnectionManager.prototype, 'stop').mockResolvedValue(undefined);
    jest.spyOn(ImService.prototype, 'listThreads').mockResolvedValue({ statusCode: 0, statusMsg: 'OK', threads: [], hasMore: false, cursor: '0', conversations: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
    expect(unexpectedRequests).toEqual([]);
  });

  function createQrAccount(localState?: false | { backend: 'json' | 'sqlite' }, transport = new ApiConnection()): Account {
    transport.jar.set('sessionid', 'session-id');
    jest.spyOn(transport, 'getSelfProfile').mockResolvedValue({ user: {} });
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'getQrcode').mockResolvedValue({
      token: 'qr-token',
      qrcodeBase64: 'base64',
      expireTime: 9999999999,
    });
    jest.spyOn(transport, 'checkQrconnect').mockResolvedValue({
      message: 'success',
      data: {
        status: 'confirmed',
        error_code: 0,
        user_data: { user_id_str: '10001', screen_name: 'tester' },
      },
    });
    return Account.create(
      transport,
      new AccountStore({ dataDir }),
      { skipVerify: true, ...(localState !== undefined ? { localState } : {}) },
    );
  }

  it.each(['success', 'partial failure', 'logout'] as const)('loads contacts after login with independent results: %s', async outcome => {
    loadContacts.mockRestore();
    const account = createQrAccount(false);
    const logger = account.logger;
    jest.spyOn(account, 'logger', 'get').mockReturnValue(logger);
    const info = jest.spyOn(logger, 'info');
    const warn = jest.spyOn(logger, 'warn');
    let release!: (friends: readonly Friend[]) => void;
    const friends = jest.spyOn(account, 'getFriendList').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const groups = jest.spyOn(account, 'getGroupList').mockResolvedValue([account.bindGroup('700', '700')]);
    if (outcome === 'partial failure') groups.mockRejectedValue(new Error('group unavailable'));
    const refresh = jest.spyOn(account, 'refreshStrangerConversations').mockResolvedValue({ statusCode: 0, statusMsg: '', pages: 1, conversations: 0 });
    const strangers = jest.spyOn(account, 'getStrangerList').mockImplementation(async () => {
      expect(refresh).toHaveBeenCalledTimes(1);
      return [];
    });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const online = new Promise<void>(resolve => account.once('system.online', resolve));
    const login = account.login(); await ready;
    const continuation = account.continueLogin(); await online;
    expect(account.online).toBe(true);
    expect(friends).toHaveBeenCalledTimes(1);
    expect(groups).toHaveBeenCalledWith(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    if (outcome === 'logout') await account.logout();
    release([account.bindFriend('20002', '0:1:10001:20002', '800')]);
    await continuation; await login;
    if (outcome === 'logout') {
      expect(info).not.toHaveBeenCalledWith('加载了 %s', expect.any(String));
    } else {
      expect(strangers).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('加载了 %s', outcome === 'success'
        ? '1 个好友，1 个群，0 个陌生人' : '1 个好友，群加载失败，0 个陌生人');
      if (outcome === 'partial failure') expect(warn).toHaveBeenCalledWith('%s列表加载失败: %s', '群', 'group unavailable');
      await account.login(); // Already-online login does not reload all lists.
      expect(friends).toHaveBeenCalledTimes(1);
      await account.logout();
    }
  });

  it('owns activity-driven renewal from online through logout without treating inbound messages as activity', async () => {
    jest.useFakeTimers();
    const account = createQrAccount(false);
    const beat = jest.mocked(ApiConnection.prototype.sendPassportTokenBeat);
    expect(() => account.markActive()).toThrow('未上线');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready;
    expect(beat).not.toHaveBeenCalled();
    try {
      await account.continueLogin(); await login;
      expect(beat.mock.calls.map(([scene]) => scene)).toEqual(['boot']);
      const signal = beat.mock.calls[0]![1]!;
      const manager = jest.mocked(ConnectionManager.prototype.start).mock.instances[0]! as unknown as ConnectionManager;
      const received = jest.fn(); account.on('message', received);
      manager['options'].onInbound({ threadId: '700', conversationShortId: '700', conversationType: 2,
        senderUid: '20002', serverMessageId: '99', clientMessageId: 'passive', rawContent: '{"text":"hello"}',
        text: 'hello', messageType: 7, raw: {} });
      expect(received).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(600_000);
      expect(beat).toHaveBeenCalledTimes(1);
      account.markActive();
      expect(beat.mock.calls.map(([scene]) => scene)).toEqual(['boot', 'active']);
      await jest.advanceTimersByTimeAsync(10_000); account.markActive();
      await jest.advanceTimersByTimeAsync(590_000);
      expect(beat.mock.calls.map(([scene]) => scene)).toEqual(['boot', 'active', 'polling']);
      await account.logout(); expect(signal.aborted).toBe(true);
      expect(() => account.markActive()).toThrow('未上线');
      await jest.advanceTimersByTimeAsync(1_200_000);
      expect(beat).toHaveBeenCalledTimes(3);
    } finally { await account.logout(); jest.useRealTimers(); }
  });

  it('refreshes settings after a promoted device update without reconnecting IM, and stops updates on logout', async () => {
    const install = jest.spyOn(ApiConnection.prototype, 'setDeviceUpdateHandler');
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready;
    try {
      await account.continueLogin(); await login;
      const save = install.mock.calls.at(-1)![0];
      const settings = jest.mocked(ApiConnection.prototype.getApplicationSettings);
      expect(settings).toHaveBeenCalledTimes(1);
      save({ deviceId: '300', installId: '400' });
      expect(settings).toHaveBeenCalledTimes(2);
      expect(jest.mocked(ConnectionManager.prototype.start)).toHaveBeenCalledTimes(1);
      expect(new AccountStore({ dataDir }).load('10001')?.deviceProfile).toMatchObject({ deviceId: '300', installId: '400' });
      await account.logout();
      save({ deviceId: 'late', installId: 'late' });
      expect(settings).toHaveBeenCalledTimes(2);
      expect(new AccountStore({ dataDir }).load('10001')?.deviceProfile.deviceId).toBe('300');
    } finally { await account.logout(); }
  });

  it('logs out on a rejected numeric Passport 401 without deleting the saved Session', async () => {
    const account = createQrAccount(false);
    let finish!: (response: import('../desktop/types.js').PassportApiResponse) => void;
    jest.mocked(ApiConnection.prototype.sendPassportTokenBeat).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const offline = new Promise<void>(resolve => account.once('system.offline', resolve));
    const store = new AccountStore({ dataDir }); const cookies = store.load('10001')!.session.cookies;
    finish({ message: 'error', data: { error_code: 401 } }); await offline;
    expect(account.state).toBe('offline');
    expect(ConnectionManager.prototype.stop).toHaveBeenCalled();
    expect(store.load('10001')!.session.cookies).toBe(cookies);
  });

  it('does not let an old pending renewal revoke a new login', async () => {
    const account = createQrAccount(false);
    let finish!: (response: import('../desktop/types.js').PassportApiResponse) => void;
    const beat = jest.mocked(ApiConnection.prototype.sendPassportTokenBeat);
    beat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const signal = beat.mock.calls[0]![1]!;
    await account.logout(); await account.login();
    expect(beat).toHaveBeenCalledTimes(2); expect(signal.aborted).toBe(true);
    finish({ message: 'error', data: { error_code: 401 } });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(account.online).toBe(true);
    await account.logout();
  });

  it('cancels an online renewal challenge on logout without permitting a late retry', async () => {
    const account = createQrAccount(false);
    const beat = jest.mocked(ApiConnection.prototype.sendPassportTokenBeat).mockResolvedValueOnce({ message: 'error', data: {
      error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
    } });
    const challenge = new Promise<import('./auth/login-verification.js').LoginVerification>(resolve => {
      account.once('system.login.verification', ({ verification }) => resolve(verification));
    });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const verification = await challenge;
    await account.logout();
    await expect(verification.complete({ fp: 'late' })).rejects.toThrow('登录验证已结束');
    expect(beat).toHaveBeenCalledTimes(1);
    expect(account.online).toBe(false);
  });

  it('resumes a real token-beat challenge on the online connection and persists its response without login promotion', async () => {
    jest.mocked(ApiConnection.prototype.sendPassportTokenBeat).mockRestore();
    const requests: { url: URL; headers: Headers; body: RequestInit['body'] }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(url.pathname).toBe('/passport/token/beat/web/');
      requests.push({ url, headers: new Headers(init?.headers), body: init?.body });
      if (requests.length === 1) return Response.json({ message: 'error', data: {
        error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
      } }, { headers: { 'set-cookie': 'msToken=fixture-rotated-token; Path=/' } });
      return Response.json({ message: 'success', data: {} }, { headers: {
        'set-cookie': 'sessionid=renewed; Path=/',
        'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket: 'renewed', ts_sign_ree: 'renewed-signature' })).toString('base64'),
      } });
    });
    const account = createQrAccount(false);
    const store = new AccountStore({ dataDir });
    const online = jest.fn(); account.on('system.online', online);
    const challenge = new Promise<import('./auth/login-verification.js').LoginVerification>(resolve => {
      account.once('system.login.verification', ({ verification }) => resolve(verification));
    });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    try {
      const verification = await challenge;
      expect(verification.operation).toBe('token-beat'); expect(account.online).toBe(true);
      const saved = jest.spyOn(AccountStore.prototype, 'save');
      let persisted!: () => void;
      const committed = new Promise<void>(resolve => { persisted = resolve; });
      const originalSave = saved.getMockImplementation();
      saved.mockImplementation(function (this: AccountStore, account) {
        const result = originalSave!.call(this, account);
        if (account.session.cookies.includes('sessionid=renewed')) persisted();
        return result;
      });
      await verification.complete({ fp: 'fixture-fp', fields: { password: 'ignored' } });
      await committed;
      expect(requests).toHaveLength(2);
      for (const key of ['scene', 'sign', 'qs', 'ts', 'biz_trace_id']) expect(requests[1]!.url.searchParams.get(key)).toBe(requests[0]!.url.searchParams.get(key));
      expect(requests[1]!.url.searchParams.get('scene')).toBe('boot');
      expect(requests[1]!.url.searchParams.get('fp')).toBe('fixture-fp');
      expect(requests[1]!.url.searchParams.get('verifyFp')).toBe('fixture-fp');
      expect(requests[1]!.url.searchParams.has('msToken')).toBe(false);
      expect(requests[1]!.headers.get('cookie')).toContain('msToken=fixture-rotated-token');
      expect(requests[1]!.body).toBeUndefined();
      expect(online).toHaveBeenCalledTimes(1);
      expect(new ApiConnection(store.toClientConfig(store.load('10001')!)).hasBoundTicket()).toBe(true);
    } finally { await account.logout(); }
  });

  it.each([[0, 4], [6, 4], [undefined, 4], [9001, 1]] as const)('does not promote an unsuccessful QR response with an old Session (code=%s)', async (code, attempts) => {
    const poll = jest.spyOn(ApiConnection.prototype, 'checkQrconnect');
    const account = createQrAccount(false);
    poll.mockResolvedValue({
      message: 'error', data: { status: 'confirmed', ...(code === undefined ? {} : { error_code: code }), user_data: { user_id_str: '10001' } },
    });
    const online = jest.fn(); account.on('system.online', online);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); const settled = login.then(() => 'online', () => 'failed');
    await ready;
    try {
      await account.continueLogin().catch(error => { expect(error.message).toContain('Passport 未返回 success'); });
      expect(await settled).toBe('failed');
      expect(account.online).toBe(false);
      expect(online).not.toHaveBeenCalled();
      expect(new AccountStore({ dataDir }).listUids()).toEqual([]);
      expect(poll).toHaveBeenCalledTimes(attempts);
    } finally { await account.logout(); }
  });

  it.each([
    ['sms', 'error', 0, false], ['password', 'error', 0, false],
    ['sms', 'success', 401, true], ['password', 'success', 401, true],
  ] as const)('classifies %s login using message=%s (code=%s)', async (method, message, errorCode, accepted) => {
    const transport = new ApiConnection(); transport.jar.set('sessionid', 'old-session');
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'sendCode').mockResolvedValue({ message: 'success', data: {} });
    const response = { message, data: { error_code: errorCode, user_id_str: '10001' } };
    jest.spyOn(transport, 'userLogin').mockResolvedValue(response);
    jest.spyOn(transport, 'smsLogin').mockResolvedValue(response);
    const account = Account.create(transport, new AccountStore({ dataDir }), {
      login: method === 'sms' ? { method, mobile: '13800000000' } : { method, mobile: '13800000000', password: 'fixture' },
    });
    const ready = new Promise<void>(resolve => account.once('system.login.sms', resolve));
    const login = account.login(); const result = login.then(() => 'online', () => 'failed');
    try {
      if (method === 'sms') { await ready; await account.continueLoginWithSms('123456').catch(() => undefined); }
      expect(await result).toBe(accepted ? 'online' : 'failed');
      expect(account.online).toBe(accepted);
      expect(new AccountStore({ dataDir }).listUids()).toEqual(accepted ? ['10001'] : []);
    } finally { await account.logout(); }
  });

  it.each(['1', '2', '3', '4', '5'])('handles the Desktop numeric-string QR status %s without waiting for expiry', async status => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const poll = jest.spyOn(ApiConnection.prototype, 'checkQrconnect');
    const account = createQrAccount(false);
    const replacesQr = status === '4' || status === '5';
    const confirmed = { message: 'success', data: { status: '3', user_data: { user_id_str: '10001' } } };
    poll.mockReset().mockResolvedValue(confirmed);
    if (status !== '3') poll.mockResolvedValueOnce({ message: 'success', data: {
      status, ...(replacesQr ? { token: 'replacement-token', qrcode: 'replacement-code', expire_time: 9999999999 } : {}),
    } });
    const codes: string[] = [];
    const statuses: string[] = [];
    account.on('system.login.qrcode', info => { codes.push(info.token); });
    account.on('system.login.qrcode.status', info => { statuses.push(info.status); });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login().catch(() => undefined);
    await ready;
    const continuation = account.continueLogin().catch(() => undefined);
    try {
      await jest.advanceTimersByTimeAsync(0);
      if (status !== '3') {
        // New/scanned and server replacement responses all finish an outer poll.
        // C339 schedules the next check after the normal interval, not immediately.
        await jest.advanceTimersByTimeAsync(999);
        expect(account.online).toBe(false);
        expect(poll).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
      }
      expect(account.online).toBe(true);
      expect(codes).toEqual(replacesQr ? ['qr-token', 'replacement-token'] : ['qr-token']);
      expect(statuses).toEqual(status === '3' ? ['3'] : [status, '3']);
      expect(poll).toHaveBeenLastCalledWith(replacesQr ? 'replacement-token' : 'qr-token', {});
    } finally {
      await account.logout();
      await jest.advanceTimersByTimeAsync(1000);
      await continuation; await login;
      jest.useRealTimers();
    }
  });

  it('offers verification before QR creation when get_qrcode returns a Passport challenge', async () => {
    const transport = new ApiConnection({ enableABogus: false });
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(path).toBe('/passport/web/get_qrcode/');
      return Response.json({ message: 'error', data: {
        error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
      } });
    });
    const account = Account.create(transport, new AccountStore({ dataDir }), { localState: false });
    const qr = jest.fn(); account.on('system.login.qrcode', qr);
    const operations: string[] = [];
    account.on('system.login.verification', ({ verification }) => {
      operations.push(verification.operation); verification.cancel('fixture cancelled');
    });
    try {
      await account.login().catch(() => undefined);
      expect(operations).toEqual(['get-qrcode']);
      expect(qr).not.toHaveBeenCalled();
      expect(account.online).toBe(false);
    } finally { await account.logout(); }
  });

  it('does not replay a pending QR creation after logout even if its verification later completes', async () => {
    const transport = new ApiConnection({ enableABogus: false });
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    let qrRequests = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(path).toBe('/passport/web/get_qrcode/'); qrRequests++;
      return Response.json({ message: 'error', data: {
        error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
      } });
    });
    const account = Account.create(transport, new AccountStore({ dataDir }), { localState: false });
    let complete!: () => Promise<void>;
    const ready = new Promise<void>(resolve => account.once('system.login.verification', ({ verification }) => {
      complete = () => verification.complete({ fp: 'too-late-fixture' }); resolve();
    }));
    const qr = jest.fn(); account.on('system.login.qrcode', qr);
    const login = account.login().catch(() => undefined);
    try {
      await ready;
      await account.logout();
      await complete().catch(() => undefined);
      await login;
      expect(qrRequests).toBe(1);
      expect(qr).not.toHaveBeenCalled();
      expect(new AccountStore({ dataDir }).listUids()).toEqual([]);
    } finally { await account.logout(); }
  });

  it('does not open rejection middleware for a successful QR response containing decision-shaped data', async () => {
    const account = createQrAccount(false);
    jest.spyOn(ApiConnection.prototype, 'checkQrconnect').mockResolvedValue({ message: 'success', data: {
      status: '3', user_data: { user_id_str: '10001' },
      verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha' }),
    } });
    const verification = jest.fn(); account.on('system.login.verification', verification);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', () => resolve()));
    const login = account.login();
    try {
      await ready; await account.continueLogin(); await login;
      expect(verification).not.toHaveBeenCalled();
      expect(account.online).toBe(true);
    } finally { await account.logout(); }
  });

  it.each([
    [2046, 'fixture-key+/=', true],
    ['2046', 'fixture-key+/=', false],
    [1105, 'fixture-key+/=', false],
    [2046, '', false],
    [2046, 0, false],
    [2046, false, false],
    [2046, null, false],
    [2046, undefined, false],
  ] as const)('selects the Desktop secondary form patch for code=%j key=%j', async (errorCode, smsKey, shouldPatch) => {
    const transport = new ApiConnection({ enableABogus: false });
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    const sent: { url: URL; body: string }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/passport/web/user/login/');
      sent.push({ url, body: String(init?.body) });
      if (sent.length === 1) return Response.json({ message: 'error', data: {
        error_code: errorCode, sms_code_key: smsKey,
        verify_center_secondary_decision_conf: JSON.stringify({ verify_from: 'verify_center' }),
      } });
      return Response.json({ message: 'success', data: { user_id_str: '10001' } }, {
        headers: { 'Set-Cookie': 'sessionid=fixture-session; Path=/' },
      });
    });
    const account = Account.create(transport, new AccountStore({ dataDir }), {
      skipVerify: true, localState: false,
      login: { method: 'password', mobile: '13800000000', password: 'fixture-password' },
    });
    const challenges: unknown[] = [];
    account.on('system.login.verification', ({ verification }) => {
      challenges.push(verification.errorCode);
      void verification.complete({ fields: { sms_code_key: 'untrusted-callback-key' } });
    });
    try {
      await account.login();
      expect(account.online).toBe(true);
      expect(challenges).toHaveLength(1);
      expect(sent).toHaveLength(2);
      const original = sent[0]!;
      let expected = original.body;
      if (shouldPatch) {
        const fields = Object.fromEntries(original.body.split('&').map(pair => pair.split('=')));
        fields['sms_code_key'] = String(smsKey);
        expected = Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
      }
      expect(sent[1]!.body).toBe(expected);
      for (const key of ['sign', 'qs', 'ts', 'biz_trace_id', 'fp', 'verifyFp']) {
        expect(sent[1]!.url.searchParams.get(key)).toBe(original.url.searchParams.get(key));
      }
    } finally { await account.logout(); }
  });

  it.each([
    [['captcha', 'secondary', 'captcha']],
    [['secondary', 'captcha', 'secondary']],
    [['secondary', 'secondary', 'captcha']],
  ] as const)('preserves one password request across repeated challenges %j', async sequence => {
    const transport = new ApiConnection({ enableABogus: false });
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    const sent: { params: URLSearchParams; body: string }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(url.pathname).toBe('/passport/web/user/login/');
      sent.push({ params: url.searchParams, body: String(init?.body) });
      const headers = new Headers({ 'set-cookie': `msToken=fixture-token-${sent.length}; Path=/` });
      if (sent.length === 4) {
        headers.append('set-cookie', 'sessionid=fixture-session; Path=/');
        return Response.json({ message: 'success', data: { user_id_str: '10001' } }, { headers });
      }
      return Response.json({ message: 'error', data: sequence[sent.length - 1] === 'secondary' ? {
        error_code: 2046, sms_code_key: `fixture-sms-key-${sent.length}+/=`,
        verify_center_secondary_decision_conf: JSON.stringify({ verify_from: 'verify_center', verify_ways: [{ verify_way: 'mobile_sms_verify' }] }),
      } : {
        error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
      } }, { headers });
    });
    const account = Account.create(transport, new AccountStore({ dataDir }), {
      skipVerify: true, localState: false,
      login: { method: 'password', mobile: '13800000000', password: 'a😀b' },
    });
    let challenges = 0;
    account.on('system.login.verification', ({ verification }) => {
      challenges++;
      void verification.complete(sequence[challenges - 1] === 'secondary'
        ? { fields: { password: 'must-not-overwrite', unknown_ticket: 'must-not-send' } }
        : { fp: `fixture-fp-${challenges}` });
    });
    try {
      await account.login();
      expect(account.online).toBe(true);
      expect(challenges).toBe(3);
      expect(sent).toHaveLength(4);
      expect(new URLSearchParams(sent[0]!.body).get('password')).toBe('6467');
      let fp: string | null = null;
      let body = sent[0]!.body;
      for (let index = 1; index < sent.length; index++) {
        for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) expect(sent[index]!.params.get(key)).toBe(sent[0]!.params.get(key));
        expect(sent[index]!.params.has('msToken')).toBe(false);
        expect(sent[index]!.params.has('isResend')).toBe(false);
        if (sequence[index - 1] === 'captcha') fp = `fixture-fp-${index}`;
        else {
          const fields = Object.fromEntries(body.split('&').map(pair => pair.split('=')));
          fields['sms_code_key'] = `fixture-sms-key-${index}+/=`;
          body = Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
        }
        expect(sent[index]!.params.get('fp')).toBe(fp);
        expect(sent[index]!.params.get('verifyFp')).toBe(sent[index]!.params.get('fp'));
        expect(sent[index]!.body).toBe(body);
      }
    } finally { await account.logout(); }
  });

  it.each([
    ['get-qrcode', '/passport/web/get_qrcode/'],
    ['qr-connect', '/passport/web/check_qrconnect/'],
    ['send-sms', '/passport/web/send_code/'],
    ['send-voice-sms', '/passport/web/send_voice_code/'],
    ['sms-login', '/passport/web/sms_login/'],
    ['password-login', '/passport/web/user/login/'],
  ] as const)('resumes %s through the real Account and request layer after human verification', async (operation, targetPath) => {
    const transport = new ApiConnection({ enableABogus: false });
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    const requests: { url: URL; body: unknown; headers: Headers }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      if (path === targetPath) {
        requests.push({ url, body: init?.body, headers: new Headers(init?.headers) });
        if (requests.length === 1) return Response.json({ message: 'error', data: {
          error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
        } }, { headers: { 'Set-Cookie': 'passport_csrf_token=verified-fixture; Path=/' } });
        // Successful replay is not the same as the next scheduled QR poll.
        if (operation === 'qr-connect' && requests.length === 2) {
          return Response.json({ message: 'success', data: { status: '2' } });
        }
      }
      if (path === '/passport/web/get_qrcode/') return Response.json({ message: 'success', data: {
        token: 'fixture-token', qrcode: 'fixture-image', expire_time: 9999999999,
      } });
      if (path === '/passport/web/check_qrconnect/') return Response.json({ message: 'success', data: {
        status: '3', user_data: { user_id_str: '10001' },
      } }, { headers: { 'Set-Cookie': 'sessionid=fixture-session; Path=/' } });
      if (path === '/passport/web/sms_login/' || path === '/passport/web/user/login/') {
        return Response.json({ message: 'success', data: { user_id_str: '10001' } }, {
          headers: { 'Set-Cookie': 'sessionid=fixture-session; Path=/' },
        });
      }
      expect(['/passport/web/send_code/', '/passport/web/send_voice_code/']).toContain(path);
      return Response.json({ message: 'success', data: {} });
    });
    const qrMode = operation === 'get-qrcode' || operation === 'qr-connect';
    const passwordMode = operation === 'password-login';
    const account = Account.create(transport, new AccountStore({ dataDir }), {
      skipVerify: true, localState: false,
      login: qrMode ? { method: 'qr' } : passwordMode
        ? { method: 'password', mobile: '13800000000', password: 'fixture-password' }
        : { method: 'sms', mobile: '13800000000' },
    });
    const seen: string[] = [];
    account.on('system.login.verification', ({ verification }) => {
      seen.push(verification.operation);
      void verification.complete({ fp: 'fixture-fp', fields: { unexpected_callback_field: 'must-not-send' } });
    });
    const ready = new Promise<void>(resolve => account.once(qrMode ? 'system.login.qrcode' : 'system.login.sms', () => resolve()));
    const login = account.login();
    // Observe rejection immediately even while the test awaits a login event.
    void login.catch(() => undefined);
    try {
      if (!passwordMode) {
        await ready;
        if (qrMode) await account.continueLogin();
        else {
          if (operation === 'send-voice-sms') await account.requestLoginVoiceCode();
          await account.continueLoginWithSms('123456');
        }
      }
      await login;
      expect(account.online).toBe(true);
      expect(seen).toEqual([operation]);
      expect(requests).toHaveLength(operation === 'qr-connect' ? 3 : 2);
      const first = requests[0]!.url.searchParams, retry = requests[1]!.url.searchParams;
      for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) expect(retry.get(key)).toBe(first.get(key));
      expect(retry.has('isResend')).toBe(false);
      expect(retry.get('fp')).toBe('fixture-fp');
      expect(retry.get('verifyFp')).toBe('fixture-fp');
      expect(requests[1]!.body).toBe(requests[0]!.body);
      expect(requests[1]!.headers.get('x-tt-passport-csrf-token')).toBe('verified-fixture');
      if (operation === 'qr-connect') {
        const next = requests[2]!.url.searchParams;
        expect(next.has('fp')).toBe(false);
        expect(next.has('verifyFp')).toBe(false);
        expect(next.get('biz_trace_id')).toBe(first.get('biz_trace_id'));
      }
    } finally { await account.logout(); await login.catch(() => undefined); }
  });

  it.each(['sqlite', 'json', false] as const)('keeps partial command4 changes live without persisting or prematurely folding (%s)', async backend => {
    const account = createQrAccount(backend === false ? false : { backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const initial = { conversationId: '700', conversationShortId: '900', conversationType: 2,
      isGroup: true, name: 'group', members: [], lastMessageTime: 0, settingVersion: '10',
      settingExt: { 'a:s_is_folded': '0' }, settingExtVersions: { seed: '1', 'a:s_is_folded': '1' } };
    account.applyConversationInfo(initial);
    const readDisk = () => {
      const file = readdirSync(dataDir, { recursive: true }).map(String).find(path => path.endsWith(backend === 'json' ? 'im-state.json' : 'im-state.sqlite'))!;
      const store = createImStateStore({ accountDir: dirname(join(dataDir, file)), backend: backend === 'json' ? 'json' : 'sqlite' });
      try { return store.getConversation('700'); } finally { store.close(); }
    };
    const updates = jest.fn(); account.on('notice.conversation.update', updates);
    const refresh = jest.spyOn(account.im, 'getConversationInfos');
    const command = (entries: unknown[], version = 9) => JSON.stringify({ command_type: 4, conversation_id: '700', conversation_version: version, ext_data: entries });
    account.applySettingCommand(50001, command([
      { key: 'a:s_is_folded', value: '1', version: 2, op_type: 1 },
      { key: 'bad', value: 'x', version: 0, op_type: 1 },
    ]), {});
    expect(account.cachedConversation('700')).toMatchObject({ settingExt: { 'a:s_is_folded': '1' }, isFolded: false });
    expect(refresh).not.toHaveBeenCalled(); // Failed ext batch but command version is old.
    if (backend !== false) expect(readDisk())
      .toMatchObject({ settingExt: { 'a:s_is_folded': '0' }, isFolded: false });
    jest.spyOn(ImInboxQueries.prototype, 'groupList').mockResolvedValue({ statusCode: 0, statusMsg: '', groups: [initial], fromCache: true });
    await account.getGroupList(); // Local reads must neither roll back nor commit the dirty map.
    expect(account.cachedConversation('700')!.settingExt!['a:s_is_folded']).toBe('1');
    account.applySettingCommand(50001, command([{ key: 'seed', version: 1, op_type: 1 }]), {});
    await Promise.resolve();
    expect(updates).toHaveBeenCalledTimes(1); // Handled without changes still notifies.
    expect(account.cachedConversation('700')!.isFolded).toBe(false);
    if (backend !== false) expect(account['stateStore']!.getConversation('700')!.settingExt!['a:s_is_folded']).toBe('0');
    account.applySettingCommand(50001, command([{ key: 'seed', value: 'saved', version: 2, op_type: 1 }]), {});
    await Promise.resolve();
    expect(updates).toHaveBeenCalledTimes(2);
    expect(account.cachedConversation('700')).toMatchObject({ isFolded: true, settingVersion: '10', settingExt: { 'a:s_is_folded': '1', seed: 'saved' } });
    if (backend !== false) expect(readDisk()).toMatchObject({ isFolded: true, settingExt: { 'a:s_is_folded': '1' } });
    account.applySettingCommand(50001, command([{ key: 'a:s_is_folded', version: 3, op_type: 2 }]), {});
    expect(account.cachedConversation('700')!.settingExt).not.toHaveProperty('a:s_is_folded');
    expect(account.cachedConversation('700')!.settingExtVersions).not.toHaveProperty('a:s_is_folded');
    expect(account.cachedConversation('700')!.isFolded).toBe(false);
    await account.logout();
  });

  it.each(['status', 'network'])('deduplicates command4 refresh, clears %s failures, and uses live snapshots', async failure => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const info = { conversationId: '700', conversationShortId: '900', conversationType: 2, inboxType: 3,
      isGroup: true, name: 'known', members: [], lastMessageTime: 0, settingVersion: '10' };
    account.applyConversationInfo(info);
    let finish!: (result: Awaited<ReturnType<ImService['getConversationInfos']>>) => void;
    let reject!: (error: Error) => void;
    const refresh = jest.spyOn(account.im, 'getConversationInfos').mockImplementation(() => new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
    const updates = jest.fn(); account.on('notice.conversation.update', updates);
    const content = '{"command_type":4,"conversation_id":"700","conversation_version":10,"inbox_type":99,"conversation_type":1,"ext_data":[]}';
    account.applySettingCommand(50001, content, {}); account.applySettingCommand(50001, content, {});
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith([{ threadId: '700', conversationShortId: '900', conversationType: 2, inboxType: 3 }]);
    if (failure === 'network') reject(new Error('network failed'));
    else finish({ statusCode: 4, statusMsg: 'failed', conversations: [] });
    await new Promise(resolve => setImmediate(resolve));
    expect(updates).not.toHaveBeenCalled();
    account.applySettingCommand(50001, content, {});
    expect(refresh).toHaveBeenCalledTimes(2);
    finish({ statusCode: 0, statusMsg: '', conversations: [{ ...info, name: 'fresh', settingVersion: '11', settingExt: { fresh: 'yes' } }] });
    await new Promise(resolve => setImmediate(resolve));
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]![0].conversation).toMatchObject({ name: 'fresh', settingVersion: '11', settingExt: { fresh: 'yes' } });
    account.applySettingCommand(50001, content.replace('10', '11'), {});
    expect(refresh).toHaveBeenCalledTimes(3);
    await account.logout();
    finish({ statusCode: 0, statusMsg: '', conversations: [{ ...info, name: 'stale' }] });
    await new Promise(resolve => setImmediate(resolve));
    expect(updates).toHaveBeenCalledTimes(1);
    expect(account.cachedConversation('700')).toBeUndefined();
  });

  it.each(['sqlite', 'json'] as const)('merges an older network group list against live dirty ext before saving (%s)', async backend => {
    const account = createQrAccount({ backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const initial = { conversationId: '700', conversationShortId: '900', conversationType: 2,
      isGroup: true, name: 'initial', members: [], lastMessageTime: 0, settingVersion: '10',
      settingExt: { 'a:s_is_folded': '0' }, settingExtVersions: { seed: '1' } };
    account.applyConversationInfo(initial);
    account.applySettingCommand(50001, '{"command_type":4,"conversation_id":"700","conversation_version":9,"ext_data":[{"key":"a:s_is_folded","value":"1","version":2,"op_type":1},{"key":"bad","version":0,"op_type":1}]}', {});
    jest.mocked(ImService.prototype.listThreads).mockResolvedValueOnce({ statusCode: 0, statusMsg: '', hasMore: false,
      cursor: '0', threads: [], conversations: [{ ...initial, name: 'network core', settingVersion: '9' }] });
    await account.getGroupList(true);
    expect(account.cachedConversation('700')).toMatchObject({ name: 'network core', settingVersion: '10',
      settingExt: { 'a:s_is_folded': '1' }, settingExtVersions: { seed: '1', 'a:s_is_folded': '2' }, isFolded: true });
    expect(account['stateStore']!.getConversation('700')).toMatchObject({ isFolded: true, settingExt: { 'a:s_is_folded': '1' } });
    await account.logout();
  });

  it('can restore a removed conversation from an already-requested full refresh, but never from command4 alone', async () => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const info = { conversationId: '700', conversationShortId: '900', conversationType: 2,
      isGroup: true, name: 'known', members: [], lastMessageTime: 0 };
    let finish!: (result: Awaited<ReturnType<ImService['getConversationInfos']>>) => void;
    const refresh = jest.spyOn(account.im, 'getConversationInfos').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const command = '{"command_type":4,"conversation_id":"700","ext_data":[]}';
    account.applySettingCommand(50001, command, {}); expect(refresh).not.toHaveBeenCalled();
    account.applyConversationInfo(info); account.applySettingCommand(50001, command, {});
    account.forgetConversation('700');
    expect(account.cachedConversation('700')).toBeUndefined();
    finish({ statusCode: 0, statusMsg: '', conversations: [{ ...info, name: 'restored', settingVersion: '12' }] });
    await new Promise(resolve => setImmediate(resolve));
    expect(account.cachedConversation('700')).toMatchObject({ name: 'restored', settingVersion: '12' });
    await account.logout();
  });

  it('routes live/history/pull command4 separately and marks the OUTER conversation in pull batches', async () => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const info = { conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'known', members: [], lastMessageTime: 0, settingExtVersions: { k: '1' } };
    account.applyConversationInfo(info); account.applyConversationInfo({ ...info, conversationId: 'outer' });
    const manager = jest.mocked(ConnectionManager.prototype.start).mock.instances[0]! as unknown as ConnectionManager;
    const callbacks = manager['options'];
    const update = jest.fn(); const batch = jest.fn(); const messages = jest.fn();
    account.on('notice.conversation.update', update); account.on('notice.message.batch-update', batch); account.on('message', messages);
    const content = '{"command_type":4,"conversation_id":"700","ext_data":[{"key":"k","value":"v","version":2,"op_type":1}]}';
    callbacks.onNotice!({ type: 'im.command', conversationId: 'outer', conversationType: 2, messageType: 50001, content, raw: {} });
    await Promise.resolve(); expect(update).toHaveBeenCalledTimes(1); expect(batch).not.toHaveBeenCalled();
    account.cacheMessages([{ threadId: 'outer', msgId: '1', senderUid: '20', msgType: 50001, content, status: 0, createTime: 0 }]);
    await Promise.resolve(); expect(update).toHaveBeenCalledTimes(2); expect(batch).not.toHaveBeenCalled();
    callbacks.onHistoryBatch([{ threadId: 'outer', conversationShortId: '800', conversationType: 2, senderUid: '20',
      messageType: 50001, rawContent: content, text: '', raw: {} }], []);
    expect(batch.mock.calls[0]![0].updates).toMatchObject([{ conversation: { conversationId: 'outer' }, messages: [] }]);
    expect(messages).not.toHaveBeenCalled();
    await Promise.resolve(); expect(update).toHaveBeenCalledTimes(3);
    account.applySettingCommand(50001, content.replace('700', 'unknown'), {});
    expect(account.cachedConversation('unknown')).toBeUndefined();
    await account.logout();
  });

  it.each([undefined, false] as const)('binds group metadata and risk from merged settings (localState=%s)', async localState => {
    const account = createQrAccount(localState);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const conversation = { conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'first', lastMessageTime: 0, members: [] };
    account.applyConversationInfo({ ...conversation, settingVersion: '10', pinned: true,
      settingExt: { 'a:sky_eye_dialog': '{"risk":1}' }, settingExtVersions: { 'a:sky_eye_dialog': '5' } });
    const group = account.pickGroup('700')!;
    account.applyConversationInfo({ ...conversation, name: 'new core', settingVersion: '9', pinned: false, settingExt: {} });
    expect(account.pickGroup('700')).toBe(group);
    expect(group.name).toBe('new core');
    expect(group.pinned).toBe(true);
    await expect(group.sendMsg('must not pass the gate')).rejects.toThrow('当前会话存在风险');
    expect(account.cachedConversation('700')).toMatchObject({ settingVersion: '10', settingExtVersions: { 'a:sky_eye_dialog': '5' } });
    await account.logout();
  });

  it('keeps nonpersistent versions through group refresh, isolates maps and clears only removed groups', async () => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const current = { conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'initial', lastMessageTime: 0, members: [], settingVersion: '9007199254740993',
      pinned: true, readIndexV2: '9007199254740994', readBadgeCount: 12,
      settingExt: { 'a:sky_eye_dialog': '{"risk":1}' }, settingExtVersions: { 'a:sky_eye_dialog': '9' } };
    account.applyConversationInfo(current);
    account.applyConversationInfo({ ...current, conversationId: '0:1:10001:20002', conversationType: 1, isGroup: false });
    current.settingExtVersions['a:sky_eye_dialog'] = '1';
    (account.cachedConversation('700')!.settingExt as Record<string, string>)['a:sky_eye_dialog'] = '{}';
    const list = jest.spyOn(ImInboxQueries.prototype, 'groupList').mockResolvedValue({ statusCode: 0, statusMsg: '', groups: [{
      conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true,
      name: 'new core', inboxType: 0, lastMessageTime: 0, members: [], ticket: 'full-network-ticket', participantsCount: 3,
      settingVersion: '9007199254740992', pinned: false, settingExt: {}, settingExtVersions: {},
    }] });
    const [group] = await account.getGroupList(true);
    expect(group!.name).toBe('new core'); expect(group!.pinned).toBe(true);
    expect(account.cachedConversation('700')).toMatchObject({ settingVersion: '9007199254740993', readIndexV2: '9007199254740994',
      readBadgeCount: 12, ticket: 'full-network-ticket', participantsCount: 3, settingExtVersions: { 'a:sky_eye_dialog': '9' } });
    await expect(group!.sendMsg('blocked')).rejects.toThrow('当前会话存在风险');
    account.patchCachedConversation('missing', { settingExt: { risk: 'x' } });
    expect(account.cachedConversation('missing')).toBeUndefined();
    list.mockResolvedValue({ statusCode: 0, statusMsg: '', groups: [] });
    await account.getGroupList(true);
    expect(account.cachedConversation('700')).toBeUndefined();
    expect(account.cachedConversation('0:1:10001:20002')).toBeDefined();
    await account.logout();
    expect(account.cachedConversation('0:1:10001:20002')).toBeUndefined();
    expect(readdirSync(dataDir, { recursive: true }).filter(path => String(path).includes('im-state'))).toEqual([]);
  });

  it('keeps login pending until the account is actually online and reuses the task', async () => {
    const account = createQrAccount();
    const qrReady = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));

    const first = account.login();
    const second = account.login();
    await qrReady;

    expect(first).toBe(second);
    expect(account.state).toBe('logging-in');
    await account.continueLogin();
    await first;
    expect(account.state).toBe('online');
    expect(account.online).toBe(true);

    const logout = account.logout();
    const relogin = account.login();
    expect(account.login()).toBe(relogin);
    await logout;
    await relogin;
    expect(account.state).toBe('online');

    await Promise.all([account.logout(), account.logout()]);
    expect(account.state).toBe('offline');
    expect(account.online).toBe(false);
  });

  it.each(['sqlite', 'json'] as const)('uses an application-settings startup snapshot and restores the refreshed cache on next login (%s)', async backend => {
    const read = jest.mocked(ApiConnection.prototype.getApplicationSettings);
    read.mockResolvedValue({ im_msg_not_float_not_hint: { enable: true, not_hint_config: { 7: [-1] } } });
    const account = createQrAccount({ backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'group', members: [], lastMessageTime: 0 });
    const message = { threadId: '700', msgId: '1', clientMessageId: 'first', senderUid: '22', content: '{"text":"body"}',
      msgType: 7, status: 0, createTime: 1, orderInConversation: '1' };
    account.cacheMessages([message]);
    expect(account.cachedConversation('700')).toMatchObject({ lastMessage: { msgId: '1' }, hintMessage: null });
    read.mockResolvedValue({ im_msg_not_float_not_hint: { enable: false } });
    await account['applicationSettings']!.refresh();
    account.cacheMessages([{ ...message, msgId: '2', clientMessageId: 'second', orderInConversation: '2' }]);
    expect(account.cachedConversation('700')!.hintMessage).toBeNull(); // Existing IM keeps its initialization options.
    await account.logout();
    read.mockRejectedValue(new Error('offline settings endpoint'));
    await account.login();
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'group', members: [], lastMessageTime: 0 });
    account.cacheMessages([{ ...message, msgId: '3', clientMessageId: 'third', orderInConversation: '3' }]);
    expect(account.cachedConversation('700')!.hintMessage!.msgId).toBe('3');
    await account.logout();
  });

  it('cancels startup settings and refuses late configuration/receiver creation after logout', async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    let seen!: () => void;
    let signal: AbortSignal | undefined;
    const called = new Promise<void>(done => { seen = done; });
    jest.mocked(ApiConnection.prototype.getApplicationSettings).mockImplementation(input => {
      signal = input; seen(); return new Promise(done => { resolve = done; });
    });
    const account = createQrAccount();
    const ready = new Promise<void>(done => account.once('system.login.qrcode', done));
    const login = account.login(); const rejected = login.catch(() => undefined);
    await ready;
    const continued = account.continueLogin().catch(() => undefined);
    await called;
    await account.logout();
    expect(signal!.aborted).toBe(true);
    resolve({ feature: 'late' });
    await rejected; await continued;
    expect(ConnectionManager.prototype.start).not.toHaveBeenCalled();
    expect(account.online).toBe(false);
    expect(account['applicationSettings']).toBeUndefined();
  });

  it.each(['stopping', 'offline', 'relogged'] as const)('does not absorb old HTTP authentication after logout (%s)', async phase => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const connection = account['runtime'].connection;
    const store = new AccountStore({ dataDir });
    const before = store.load('10001')!;
    const cookies = connection.getCookies();
    const ticket = connection.getTicketGuardState();
    let finish!: (response: Response) => void;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).includes('/get_client_cert/')) return Response.json({ message: 'success', data: {} });
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = connection.requestRaw('https://imdesktop.douyin.com/passport/web/check_qrconnect/', { method: 'POST' });
    let stopped!: () => void;
    jest.mocked(ConnectionManager.prototype.stop).mockImplementationOnce(() => new Promise(resolve => { stopped = resolve; }));
    const logout = account.logout();
    if (phase !== 'stopping') { stopped(); await logout; }
    if (phase === 'relogged') await account.login();
    const current = store.load('10001')!;
    const lateHeaders = new Headers({ 'set-cookie': 'sessionid=stale-login; Path=/', 'x-ms-token': 'stale-ms',
      'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket: 'stale-login', ts_sign_ree: 'stale-binding' })).toString('base64') });
    finish(new Response('{"status_code":0}', { headers: lateHeaders }));
    // Do not turn an acknowledged external action into an apparent transport failure.
    await expect(pending).resolves.toMatchObject({ status: 200, data: '{"status_code":0}' });
    try {
      expect(connection.getCookies()).toBe(cookies);
      expect(connection.getTicketGuardState()).toEqual(ticket);
      expect(store.load('10001')!.session).toEqual(current.session);
      expect(store.load('10001')!.session.cookies).toBe(before.session.cookies);
      expect(account.uid).toBe('10001');
    } finally {
      if (phase === 'stopping') stopped();
      await logout;
      await account.logout();
    }
  });

  it('isolates a cancelled login response from the next pending login on the same connection', async () => {
    const account = createQrAccount();
    let ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const first = account.login().catch(() => undefined); await ready;
    const connection = account['runtime'].connection;
    let finish!: (response: Response) => void;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).includes('/get_client_cert/')
      ? Response.json({ message: 'success', data: {} }) : new Promise(resolve => { finish = resolve; }));
    const old = connection.requestRaw('https://imdesktop.douyin.com/passport/web/check_qrconnect/', { method: 'POST' });
    await account.logout(); await first;
    ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const second = account.login(); await ready;
    finish(new Response('{}', { headers: { 'set-cookie': 'sessionid=cancelled-attempt; Path=/' } }));
    await old;
    await account.continueLogin(); await second;
    try {
      expect(connection.jar.get('sessionid')).toBe('session-id');
      expect(new AccountStore({ dataDir }).load('10001')!.session.cookies).toBe('sessionid=session-id');
    } finally { await account.logout(); }
  });

  it('does not replace the current QR token with a cancelled QR fetch result', async () => {
    const account = createQrAccount();
    const connection = account['runtime'].connection;
    let finish!: (value: Awaited<ReturnType<ApiConnection['getQrcode']>>) => void;
    let called!: () => void; const started = new Promise<void>(resolve => { called = resolve; });
    jest.mocked(connection.getQrcode).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; called(); }));
    const first = account.login().catch(() => undefined); await started;
    await account.logout(); await first;
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const second = account.login(); await ready;
    finish({ token: 'cancelled-qr', qrcodeBase64: 'old', expireTime: 9999999999 });
    await new Promise(resolve => setImmediate(resolve));
    await account.continueLogin(); await second;
    try { expect(connection.checkQrconnect).toHaveBeenCalledWith('qr-token', {}); }
    finally { await account.logout(); }
  });

  it('retains a late device certificate in memory without saving an offline account', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const connection = account['runtime'].connection;
    let finish!: (response: Response) => void;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).includes('/get_client_cert/')
      ? new Promise(resolve => { finish = resolve; }) : Response.json({}));
    await connection.requestRaw('https://imdesktop.douyin.com/passport/web/check_qrconnect/', { method: 'POST' });
    await account.logout();
    const store = new AccountStore({ dataDir }); const saved = store.load('10001');
    finish(Response.json({ message: 'success', data: { cert: 'synthetic-device-cert' } }));
    await new Promise(resolve => setImmediate(resolve));
    expect(connection.getTicketGuardState()?.clientCert).toBe(Buffer.from('synthetic-device-cert').toString('base64'));
    expect(store.load('10001')).toEqual(saved);
    expect(account.uid).toBe('10001');
  });

  it('does not cache a previous login generation send acknowledgement after relogin', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let resolve!: (value: { statusCode: number; statusMsg: string; serverMessageId: string }) => void;
    const send = jest.spyOn(account.im, 'send').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = account.outbound.sendText({ threadId: '700', conversationShortId: '700', conversationType: 2, text: 'old session' });
    expect(send).toHaveBeenCalledTimes(1);
    await account.logout(); await account.login();
    resolve({ statusCode: 0, statusMsg: '', serverMessageId: '99' });
    await pending;
    expect(account.cachedMessages('700')).toEqual([]);
    await account.logout();
  });

  it.each(['before', 'after'] as const)('preserves server metadata when a message arrives %s its send acknowledgement', async arrival => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let resolve!: (value: { statusCode: number; statusMsg: string; serverMessageId: string }) => void;
    jest.spyOn(account.im, 'send').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = account.outbound.sendText({ threadId: '700', conversationShortId: '700', conversationType: 2, text: 'sent text' });
    const serverMessage = {
      msgId: '99', threadId: '700', senderUid: '10001', content: '{"text":"server text"}',
      msgType: 7, createTime: 123, status: 0, version: '9',
      orderInConversation: '9007199254740995', indexInConversation: '12', indexInConversationV2: '1234',
      ext: { 's:visible': '22', visible_code: '1' },
    };
    if (arrival === 'before') account.cacheMessages([serverMessage]);
    resolve({ statusCode: 0, statusMsg: '', serverMessageId: '99' }); await pending;
    if (arrival === 'after') account.cacheMessages([serverMessage]);
    expect(account.cachedMessages('700')).toEqual([{ ...serverMessage, orderIndex: serverMessage.orderInConversation }]);
    await account.logout(); await account.login();
    expect(account.cachedMessages('700')).toEqual([{ ...serverMessage, orderIndex: serverMessage.orderInConversation }]);
    await account.logout();
  });

  it.each([undefined, false] as const)('merges incoming updates before dispatch, suppresses repeats and stores self echoes (localState=%s)', async localState => {
    const account = createQrAccount(localState);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const onMessage = jest.fn(() => {
      if (localState !== false) expect(account.cachedMessages('700')[0]?.content).toBe('{"text":"hello"}');
    });
    account.on('message', onMessage);
    const onUpdate = jest.fn(event => {
      expect(event.account).toBe(account);
      if (localState !== false) expect(account.cachedMessage(event.conversationId, event.serverMessageId, 'server')).toEqual(event.message);
    });
    account.on('notice.message.update', onUpdate);
    const assembler = account['assembler']!;
    const inbound = { threadId: '700', conversationShortId: '700', conversationType: 2, senderUid: '20002',
      serverMessageId: '99', clientMessageId: 'ABC', createTime: '123', version: '1', orderInConversation: '10',
      rawContent: '{"text":"hello"}', text: 'hello', messageType: 7, raw: {}, ext: { 's:client_message_id': 'ABC', kept: 'old' } };
    assembler.receiveMessage(inbound);
    assembler.receiveMessage(inbound); // Native upsert has no field-diff/version gate.
    assembler.receiveMessage({ ...inbound, serverMessageId: '100', version: '2', orderInConversation: '20',
      rawContent: '', text: '', ext: { 's:client_message_id': 'abc', added: 'new' } });
    expect(onMessage).toHaveBeenCalledTimes(1);
    const updatesBeforeSelf = localState === false ? 2 : 3;
    expect(onUpdate).toHaveBeenCalledTimes(updatesBeforeSelf);
    if (localState !== false) expect(onUpdate.mock.calls[2]![0]).toMatchObject({ type: 'message.update', conversationId: '700', serverMessageId: '100', clientMessageId: 'abc',
      message: { version: '2', content: '{"text":"hello"}' } });
    if (localState !== false) expect(account.cachedMessages('700')).toEqual([expect.objectContaining({
      msgId: '100', clientMessageId: 'abc', content: '{"text":"hello"}', version: '2',
      orderInConversation: '20', orderIndex: '10', ext: { 's:client_message_id': 'abc', kept: 'old', added: 'new' },
    })]);
    assembler.receiveMessage({ ...inbound, serverMessageId: '101', clientMessageId: 'self', senderUid: '10001', ext: {} });
    expect(onMessage).toHaveBeenCalledTimes(1);
    if (localState !== false) expect(account.cachedMessages('700').some(message => message.msgId === '101')).toBe(true);
    assembler.receiveMessage({ ...inbound, threadId: '0:1:10001:20002', conversationType: 1,
      serverMessageId: '103', clientMessageId: 'self-private', senderUid: '10001', ext: {} });
    expect(account.cachedFriend('10001')).toBeUndefined();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(updatesBeforeSelf + 2);
    await account.logout(); await account.login();
    // Stale receiver callbacks do not write to the new runtime or emit events.
    assembler.receiveMessage({ ...inbound, threadId: 'stale', serverMessageId: '102' });
    expect(account.cachedMessages('stale')).toEqual([]);
    expect(account.cachedGroup('stale')).toBeUndefined();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(updatesBeforeSelf + 2);
    account['assembler']!.receiveMessage(inbound);
    expect(onUpdate).toHaveBeenCalledTimes(updatesBeforeSelf + 3);
    expect(onMessage).toHaveBeenCalledTimes(localState === false ? 2 : 1);
    await account.logout();
  });

  it('suppresses new-message dispatch if an update listener logs out synchronously', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const onMessage = jest.fn();
    account.on('message', onMessage);
    let logout!: Promise<void>;
    account.on('notice.message.update', () => { logout = account.logout(); });
    account['assembler']!.receiveMessage({ threadId: '700', conversationShortId: '700', conversationType: 2,
      senderUid: '22', serverMessageId: '99', clientMessageId: 'client', text: 'hello', rawContent: '{"text":"hello"}', messageType: 7, raw: {} });
    await logout;
    expect(onMessage).not.toHaveBeenCalled();
    expect(account.state).toBe('offline');
  });

  it.each(['json', 'sqlite'] as const)('retains inbound property changes through account cache and local summary (%s)', async backend => {
    const account = createQrAccount({ backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true,
      name: 'group', members: [], lastMessageTime: 0 });
    const inbound = { threadId: '700', conversationShortId: '700', conversationType: 2, senderUid: '10001', serverMessageId: '1', clientMessageId: 'one',
      createTime: '1000', orderInConversation: '1', rawContent: '{"text":"self"}', text: 'self', messageType: 7, raw: {} };
    const assembler = account['assembler']!;
    const onMessage = jest.fn(); const onConversation = jest.fn();
    account.on('message', onMessage); account.on('notice.conversation.update', onConversation);
    assembler.receiveMessage(inbound);
    assembler.receiveMessage({ ...inbound, serverMessageId: '2', clientMessageId: 'two', createTime: '2000', orderInConversation: '2' });
    const propertyList = { 'se:ok': [{ uid: '9007199254740993', secUid: '', createTime: '5', value: '', idempotentId: '' }] };
    assembler.receiveMessage({ ...inbound, propertyList });
    expect(account.cachedMessage('700', '1', 'server')!.propertyList).toEqual(propertyList);
    expect(account.cachedConversation('700')).toMatchObject({ propertyInfo: { clientId: 'one', sender: '9007199254740993', createdAt: '5' }, propertyMessage: { msgId: '1' }, sortOrder: '5000' });
    assembler.receiveMessage({ ...inbound, propertyList: {} });
    expect(account.cachedConversation('700')).toMatchObject({ propertyInfo: { clientId: '' }, propertyMessage: null, sortOrder: '5000' });
    expect(onMessage).not.toHaveBeenCalled(); expect(onConversation).not.toHaveBeenCalled();
    await account.logout();
  });

  it.each([undefined, false] as const)('merges recovery batches without replaying bot handlers (localState=%s)', async localState => {
    const account = createQrAccount(localState);
    const initial = { conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true,
      name: 'initial', members: [], lastMessageTime: 0 };
    jest.mocked(ImService.prototype.listThreads).mockResolvedValue({ statusCode: 0, statusMsg: '', threads: [],
      conversations: [initial], hasMore: false, cursor: '0' });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    expect(account.cachedConversation('700')).toMatchObject({ ...initial, settingVersion: '0', readIndexV2: '0' });
    const manager = jest.mocked(ConnectionManager.prototype.start).mock.instances[0]! as unknown as ConnectionManager;
    const callbacks = manager['options'];
    const onMessage = jest.fn(); const onUpdate = jest.fn(); const onBatch = jest.fn();
    account.on('message', onMessage); account.on('notice.message.update', onUpdate);
    account.on('notice.message.batch-update', onBatch);
    const inbound = { threadId: '700', conversationShortId: '700', conversationType: 2, senderUid: '20002',
      serverMessageId: '99', clientMessageId: 'CLIENT', indexInConversationV2: '10', version: '1',
      rawContent: '{"text":"history"}', text: 'history', messageType: 7, raw: {}, ext: { kept: 'old' } };
    callbacks.onHistoryBatch([inbound], [{ ...initial, name: 'updated snapshot' }]);
    callbacks.onHistoryBatch([{ ...inbound, rawContent: '', text: '', version: '2', ext: { added: 'new' } }], []);
    expect(onMessage).not.toHaveBeenCalled(); expect(onUpdate).not.toHaveBeenCalled();
    if (localState !== false) {
      expect(account.cachedMessage('700', '99', 'server')).toMatchObject({ version: '2', content: inbound.rawContent,
        clientMessageId: 'client', ext: { kept: 'old', added: 'new' } });
      expect(onBatch).toHaveBeenCalledTimes(2);
      expect(onBatch.mock.calls[1]![0]).toMatchObject({ updates: [{ conversation: { name: 'updated snapshot' },
        messages: [expect.objectContaining({ msgId: '99', version: '2', content: inbound.rawContent })] }] });
    } else {
      expect(onBatch).toHaveBeenCalledTimes(2);
      expect(onBatch.mock.calls[0]![0].updates).toMatchObject([{ conversation: { name: 'updated snapshot' },
        messages: [expect.objectContaining({ msgId: '99', content: inbound.rawContent })] }]);
      expect(account.cachedMessages('700')).toEqual([]); // Still no persistent/message history store.
    }
    callbacks.onInbound(inbound); // Pulled IDs are already known, even with local persistence disabled.
    expect(onMessage).not.toHaveBeenCalled(); expect(onUpdate).toHaveBeenCalledTimes(1);
    await account.logout(); await account.login();
    callbacks.onHistoryBatch([{ ...inbound, threadId: 'stale' }], [{ ...initial, conversationId: 'stale' }]);
    expect(account.cachedMessages('stale')).toEqual([]);
    expect(account.cachedConversation('stale')).toBeUndefined();
    expect(account.cachedGroup('stale')).toBeUndefined();
    expect(onBatch).toHaveBeenCalledTimes(2);
    await account.logout();
  });

  it.each(['history', 'recall', 'delete-message', 'delete-conversation'] as const)(
    'does not apply a late %s response to a new login cache', async operation => {
      const account = createQrAccount();
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      const contact = Group.bind('700', '700', account);
      const original = { msgId: '99', clientMessageId: 'original', threadId: '700', senderUid: '22', content: 'current', msgType: 7, createTime: 100, status: 0 };
      account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2,
        isGroup: true, name: 'group', members: [], lastMessageTime: 0 });
      account.cacheMessages([original]);
      let release!: () => void;
      let dispatched!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const sent = new Promise<void>(resolve => { dispatched = resolve; });
      const response = { statusCode: 0, statusMsg: '', recalled: true, hasMore: false, cursor: '0', direction: 'older' as const,
        messages: [{ ...original, content: 'stale' }] };
      const method = { history: 'getMessages', recall: 'recall', 'delete-message': 'deleteMessage', 'delete-conversation': 'deleteConversation' } as const;
      jest.spyOn(account.im, method[operation]).mockImplementation(async () => { dispatched(); await waiting; return response; });
      const task = operation === 'history' ? contact.getHistory() : operation === 'recall' ? contact.recallMsg('99')
        : operation === 'delete-message' ? contact.deleteMsg('99') : contact.deleteConversation();
      const checked = expect(task).rejects.toThrow('账号连接已变化');
      await sent;
      await account.logout(); await account.login();
      const newContact = Group.bind('700', '700', account);
      account.rememberGroup(newContact);
      release(); await checked;
      expect(account.cachedMessage('700', '99', 'server')).toEqual(original);
      expect(account.cachedGroup('700')).toBe(newContact);
      await account.logout();
    },
  );

  it('marks a recalled target by client ID first, retaining its body and recall state across sync and restart', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const first = { msgId: '99', clientMessageId: 'client-a', threadId: '700', senderUid: '22',
      content: 'original', msgType: 7, createTime: 100, status: 0, orderInConversation: '10' };
    const second = { ...first, msgId: '100', clientMessageId: 'client-b' };
    account.cacheMessages([first, second]);
    const notices: unknown[] = [];
    account.on('notice.message.recall', event => {
      expect(account.cachedMessage('700', '99', 'server')!.ext?.['s:is_recalled']).toBe('true');
      notices.push(event);
    });
    account['assembler']!.receiveNotice({ type: 'message.recall', conversationId: '700', conversationType: 2,
      clientMessageId: 'client-a', serverMessageId: '100', createTime: '123', raw: {} });
    expect(notices[0]).toMatchObject({ type: 'message.recall', clientMessageId: 'client-a', serverMessageId: '99' });
    expect(account.cachedMessage('700', '100', 'server')!.ext).toBeUndefined();
    expect(account.cachedMessage('700', '99', 'server')).toMatchObject({ content: 'original', msgType: 7,
      ext: { 's:is_recalled': 'true' }, localExt: { 's:text_recall_timestamp': '123' } });
    account.cacheMessages([{ ...first, content: 'synced', orderInConversation: '20' }]);
    expect(account.cachedMessage('700', '99', 'server')).toMatchObject({ content: 'synced', orderIndex: '10',
      ext: { 's:is_recalled': 'true' }, localExt: { 's:text_recall_timestamp': '123' } });
    await account.logout(); await account.login();
    expect(account.cachedMessage('700', '99', 'server')!.ext?.['s:is_recalled']).toBe('true');
    // Native merge does not invent an irreversible tombstone: an explicit new ext value wins.
    account.cacheMessages([{ ...first, ext: { 's:is_recalled': '' } }]);
    expect(account.cachedMessage('700', '99', 'server')!.ext?.['s:is_recalled']).toBe('');
    expect(account.removeCachedMessage('700', '100')).toBe(true);
    expect(account.removeCachedMessage('700', '100')).toBe(false);
    expect(account.cachedMessage('700', 'client-b', 'client')).toBeUndefined();
    expect(account.cachedMessage('700', '100', 'server')!.deleted).toBe(true);
    const now = Date.now();
    account.markCachedMessageRecalled('700', { clientMessageId: 'missing', serverMessageId: '100', createTime: '9223372036854775807' });
    expect(Number(account.cachedMessage('700', '100', 'server')!.localExt?.['s:text_recall_timestamp'])).toBeGreaterThanOrEqual(now);
    expect(account.markCachedMessageRecalled('700', { serverMessageId: 'missing' })).toBeUndefined();
    expect(account.cachedMessages('700')).toHaveLength(2);
    await account.logout();
  });

  it('persists direct-reference recall updates before notice dispatch without clearing bodies or traversing roots', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true,
      name: 'stored group', members: [], lastMessageTime: 0 });
    const original = { msgId: '99', clientMessageId: 'original', threadId: '700', senderUid: '22',
      content: 'original', msgType: 7, createTime: 100, status: 0, orderInConversation: '10' };
    const referenceInfo = { refMessageId: '99', hint: 'original hint', refMessageType: 7, refMessageStatus: 0, rootMessageId: 'earlier' };
    const quote = { ...original, msgId: '100', clientMessageId: 'quote', content: 'reply', referenceInfo, localExt: { kept: 'local' } };
    account.cacheMessages([original, quote,
      { ...quote, msgId: '101', clientMessageId: 'indirect', referenceInfo: { ...referenceInfo, refMessageId: '100', rootMessageId: '99' } },
      { ...quote, msgId: '102', clientMessageId: 'deleted' },
      { ...quote, threadId: 'other' },
      { ...quote, msgId: '103', clientMessageId: 'orphan', referenceInfo: { ...referenceInfo, refMessageId: 'missing' } },
    ]);
    account.removeCachedMessage('700', '102');
    const savedQuote = account.cachedMessage('700', '100', 'server')!;
    const expected = { ...savedQuote, referenceInfo: { ...referenceInfo, refMessageStatus: 3 } };
    const batches: unknown[] = [];
    account.on('notice.message.batch-update', event => {
      expect(account.cachedMessage('700', '100', 'server')).toEqual(expected);
      batches.push(event);
    });
    const listener = jest.fn(() => expect(account.cachedMessage('700', '100', 'server')).toEqual(expected));
    account.on('notice.message.recall', listener);
    account['assembler']!.receiveNotice({ type: 'message.recall', conversationId: '700', conversationType: 2,
      clientMessageId: 'original', serverMessageId: 'wrong', createTime: '123', raw: {} });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(batches[0]).toMatchObject({ updates: [{ conversation: { conversationId: '700', name: 'stored group' },
      messages: [{ msgId: '99', ext: { 's:is_recalled': 'true' } }, { msgId: '100', referenceInfo: { refMessageStatus: 3 } }] }], deletedClientMessageIds: [] });
    expect(account.cachedMessage('700', '101', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    expect(account.cachedMessage('700', '102', 'server')).toMatchObject({ deleted: true, referenceInfo: { refMessageStatus: 0 } });
    expect(account.cachedMessage('other', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    expect(account.markCachedMessageRecalled('700', { serverMessageId: 'missing' })).toBeUndefined();
    expect(account.cachedMessage('700', '103', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    // Repeated notifications are idempotent; neither mutate source DTOs nor erase local fields/order.
    account.markCachedMessageRecalled('700', { clientMessageId: 'original', serverMessageId: '99' });
    expect(referenceInfo.refMessageStatus).toBe(0);
    expect(account.cachedMessage('700', '100', 'server')).toEqual(expected);
    await account.logout(); await account.login();
    expect(account.cachedMessage('700', '100', 'server')).toEqual(expected);
    // Native merge does not prove permanent protection of this local reference update.
    account.cacheMessages([quote]);
    expect(account.cachedMessage('700', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    await account.logout();
  });

  it.each(['sqlite', 'json'] as const)('applies command deletions and reference updates in %s with separate live/pull events', async backend => {
    const account = createQrAccount({ backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const original = { msgId: '9007199254740993', clientMessageId: 'ORIGINAL', threadId: '700', conversationType: 2,
      senderUid: '22', content: 'original', msgType: 7, createTime: 1, status: 0 };
    const ref = { refMessageId: original.msgId, hint: 'keep hint', refMessageType: 7, refMessageStatus: 0, rootMessageId: 'root' };
    const quote = { ...original, msgId: '100', clientMessageId: 'quote', content: 'quote body', referenceInfo: ref };
    account.cacheMessages([original, quote,
      { ...quote, msgId: '101', clientMessageId: 'indirect', referenceInfo: { ...ref, refMessageId: '100', rootMessageId: original.msgId } },
      { ...quote, msgId: '102', clientMessageId: 'deleted' },
      { ...quote, msgId: '103', clientMessageId: 'hidden', status: 1 },
      { ...quote, threadId: 'elsewhere' },
      ...Array.from({ length: 60 }, (_, index) => ({ ...original, msgId: String(200 + index), clientMessageId: `padding-${index}`, createTime: 999 })),
    ]);
    account.removeCachedMessage('700', '102');
    const events: string[] = [];
    const batches = jest.fn(); const messages = jest.fn();
    account.on('message', messages);
    account.on('notice.message.update', event => {
      expect(account.cachedMessage('700', original.msgId, 'server')!.deleted).toBe(true);
      expect(event.message).toMatchObject({ msgId: '100', content: 'quote body', referenceInfo: { ...ref, refMessageStatus: 4 } });
      events.push('update');
    });
    account.on('notice.message.delete', event => {
      expect(event.message).toMatchObject({ msgId: original.msgId, content: 'original', clientMessageId: 'original' });
      expect(event.message).not.toHaveProperty('deleted');
      events.push('delete');
    });
    account.on('notice.message.batch-update', event => { events.push('batch'); batches(event); });
    account['assembler']!.receiveNotice({ type: 'message.delete', conversationId: '700', serverMessageId: original.msgId, raw: {} });
    expect(events).toEqual(['update', 'delete']); // live push never creates a batch for this command
    expect(account.cachedMessage('700', 'original', 'client')).toBeUndefined();
    expect(account.cachedMessage('700', '101', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    expect(account.cachedMessage('700', '102', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    expect(account.cachedMessage('700', '103', 'server')!.referenceInfo!.refMessageStatus).toBe(4); // stored but not displayed
    expect(account.cachedMessage('elsewhere', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    expect(ref.refMessageStatus).toBe(0);
    account['assembler']!.receiveNotice({ type: 'message.delete', conversationId: '700', serverMessageId: original.msgId, raw: {} });
    expect(account.applyMessageDeletionCommand('700', 'missing', {})).toBeUndefined();
    expect(events).toEqual(['update', 'delete']);
    const manager = jest.mocked(ConnectionManager.prototype.start).mock.instances[0]! as unknown as ConnectionManager;
    const command = { threadId: 'outer', conversationShortId: '700', conversationType: 2, senderUid: '0',
      text: '', rawContent: `{"command_type":2,"conversation_id":"700","message_id":${original.msgId}}`, messageType: 50001, raw: {} };
    manager['options'].onHistoryBatch([command, command], []);
    expect(events).toEqual(['update', 'delete', 'batch']);
    expect(batches.mock.calls[0]![0]).toMatchObject({ updates: [], deletedClientMessageIds: ['original', 'original'] });
    // Normal server save may restore the target; a pulled command then performs single events plus a batch.
    account.cacheMessages([original]);
    manager['options'].onHistoryBatch([command], []);
    expect(events.slice(-3)).toEqual(['update', 'delete', 'batch']);
    expect(messages).not.toHaveBeenCalled();
    // Explicit history (native bool=false) retains command single events but does not emit a batch.
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true,
      name: 'group', members: [], lastMessageTime: 0 });
    jest.spyOn(account.im, 'getMessages').mockResolvedValue({ statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', direction: 'older',
      messages: [original, { ...original, msgId: '999', clientMessageId: 'command', content: command.rawContent, msgType: 50001 }] });
    const beforeHistory = events.length;
    await account.pickGroup('700')!.getHistory();
    expect(events.slice(beforeHistory)).toEqual(['update', 'delete']);
    await account.logout(); await account.login();
    expect(account.cachedMessage('700', original.msgId, 'server')!.deleted).toBe(true);
    expect(account.cachedMessage('700', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(4);
    const before = events.length;
    manager['options'].onHistoryBatch([command], []);
    expect(events).toHaveLength(before);
    await account.logout();
  });

  it.each(['sqlite', 'json'] as const)('publishes deletion summary before reference/delete events, but recall only through batch (%s)', async backend => {
    const account = createQrAccount({ backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'group', members: [], lastMessageTime: 0 });
    const target = { threadId: '700', msgId: '99', clientMessageId: 'target', senderUid: '22', content: 'body',
      msgType: 7, createTime: 1, status: 0, orderInConversation: '100', indexInConversation: '42' };
    const quote = { ...target, msgId: '100', clientMessageId: 'quote', orderInConversation: '99', indexInConversation: '41',
      referenceInfo: { refMessageId: '99', refMessageType: 7, refMessageStatus: 0, hint: 'body' } };
    account.cacheMessages([target, quote]);
    const events: string[] = [];
    let snapshot: unknown;
    account.on('notice.conversation.update', event => {
      events.push('conversation'); snapshot = event.conversation;
      expect(event.conversation).toMatchObject({ lastMessageIndex: '41', lastMessage: { msgId: '100' } });
      expect(account.cachedMessage('700', '99', 'server')!.deleted).toBe(true);
      expect(account.cachedMessage('700', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    });
    account.on('notice.message.update', () => events.push('update'));
    account.on('notice.message.delete', () => events.push('delete'));
    account.on('notice.message.batch-update', event => {
      events.push('batch');
      expect(event.updates[0]!.conversation.lastMessage!.ext).toEqual({ 's:is_recalled': 'true' });
    });
    expect(account.deleteCachedMessageByClientId('700', 'target', true)).toBe(true);
    expect(events).toEqual(['conversation', 'update', 'delete']);
    expect(snapshot).toMatchObject({ lastMessage: { referenceInfo: { refMessageStatus: 0 } } });
    account.markCachedMessageRecalled('700', { clientMessageId: 'quote', serverMessageId: '100' });
    expect(events).toEqual(['conversation', 'update', 'delete', 'batch']);
    await account.logout();
  });

  it('stops deletion work when its conversation-update listener logs out', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'group', members: [], lastMessageTime: 0 });
    const target = { threadId: '700', msgId: '99', clientMessageId: 'target', senderUid: '22', content: 'body',
      msgType: 7, createTime: 1, status: 0, orderInConversation: '100' };
    account.cacheMessages([target]);
    let logout!: Promise<void>;
    account.on('notice.conversation.update', event => {
      expect(event.conversation!.lastMessage).toBeNull(); // No candidates still produces the native callback.
      logout = account.logout();
    });
    const deleted = jest.fn(); account.on('notice.message.delete', deleted);
    expect(account.deleteCachedMessageByClientId('700', 'target', true)).toBe(true);
    await logout;
    expect(deleted).not.toHaveBeenCalled();
    await account.login();
    expect(account.cachedMessage('700', '99', 'server')!.deleted).toBe(true);
    await account.logout();
  });

  it('stops command batch delivery when a reference update handler logs out', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const original = { threadId: '700', msgId: '99', clientMessageId: 'original', senderUid: '22', content: 'body', msgType: 7, createTime: 1, status: 0 };
    account.cacheMessages([original, { ...original, msgId: '100', clientMessageId: 'quote', referenceInfo: { refMessageId: '99', refMessageType: 7, refMessageStatus: 0, hint: 'body' } }]);
    let logout!: Promise<void>;
    account.on('notice.message.update', () => { logout = account.logout(); });
    const deleted = jest.fn(); const batch = jest.fn();
    account.on('notice.message.delete', deleted); account.on('notice.message.batch-update', batch);
    const manager = jest.mocked(ConnectionManager.prototype.start).mock.instances[0]! as unknown as ConnectionManager;
    manager['options'].onHistoryBatch([{ threadId: '700', conversationShortId: '700', conversationType: 2, senderUid: '0',
      text: '', rawContent: '{"command_type":2,"conversation_id":"700","message_id":99}', messageType: 50001, raw: {} }], []);
    await logout;
    expect(deleted).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
    await account.login();
    expect(account.cachedMessage('700', '99', 'server')!.deleted).toBe(true);
    expect(account.cachedMessage('700', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(4);
    await account.logout();
  });

  it.each(['sqlite', 'json'] as const)('aligns active/local/client-only deletion and its events with native (%s)', async backend => {
    const account = createQrAccount({ backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '9007199254740993', conversationType: 2,
      inboxType: 3, isGroup: true, name: 'group', members: [], lastMessageTime: 0 });
    const group = Group.bind('700', 'wrong-contact-hint', account);
    const original = { msgId: '99', clientMessageId: 'original', threadId: '700', conversationType: 2,
      inboxType: 9, senderUid: '22', content: 'body', msgType: 7, createTime: 1, status: 0 };
    const quote = { ...original, msgId: '100', clientMessageId: 'quote', content: 'reply',
      referenceInfo: { refMessageId: '99', refMessageType: 7, refMessageStatus: 0, hint: 'body' } };
    account.cacheMessages([original, quote]);
    const events: string[] = [];
    account.on('notice.message.update', event => { events.push('update'); expect(event.message.msgId).toBe('100'); });
    account.on('notice.message.delete', event => { events.push('delete'); expect(event.message).not.toHaveProperty('deleted'); });
    const batch = jest.fn(); account.on('notice.message.batch-update', batch);
    const send = jest.spyOn(account.im, 'deleteMessage').mockResolvedValue({ statusCode: 0, statusMsg: '' });
    expect(group.deleteLocalMsg('99')).toBe(true);
    expect(account.cachedMessage('700', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(0);
    expect(events).toEqual(['delete']); expect(send).not.toHaveBeenCalled();
    expect(group.deleteLocalMsg({ clientMessageId: 'original' })).toBe(false);
    account.cacheMessages([original]);
    await expect(group.deleteMsg('99')).resolves.toEqual({ statusCode: 0, statusMsg: '' });
    expect(send).toHaveBeenCalledWith({ threadId: '700', conversationShortId: '9007199254740993', conversationType: 2, inboxType: 3, serverMessageId: '99' });
    expect(events).toEqual(['delete', 'update', 'delete']);
    expect(account.cachedMessage('700', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(4);
    account.cacheMessages([{ ...original, msgId: '0', clientMessageId: 'pending' }]);
    await expect(group.deleteMsg({ clientMessageId: 'PENDING' })).resolves.toEqual({ statusCode: 0, statusMsg: '' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(account.cachedMessage('700', 'pending', 'client')).toBeUndefined();
    expect(events.at(-1)).toBe('delete'); expect(batch).not.toHaveBeenCalled();
    await account.logout(); await account.login();
    expect(account.cachedMessage('700', 'original', 'client')).toBeUndefined();
    expect(account.cachedMessage('700', 'pending', 'client')).toBeUndefined();
    expect(account.cachedMessage('700', '100', 'server')!.referenceInfo!.refMessageStatus).toBe(4);
    await account.logout();
  });

  it.each([200, 3, 'network'] as const)('does not swallow active-delete failure %s or change local state', async status => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'group', members: [], lastMessageTime: 0 });
    const original = { msgId: '99', clientMessageId: 'original', threadId: '700', senderUid: '22', content: 'body', msgType: 7, createTime: 1, status: 0 };
    account.cacheMessages([original]);
    const notice = jest.fn(); account.on('notice', notice);
    const send = jest.spyOn(account.im, 'deleteMessage');
    if (status === 'network') send.mockRejectedValue(new Error('network failed'));
    else send.mockResolvedValue({ statusCode: status, statusMsg: 'rejected' });
    const pending = account.pickGroup('700')!.deleteMsg({ clientMessageId: 'original' });
    if (status === 'network') await expect(pending).rejects.toThrow('network failed');
    else await expect(pending).resolves.toEqual({ statusCode: status, statusMsg: 'rejected' });
    expect(account.cachedMessage('700', '99', 'server')).toEqual(original);
    expect(notice).not.toHaveBeenCalled();
    await account.logout();
  });

  it('requires cached conversation/client identity and never creates a friend conversation for deletion', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const friend = Friend.bind('20002', '0:1:10001:20002', '', account);
    const send = jest.spyOn(account.im, 'deleteMessage'); const create = jest.spyOn(account, 'ensureFriendConversation');
    await expect(friend.deleteMsg('99')).rejects.toThrow('本地会话不存在');
    expect(friend.deleteLocalMsg('99')).toBe(false);
    account.applyConversationInfo({ conversationId: friend.threadId, conversationShortId: '700', conversationType: 1,
      isGroup: false, name: 'private', members: [], lastMessageTime: 0 });
    await expect(friend.deleteMsg('99')).rejects.toThrow('本地消息不存在');
    account.cacheMessages([{ msgId: '99', threadId: friend.threadId, senderUid: '22', content: 'no client', msgType: 7, createTime: 1, status: 0 }]);
    await expect(friend.deleteMsg('99')).rejects.toThrow('本地消息不存在');
    expect(friend.deleteLocalMsg('99')).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    await account.logout();
  });

  it('uses captured client identity after an active-delete response, never a server-ID replacement', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'group', members: [], lastMessageTime: 0 });
    const original = { msgId: '99', clientMessageId: 'original', threadId: '700', senderUid: '22', content: 'body', msgType: 7, createTime: 1, status: 0 };
    account.cacheMessages([original]);
    let resolve!: (result: { statusCode: number; statusMsg: string }) => void;
    jest.spyOn(account.im, 'deleteMessage').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = account.pickGroup('700')!.deleteMsg('99');
    account.removeCachedMessage('700', '99');
    account.cacheMessages([{ ...original, clientMessageId: 'replacement' }]);
    resolve({ statusCode: 0, statusMsg: '' }); await pending;
    expect(account.cachedMessage('700', 'replacement', 'client')!.deleted).not.toBe(true);
    await account.logout();
  });

  it.each([0, 200, 3])('publishes active recall updates from outer status %s before returning, without waiting for a push', async statusCode => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true,
      name: 'group', members: [], lastMessageTime: 0 });
    const original = { msgId: '99', clientMessageId: 'original', threadId: '700', senderUid: '10001', content: 'body', msgType: 7, createTime: 1, status: 0 };
    account.cacheMessages([original]);
    const events: unknown[] = [];
    account.on('notice.message.batch-update', event => { events.push(event); });
    const recall = jest.spyOn(account.im, 'recall').mockResolvedValue({ statusCode, statusMsg: '', recalled: statusCode === 0 || statusCode === 200 });
    await account.pickGroup('700')!.recallMsg('99');
    expect(recall).toHaveBeenCalledTimes(1);
    if (statusCode === 3) {
      expect(events).toEqual([]);
      expect(account.cachedMessage('700', '99', 'server')).toEqual(original);
    } else {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ updates: [{ messages: [expect.objectContaining({ msgId: '99', ext: { 's:is_recalled': 'true' } })] }] });
      account['assembler']!.receiveNotice({ type: 'message.recall', conversationId: '700', conversationType: 2,
        serverMessageId: '99', clientMessageId: 'original', raw: {} });
      expect(events).toHaveLength(2); // HTTP callback and later push are independent native producers.
    }
    await account.logout();
  });

  it('does not let a server-only recall signal bypass the native client-ID wrapper', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const original = { msgId: '99', clientMessageId: 'client', threadId: '700', senderUid: '22', content: 'body', msgType: 7, createTime: 1, status: 0 };
    account.cacheMessages([original]);
    expect(account.markCachedMessageRecalled('700', { serverMessageId: '99' })).toBeUndefined();
    expect(account.cachedMessage('700', '99', 'server')).toEqual(original);
    await account.logout();
  });

  it('keeps hidden ordinary messages in cache without new-message or update callbacks', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const onMessage = jest.fn(); const onUpdate = jest.fn();
    account.on('message', onMessage); account.on('notice.message.update', onUpdate);
    account['assembler']!.receiveMessage({ threadId: '700', conversationShortId: '700', conversationType: 2,
      senderUid: '22', serverMessageId: '99', clientMessageId: 'client', messageType: 7, status: 1,
      text: 'hidden', rawContent: '{"text":"hidden"}', raw: {} });
    expect(account.cachedMessage('700', '99', 'server')!.content).toBe('{"text":"hidden"}');
    expect(onMessage).not.toHaveBeenCalled(); expect(onUpdate).not.toHaveBeenCalled();
    expect(account.cachedGroup('700')).toBeUndefined();
    await account.logout();
  });

  it.each(['sqlite', 'json'] as const)('exposes raw read summaries from the current account cache (%s)', async backend => {
    const account = createQrAccount({ backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const contact = Group.bind('700', '700', account);
    const address = { threadId: '700', conversationShortId: '700', conversationType: 2 as const };
    account.cacheMessages([{ ...address, msgId: '90', clientMessageId: 'cached-only', senderUid: '10001', content: 'test',
      msgType: 7, status: 0, createTime: 1000, orderInConversation: '10', indexInConversation: '10' }]);
    account.replaceCachedGroupMembers('700', [{ uid: '22', secUid: 'sec22', role: 0 }]);
    const summaryNotice = jest.fn();
    account.on('notice.conversation.read-summary', summaryNotice);
    expect(contact.getCachedReadSummary()).toMatchObject({ clientMessageId: '', readUsers: [], isAllRead: false });
    const query = jest.spyOn(ImService.prototype, 'getConversationReadState').mockResolvedValue({ statusCode: 0, statusMsg: '',
      readIndexes: [{ uid: '22', index: '10' }], minIndexes: [{ uid: '22', index: '0' }] });
    await contact.getReadState();
    expect(contact.getCachedReadSummary()).toMatchObject({ serverMessageId: '90', readUsers: [{ uid: '22' }], isAllRead: true });
    contact.getCachedReadSummary()!.readUsers.length = 0;
    expect(contact.getCachedReadSummary()!.readUsers).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(summaryNotice).toHaveBeenCalledTimes(1);
    expect(summaryNotice.mock.calls[0]![0].summaries).toMatchObject([{ conversationId: '700', isAllRead: true }]);
    await contact.getReadState();
    expect(summaryNotice).toHaveBeenCalledTimes(1);
    account.upsertCachedGroupMembers('700', [{ uid: '22', secUid: 'changed-sec', role: 0 }]);
    expect(summaryNotice).toHaveBeenCalledTimes(1); // A member cache write alone is not a proven native trigger.
    await contact.getReadState();
    expect(summaryNotice).toHaveBeenCalledTimes(2);
    expect(summaryNotice.mock.calls[1]![0].summaries[0].readUsers[0].secUid).toBe('changed-sec');
    const rawRead = jest.fn(() => {
      expect(summaryNotice).toHaveBeenCalledTimes(3);
      expect(account.cachedReadCursors('700')[0]!.readIndex).toBe('11');
    });
    account.on('notice.group.marked-read', rawRead);
    account['assembler']!.receiveNotice({ type: 'conversation.read', conversationId: '700', conversationType: 2,
      readerUid: '22', readMessageIndex: '11', raw: {} });
    expect(summaryNotice).toHaveBeenCalledTimes(3); // Read-index changes matter even when isAllRead remains true.
    expect(rawRead).toHaveBeenCalledTimes(1);
    expect(account.cachedReadSummary('another-conversation')).toBeUndefined();
    await account.logout();
    expect(contact.getCachedReadSummary()).toBeUndefined();
    await account.login();
    expect(contact.getCachedReadSummary()).toMatchObject({ serverMessageId: '90', isAllRead: true });
    await contact.getReadState();
    expect(summaryNotice).toHaveBeenCalledTimes(4); // Notification cache is per runtime, not persisted.
    await account.logout();
  });

  it('updates all read-summary notification entries before one batch and skips missing messages without clearing entries', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const make = (id: string) => ({ conversationId: id, conversationShortId: id, conversationType: 2,
      clientMessageId: 'client', serverMessageId: '90', createTime: '1000', isAllRead: false, readUsers: [] });
    const summaries = new Map([['700', make('700')], ['701', make('701')]]);
    jest.spyOn(account, 'cachedReadSummary').mockImplementation(id => summaries.get(id));
    const notice = jest.fn(() => {
      // Reentrant recalculation must observe the entire new cache and produce no duplicate batch.
      account.updateReadSummaries(['700', '701']);
    });
    account.on('notice.conversation.read-summary', notice);
    account.updateReadSummaries(['700', '701', '700', 'missing']);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(account['readSummaryNotifications'].size).toBe(2);
    summaries.delete('700');
    account.updateReadSummaries(['700']);
    expect(account['readSummaryNotifications'].has('700')).toBe(true);
    summaries.set('700', make('700'));
    account.updateReadSummaries(['700']);
    expect(notice).toHaveBeenCalledTimes(1);
    summaries.get('700')!.serverMessageId = '91';
    account.updateReadSummaries(['700']);
    expect(notice).toHaveBeenCalledTimes(2);
    await account.logout();
    expect(account['readSummaryNotifications'].size).toBe(0);
    account.updateReadSummaries(['700']);
    expect(notice).toHaveBeenCalledTimes(2);
  });

  it.each(['sqlite', 'json'] as const)('projects receipt privacy using account policy caches without changing raw summaries (%s)', async backend => {
    const account = createQrAccount({ backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const contact = Group.bind('700', '700', account);
    account.cacheMessages([{ threadId: '700', conversationShortId: '700', conversationType: 2, msgId: '90',
      senderUid: '10001', content: 'test', msgType: 7, status: 0, createTime: 1000,
      orderInConversation: '10', indexInConversation: '10' }]);
    account.replaceCachedGroupMembers('700', [{ uid: '22', secUid: 'sec22', role: 0 }]);
    account.applyParticipantReadIndex('700', '22', '10');
    const privacy = jest.spyOn(ImService.prototype, 'getMessageReadPrivacy').mockResolvedValue({ statusCode: 0, statusMsg: '',
      currentUserSwitch: 0, enableReadState: true, messages: [{ serverMessageId: '90', errorCode: 0, on: [], off: ['22'] }] });
    const switchQuery = jest.spyOn(ImService.prototype, 'getReadReceiptPrivacy').mockResolvedValue({ statusCode: 0, statusMsg: '',
      currentUserSwitch: 0, enableReadState: true });
    const rawNotice = jest.fn(); account.on('notice.conversation.read-summary', rawNotice);
    await expect(contact.getReadReceipt()).resolves.toMatchObject({ raw: { isAllRead: true, readUsers: [{ uid: '22' }] },
      readUsers: [], isAllRead: false });
    await contact.getReadReceipt();
    expect(privacy).toHaveBeenCalledTimes(1);
    expect(switchQuery).not.toHaveBeenCalled();
    expect(contact.getCachedReadSummary()!.isAllRead).toBe(true);
    expect(rawNotice).not.toHaveBeenCalled();
    await account.logout(); await account.login();
    await expect(contact.getReadReceipt()).resolves.toMatchObject({ readUsers: [], isAllRead: false });
    expect(privacy).toHaveBeenCalledTimes(1); // Persisted per-message policy is reused after the current switch is checked.
    expect(switchQuery).toHaveBeenCalledTimes(1);
    privacy.mockResolvedValue({ statusCode: 0, statusMsg: '', currentUserSwitch: 0, enableReadState: true,
      messages: [{ serverMessageId: '90', errorCode: 0, on: [], off: [] }] });
    await expect(contact.getReadReceipt(true)).resolves.toMatchObject({ readUsers: [{ uid: '22' }], isAllRead: true });
    expect(privacy).toHaveBeenCalledTimes(2);
    expect(rawNotice).not.toHaveBeenCalled();
    account.cacheMessages([{ threadId: '700', conversationShortId: '700', conversationType: 2, msgId: '0',
      clientMessageId: 'pending-client', ext: { 's:client_message_id': 'pending-client' }, senderUid: '10001',
      content: 'pending', msgType: 7, status: 0, createTime: 2000, orderInConversation: '20', indexInConversation: '20' }]);
    await expect(contact.getReadReceipt()).resolves.toMatchObject({ raw: { serverMessageId: '0' },
      privacy: { statusCode: 0, messages: [] }, readUsers: [], isAllRead: false });
    expect(privacy).toHaveBeenCalledTimes(2); // serverId0 has no per-message network lookup.
    await account.logout();
  });

  it.each([undefined, false] as const)('persists/isolates read cursors across query, push and logout (localState=%s)', async localState => {
    const account = createQrAccount(localState);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    if (localState === false) expect(account.cachedReadSummary('700')).toBeUndefined();
    const address = { threadId: '700', conversationShortId: '700', conversationType: 2 as const, inboxType: 1 };
    const snapshot = { statusCode: 0, statusMsg: '', readIndexes: [{ uid: '22', index: '10', indexV2: '999', minIndex: '999' }], minIndexes: [{ uid: '22', index: '-2' }] };
    const query = jest.spyOn(ImService.prototype, 'getConversationReadState').mockResolvedValue(snapshot);
    await account.readConversationState(address);
    expect(account.cachedReadCursors('700')).toEqual([{ uid: '22', readIndex: '10', minIndex: '-2' }]);
    expect(account.applyParticipantReadIndex('700', '10001', '12')).toBe(false);
    expect(account.applyParticipantReadIndex('700', '22', '10')).toBe(false);
    expect(account.applyParticipantReadIndex('700', '22', '9')).toBe(false);
    expect(account.applyParticipantReadIndex('700', '22', '12')).toBe(true);
    account.cachedReadCursors('700')[0]!.minIndex = '999';
    expect(account.cachedReadCursors('700')[0]).toEqual({ uid: '22', readIndex: '12', minIndex: '-2' });
    let resolve!: (value: typeof snapshot) => void;
    query.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = account.readConversationState(address);
    account.applyParticipantReadIndex('700', '22', '15'); resolve(snapshot);
    await expect(pending).rejects.toThrow('状态已变化');
    expect(account.cachedReadCursors('700')[0]!.readIndex).toBe('15');
    await account.logout();
    expect(account.applyParticipantReadIndex('700', '22', '20')).toBe(false);
    expect(account.cachedReadCursors('700')).toEqual([]);
    await account.login();
    expect(account.cachedReadCursors('700')).toEqual(localState === false ? [] : [{ uid: '22', readIndex: '15', minIndex: '-2' }]);
    await account.readConversationState(address);
    account.removeCachedGroupMembers('700', ['22']);
    expect(account.cachedReadCursors('700')).toEqual([]);
    await account.readConversationState(address);
    account.forgetConversation('700');
    expect(account.cachedReadCursors('700')).toEqual([]);
    await account.logout();
  });

  it.each(['logout', 'delete', 'member-remove', 'group-list'] as const)('rejects an in-flight read snapshot after %s', async action => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const snapshot = { statusCode: 0, statusMsg: '', readIndexes: [{ uid: '22', index: '10' }], minIndexes: [] };
    account.rememberGroup(Group.bind('700', '700', account));
    let resolve!: (value: typeof snapshot) => void;
    jest.spyOn(account.im, 'getConversationReadState').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = account.readConversationState({ threadId: '700', conversationShortId: '700', conversationType: 2, inboxType: 1 });
    if (action === 'logout') await account.logout();
    else if (action === 'delete') account.forgetConversation('700');
    else if (action === 'group-list') {
      jest.spyOn(ImInboxQueries.prototype, 'groupList').mockResolvedValue({ statusCode: 0, statusMsg: '', groups: [] });
      await account.getGroupList(true);
    }
    else account.removeCachedGroupMembers('700', ['22']);
    resolve(snapshot);
    await expect(pending).rejects.toThrow('状态已变化');
    expect(account.cachedReadCursors('700')).toEqual([]);
    await account.logout();
  });

  it.each(['json', 'sqlite', 'disabled'] as const)('shares confirmed relation state across user views without creating membership or notices (%s)', async backend => {
    const account = createQrAccount(backend === 'disabled' ? false : { backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const friend = Friend.bind('22', '', '', account, { secUid: 'sec22', blocked: true, remark: 'old' });
    const stranger = Stranger.bind('22', '', '', account, { secUid: 'sec22' });
    const member = Member.bind({ uid: '22', secUid: 'sec22', role: 2, alias: 'group-alias' }, Group.bind('700', '700', account));
    const notice = jest.fn(), request = jest.fn();
    account.on('notice', notice); account.on('request', request);
    const send = jest.spyOn(account.im, 'setUserFollowed').mockResolvedValue({ statusCode: 0, statusMsg: '', followStatus: 1 });
    await member.setFollowed();
    expect(friend.followStatus).toBe(1); expect(stranger.followStatus).toBe(1);
    expect(friend.blocked).toBe(false);
    send.mockResolvedValue({ statusCode: 3, statusMsg: 'rejected', followStatus: 0 });
    await friend.setFollowed(false);
    expect(member.followStatus).toBe(1);
    for (const followStatus of [0, 4, 2] as const) {
      account.updateUserRelation('22', { blocked: true });
      send.mockResolvedValue({ statusCode: 0, statusMsg: '', followStatus });
      await stranger.setFollowed(followStatus !== 0);
      expect([friend.followStatus, stranger.followStatus, member.followStatus]).toEqual([followStatus, followStatus, followStatus]);
      expect(friend.blocked).toBe(followStatus !== 2);
      expect(account.fl.size).toBe(0);
      expect(account.sl.size).toBe(0);
      expect(account.gl.size).toBe(0);
      expect(member.role).toBe(2); expect(member.alias).toBe('group-alias');
    }
    jest.spyOn(account.im, 'getUserProfile').mockResolvedValue({ uid: '22', secUid: 'sec22', nickname: 'peer', followStatus: 4, blocked: false, remark: '' });
    await member.getProfile();
    expect(member.role).toBe(2); expect(member.alias).toBe('group-alias'); expect(member.nickname).toBe('peer');
    expect(friend.followStatus).toBe(4); expect(friend.remark).toBe(''); expect(stranger.followStatus).toBe(4);
    expect(account.fl.size).toBe(0); // Reading/member actions do not manufacture friendship.
    expect(notice).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    await account.logout(); await account.login();
    expect(account.getUserRelation('22')).toEqual(backend === 'disabled' ? undefined : { followStatus: 4, blocked: false, remark: '' });
    await account.logout();
  });

  it('keeps relation state isolated per account and rejects mismatched profile identities', async () => {
    const account = createQrAccount();
    const other = createQrAccount();
    account.updateUserRelation('22', { followStatus: 4 });
    expect(other.getUserRelation('22')).toBeUndefined();
    other.updateUserRelation('22', { followStatus: 0 });
    expect(account.getUserRelation('22')?.followStatus).toBe(4);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    jest.spyOn(account.im, 'getUserProfile').mockResolvedValue({ uid: '33', secUid: 'sec22', nickname: 'wrong', followStatus: 1 });
    await expect(account.readUserProfile('22', 'sec22')).rejects.toThrow('身份不匹配');
    expect(account.getUserRelation('22')?.followStatus).toBe(4);
    await account.logout();
  });

  it('retries the original account action only after successful human verification and bounds repeated challenges', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const challenge = new ActionChallengeError('passport-decision', '{"detail":"fixture"}');
    const action = jest.fn().mockRejectedValueOnce(challenge).mockResolvedValue({ followStatus: 4 });
    const seen = jest.fn(async ({ verification }) => {
      expect(verification.account).toBe(account);
      expect(account.online).toBe(true);
      await verification.complete({ status: true });
    });
    account.on('system.action.verification', seen);
    await expect(account.runVerifiedAction({ operation: 'follow', uid: '22' }, action)).resolves.toEqual({ followStatus: 4 });
    expect(action).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenCalledTimes(1);
    action.mockReset().mockRejectedValue(challenge);
    await expect(account.runVerifiedAction({ operation: 'follow', uid: '22' }, action)).rejects.toBe(challenge);
    expect(action).toHaveBeenCalledTimes(3);
    await account.logout();
  });

  it('does not retry ambiguous failures or resume business actions after logout', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const action = jest.fn().mockRejectedValue(new Error('response lost'));
    await expect(account.runVerifiedAction({ operation: 'follow', uid: '22' }, action)).rejects.toThrow('response lost');
    expect(action).toHaveBeenCalledTimes(1);
    action.mockReset().mockRejectedValue(new ActionChallengeError('bdturing', 'fixture'));
    const waiting = new Promise<void>(resolve => account.once('system.action.verification', () => resolve()));
    const pending = account.runVerifiedAction({ operation: 'follow', uid: '22' }, action);
    const rejected = expect(pending).rejects.toThrow('账号已停止');
    await waiting; await account.logout(); await rejected;
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('does not emit a business challenge whose response arrives after logout (relogin=%s)', async relogin => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let reject!: (error: unknown) => void;
    const action = jest.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const challenge = new ActionChallengeError('bdturing', 'synthetic-late-challenge');
    const seen = jest.fn(({ verification }) => { verification.cancel('fixture cleanup'); });
    account.on('system.action.verification', seen);
    const pending = account.runVerifiedAction({ operation: 'follow', uid: '22' }, action);
    const observed = pending.catch(error => error);
    await account.logout();
    expect(account.online).toBe(false);
    if (relogin) await account.login();
    reject(challenge);
    try {
      expect(await observed).toBe(challenge);
      expect(seen).not.toHaveBeenCalled();
      expect(action).toHaveBeenCalledTimes(1);
    } finally { await account.logout(); }
  });

  it.each([
    ['friend', false], ['stranger', false], ['member', false],
    ['friend', true], ['stranger', true], ['member', true],
  ] as const)('returns the actual late %s follow result without repopulating a retired account cache (relogin=%s)', async (kind, relogin) => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let finish!: (result: { statusCode: number; statusMsg: string; followStatus: 1 }) => void;
    const action = jest.spyOn(account.im, 'setUserFollowed').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const contact = kind === 'friend' ? Friend.bind('22', '', '', account, { secUid: 'fixture-sec' })
      : kind === 'stranger' ? Stranger.bind('22', '', '', account, { secUid: 'fixture-sec' })
        : Member.bind({ uid: '22', secUid: 'fixture-sec', role: 0 }, Group.bind('700', '700', account));
    const pending = contact.setFollowed();
    await account.logout();
    expect(account.getUserRelation('22')).toBeUndefined();
    if (relogin) {
      await account.login();
      account.updateUserRelation('22', { followStatus: 0, blocked: true });
    }
    const result = { statusCode: 0, statusMsg: 'OK', followStatus: 1 as const };
    finish(result);
    try {
      await expect(pending).resolves.toBe(result);
      expect(account.getUserRelation('22')).toEqual(relogin ? { followStatus: 0, blocked: true } : undefined);
      expect(action).toHaveBeenCalledTimes(1);
    } finally { await account.logout(); }
  });

  describe.each(['memory', 'json', 'sqlite'] as const)('relationship mutation ownership (%s)', backend => {
    it.each([
      ['friend', 'logout'], ['stranger', 'logout'], ['friend', 'relogin'], ['stranger', 'relogin'],
      ['friend', 'new-relation'], ['stranger', 'new-relation'],
    ] as const)('isolates the background %s block profile after %s', async (kind, transition) => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in block fixture'));
      const account = createQrAccount(backend === 'memory' ? false : { backend });
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      const action = jest.spyOn(account.im, 'setUserBlocked').mockResolvedValue({ statusCode: 0, statusMsg: 'fixture' });
      type Profile = NonNullable<Awaited<ReturnType<ImService['getUserProfile']>>>;
      let finish!: (value: Profile) => void;
      const fetchProfile = jest.spyOn(account.im, 'getUserProfile').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const contact = kind === 'friend' ? Friend.bind('22', '', '', account, { secUid: 'fixture-sec' })
        : Stranger.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const refresh = jest.spyOn(contact, 'getProfile');
      await contact.setBlocked(true);
      const task = refresh.mock.results[0]!.value as Promise<unknown>;
      if (transition !== 'new-relation') await account.logout();
      if (transition === 'relogin') await account.login();
      if (transition !== 'logout') account.updateUserRelation('22', { blocked: false, followStatus: 1 });
      finish({ uid: '22', secUid: 'fixture-sec', nickname: 'old', blocked: true, followStatus: 0 });
      try {
        if (transition === 'new-relation') await task;
        else await expect(task).rejects.toThrow('账号状态已变化');
        expect(account.getUserRelation('22')).toEqual(transition === 'logout' ? undefined : { blocked: false, followStatus: 1 });
        expect(action).toHaveBeenCalledTimes(1); expect(fetchProfile).toHaveBeenCalledTimes(1);
      } finally { await account.logout(); }
    });

    it.each(['friend', 'stranger'] as const)('routes actual %s block and profile HTTP responses through separate state confirmation', async kind => {
      const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in block fixture'));
      const account = createQrAccount(backend === 'memory' ? false : { backend });
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      const contact = kind === 'friend' ? Friend.bind('22', '', '', account, { secUid: 'fixture-sec' })
        : Stranger.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const refresh = jest.spyOn(contact, 'getProfile');
      const request = jest.spyOn(ApiConnection.prototype, 'requestRaw').mockImplementation(async (input, init) => {
        const url = new URL(input);
        expect(url.origin).toBe('https://imdesktop.douyin.com'); expect(init.method).toBe('GET');
        expect(url.searchParams.get('sec_user_id')).toBe('fixture-sec');
        let body;
        if (url.pathname === '/aweme/v1/web/user/block/') {
          expect(url.searchParams.get('block_type')).toBe('1'); expect(url.searchParams.get('source')).toBe('0');
          body = { status_code: 0, is_block: true }; // This field must not dictate local state.
        } else {
          expect(url.pathname).toBe('/aweme/v1/web/user/profile/other/'); expect(url.searchParams.get('source')).toBe('together');
          body = { status_code: 0, user: { uid: '22', sec_uid: 'fixture-sec', nickname: 'confirmed profile', follow_status: 1, is_block: false } };
        }
        return { ok: true, status: 200, headers: new Headers(), data: '', rawText: JSON.stringify(body) };
      });
      try {
        await expect(contact.setBlocked(true)).resolves.toMatchObject({ statusCode: 0 });
        await refresh.mock.results[0]!.value;
        expect(account.getUserRelation('22')).toEqual({ blocked: false, followStatus: 1 });
        expect(contact.nickname).toBe('confirmed profile');
        expect(request).toHaveBeenCalledTimes(2); expect(network).not.toHaveBeenCalled();
      } finally { await account.logout(); }
    });

    it.each([
      ['friend', 0], ['stranger', 0], ['friend', 8], ['stranger', 8],
    ] as const)('refreshes %s profile independently after block response %s instead of inferring state', async (kind, statusCode) => {
      const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in block fixture'));
      const account = createQrAccount(backend === 'memory' ? false : { backend });
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      const result = { statusCode, statusMsg: 'fixture' };
      const action = jest.spyOn(account.im, 'setUserBlocked').mockResolvedValue(result);
      type Profile = NonNullable<Awaited<ReturnType<ImService['getUserProfile']>>>;
      let finish!: (value: Profile) => void;
      const profile = jest.spyOn(account.im, 'getUserProfile').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const friend = Friend.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const stranger = Stranger.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const contact = kind === 'friend' ? friend : stranger;
      account.updateUserRelation('22', { followStatus: 2, blocked: false });
      try {
        await expect(contact.setBlocked(true)).resolves.toBe(result);
        expect(profile).toHaveBeenCalledTimes(1);
        expect(profile).toHaveBeenCalledWith('fixture-sec');
        expect(account.getUserRelation('22')).toEqual({ followStatus: 2, blocked: false });
        finish({ uid: '22', secUid: 'fixture-sec', nickname: 'fresh', followStatus: 0, blocked: true });
        for (let tick = 0; tick < 4; tick++) await Promise.resolve();
        expect(friend.blocked).toBe(true); expect(stranger.blocked).toBe(true);
        expect(friend.followStatus).toBe(0); expect(stranger.followStatus).toBe(0);
        expect(contact.nickname).toBe('fresh');
        profile.mockRejectedValueOnce(new Error('profile unavailable'));
        await expect(contact.setBlocked(false)).resolves.toBe(result);
        for (let tick = 0; tick < 4; tick++) await Promise.resolve();
        expect(account.getUserRelation('22')).toEqual({ followStatus: 0, blocked: true });
        const before = profile.mock.calls.length;
        action.mockRejectedValueOnce(new Error('block response lost'));
        await expect(contact.setBlocked(false)).rejects.toThrow('block response lost');
        expect(profile).toHaveBeenCalledTimes(before);
        expect(action).toHaveBeenCalledTimes(3);
        expect(network).not.toHaveBeenCalled();
      } finally { await account.logout(); }
    });

    it.each(['friend', 'stranger'] as const)('checks the actual remark response before updating shared %s state', async kind => {
      const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in remark fixture'));
      const account = createQrAccount(backend === 'memory' ? false : { backend });
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      const friend = Friend.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const stranger = Stranger.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const contact = kind === 'friend' ? friend : stranger;
      const request = jest.spyOn(ApiConnection.prototype, 'requestRaw').mockResolvedValue({ ok: true, status: 200,
        headers: new Headers(), data: '', rawText: JSON.stringify({ status_code: 0, remark_name: 'unexpected' }) });
      account.updateUserRelation('22', { remark: 'confirmed old' });
      try {
        const result = await contact.setRemark('requested');
        expect(result.statusCode).not.toBe(0);
        expect(result).not.toHaveProperty('remark');
        expect(friend.remark).toBe('confirmed old'); expect(stranger.remark).toBe('confirmed old');
        request.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), data: '',
          rawText: JSON.stringify({ status_code: 200, remark_name: '' }) });
        await expect(contact.setRemark(' \t')).resolves.toMatchObject({ statusCode: 0, remark: '' });
        expect((request.mock.calls[1]![1].body as FormData).get('remark_name')).toBe('');
        expect(friend.remark).toBe(''); expect(stranger.remark).toBe('');
        expect(request).toHaveBeenCalledTimes(2);
        expect(network).not.toHaveBeenCalled();
      } finally { await account.logout(); }
    });

    it.each(['friend', 'stranger'] as const)('publishes confirmed %s remark state in the same login without replaying local failures', async kind => {
      const account = createQrAccount(backend === 'memory' ? false : { backend });
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      const result = { statusCode: 0, statusMsg: 'OK', remark: '' };
      const action = jest.spyOn(account.im, 'setUserRemark').mockResolvedValue(result);
      const friend = Friend.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const stranger = Stranger.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const contact = kind === 'friend' ? friend : stranger;
      const invoke = () => contact.setRemark('');
      account.updateUserRelation('22', { blocked: true, remark: 'before' });
      try {
        await expect(invoke()).resolves.toBe(result);
        const confirmed = account.getUserRelation('22');
        expect(confirmed).toEqual({ blocked: true, remark: '' });
        expect(friend.blocked).toBe(stranger.blocked); expect(friend.remark).toBe(stranger.remark);
        action.mockResolvedValueOnce({ statusCode: 3, statusMsg: 'rejected', remark: 'not applied' });
        await expect(invoke()).resolves.toMatchObject({ statusCode: 3 });
        expect(account.getUserRelation('22')).toBe(confirmed);
        const failure = new Error('fixture local publication failed');
        jest.spyOn(account, 'updateUserRelation').mockImplementationOnce(() => { throw failure; });
        await expect(invoke()).rejects.toBe(failure);
        expect(action).toHaveBeenCalledTimes(3);
      } finally { await account.logout(); }
    });

    it.each([
      ['friend', 'block', false], ['stranger', 'block', false],
      ['friend', 'remark', false], ['stranger', 'remark', false],
      ['friend', 'block', true], ['stranger', 'block', true],
      ['friend', 'remark', true], ['stranger', 'remark', true],
    ] as const)('does not publish late %s %s results into a retired login (relogin=%s)', async (kind, operation, relogin) => {
      const account = createQrAccount(backend === 'memory' ? false : { backend });
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      type Result = { statusCode: number; statusMsg: string; remark?: string };
      let finish!: (result: Result) => void;
      const action = jest.spyOn(account.im, operation === 'block' ? 'setUserBlocked' : 'setUserRemark')
        .mockImplementation(() => new Promise<Result>(resolve => { finish = resolve; }));
      const contact = kind === 'friend' ? Friend.bind('22', '', '', account, { secUid: 'fixture-sec' })
        : Stranger.bind('22', '', '', account, { secUid: 'fixture-sec' });
      const pending = operation === 'block' ? contact.setBlocked(true) : contact.setRemark('old request');
      await account.logout();
      expect(account.getUserRelation('22')).toBeUndefined();
      if (relogin) {
        await account.login();
        account.updateUserRelation('22', { blocked: false, remark: 'new login' });
      }
      const publish = jest.spyOn(account, 'updateUserRelation');
      const result = { statusCode: 0, statusMsg: 'OK', ...(operation === 'remark' ? { remark: 'old response' } : {}) };
      finish(result);
      try {
        await expect(pending).resolves.toBe(result);
        expect(publish).not.toHaveBeenCalled();
        expect(account.getUserRelation('22')).toEqual(relogin ? { blocked: false, remark: 'new login' } : undefined);
        expect(action).toHaveBeenCalledTimes(1);
      } finally { await account.logout(); }
    });
  });

  it('never interprets a local publication error as a challenge to retry a completed mutation', async () => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const action = jest.fn().mockResolvedValue({ statusCode: 0, followStatus: 1 });
    const error = new ActionChallengeError('bdturing', 'synthetic-local-error');
    const publish = jest.fn(() => { throw error; });
    const seen = jest.fn(); account.on('system.action.verification', seen);
    try {
      await expect(account.runVerifiedAction({ operation: 'follow', uid: '22' }, action, publish)).rejects.toBe(error);
      expect(action).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(seen).not.toHaveBeenCalled();
    } finally { await account.logout(); }
  });

  it.each(['friend', 'stranger', 'member'] as const)('publishes a confirmed %s follow result after verification within the same login', async kind => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const result = { statusCode: 0, statusMsg: 'OK', followStatus: 4 as const };
    const action = jest.spyOn(account.im, 'setUserFollowed')
      .mockRejectedValueOnce(new ActionChallengeError('bdturing', 'synthetic-challenge'))
      .mockResolvedValue(result);
    const contact = kind === 'friend' ? Friend.bind('22', '', '', account, { secUid: 'fixture-sec' })
      : kind === 'stranger' ? Stranger.bind('22', '', '', account, { secUid: 'fixture-sec' })
        : Member.bind({ uid: '22', secUid: 'fixture-sec', role: 0 }, Group.bind('700', '700', account));
    const seen = jest.fn(({ verification }) => {
      expect(account.getUserRelation('22')).toBeUndefined();
      void verification.complete({ status: true });
    });
    account.on('system.action.verification', seen);
    try {
      await expect(contact.setFollowed()).resolves.toBe(result);
      expect(account.getUserRelation('22')).toEqual({ followStatus: 4 });
      expect(action).toHaveBeenCalledTimes(2);
      expect(action.mock.calls[0]).toEqual(action.mock.calls[1]);
      expect(seen).toHaveBeenCalledTimes(1);
    } finally { await account.logout(); }
  });

  it.each((['friend', 'stranger', 'member'] as const).flatMap(kind =>
    ['', 'null'].map(rawText => ({ kind, rawText }))))(
    'does not dispatch verification or replay $kind follow for a discarded BDTuring header ($rawText)', async ({ kind, rawText }) => {
      const connection = new ApiConnection({ enableABogus: false });
      // Ticket issuance is covered separately; keep the real business/HTTP/error path.
      jest.spyOn(connection, 'hasBoundTicket').mockReturnValue(true);
      const account = createQrAccount(false, connection);
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      const contact = kind === 'friend' ? Friend.bind('22', '', '', account, { secUid: 'fixture-peer' })
        : kind === 'stranger' ? Stranger.bind('22', '', '', account, { secUid: 'fixture-peer' })
          : Member.bind({ uid: '22', secUid: 'fixture-peer', role: 0 }, Group.bind('700', '700', account));
      account.updateUserRelation('22', { followStatus: 0 });
      const seen = jest.fn(({ verification }) => { void verification.cancel('unexpected challenge'); });
      account.on('system.action.verification', seen);
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        if (new URL(String(input)).pathname === '/passport/ticket_guard/get_client_cert/') return Response.json({ data: {} });
        expect(new URL(String(input)).pathname).toBe('/aweme/v1/web/commit/follow/user/');
        return new Response(rawText, { headers: { 'bdturing-verify': '{"detail":"fixture-private"}' } });
      });
      fetch.mockClear();
      try {
        await expect(contact.setFollowed()).rejects.toMatchObject({ name: 'DouyinResponseError', kind: rawText ? 'invalid-json' : 'empty' });
        expect(seen).not.toHaveBeenCalled();
        expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
          '/passport/ticket_guard/get_client_cert/', '/aweme/v1/web/commit/follow/user/',
        ]);
        expect(account.getUserRelation('22')).toEqual({ followStatus: 0 });
      } finally { await account.logout(); }
    });

  it.each((['friend', 'stranger', 'member'] as const).flatMap(kind =>
    (['passport-decision', 'bdturing'] as const).flatMap(source =>
      (['confirmed', 'cancelled', 'cookie-only', 'rejected'] as const).map(outcome => ({ kind, source, outcome }))),
  ))('carries $kind $source follow through real transport, ticket rotation and relation persistence ($outcome)', async ({ kind, source, outcome }) => {
    const origin = 'https://imdesktop.douyin.com';
    const followPath = '/aweme/v1/web/commit/follow/user/';
    const guard = new DesktopTicketGuard();
    const guardHeaders = (ticket: string, binding: string) => ({
      'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket, ts_sign_ree: binding })).toString('base64'),
    });
    guard.acceptResponse(guard.prepare(new URL(`${origin}/passport/web/check_qrconnect/`), ''),
      new Headers(guardHeaders('session-id', 'fixture-initial-binding')), 'session-id');
    const connection = new ApiConnection({ desktopTicketGuard: guard.exportState(), enableABogus: false,
      deviceId: '10002', installId: '10003', userAgent: 'fixture-follow-UA' });
    // Login/hardware/IM startup use the enclosing fixtures. From contact.setFollowed
    // through final fetch, verification HTTP, persistence and profile readback, no
    // method is replaced. The human completion is synthetic, not official UI proof.
    const account = createQrAccount({ backend: 'json' }, connection);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const contact = kind === 'friend' ? Friend.bind('22', '', '', account, { secUid: 'fixture-peer' })
      : kind === 'stranger' ? Stranger.bind('22', '', '', account, { secUid: 'fixture-peer' })
        : Member.bind({ uid: '22', secUid: 'fixture-peer', role: 0 }, Group.bind('700', '700', account));
    const initialRelation = { followStatus: 0 as const, blocked: true };
    account.updateUserRelation('22', initialRelation);
    const store = new AccountStore({ dataDir });
    const readDiskRelation = () => {
      const state = createImStateStore({ accountDir: join(dataDir, 'accounts', '10001'), backend: 'json' });
      try { return state.getUserRelation('22'); } finally { state.close(); }
    };
    let followCalls = 0, verificationCalls = 0, profileCalls = 0;
    let originalQuery = '';
    const publicPoints: string[] = [];
    const checkSignature = (headers: Headers, rotated: boolean) => {
      const point = Buffer.from(headers.get('bd-ticket-guard-ree-public-key')!, 'base64');
      publicPoints.push(point.toString('base64'));
      const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
      const data = JSON.parse(Buffer.from(headers.get('bd-ticket-guard-client-data')!, 'base64').toString());
      const session = rotated ? 'fixture-rotated-session' : 'session-id';
      expect(headers.get('cookie')).toContain(`sessionid=${session}`);
      expect(headers.get('bd-ticket-guard-iteration-version')).toBe('2');
      expect(data.ts_sign_ree).toBe(rotated ? 'fixture-rotated-binding' : 'fixture-initial-binding');
      const content = Buffer.from(`ticket=${session}&path=${followPath}&timestamp=${data.timestamp}`);
      expect(verify('sha256', content, key, Buffer.from(data.req_sign_ree, 'base64'))).toBe(true);
      expect(verify('sha256', Buffer.concat([content, Buffer.from('tampered')]), key, Buffer.from(data.req_sign_ree, 'base64'))).toBe(false);
    };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)), headers = new Headers(init?.headers);
      expect(url.origin).toBe(origin);
      if (url.pathname === followPath) {
        followCalls++;
        expect(init).toMatchObject({ method: 'POST', body: '', redirect: 'manual' });
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ user_id: '22', secUid: 'fixture-peer',
          type: '1', tag: 'frienddetail', verifyFp: 'verify_10002' });
        checkSignature(headers, followCalls > 1);
        if (followCalls === 1) {
          originalQuery = url.search;
          const challengeHeader = source === 'passport-decision' ? 'x-tt-verify-passport-decision' : 'bdturing-verify';
          return Response.json({ status_code: 0, follow_status: 1 }, { headers: {
            [challengeHeader]: '{"detail":"fixture-human-challenge"}',
          } });
        }
        expect(followCalls).toBe(2);
        expect(verificationCalls).toBe(1);
        expect(url.search).toBe(originalQuery);
        expect(['confirmed', 'rejected']).toContain(outcome);
        // The rotated ticket must already be durable when a replay leaves the SDK.
        const saved = new AccountStore({ dataDir }).load('10001')!;
        expect(saved.session.cookies).toBe(connection.getCookies());
        expect(saved.session.desktopTicketGuard).toEqual(connection.getTicketGuardState());
        return Response.json(outcome === 'rejected'
          ? { status_code: 8, status_msg: 'fixture rejected', follow_status: 1 }
          : { status_code: 0, follow_status: 4 });
      }
      if (url.pathname === '/passport/web/validate_code/') {
        verificationCalls++;
        expect(followCalls).toBe(1);
        expect(headers.get('cookie')).toContain('sessionid=session-id');
        return Response.json({ message: 'success', data: {} }, { headers: {
          'set-cookie': 'sessionid=fixture-rotated-session; Path=/; Secure',
          ...(outcome !== 'cookie-only' ? guardHeaders('fixture-rotated-session', 'fixture-rotated-binding') : {}),
        } });
      }
      expect(url.pathname).toBe('/aweme/v1/web/user/profile/other/');
      expect(url.searchParams.get('sec_user_id')).toBe('fixture-peer');
      expect(url.searchParams.get('source')).toBe('together');
      profileCalls++;
      return Response.json({ status_code: 0, user: { uid: '22', sec_uid: 'fixture-peer',
        nickname: 'fixture peer', follow_status: 2, is_block: 0 } });
    });
    let settle!: (value: ActionVerification) => void;
    const challenged = new Promise<ActionVerification>(resolve => { settle = resolve; });
    const events = jest.fn(({ verification }: { verification: ActionVerification }) => settle(verification));
    account.on('system.action.verification', events);
    const pending = contact.setFollowed();
    // Observe early errors immediately; never hide a pre-challenge failure behind a wait.
    const observed = pending.then(result => ({ result }), error => ({ error }));
    try {
      const verification = await Promise.race([challenged, observed.then(value => {
        throw new Error(`follow ended before challenge: ${'error' in value ? value.error : 'result'}`);
      })]);
      expect(verification.account).toBe(account);
      expect(verification.source).toBe(source);
      expect(verification.target).toEqual({ operation: 'follow', uid: '22' });
      expect(followCalls).toBe(1);
      expect(account.getUserRelation('22')).toEqual(initialRelation);
      expect(readDiskRelation()).toEqual(initialRelation);
      await connection.requestVerificationRaw(`${origin}/passport/web/validate_code/`, {
        method: 'POST', body: 'code=fixture', signal: verification.signal,
      }, 'action', 'xhr');
      expect(followCalls).toBe(1);
      if (outcome === 'cancelled') verification.cancel('fixture user cancelled');
      else await verification.complete({ status: true });
      const ended = await observed;
      expect(events).toHaveBeenCalledTimes(1);
      expect(verification.signal.aborted).toBe(true);
      expect(verificationCalls).toBe(1);
      if (outcome === 'cookie-only' || outcome === 'cancelled') {
        expect('error' in ended && ended.error.message).toContain(outcome === 'cookie-only' ? '安全票据' : 'fixture user cancelled');
        expect(followCalls).toBe(1);
      } else {
        expect('result' in ended && ended.result).toEqual(outcome === 'rejected'
          ? { statusCode: 8, statusMsg: 'fixture rejected' }
          : { statusCode: 0, statusMsg: '', followStatus: 4 });
        expect(followCalls).toBe(2);
        expect(publicPoints[1]).toBe(publicPoints[0]);
      }
      const expectedRelation = outcome === 'confirmed' ? { ...initialRelation, followStatus: 4 } : initialRelation;
      expect(account.getUserRelation('22')).toEqual(expectedRelation);
      expect(readDiskRelation()).toEqual(expectedRelation);
      const saved = store.load('10001')!;
      expect(saved.session.cookies).toBe(connection.getCookies());
      expect(saved.session.desktopTicketGuard).toEqual(connection.getTicketGuardState());
      const restored = new ApiConnection({ ...store.toClientConfig(saved), enableABogus: false });
      expect(restored.hasBoundTicket()).toBe(outcome !== 'cookie-only');
      expect(profileCalls).toBe(0); // No automatic readback or inferred mutual follow.
      if (outcome === 'confirmed') {
        await expect(contact.getProfile()).resolves.toMatchObject({ uid: '22', followStatus: 2 });
        expect(profileCalls).toBe(1);
        expect(readDiskRelation()).toEqual({ followStatus: 2, blocked: false });
      }
    } finally { await account.logout(); await observed; }
  });

  it('queries activity only on demand without changing relations, read state or emitting notices', async () => {
    const account = createQrAccount(false);
    const active = jest.spyOn(ImService.prototype, 'getActiveStatus').mockResolvedValue({ statusCode: 0, statusMsg: '', users: [{ secUid: 'sec22', lastActiveTime: 0 }] });
    const notices = jest.fn(); account.on('notice', notices);
    await expect(account.getActiveStatus(['sec22'])).rejects.toThrow('账号未上线');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    try {
      expect(active).not.toHaveBeenCalled();
      account.updateUserRelation('22', { followStatus: 4 });
      const before = { friends: [...account.fl], strangers: [...account.sl], relation: account.getUserRelation('22') };
      await expect(account.getActiveStatus(['sec22'], ['700'])).resolves.toEqual({ statusCode: 0, statusMsg: '', users: [{ secUid: 'sec22', lastActiveTime: 0 }] });
      expect(active.mock.calls).toEqual([[['sec22'], ['700']]]);
      expect({ friends: [...account.fl], strangers: [...account.sl], relation: account.getUserRelation('22') }).toEqual(before);
      expect(notices).not.toHaveBeenCalled();
    } finally { await account.logout(); }
  });

  it.each([false, true])('rejects late activity results after logout (relogin=%s)', async relogin => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let finish!: (value: import('../services/im/user-directory.js').ActiveStatusResponse) => void;
    jest.spyOn(account.im, 'getActiveStatus').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = account.getActiveStatus(['sec22']);
    const rejected = expect(pending).rejects.toThrow('账号状态已变化');
    await account.logout();
    try {
      if (relogin) await account.login();
      finish({ statusCode: 0, statusMsg: '', users: [] });
      await rejected;
    } finally { await account.logout(); }
  });

  it('exposes independent user-search pages without binding contacts, following or publishing notices', async () => {
    const account = createQrAccount(false);
    const search = jest.spyOn(ImService.prototype, 'searchUsers').mockImplementation(async (keyword, cursor = 0) => ({
      keyword, cursor, statusCode: 0, statusMsg: '', hasMore: true, nextCursor: cursor + 30,
      users: [{ uid: '22', secUid: 'sec22', nickname: keyword, followStatus: 1 }],
    }));
    const follow = jest.spyOn(ImService.prototype, 'setUserFollowed');
    const notices = jest.fn(); account.on('notice', notices);
    await expect(account.searchUsers('test')).rejects.toThrow('账号未上线');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    try {
      expect(search).not.toHaveBeenCalled();
      account.updateUserRelation('22', { followStatus: 4 });
      const before = { friends: [...account.fl], strangers: [...account.sl], relation: account.getUserRelation('22') };
      const results = await Promise.all([account.searchUsers('one'), account.searchUsers('two', 30)]);
      expect(results.map(value => [value.keyword, value.cursor, value.nextCursor])).toEqual([['one', 0, 30], ['two', 30, 60]]);
      expect({ friends: [...account.fl], strangers: [...account.sl], relation: account.getUserRelation('22') }).toEqual(before);
      expect(search.mock.calls).toEqual([['one', 0], ['two', 30]]);
      expect(follow).not.toHaveBeenCalled(); expect(notices).not.toHaveBeenCalled();
    } finally { await account.logout(); }
  });

  it.each([false, true])('rejects late search pages after logout (relogin=%s)', async relogin => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let finish!: (value: import('../services/im/user-directory.js').UserSearchResponse) => void;
    jest.spyOn(account.im, 'searchUsers').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = account.searchUsers('old');
    const rejected = expect(pending).rejects.toThrow('账号状态已变化');
    await account.logout();
    try {
      if (relogin) await account.login();
      finish({ statusCode: 0, statusMsg: '', keyword: 'old', cursor: 0, hasMore: false, users: [] });
      await rejected;
    } finally { await account.logout(); }
  });

  describe('stranger inbox lifecycle', () => {
    function seed(account: Account, uid: string, inboxType = 1) {
      account.applyConversationInfo({ conversationId: `0:1:10001:${uid}`, conversationShortId: uid,
        conversationType: 1, isGroup: false, inboxType, name: '', lastMessageTime: 1,
        mode: 2, coreExt: { stranger: '10001' }, settingExt: { 'a:cell_sort_time': '1' },
        members: [{ uid, role: 0, nickname: 'fixture', avatar: 'avatar', secUid: 'sec-fixture' }] });
    }
    async function onlineAccount() {
      const account = createQrAccount(false);
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      return account;
    }

    it.each([false, true])('does not republish a settled local stranger query after logout (relogin=%s)', async relogin => {
      const account = await onlineAccount();
      const network = jest.spyOn(account.im, 'getRecentStrangerMessages');
      seed(account, '22');
      const pending = account.getStrangerList();
      expect(account.sl.has('22')).toBe(true); // The local projection is already complete before yielding.
      await account.logout();
      try {
        if (relogin) {
          await account.login();
          seed(account, '33');
          await account.getStrangerList();
        }
        const before = [...account.sl.keys()];
        expect((await pending).map(stranger => stranger.uid)).toEqual(['22']);
        expect([...account.sl.keys()]).toEqual(before);
        expect(account.sl.has('22')).toBe(false);
        expect(network).not.toHaveBeenCalled();
        if (!relogin) await expect(account.getStrangerList()).rejects.toThrow('账号未上线');
      } finally { await account.logout(); }
    });

    it.each([0, 8])('keeps the new login cache when an old delete-all returns status %s', async statusCode => {
      const account = await onlineAccount();
      seed(account, '22');
      await account.getStrangerList();
      let finish!: (value: { statusCode: number; statusMsg: string }) => void;
      const remove = jest.spyOn(account.im, 'deleteAllStrangerConversations').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const pending = account.deleteAllStrangerConversations();
      await account.logout();
      try {
        await account.login(); seed(account, '33'); await account.getStrangerList();
        const before = [...account.sl.keys()];
        const result = { statusCode, statusMsg: 'fixture result' };
        finish(result);
        await expect(pending).resolves.toBe(result); // Preserve the actual old action outcome, without replay.
        expect([...account.sl.keys()]).toEqual(before);
        expect(account.sl.has('33')).toBe(true);
        expect(remove).toHaveBeenCalledTimes(1);
      } finally { await account.logout(); }
    });

    it('still replaces the current list and clears it only on confirmed current-login deletion', async () => {
      const account = await onlineAccount();
      seed(account, '22', 3);
      const remove = jest.spyOn(account.im, 'deleteAllStrangerConversations').mockResolvedValueOnce({ statusCode: 8, statusMsg: 'rejected' })
        .mockResolvedValueOnce({ statusCode: 0, statusMsg: '' });
      try {
        await account.getStrangerList(); const first = account.sl.get('22');
        expect(first).toMatchObject({ nickname: 'fixture', avatar: 'avatar', secUid: 'sec-fixture', inboxType: 3 });
        await account.getStrangerList(); expect(account.sl.get('22')).toBe(first);
        await account.deleteAllStrangerConversations(); expect(account.sl.get('22')).toBe(first);
        await account.deleteAllStrangerConversations(); expect(account.sl.size).toBe(0);
        expect(remove).toHaveBeenCalledTimes(2);
      } finally { await account.logout(); }
    });
  });

  describe.each(['memory', 'json', 'sqlite'] as const)('recommended contacts (%s)', backend => {
    async function onlineAccount() {
      const account = createQrAccount(backend === 'memory' ? false : { backend });
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      return account;
    }

    it('uses the real service on demand without caching recommendations as relationships or starting other queries', async () => {
      const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fixture network'));
      await expect(createQrAccount(false).getRecommendedContacts()).rejects.toThrow('账号未上线');
      const account = await onlineAccount();
      const notices = jest.fn(); account.on('notice', notices);
      const raw = jest.spyOn(ApiConnection.prototype, 'requestRaw').mockResolvedValue({
        ok: true, status: 200, headers: new Headers(), data: '',
        rawText: JSON.stringify({ friends: [{ name: 'recommendation', sec_uid: 'sec22', active_time: 0 }] }),
      });
      const follow = jest.spyOn(account.im, 'setUserFollowed'), profile = jest.spyOn(account.im, 'getUserProfile');
      const active = jest.spyOn(account.im, 'getActiveStatus');
      account.bindFriend('22', '', 'existing', { secUid: 'sec22' });
      account.updateUserRelation('22', { followStatus: 4, remark: 'local-remark' });
      const before = { friends: [...account.fl], strangers: [...account.sl], groups: [...account.gl], relation: account.getUserRelation('22') };
      try {
        expect(raw).not.toHaveBeenCalled();
        await expect(account.getRecommendedContacts()).resolves.toEqual({ statusCode: 0, statusMsg: '', contacts: [{ name: 'recommendation', secUid: 'sec22', lastActiveTime: 0 }] });
        raw.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), data: '', rawText: '{"friends":[]}' });
        await expect(account.getRecommendedContacts()).resolves.toEqual({ statusCode: 0, statusMsg: '', contacts: [] });
        expect(raw).toHaveBeenCalledTimes(2);
        for (const [url, init] of raw.mock.calls) {
          expect(new URL(url).pathname).toBe('/aweme/v1/web/im/friend/recommend/');
          expect(init.method).toBe('GET');
        }
        expect({ friends: [...account.fl], strangers: [...account.sl], groups: [...account.gl], relation: account.getUserRelation('22') }).toEqual(before);
        expect(notices).not.toHaveBeenCalled(); expect(follow).not.toHaveBeenCalled();
        expect(profile).not.toHaveBeenCalled(); expect(active).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
      } finally { await account.logout(); }
    });

    it.each([false, true])('rejects late recommendation results after logout (relogin=%s)', async relogin => {
      const account = await onlineAccount();
      let finish!: (value: import('../services/im/types.js').RecommendedContactsResponse) => void;
      const query = jest.spyOn(account.im, 'getRecommendedContacts').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const pending = account.getRecommendedContacts();
      const rejected = expect(pending).rejects.toThrow('账号状态已变化');
      await account.logout();
      try {
        if (relogin) await account.login();
        finish({ statusCode: 0, statusMsg: '', contacts: [{ secUid: 'old', name: 'old login' }] });
        await rejected;
        expect(query).toHaveBeenCalledTimes(1);
        expect(account.fl.size).toBe(0); expect(account.sl.size).toBe(0);
      } finally { await account.logout(); }
    });
  });

  it('queries new follower count only on demand without modifying contacts or emitting notices', async () => {
    const account = createQrAccount(false);
    const counts = jest.spyOn(ImService.prototype, 'getNewFollowerCount').mockResolvedValue({ statusCode: 0, statusMsg: '', count: 4 });
    const notices = jest.fn();
    account.on('notice', notices);
    await expect(account.getNewFollowerCount()).rejects.toThrow('账号未上线');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    try {
      expect(counts).not.toHaveBeenCalled();
      const before = { friends: [...account.fl], strangers: [...account.sl], relation: account.getUserRelation('22') };
      await expect(account.getNewFollowerCount()).resolves.toEqual({ statusCode: 0, statusMsg: '', count: 4 });
      counts.mockResolvedValueOnce({ statusCode: 0, statusMsg: '' });
      await expect(account.getNewFollowerCount()).resolves.toEqual({ statusCode: 0, statusMsg: '' });
      counts.mockResolvedValueOnce({ statusCode: 8, statusMsg: '未登录' });
      await expect(account.getNewFollowerCount()).resolves.toEqual({ statusCode: 8, statusMsg: '未登录' });
      expect({ friends: [...account.fl], strangers: [...account.sl], relation: account.getUserRelation('22') }).toEqual(before);
      expect(counts).toHaveBeenCalledTimes(3);
      expect(notices).not.toHaveBeenCalled();
    } finally { await account.logout(); }
  });

  it.each([false, true])('rejects late new follower counts after logout (relogin=%s)', async relogin => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let finish!: (value: { statusCode: number; statusMsg: string; count: number }) => void;
    jest.spyOn(account.im, 'getNewFollowerCount').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = account.getNewFollowerCount();
    const rejected = expect(pending).rejects.toThrow('账号状态已变化');
    await account.logout();
    try {
      if (relogin) {
        // This fixture restores its saved Session on a second login; no new QR.
        await account.login();
      }
      finish({ statusCode: 0, statusMsg: '', count: 999 });
      await rejected;
    } finally { await account.logout(); }
  });

  describe('explicit follower notice reads', () => {
    const item = (uid = '22', nickname = 'first') => ({ uid, secUid: `sec-${uid}`, nickname, hasRead: 0 });
    const page = (notices = [item()], hasMore = false, maxTime = '10', minTime = '1') => ({
      statusCode: 0, statusMsg: '', notices, hasMore, maxTime, minTime,
    });
    async function onlineAccount() {
      const account = createQrAccount(false);
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      return account;
    }

    it('requires an explicit online read, preserves the first UID snapshot and does not mutate relations/counts', async () => {
      const read = jest.spyOn(ImService.prototype, 'readFollowerNoticePage')
        .mockResolvedValueOnce(page([item()], true, '9007199254740993', '0'))
        .mockResolvedValueOnce(page([item('22', 'later'), item('33')]));
      const count = jest.spyOn(ImService.prototype, 'getNewFollowerCount');
      const follow = jest.spyOn(ImService.prototype, 'setUserFollowed');
      await expect(createQrAccount(false).readFollowerNotices()).rejects.toThrow('账号未上线');
      const account = await onlineAccount();
      try {
        expect(read).not.toHaveBeenCalled();
        const notices = jest.fn(); account.on('notice', notices);
        account.updateUserRelation('22', { followStatus: 4 });
        const before = { fl: [...account.fl], sl: [...account.sl], relation: account.getUserRelation('22') };
        await expect(account.readFollowerNotices()).resolves.toEqual({
          statusCode: 0, statusMsg: '', notices: [item(), item('33')], truncated: false,
        });
        expect(read.mock.calls).toEqual([['0', '1'], ['9007199254740993', '0']]);
        expect({ fl: [...account.fl], sl: [...account.sl], relation: account.getUserRelation('22') }).toEqual(before);
        expect(count).not.toHaveBeenCalled(); expect(follow).not.toHaveBeenCalled(); expect(notices).not.toHaveBeenCalled();
      } finally { await account.logout(); }
    });

    it.each([false, true])('counts raw rows before deduplication and reads past exactly 120 (last hasMore=%s)', async hasMore => {
      const account = await onlineAccount();
      let calls = 0;
      const read = jest.spyOn(account.im, 'readFollowerNoticePage').mockImplementation(async () => {
        calls++;
        return page(Array.from({ length: 20 }, (_, i) => item(String(i + 1))), calls < 7 || hasMore, String(calls));
      });
      try {
        const result = await account.readFollowerNotices();
        expect(result).toMatchObject({ statusCode: 0, truncated: hasMore });
        expect(result.notices).toHaveLength(20);
        expect(read).toHaveBeenCalledTimes(7);
        expect(read.mock.calls).toEqual(Array.from({ length: 7 }, (_, i) => [String(i), '1']));
      } finally { await account.logout(); }
    });

    it.each(['repeat', 'cycle', 'empty', 'missing'] as const)('stops invalid pagination without retry or partial success (%s)', async failure => {
      const account = await onlineAccount();
      const read = jest.spyOn(account.im, 'readFollowerNoticePage');
      if (failure === 'repeat') read.mockResolvedValue(page([item()], true, '0'));
      if (failure === 'cycle') read.mockResolvedValueOnce(page([item()], true, '10')).mockResolvedValue(page([item('33')], true, '0'));
      if (failure === 'empty') read.mockResolvedValue(page([], true));
      if (failure === 'missing') read.mockResolvedValue({ statusCode: 0, statusMsg: '', notices: [item()], hasMore: true });
      try {
        await expect(account.readFollowerNotices()).resolves.toMatchObject({ statusCode: -3, notices: [], truncated: false });
        expect(read).toHaveBeenCalledTimes(failure === 'cycle' ? 2 : 1);
      } finally { await account.logout(); }
    });

    it.each(['business', 'transport'] as const)('does not replay a failed later page or claim partial success (%s)', async failure => {
      const account = await onlineAccount();
      const read = jest.spyOn(account.im, 'readFollowerNoticePage').mockResolvedValueOnce(page([item()], true));
      const error = new Error('response lost after read-marking request');
      if (failure === 'business') read.mockResolvedValueOnce({ statusCode: 8, statusMsg: '未登录', notices: [], hasMore: false });
      else read.mockRejectedValueOnce(error);
      try {
        if (failure === 'business') await expect(account.readFollowerNotices()).resolves.toEqual({ statusCode: 8, statusMsg: '未登录', notices: [], truncated: false });
        else await expect(account.readFollowerNotices()).rejects.toBe(error);
        expect(read.mock.calls).toEqual([['0', '1'], ['10', '1']]);
      } finally { await account.logout(); }
    });

    it.each([false, true])('does not continue a pending read after logout (relogin=%s)', async relogin => {
      const account = await onlineAccount();
      let finish!: (value: ReturnType<typeof page>) => void;
      const read = jest.spyOn(ImService.prototype, 'readFollowerNoticePage').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const pending = account.readFollowerNotices();
      const rejected = expect(pending).rejects.toThrow('账号状态已变化');
      await account.logout();
      try {
        if (relogin) await account.login();
        finish(page([item()], true));
        await rejected;
        expect(read).toHaveBeenCalledTimes(1);
      } finally { await account.logout(); }
    });
  });

  it('exposes independent online-only settings reads without altering mark-read notices', async () => {
    const account = createQrAccount();
    const settings = jest.spyOn(ImService.prototype, 'getUserSettings').mockResolvedValue({ statusCode: 0, statusMsg: '', imReadStatusShow: -1, enableReadState: false });
    const privacy = jest.spyOn(ImService.prototype, 'getReadReceiptPrivacy').mockResolvedValue({ statusCode: 0, statusMsg: '', currentUserSwitch: 0, enableReadState: true });
    await expect(account.getUserSettings()).rejects.toThrow('账号未上线');
    await expect(account.getReadReceiptPrivacy()).rejects.toThrow('账号未上线');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    expect(settings).not.toHaveBeenCalled(); expect(privacy).not.toHaveBeenCalled();
    await expect(account.getUserSettings()).resolves.toMatchObject({ enableReadState: false });
    await expect(account.getReadReceiptPrivacy()).resolves.toMatchObject({ enableReadState: true });
    expect(settings).toHaveBeenCalledTimes(1); expect(privacy).toHaveBeenCalledTimes(1);
    await account.logout();
  });

  it('cancels message privacy results across logout without caching or synthesizing notices', async () => {
    const account = createQrAccount();
    await expect(account.getMessageReadPrivacy([])).rejects.toThrow('账号未上线');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let resolve!: (value: { statusCode: number; statusMsg: string; messages: [] }) => void;
    jest.spyOn(account.im, 'getMessageReadPrivacy').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = account.getMessageReadPrivacy([{ serverMessageId: '99', conversationId: '700', conversationShortId: '700', conversationType: 2, createTime: 123 }]);
    await account.logout();
    resolve({ statusCode: 0, statusMsg: '', messages: [] });
    await expect(pending).rejects.toThrow('账号状态已变化');
  });

  it('reuses persisted privacy policies, refreshes explicitly and gates restart cache by a fresh account switch', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const query = { serverMessageId: '99', conversationId: '700', conversationShortId: '700', conversationType: 2 as const, createTime: 123 };
    const fetch = jest.spyOn(ImService.prototype, 'getMessageReadPrivacy').mockResolvedValue({ statusCode: 0, statusMsg: '', currentUserSwitch: 0, enableReadState: true,
      messages: [{ serverMessageId: '99', errorCode: 0, on: ['22'], off: [] }] });
    const first = await account.getMessageReadPrivacy([query]);
    (first.messages[0]!.on as string[]).push('33');
    await expect(account.getMessageReadPrivacy([query])).resolves.toMatchObject({ messages: [{ on: ['22'] }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    await account.getMessageReadPrivacy([query], true); expect(fetch).toHaveBeenCalledTimes(2);
    await account.logout(); await account.login();
    const switchQuery = jest.spyOn(ImService.prototype, 'getReadReceiptPrivacy').mockResolvedValue({ statusCode: 0, statusMsg: '', currentUserSwitch: -1, enableReadState: false });
    await expect(account.getMessageReadPrivacy([query])).resolves.toMatchObject({ enableReadState: false, messages: [] });
    expect(switchQuery).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
    switchQuery.mockResolvedValue({ statusCode: 0, statusMsg: '', currentUserSwitch: 0, enableReadState: true });
    await account.getReadReceiptPrivacy();
    await expect(account.getMessageReadPrivacy([query])).resolves.toMatchObject({ messages: [{ on: ['22'] }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    account.removeCachedMessage('700', '99');
    await account.getMessageReadPrivacy([query]); expect(fetch).toHaveBeenCalledTimes(3);
    await account.logout();
  });

  it('does not cache disabled or failed privacy replies and does not resurrect a deleted policy from an in-flight query', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const query = { serverMessageId: '99', conversationId: '700', conversationShortId: '700', conversationType: 2 as const, createTime: 123 };
    const fetch = jest.spyOn(account.im, 'getMessageReadPrivacy').mockResolvedValue({ statusCode: 0, statusMsg: '', currentUserSwitch: -1, enableReadState: false, messages: [] });
    await account.getMessageReadPrivacy([query]); await account.getMessageReadPrivacy([query]);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValue({ statusCode: 8, statusMsg: 'failed', messages: [] });
    await account.getMessageReadPrivacy([query]); await account.getMessageReadPrivacy([query]);
    expect(fetch).toHaveBeenCalledTimes(4);
    const result = { statusCode: 0, statusMsg: '', currentUserSwitch: 0, enableReadState: true,
      messages: [{ serverMessageId: '99', errorCode: 0, on: [], off: [] }] };
    let resolve!: (value: typeof result) => void;
    fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = account.getMessageReadPrivacy([query]);
    account.forgetConversation('700'); resolve(result);
    await expect(pending).rejects.toThrow('消息已删除');
    fetch.mockResolvedValue(result);
    await account.getMessageReadPrivacy([query]); expect(fetch).toHaveBeenCalledTimes(6);
    await account.logout();
  });

  it('fetches only missing privacy policies and rechecks the global switch after query failures', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const first = { serverMessageId: '99', conversationId: '700', conversationShortId: '700', conversationType: 2 as const, createTime: 123 };
    const second = { ...first, serverMessageId: '100' };
    const fetch = jest.spyOn(account.im, 'getMessageReadPrivacy').mockImplementation(async queries => ({
      statusCode: 0, statusMsg: '', currentUserSwitch: 0, enableReadState: true,
      messages: queries.map(query => ({ serverMessageId: query.serverMessageId, errorCode: 0, on: [], off: [] })),
    }));
    await account.getMessageReadPrivacy([first]);
    const mixed = await account.getMessageReadPrivacy([second, first]);
    expect(fetch).toHaveBeenLastCalledWith([second]);
    expect(mixed.messages.map(policy => policy.serverMessageId)).toEqual(['100', '99']);
    await expect(account.getMessageReadPrivacy([{ ...first, createTime: NaN }])).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    const current = jest.spyOn(account.im, 'getReadReceiptPrivacy').mockResolvedValue({
      statusCode: 0, statusMsg: '', currentUserSwitch: -1, enableReadState: false,
    });
    fetch.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(account.getMessageReadPrivacy([first], true)).rejects.toThrow('network unavailable');
    await expect(account.getMessageReadPrivacy([first])).resolves.toMatchObject({ enableReadState: false, messages: [] });
    expect(current).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce({ statusCode: 8, statusMsg: 'failed', messages: [] });
    await account.getMessageReadPrivacy([second], true);
    await account.getMessageReadPrivacy([second]);
    expect(current).toHaveBeenCalledTimes(2);
    await account.logout();
  });

  it.each(['sqlite', 'json', false] as const)('uses live setting ext for sends, including startup and refresh (%s)', async backend => {
    const conversation = mapProtoConversationListItem({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      conversationCoreInfo: { ext: { 'a:sky_eye_dialog': '{"core":"not used"}' } },
      conversationSettingInfo: { ext: { 'a:sky_eye_dialog': '{"risk":1}' } } });
    jest.mocked(ImService.prototype.listThreads).mockResolvedValueOnce({ statusCode: 0, statusMsg: '', threads: [],
      conversations: [conversation], hasMore: false, cursor: '0' });
    const account = createQrAccount(backend === false ? false : { backend });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const group = Group.bind('700', '700', account);
    const send = jest.spyOn(account.im, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '99' });
    await expect(group.sendMsg('hello')).rejects.toThrow('当前会话存在风险');
    const get = jest.spyOn(account.im, 'getConversationInfos').mockResolvedValue({ statusCode: 0, statusMsg: '',
      conversations: [{ ...conversation, settingExt: { 'a:sky_eye_dialog_list': '[{}]', 'a:sky_eye_dialog': '{"legacy":1}' } }] });
    await group.refresh();
    await group.sendMsg('list first empty suppresses legacy');
    account.applyConversationInfo(conversation);
    // Neither persisted storage nor the nonpersistent fallback aliases caller-owned maps.
    (conversation.settingExt as Record<string, string>)['a:sky_eye_dialog'] = '{}';
    await expect(group.sendMsg('still blocked')).rejects.toThrow('当前会话存在风险');
    account.patchCachedConversation('700', { settingExt: {} });
    await group.sendMsg('cleared');
    account.applyConversationInfo({ ...conversation, settingExt: { 'a:sky_eye_dialog': '{"risk":1}' } });
    account.forgetConversation('700');
    await group.sendMsg('no local setting after delete');
    expect(get).toHaveBeenCalledTimes(1); // No implicit fetch on each send.
    expect(send).toHaveBeenCalledTimes(3);
    await account.logout();
  });

  it('keeps settings from group-list mapping without persistence and clears them on logout', async () => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const conversation = { conversationId: '700', conversationShortId: '700', conversationType: 2, isGroup: true,
      name: 'group', members: [], lastMessageTime: 0, settingExt: { 'a:sky_eye_dialog': '{"risk":1}' } };
    jest.spyOn(account.im, 'listThreads').mockResolvedValueOnce({ statusCode: 0, statusMsg: '', threads: [],
      conversations: [conversation], hasMore: false, cursor: '0' });
    const [group] = await account.getGroupList(true);
    const send = jest.spyOn(account.im, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '99' });
    await expect(group!.sendMsg('blocked')).rejects.toThrow('当前会话存在风险');
    expect(send).not.toHaveBeenCalled();
    await account.logout();
    await account.login(); // Empty startup snapshot: old transient settings must not carry over.
    const nextSend = jest.spyOn(account.im, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '100' });
    await Group.bind('700', '700', account).sendMsg('no old risk');
    expect(nextSend).toHaveBeenCalledTimes(1);
    await account.logout();
  });

  it('retains the newly created private conversation settings before the first text send', async () => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const create = jest.spyOn(account.im, 'createPrivateConversation').mockResolvedValue({ statusCode: 0, statusMsg: '',
      conversation: { conversationId: '0:1:10001:44', conversationShortId: '90', conversationType: 1, isGroup: false,
        name: '', members: [], lastMessageTime: 0, settingExt: { 'a:sky_eye_dialog': '{"risk":1}' } } });
    const send = jest.spyOn(account.im, 'send');
    const friend = Friend.bind('44', '0:1:10001:44', '', account);
    await expect(friend.sendMsg('hello')).rejects.toThrow('当前会话存在风险');
    expect(create).toHaveBeenCalledTimes(1);
    expect(friend.conversationShortId).toBe('90');
    expect(send).not.toHaveBeenCalled();
    await account.logout();
  });

  it('replaces transient group settings on a complete group snapshot without clearing private settings', async () => {
    const base = { conversationShortId: '90', name: '', members: [], lastMessageTime: 0,
      settingExt: { 'a:sky_eye_dialog': '{"risk":1}' } };
    jest.mocked(ImService.prototype.listThreads).mockResolvedValueOnce({ statusCode: 0, statusMsg: '', threads: [],
      conversations: [{ ...base, conversationId: '700', conversationType: 2, isGroup: true },
        { ...base, conversationId: '0:1:10001:44', conversationType: 1, isGroup: false }], hasMore: false, cursor: '0' });
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const send = jest.spyOn(account.im, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '99' });
    expect(await account.getGroupList(true)).toEqual([]);
    await account.outbound.sendText({ threadId: '700', conversationShortId: '90', text: 'group settings gone' });
    await expect(account.outbound.sendText({ threadId: '0:1:10001:44', conversationShortId: '90', text: 'private still blocked' }))
      .rejects.toThrow('当前会话存在风险');
    expect(send).toHaveBeenCalledTimes(1);
    await account.logout();
  });

  it('rejects a late conversation refresh without restoring transient settings after logout', async () => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let resolve!: (value: Awaited<ReturnType<ImService['getConversationInfos']>>) => void;
    jest.spyOn(account.im, 'getConversationInfos').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = account.refreshContactAddresses([{ threadId: '700', conversationShortId: '700', conversationType: 2, inboxType: 1 }]);
    await account.logout();
    resolve({ statusCode: 0, statusMsg: '', conversations: [{ conversationId: '700', conversationShortId: '700',
      conversationType: 2, isGroup: true, name: 'group', members: [], lastMessageTime: 0, settingExt: { 'a:sky_eye_dialog': '{"risk":1}' } }] });
    await expect(pending).rejects.toThrow('账号状态已变化');
    await account.login();
    const send = jest.spyOn(account.im, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '100' });
    await Group.bind('700', '700', account).sendMsg('no stale risk');
    expect(send).toHaveBeenCalledTimes(1);
    await account.logout();
  });

  it.each(['private-create', 'group-list'] as const)('discards late %s settings after logout', async operation => {
    const account = createQrAccount(false);
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const group = operation === 'group-list';
    const conversation = { conversationId: group ? '700' : '0:1:10001:44', conversationShortId: '90',
      conversationType: group ? 2 : 1, isGroup: group, name: '', members: [], lastMessageTime: 0,
      settingExt: { 'a:sky_eye_dialog': '{"risk":1}' } };
    let finish!: () => void;
    if (group) {
      jest.spyOn(account.im, 'listThreads').mockImplementationOnce(() => new Promise(resolve => {
        finish = () => resolve({ statusCode: 0, statusMsg: '', conversations: [conversation], threads: [], hasMore: false, cursor: '0' });
      }));
    } else {
      jest.spyOn(account.im, 'createPrivateConversation').mockImplementation(() => new Promise(resolve => {
        finish = () => resolve({ statusCode: 0, statusMsg: '', conversation });
      }));
    }
    const friend = Friend.bind('44', conversation.conversationId, '', account);
    const pending = group ? account.getGroupList(true) : account.ensureFriendConversation(friend);
    await account.logout();
    finish();
    await expect(pending).rejects.toThrow('账号状态已变化');
    expect(friend.conversationShortId).toBe('');
    await account.login();
    const send = jest.spyOn(account.im, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '100' });
    await account.outbound.sendText({ threadId: conversation.conversationId, conversationShortId: '90', text: 'no stale risk' });
    expect(send).toHaveBeenCalledTimes(1);
    await account.logout();
  });

  it('connects current collected-sticker policy to the shared sender for friend and group contacts', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const send = jest.spyOn(account.im, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '99' });
    const sticker = { id: '9', static_url: { uri: 'uri', url_list: ['https://example.invalid/emoji.webp'] } };
    const friend = Friend.bind('44', '0:1:10001:44', '90', account);
    const group = Group.bind('70001', '70001', account);
    await expect(group.sendMsg(segment.sticker(sticker))).rejects.toThrow('尚未允许');
    expect(send).not.toHaveBeenCalled();
    await friend.sendMsg(segment.sticker(sticker));
    const get = jest.spyOn(account.im, 'getCollectedEmojis').mockResolvedValue({ statusCode: 0, statusMsg: '',
      page: { nextCursor: '0', hasMore: false, stickerEnabledStatus: '0', stickers: [sticker] } });
    await account.getCollectedEmojis();
    await group.sendMsg(segment.sticker(sticker));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([request]) => request.msgType === 5 && JSON.parse(request.content).aweType === 501)).toBe(true);
    get.mockResolvedValueOnce({ statusCode: 0, statusMsg: '', page: { nextCursor: '0', hasMore: false, stickerEnabledStatus: 1 } });
    await account.getCollectedEmojis();
    await expect(group.sendMsg(segment.sticker(sticker))).rejects.toThrow('尚未允许');
    expect(send).toHaveBeenCalledTimes(2);
    await account.logout();
  });

  it('merges collected emoji pages only after online queries and distinguishes no-update from empty', async () => {
    const account = createQrAccount();
    const get = jest.spyOn(ImService.prototype, 'getCollectedEmojis').mockResolvedValue({ statusCode: 0, statusMsg: '',
      page: { nextCursor: '50', hasMore: true, stickerEnabledStatus: 0, stickers: [{ id: '20' }, { id: '10' }] } });
    expect(account.getCachedCollectedEmojis()).toBeUndefined();
    await expect(account.getCollectedEmojis()).rejects.toThrow('账号未上线');
    expect(get).not.toHaveBeenCalled();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const first = await account.getCollectedEmojis();
    first.page!.stickers![0]!['id'] = 'changed';
    expect(account.getCachedCollectedEmojis()?.stickers.map(item => item['id'])).toEqual(['20', '10']);
    get.mockResolvedValueOnce({ statusCode: 0, statusMsg: '' });
    await account.getCollectedEmojis();
    expect(account.getCachedCollectedEmojis()?.nextCursor).toBe('50');
    get.mockResolvedValueOnce({ statusCode: 0, statusMsg: '', page: { nextCursor: '0', hasMore: false } });
    await account.getCollectedEmojis();
    expect(account.getCachedCollectedEmojis()?.stickers.map(item => item['id'])).toEqual(['20', '10']);
    expect(account.getCachedCollectedEmojis()?.nextCursor).toBe('0');
    get.mockResolvedValueOnce({ statusCode: 0, statusMsg: '', page: { nextCursor: '100', hasMore: false,
      stickers: [{ id: '10', changed: true }, { id: '30' }] } });
    // An explicit cursor is a subsequent-page request, not inferred firstPage from its numeric value.
    await account.getCollectedEmojis({ cursor: '0' });
    expect(get).toHaveBeenLastCalledWith('0');
    expect(account.getCachedCollectedEmojis()?.stickers).toEqual([{ id: '20' }, { id: '10' }, { id: '30' }]);
    get.mockResolvedValueOnce({ statusCode: 8, statusMsg: 'failed' });
    await account.getCollectedEmojis();
    expect(account.getCachedCollectedEmojis()?.stickers).toHaveLength(3);
    get.mockResolvedValueOnce({ statusCode: 8, statusMsg: 'partial response', page: { nextCursor: '150', hasMore: false } });
    const partial = await account.getCollectedEmojis();
    expect(partial.statusCode).toBe(8);
    expect(account.getCachedCollectedEmojis()?.nextCursor).toBe('150');
    expect(account.getCachedCollectedEmojis()?.stickers).toHaveLength(3);
    get.mockResolvedValueOnce({ statusCode: 0, statusMsg: '', page: { nextCursor: '0', hasMore: false, stickers: [] } });
    await account.getCollectedEmojis({ cursor: '50', firstPage: true });
    expect(account.getCachedCollectedEmojis()?.stickers).toEqual([]);
    await account.logout();
    expect(account.getCachedCollectedEmojis()).toBeUndefined();
  });

  it('adds confirmed collected records once, clones snapshots, and leaves late outcomes out of offline state', async () => {
    const account = createQrAccount();
    const other = createQrAccount();
    const collect = jest.spyOn(ImService.prototype, 'collectEmoji').mockResolvedValue({ statusCode: 0, statusMsg: '', successItems: [{ id: '9' }] });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const options = { imageId: '9', stickerType: 0 };
    const result = await account.collectEmoji(options);
    result.successItems[0]!['id'] = 'changed';
    const snapshot = account.getCachedCollectedEmojis()!;
    expect(snapshot.stickers).toEqual([{ id: '9' }]);
    snapshot.stickers.length = 0;
    expect(account.getCachedCollectedEmojis()?.stickers).toEqual([{ id: '9' }]);
    expect(other.getCachedCollectedEmojis()).toBeUndefined();
    collect.mockResolvedValueOnce({ statusCode: 7280, statusMsg: 'already collected', successItems: [] });
    await account.collectEmoji(options);
    expect(account.getCachedCollectedEmojis()?.stickers).toEqual([{ id: '9' }]);
    let resolve!: (value: { statusCode: number; statusMsg: string; successItems: Record<string, unknown>[] }) => void;
    collect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const late = account.collectEmoji(options);
    await account.logout();
    resolve({ statusCode: 0, statusMsg: '', successItems: [{ id: '30' }] });
    await expect(late).resolves.toMatchObject({ statusCode: 0 });
    expect(account.getCachedCollectedEmojis()).toBeUndefined();
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it('rejects stale collected-page responses and invalid pagination options without cache updates', async () => {
    const account = createQrAccount();
    const get = jest.spyOn(ImService.prototype, 'getCollectedEmojis');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    await expect(account.getCollectedEmojis({ firstPage: 'false' as unknown as boolean })).rejects.toThrow('firstPage must be a boolean');
    expect(get).not.toHaveBeenCalled();
    let resolve!: (value: { statusCode: number; statusMsg: string }) => void;
    get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const late = account.getCollectedEmojis();
    const rejected = expect(late).rejects.toThrow('账号状态已变化');
    await account.logout();
    resolve({ statusCode: 0, statusMsg: '' });
    await rejected;
    expect(account.getCachedCollectedEmojis()).toBeUndefined();
  });

  it('keeps emoji queries and collection account-scoped, online-only and explicit', async () => {
    const account = createQrAccount();
    const get = jest.spyOn(ImService.prototype, 'getEmojiResources').mockResolvedValue({ statusCode: 0, statusMsg: '', androidResourceStatus: 1 });
    const collect = jest.spyOn(ImService.prototype, 'collectEmoji').mockResolvedValue({ statusCode: 0, statusMsg: '', successItems: [{ id: '99' }] });
    const options = { imageId: '99', stickerUri: '', stickerUrl: '', resourceId: '0', stickerType: 0 };
    await expect(account.getEmojiResources()).rejects.toThrow('账号未上线');
    expect(() => account.collectEmoji(options)).toThrow('账号未上线');
    expect(get).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    expect(collect).not.toHaveBeenCalled();
    await expect(account.getEmojiResources()).resolves.toMatchObject({ androidResourceStatus: 1 });
    await expect(account.collectEmoji(options)).resolves.toMatchObject({ successItems: [{ id: '99' }] });
    expect(collect).toHaveBeenCalledWith(options);
    expect(collect).toHaveBeenCalledTimes(1);
    let resolve!: (value: { statusCode: number; statusMsg: string }) => void;
    get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const stale = account.getEmojiResources();
    const rejected = expect(stale).rejects.toThrow('账号状态已变化');
    await account.logout();
    resolve({ statusCode: 0, statusMsg: '' });
    await rejected;
  });

  it('keeps audit unread actions account-wide, explicitly invoked and online-only', async () => {
    const account = createQrAccount();
    const get = jest.spyOn(ImService.prototype, 'getGroupJoinRequestUnread').mockResolvedValue({ statusCode: 0, statusMsg: '', unreadCount: '3' });
    const clear = jest.spyOn(ImService.prototype, 'clearGroupJoinRequestUnread').mockResolvedValue({ statusCode: 0, statusMsg: '' });
    expect(() => account.getGroupJoinRequestUnread()).toThrow('账号未上线');
    expect(() => account.clearGroupJoinRequestUnread()).toThrow('账号未上线');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    expect(clear).not.toHaveBeenCalled();
    await expect(account.getGroupJoinRequestUnread()).resolves.toMatchObject({ unreadCount: '3' });
    expect(clear).not.toHaveBeenCalled();
    await expect(account.clearGroupJoinRequestUnread()).resolves.toMatchObject({ statusCode: 0 });
    expect(get).toHaveBeenCalledWith();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith();
    await account.logout();
  });

  it('cancels a pending login when logout is requested', async () => {
    const account = createQrAccount();
    const qrReady = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));
    const login = account.login();
    const rejected = expect(login).rejects.toThrow('登录已取消');
    await qrReady;

    await account.logout();

    await rejected;
    expect(account.state).toBe('offline');
  });

  it('does not recreate a cancelled pending login or promote it when the profile response arrives late', async () => {
    const account = createQrAccount();
    const client = account['runtime'].connection;
    let finish!: (profile: Record<string, unknown>) => void;
    let started!: () => void;
    const profileStarted = new Promise<void>(resolve => { started = resolve; });
    jest.mocked(client.getSelfProfile).mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const store = new AccountStore({ dataDir });
    const promote = jest.spyOn(AccountStore.prototype, 'promote');
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); const cancelled = expect(login).rejects.toThrow('登录已取消');
    await ready;
    const continuation = account.continueLogin();
    const rejected = expect(continuation).rejects.toThrow('登录已取消');
    await profileStarted;
    await account.logout();
    finish({ user: { uid: '10001', nickname: 'late identity' } });
    await rejected; await cancelled;
    expect(promote).not.toHaveBeenCalled();
    expect(store.load('10001')).toBeUndefined();
    expect(ConnectionManager.prototype.start).not.toHaveBeenCalled();
    expect(account.state).toBe('offline');
  });

  it('does not start a receiver or fresh QR when saved-session verification fails', async () => {
    const store = new AccountStore({ dataDir });
    store.save({
      platformUid: '10001',
      session: { cookies: 'sessionid=keep-me' },
      deviceProfile: AccountStore.buildDeviceProfile('test-agent', 'test-trace'),
      meta: { createdAt: '', updatedAt: '' },
    });
    jest.spyOn(ApiConnection.prototype, 'probeSession').mockResolvedValue({ status: 'error', reason: 'network unavailable' });
    const qr = jest.spyOn(ApiConnection.prototype, 'getQrcode');
    const account = Account.create(new ApiConnection(), store, { accountId: '10001' });
    const online = jest.fn();
    account.on('system.online', online);
    await expect(account.login()).rejects.toThrow('network unavailable');
    expect(account.online).toBe(false);
    expect(online).not.toHaveBeenCalled();
    expect(ConnectionManager.prototype.start).not.toHaveBeenCalled();
    expect(qr).not.toHaveBeenCalled();
    expect(store.load('10001')?.session.cookies).toBe('sessionid=keep-me');
  });

  it('offers account-info verification while restoring a saved Session without starting a fresh login', async () => {
    const store = new AccountStore({ dataDir });
    store.save({ platformUid: '10001', session: { cookies: 'sessionid=keep-me' },
      deviceProfile: AccountStore.buildDeviceProfile('test-agent', 'test-trace'), meta: { createdAt: '', updatedAt: '' } });
    const paths: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = new URL(String(input)).pathname; paths.push(path);
      if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(path).toBe('/passport/account/info/v2/');
      return Response.json({ message: 'error', data: {
        error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
      } });
    });
    const account = Account.create(new ApiConnection(), store, { accountId: '10001' });
    const operations: string[] = [];
    account.on('system.login.verification', ({ verification }) => {
      operations.push(verification.operation); verification.cancel('fixture cancelled');
    });
    try {
      await account.login().catch(() => undefined);
      expect(operations).toEqual(['account-info']);
      expect(paths.filter(path => path === '/passport/account/info/v2/')).toHaveLength(1);
      expect(paths).not.toContain('/passport/web/get_qrcode/');
      expect(account.online).toBe(false);
      expect(store.load('10001')!.session.cookies).toBe('sessionid=keep-me');
    } finally { await account.logout(); }
  });

  it.each(['match', 'mismatch', 'repeat'] as const)('resumes account-info verification on its candidate connection and gates credentials by UID (%s)', async outcome => {
    const store = new AccountStore({ dataDir });
    store.save({ platformUid: '10001', session: { cookies: 'sessionid=original' },
      deviceProfile: AccountStore.buildDeviceProfile('test-agent', 'test-trace'), meta: { createdAt: '', updatedAt: '' } });
    const requests: { url: URL; init: RequestInit | undefined }[] = [];
    const challenges = outcome === 'repeat' ? 2 : 1;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(store.load('10001')!.session.cookies).toBe('sessionid=original');
      expect(store.load('10001')!.session.desktopTicketGuard?.binding).toBeUndefined();
      if (url.pathname === '/passport/account/info/v2/') {
        requests.push({ url, init });
        const count = requests.length;
        expect(new Headers(init?.headers).get('cookie')).toContain(count === 1 ? 'sessionid=original' : `sessionid=candidate-${count - 1}`);
        const headers = new Headers({
          'set-cookie': `sessionid=candidate-${count}; Path=/`,
          'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket: `candidate-${count}`, ts_sign_ree: `signature-${count}` })).toString('base64'),
        });
        headers.append('set-cookie', `msToken=token-${count}; Path=/`);
        return Response.json(count <= challenges ? { message: 'error', data: {
          error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
        } } : { message: 'success', data: {} }, { headers });
      }
      expect(url.pathname).toBe('/aweme/v1/web/user/profile/self/');
      expect(new Headers(init?.headers).get('cookie')).toContain(`sessionid=candidate-${challenges + 1}`);
      return Response.json({ status_code: 0, user: { uid: outcome === 'mismatch' ? '10002' : '10001' } });
    });
    // The runtime connection deliberately has unrelated credentials. Restore's
    // challenge/retry must stay on the connection created from the saved account.
    const runtime = new ApiConnection(); runtime.jar.set('sessionid', 'unrelated-runtime');
    const account = Account.create(runtime, store, { accountId: '10001', localState: false });
    const operations: string[] = [];
    account.on('system.login.verification', ({ verification }) => {
      operations.push(verification.operation);
      void verification.complete({ fp: `fp-${operations.length}`, fields: { password: 'must-not-be-sent', sms_code_key: 'ignored' } });
    });
    try {
      const result = await account.login().then(() => 'online', () => 'failed');
      expect(result).toBe(outcome === 'mismatch' ? 'failed' : 'online');
      expect(operations).toEqual(Array(challenges).fill('account-info'));
      expect(requests).toHaveLength(challenges + 1);
      for (let index = 1; index < requests.length; index++) {
        const { url, init } = requests[index]!;
        for (const key of ['sign', 'qs', 'ts', 'biz_trace_id']) expect(url.searchParams.get(key)).toBe(requests[0]!.url.searchParams.get(key));
        expect(url.searchParams.get('fp')).toBe(`fp-${index}`);
        expect(url.searchParams.get('verifyFp')).toBe(`fp-${index}`);
        expect(url.searchParams.has('msToken')).toBe(false);
        expect(new Headers(init?.headers).get('cookie')).toContain(`msToken=token-${index}`);
        expect(url.searchParams.has('isResend')).toBe(false);
        expect(url.searchParams.has('password')).toBe(false);
        expect(url.searchParams.has('sms_code_key')).toBe(false);
        expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
      }
      const saved = store.load('10001')!;
      expect(saved.session.cookies).toContain(outcome === 'mismatch' ? 'sessionid=original' : `sessionid=candidate-${challenges + 1}`);
      expect(new ApiConnection(store.toClientConfig(saved)).hasBoundTicket()).toBe(outcome !== 'mismatch');
      expect(account.online).toBe(outcome !== 'mismatch');
    } finally { await account.logout(); }
  });

  it('opens restored account-info verification with the candidate connection rather than the runtime', async () => {
    const store = new AccountStore({ dataDir });
    store.save({ platformUid: '10001', session: { cookies: 'sessionid=original' },
      deviceProfile: AccountStore.buildDeviceProfile('test-agent', 'test-trace'), meta: { createdAt: '', updatedAt: '' } });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(path).toBe('/passport/account/info/v2/');
      return Response.json({ message: 'error', data: {
        error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
      } }, { headers: { 'set-cookie': 'sessionid=candidate; Path=/' } });
    });
    const runtime = new ApiConnection(); runtime.jar.set('sessionid', 'unrelated-runtime');
    const settings = jest.spyOn(ApiConnection.prototype, 'requestVerificationRaw').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), data: '{}', rawText: '{}',
    });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const account = Account.create(runtime, store, { accountId: '10001', localState: false });
    const ready = new Promise<import('./auth/login-verification.js').LoginVerification>(resolve => {
      account.once('system.login.verification', event => resolve(event.verification));
    });
    const login = account.login(); const failed = login.catch(() => undefined);
    try {
      const verification = await ready;
      // Cancel at the boundary under test, not a 20ms deadline racing React asset IO.
      settings.mockImplementationOnce(async () => {
        verification.cancel('fixture verification request observed');
        return { ok: true, status: 200, headers: new Headers(), data: '{}', rawText: '{}' };
      });
      await expect(verification.open({ openBrowser: false, timeoutMs: 5000 })).rejects.toThrow('fixture verification request observed');
      await failed;
      const context = settings.mock.contexts[0];
      expect(context).toBeInstanceOf(ApiConnection); expect(context).not.toBe(runtime);
      expect(context!.getCookies()).toContain('sessionid=candidate');
      expect(store.load('10001')!.session.cookies).toBe('sessionid=original');
      expect(account.online).toBe(false);
    } finally { await account.logout(); }
  });

  it('cancels a restored account-info challenge on logout and rejects late verification completion', async () => {
    const store = new AccountStore({ dataDir });
    store.save({ platformUid: '10001', session: { cookies: 'sessionid=original' },
      deviceProfile: AccountStore.buildDeviceProfile('test-agent', 'test-trace'), meta: { createdAt: '', updatedAt: '' } });
    let requests = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(path).toBe('/passport/account/info/v2/'); requests++;
      return Response.json({ message: 'error', data: {
        error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture-only' }),
      } }, { headers: { 'set-cookie': 'sessionid=unverified-candidate; Path=/' } });
    });
    const account = Account.create(new ApiConnection(), store, { accountId: '10001', localState: false });
    const ready = new Promise<import('./auth/login-verification.js').LoginVerification>(resolve => {
      account.once('system.login.verification', event => resolve(event.verification));
    });
    const login = account.login(); const rejected = expect(login).rejects.toThrow('登录已取消');
    const verification = await ready;
    await account.logout(); await rejected;
    await expect(verification.complete({ fp: 'late-fp' })).rejects.toThrow('登录验证已结束');
    expect(requests).toBe(1);
    expect(store.load('10001')!.session.cookies).toBe('sessionid=original');
    expect(account.online).toBe(false);
    expect(ConnectionManager.prototype.start).not.toHaveBeenCalled();
  });

  it('aborts saved-session restoration on logout and ignores its late successful identity', async () => {
    const store = new AccountStore({ dataDir });
    store.save({ platformUid: '10001', session: { cookies: 'sessionid=keep-me' },
      deviceProfile: AccountStore.buildDeviceProfile('test-agent', 'test-trace'), meta: { createdAt: '', updatedAt: '' } });
    let finish!: (result: { status: 'alive'; uid: string; reason: string }) => void;
    let started!: () => void;
    const called = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    jest.spyOn(ApiConnection.prototype, 'probeSession').mockImplementation(input => {
      signal = input; started(); return new Promise(resolve => { finish = resolve; });
    });
    const account = Account.create(new ApiConnection(), store, { accountId: '10001' });
    const login = account.login(); const cancelled = expect(login).rejects.toThrow('登录已取消');
    await called;
    await account.logout(); await cancelled;
    expect(signal?.aborted).toBe(true);
    finish({ status: 'alive', uid: '10001', reason: 'late success' });
    for (let step = 0; step < 10; step++) await Promise.resolve();
    expect(account.state).toBe('offline');
    expect(store.load('10001')!.session.verifiedAt).toBeUndefined();
    expect(store.load('10001')!.session.cookies).toBe('sessionid=keep-me');
    expect(ConnectionManager.prototype.start).not.toHaveBeenCalled();
  });

  it('does not go online when the initial IM conversation sync is rejected', async () => {
    const account = createQrAccount();
    jest.mocked(ImService.prototype.listThreads).mockResolvedValue({ statusCode: 4, statusMsg: 'INVALID_REQUEST', threads: [], hasMore: false, cursor: '0', conversations: [] });
    const online = jest.fn();
    account.on('system.online', online);
    const ready = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));
    const login = account.login();
    const rejected = expect(login).rejects.toThrow('INVALID_REQUEST');
    await ready;
    await expect(account.continueLogin()).rejects.toThrow('INVALID_REQUEST');
    await rejected;
    expect(account.online).toBe(false);
    expect(online).not.toHaveBeenCalled();
    expect(ConnectionManager.prototype.start).not.toHaveBeenCalled();
  });

  it('adopts the replacement QR returned by Desktop Passport without restarting login', async () => {
    const transport = new ApiConnection();
    transport.jar.set('sessionid', 'session-id');
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'getSelfProfile').mockResolvedValue({ user: {} });
    jest.spyOn(transport, 'getQrcode').mockResolvedValue({
      token: 'first-token',
      qrcodeBase64: 'first-code',
      expireTime: 9999999999,
    });
    const poll = jest.spyOn(transport, 'checkQrconnect')
      .mockResolvedValueOnce({
        message: 'success',
        data: {
          status: 'expired',
          token: 'second-token',
          qrcode: 'second-code',
          expire_time: 9999999999,
        },
      })
      .mockResolvedValueOnce({
        message: 'success',
        data: {
          status: 'confirmed',
          user_data: { user_id_str: '10004', screen_name: 'refreshed qr user' },
        },
      });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      { },
    );
    const codes: string[] = [];
    let showSecond!: () => void;
    const secondReady = new Promise<void>((resolve) => {
      showSecond = resolve;
    });
    account.on('system.login.qrcode', (info) => {
      codes.push(info.qrcodeBase64);
      if (codes.length === 2) showSecond();
    });

    const login = account.login();
    while (codes.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const continuation = account.continueLogin();
    await secondReady;
    expect(account.continueLogin()).toBe(continuation);
    await continuation;
    await login;

    expect(codes).toEqual(['first-code', 'second-code']);
    expect(poll).toHaveBeenNthCalledWith(1, 'first-token', {});
    expect(poll).toHaveBeenNthCalledWith(2, 'second-token', {});
    expect(account.uid).toBe('10004');
  });

  it('completes explicit SMS login when Passport omits error_code on success', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'sendCode').mockResolvedValue({
      message: 'success',
      data: { mobile: '138****0000' },
    });
    jest.spyOn(transport, 'smsLogin').mockImplementation(async () => {
      transport.jar.set('sessionid', 'sms-session');
      return {
        message: 'success',
        data: { user_id_str: '10002', screen_name: 'sms user' },
      };
    });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      {
        login: { method: 'sms', mobile: '+86 13800000000' },
      },
    );
    const smsReady = new Promise<void>((resolve) => account.once('system.login.sms', resolve));

    const login = account.login();
    await smsReady;
    await account.continueLoginWithSms('123456');
    await login;

    expect(transport.sendCode).toHaveBeenCalledWith('+86 13800000000');
    expect(transport.smsLogin).toHaveBeenCalledWith('+86 13800000000', '123456');
    expect(account).toMatchObject({ uid: '10002', nickname: 'sms user', online: true });
  });

  it('can request a voice code without restarting an SMS login', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'sendCode').mockResolvedValue({
      message: 'success',
      data: { mobile: '138****0000' },
    });
    const sendVoiceCode = jest.spyOn(transport, 'sendVoiceCode').mockResolvedValue({
      message: 'success',
      data: { mobile: '138****0000' },
    });
    jest.spyOn(transport, 'smsLogin').mockImplementation(async () => {
      transport.jar.set('sessionid', 'voice-session');
      return {
        message: 'success',
        data: { user_id_str: '10009', screen_name: 'voice user' },
      };
    });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      {
        login: { method: 'sms', mobile: '13800000000' },
      },
    );
    const smsReady = new Promise<void>((resolve) => account.once('system.login.sms', resolve));

    const login = account.login();
    await smsReady;
    const voiceReady = new Promise<void>((resolve) => account.once('system.login.voice', resolve));
    await account.requestLoginVoiceCode();
    await voiceReady;
    await account.continueLoginWithSms('123456');
    await login;

    expect(sendVoiceCode).toHaveBeenCalledWith('13800000000');
    expect(account).toMatchObject({ uid: '10009', nickname: 'voice user', online: true });
  });

  it('completes explicit phone-password login without waiting for another action', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'userLogin').mockImplementation(async () => {
      transport.jar.set('sessionid', 'password-session');
      return {
        message: 'success',
        data: { user_id_str: '10003', screen_name: 'password user' },
      };
    });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      {
        login: { method: 'password', mobile: '13800000000', password: 'Password1' },
      },
    );

    await account.login();

    expect(transport.userLogin).toHaveBeenCalledWith('13800000000', 'Password1');
    expect(account).toMatchObject({ uid: '10003', nickname: 'password user', online: true });
  });

  it('lets the caller select a concrete account after Passport error 1454', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    const loginRequest = jest.spyOn(transport, 'userLogin')
      .mockResolvedValueOnce({
        message: 'error',
        data: {
          error_code: 1454,
          sms_code_key: 'selection-key',
          sub_account: [{
            sec_uid: 'MS4wLjABAAAAselected',
            user_id: '10005',
            name: 'selected user',
            is_bind_login_mobile: true,
          }],
        },
      })
      .mockImplementationOnce(async () => {
        transport.jar.set('sessionid', 'selected-session');
        return {
          message: 'success',
          data: { user_id_str: '10005', screen_name: 'selected user' },
        };
      });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      {
        login: { method: 'password', mobile: '13800000000', password: 'Password1' },
      },
    );
    let selection!: { accounts: readonly { secUid: string }[] };
    const selectionReady = new Promise<void>((resolve) => {
      account.once('system.login.accounts', (payload) => {
        selection = payload;
        resolve();
      });
    });

    const login = account.login();
    await selectionReady;
    expect(selection.accounts[0]?.secUid).toBe('MS4wLjABAAAAselected');
    await account.continueLoginWithSubAccount({ secUid: selection.accounts[0]!.secUid });
    await login;

    expect(loginRequest).toHaveBeenNthCalledWith(2, '13800000000', 'Password1', {
      subAccount: {
        smsCodeKey: 'selection-key',
        secUid: 'MS4wLjABAAAAselected',
      },
    });
    expect(account).toMatchObject({ uid: '10005', nickname: 'selected user', online: true });
  });

  it('can switch a protected password login to SMS without recreating the Account', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'userLogin').mockResolvedValue({
      message: 'error',
      data: { error_code: 1039, description: '请使用验证码登录' },
    });
    const sendCode = jest.spyOn(transport, 'sendCode').mockResolvedValue({
      message: 'success',
      data: { mobile: '138****0000' },
    });
    jest.spyOn(transport, 'smsLogin').mockImplementation(async () => {
      transport.jar.set('sessionid', 'sms-fallback-session');
      return {
        message: 'success',
        data: { user_id_str: '10006', screen_name: 'sms fallback user' },
      };
    });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      {
        login: { method: 'password', mobile: '13800000000', password: 'Password1' },
      },
    );
    const required = new Promise<void>((resolve) => account.once('system.login.sms-required', resolve));
    const smsReady = new Promise<void>((resolve) => account.once('system.login.sms', resolve));

    const login = account.login();
    await required;
    await account.requestLoginSmsCode();
    await smsReady;
    await account.continueLoginWithSms('123456');
    await login;

    expect(sendCode).toHaveBeenCalledWith('13800000000');
    expect(account).toMatchObject({ uid: '10006', nickname: 'sms fallback user', online: true });
  });

  it.each(['cross-page-membership', 'final-removal', 'late-duplicate', 'large-identities'] as const)(
    'joins every roster profile using the final membership snapshot (%s)', async scenario => {
      const account = createQrAccount(false);
      const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
      const login = account.login(); await ready; await account.continueLogin(); await login;
      const firstId = scenario === 'large-identities' ? '9007199254740993' : '22';
      const secondId = scenario === 'large-identities' ? '9007199254740995' : '33';
      const profile = (uid: string, nickname: string) => ({ uid, nickname, sec_uid: `sec${uid}`, user_canceled: 0 });
      const pages = [
        { status_code: 0, has_more: 1, cursor: '9007199254740997',
          user_list: [profile(firstId, 'first page')],
          friend_list: scenario === 'cross-page-membership' ? [] : [firstId], close_friend_list: [] },
        { status_code: 0, has_more: 0, cursor: '0',
          user_list: [profile(secondId, 'second page'), ...(scenario === 'late-duplicate' ? [profile(firstId, 'latest profile')] : [])],
          friend_list: scenario === 'final-removal' ? [secondId] : [secondId, firstId],
          close_friend_list: scenario === 'final-removal' ? [] : [firstId] },
      ];
      let calls = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://imdesktop.douyin.com');
        expect(url.pathname).toBe('/aweme/v1/web/familiar/list/');
        expect(url.searchParams.get('cursor')).toBe(calls === 0 ? '0' : '9007199254740997');
        const page = pages[calls++];
        expect(page).toBeDefined();
        let raw = JSON.stringify(page);
        if (scenario === 'large-identities') raw = raw.replace(/"(900719925474099[357])"/g, '$1');
        return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
      });
      try {
        const friends = await account.getFriendList();
        expect(calls).toBe(2);
        expect(friends.map(friend => friend.uid)).toEqual(scenario === 'final-removal' ? [secondId] : [firstId, secondId]);
        if (scenario !== 'final-removal') expect(account.pickFriend(firstId)).toMatchObject({
          nickname: scenario === 'late-duplicate' ? 'latest profile' : 'first page', closeFriend: true,
        });
        expect(account.pickFriend(secondId)).toMatchObject({ nickname: 'second page', closeFriend: false });
      } finally { await account.logout(); }
    },
  );

  it('refreshes explicit empty/false roster values across user views without erasing missing fields', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    const friend = account.bindFriend('22', '', '', { nickname: 'nickname', secUid: 'sec22', signature: 'old', closeFriend: true });
    account.rememberFriend(friend);
    account.updateUserRelation('22', { remark: 'old remark', followStatus: 4 });
    const stranger = Stranger.bind('22', '', '', account);
    const info = { uid: '22', nickname: 'nickname', threadId: '', unreadCount: 0, updateTime: 0 };
    const list = jest.spyOn(ImInboxQueries.prototype, 'friendList').mockResolvedValue({
      statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', total: '1', userList: [{ ...info, remark: '', signature: '' }], friendUids: ['22'], closeFriendUids: [],
    });
    await account.getFriendList();
    expect(account.pickFriend('22')).toBe(friend);
    expect(friend).toMatchObject({ remark: '', signature: '', closeFriend: false, nickname: 'nickname', followStatus: 4 });
    expect(stranger.remark).toBe('');
    account.updateUserRelation('22', { remark: 'new remark' });
    list.mockResolvedValue({ statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', total: '1', userList: [info], friendUids: ['22'] });
    await account.getFriendList();
    expect(friend.remark).toBe('new remark');
    await account.logout();
  });

  it('does not let an older profile or roster read overwrite a newer confirmed action', async () => {
    const account = createQrAccount();
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
    let resolveProfile!: (profile: { uid: string; secUid: string; nickname: string; followStatus: number }) => void;
    jest.spyOn(account.im, 'getUserProfile').mockImplementation(() => new Promise(resolve => { resolveProfile = resolve; }));
    const reading = account.readUserProfile('22', 'sec22');
    account.updateUserRelation('22', { followStatus: 1 });
    resolveProfile({ uid: '22', secUid: 'sec22', nickname: 'name', followStatus: 0 });
    await reading;
    expect(account.getUserRelation('22')?.followStatus).toBe(1);
    const page = { statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', total: '1', friendUids: ['22'], userList: [{ uid: '22', nickname: 'name', threadId: '', unreadCount: 0, updateTime: 0, remark: 'old' }] };
    let resolvePage!: (value: typeof page) => void;
    jest.spyOn(ImInboxQueries.prototype, 'friendList').mockImplementation(() => new Promise(resolve => { resolvePage = resolve; }));
    const roster = account.getFriendList();
    account.updateUserRelation('22', { remark: 'new' });
    resolvePage(page); await roster;
    expect(account.pickFriend('22')?.remark).toBe('new');
    const stale = account.getFriendList();
    await account.logout();
    resolvePage(page);
    await expect(stale).rejects.toThrow('账号状态已变化');
    expect(account.fl.size).toBe(0);
  });

  it('loads stable Friend and Group objects into fl/gl for synchronous pick operations', async () => {
    const friendList = jest.spyOn(ImInboxQueries.prototype, 'friendList')
      .mockResolvedValueOnce({
        statusCode: 0,
        statusMsg: 'OK',
        hasMore: true,
        cursor: '9007199254740993',
        total: '2',
        friendUids: ['20002'],
        userList: [{
          uid: '20002',
          secUid: 'MS4friend',
          nickname: '测试好友',
          avatarThumb: 'https://example.com/friend.jpg',
          threadId: '0:1:10001:20002',
          conversationShortId: '90001',
          unreadCount: 0,
          updateTime: 1,
        }],
      })
      .mockResolvedValueOnce({
        statusCode: 0,
        statusMsg: 'OK',
        hasMore: false,
        cursor: '9007199254740994',
        total: '2',
        friendUids: ['20002', '20003'],
        userList: [{
          uid: '20003',
          nickname: '第二页好友',
          threadId: '0:1:10001:20003',
          unreadCount: 0,
          updateTime: 0,
        }],
      });
    jest.spyOn(ImInboxQueries.prototype, 'groupList').mockResolvedValue({
      statusCode: 0,
      statusMsg: 'OK',
      groups: [{
        conversationId: '70001', conversationType: 2, isGroup: true,
        conversationShortId: '70001',
        name: '测试群',
        inboxType: 1,
        lastMessageTime: 1,
        members: [{ uid: '20002', secUid: 'MS4friend', role: 0 }],
      }],
    });
    const account = createQrAccount();
    const qrReady = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));
    const login = account.login();
    await qrReady;
    await account.continueLogin();
    await login;

    const friends = await account.getFriendList();
    const groups = await account.getGroupList();

    expect(account.pickFriend('20002')).toBe(friends[0]);
    expect(account.pickFriend('20003')).toBe(friends[1]);
    expect(friendList).toHaveBeenNthCalledWith(2, { cursor: '9007199254740993', count: 100 });
    expect(account.fl.get('20002')).toMatchObject({ nickname: '测试好友', secUid: 'MS4friend' });
    expect(account.pickGroup('70001')).toBe(groups[0]);
    expect(account.gl.get('70001')?.memberList.get('20002')).toMatchObject({ uid: '20002' });

    await account.logout();
    expect(account.fl.size).toBe(0);
    expect(account.gl.size).toBe(0);
  });

  it('resolves the current account sender for every contact action', async () => {
    const account = createQrAccount();
    jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    jest.spyOn(account, 'im', 'get').mockReturnValue({} as never);
    const firstSend = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '1' });
    const secondSend = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '', serverMessageId: '2' });
    jest.spyOn(account, 'outbound', 'get')
      .mockReturnValueOnce({ sendMessage: firstSend } as never)
      .mockReturnValueOnce({ sendMessage: secondSend } as never);
    const friend = Friend.bind('20002', '0:1:10001:20002', '90001', account);

    await friend.sendMsg('first');
    await friend.sendMsg('second');

    expect(firstSend).toHaveBeenCalledWith(expect.objectContaining({ message: 'first' }));
    expect(secondSend).toHaveBeenCalledWith(expect.objectContaining({ message: 'second' }));
  });

  it('rejects contact actions while the owning account is offline', async () => {
    const account = createQrAccount();
    const friend = Friend.bind('20002', '0:1:10001:20002', '90001', account);

    await expect(friend.sendMsg('offline')).rejects.toThrow('账号未上线');
  });

  it('creates a group from other member uids and immediately caches the Group', async () => {
    const createConversation = jest.spyOn(ImService.prototype, 'createGroupConversation').mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      conversation: {
        conversationId: '70001',
        conversationShortId: '70001',
        conversationType: 2,
        isGroup: true,
        name: '测试群',
        ownerUid: '10001',
        lastMessageTime: 0,
        members: [{ uid: '10001', role: 1 }, { uid: '20002', role: 0 }],
      },
    });
    const account = createQrAccount();
    const qrReady = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));
    const login = account.login();
    await qrReady;
    await account.continueLogin();
    await login;

    const group = await account.createGroup(['20002', '20002']);

    expect(createConversation).toHaveBeenCalledWith(['10001', '20002'], {});
    expect(account.pickGroup('70001')).toBe(group);
    expect(group).toMatchObject({ name: '测试群', ownerUid: '10001' });
  });

  it('batch marks messages and returns the original succeeded and failed event objects', async () => {
    const markConversationsRead = jest.spyOn(ImService.prototype, 'markConversationsRead')
      .mockImplementation(async (targets) => ({
        statusCode: 0,
        statusMsg: '',
        failed: [targets[1]!],
      }));
    const account = createQrAccount();
    const qrReady = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));
    const login = account.login();
    await qrReady;
    await account.continueLogin();
    await login;
    const first = PrivateMessageEvent.fromInbound({
      inboxType: 0,
      threadId: '0:1:10001:20002',
      conversationShortId: '90001',
      conversationType: 1,
      senderUid: '20002',
      serverMessageId: '101',
      indexInConversation: '10',
      indexInConversationV2: '20',
      text: '一',
      rawContent: '{"text":"一"}',
      messageType: 7,
      raw: {},
    }, account);
    const second = PrivateMessageEvent.fromInbound({
      inboxType: 0,
      threadId: '0:1:10001:20003',
      conversationShortId: '90002',
      conversationType: 1,
      senderUid: '20003',
      serverMessageId: '102',
      indexInConversation: '11',
      indexInConversationV2: '21',
      text: '二',
      rawContent: '{"text":"二"}',
      messageType: 7,
      raw: {},
    }, account);

    await expect(account.markMessagesRead([first, second])).resolves.toEqual({
      statusCode: 0,
      statusMsg: '',
      succeeded: [first],
      failed: [second],
    });
    expect(markConversationsRead).toHaveBeenCalledWith([
      expect.objectContaining({ threadId: first.threadId, serverMessageId: '101' }),
      expect.objectContaining({ threadId: second.threadId, serverMessageId: '102' }),
    ]);
  });

  it('batch refreshes loaded conversations without replacing stable contact objects', async () => {
    jest.spyOn(ImInboxQueries.prototype, 'groupList').mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      groups: [{
        conversationId: '70001', conversationType: 2, isGroup: true,
        conversationShortId: '70001',
        name: '旧群名',
        inboxType: 1,
        lastMessageTime: 1,
        members: [{ uid: '20002', role: 0 }],
      }],
    });
    const getConversationInfos = jest.spyOn(ImService.prototype, 'getConversationInfos')
      .mockResolvedValue({
        statusCode: 0,
        statusMsg: '',
        conversations: [{
          conversationId: '70001',
          conversationShortId: '70001',
          conversationType: 2,
          isGroup: true,
          name: '新群名',
          notice: '新公告',
          ownerUid: '10001',
          lastMessageTime: 1,
          members: [{ uid: '20002', role: 2 }],
        }],
      });
    const account = createQrAccount();
    const qrReady = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));
    const login = account.login();
    await qrReady;
    await account.continueLogin();
    await login;
    const [before] = await account.getGroupList();

    const contacts = await account.refreshContacts();

    expect(account.pickGroup('70001')).toBe(before);
    expect(before).toMatchObject({ name: '新群名', notice: '新公告', ownerUid: '10001' });
    expect(before?.pickMember('20002')).toMatchObject({ role: 2, isAdmin: true });
    expect(contacts).toContain(before);
    expect(getConversationInfos).toHaveBeenCalledWith([
      expect.objectContaining({ threadId: '70001', conversationShortId: '70001' }),
    ]);
  });

  it('models QR MFA as one verification challenge and resumes the QR poll', async () => {
    const transport = new ApiConnection();
    transport.jar.set('sessionid', 'session-id');
    jest.spyOn(transport, 'getSelfProfile').mockResolvedValue({
      user: { nickname: 'account-info-name' },
    });
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'getQrcode').mockResolvedValue({
      token: 'qr-token',
      qrcodeBase64: 'base64',
      expireTime: 9999999999,
    });
    const poll = jest.spyOn(transport, 'checkQrconnect')
      .mockResolvedValueOnce({
        message: 'success',
        data: {
          status: 'scanned',
          error_code: 0,
          account_flow: 'verify',
          encrypt_uid: 'encrypted-user',
          biz_params: {
            std_verify_flow_id: 'flow-id',
            std_verify_token: 'verify-token',
          },
          scan_user_info: { screen_name: 'scanner' },
        },
      })
      .mockResolvedValueOnce({
        message: 'success',
        data: {
          status: 'confirmed',
          error_code: 0,
          account_flow: 'verify',
          biz_params: {
            std_verify_flow_id: 'flow-id',
            std_verify_token: 'verify-token',
          },
          user_data: { user_id_str: '10001', screen_name: 'tester' },
        },
      });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      { },
    );
    const qrReady = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));
    let completeVerification!: () => Promise<void>;
    let verificationCount = 0;
    const verificationReady = new Promise<void>((resolve) => {
      account.on('system.login.verification', ({ verification }) => {
        verificationCount += 1;
        expect(verification).toMatchObject({
          source: 'qr-connect',
          operation: 'qr-connect',
          methods: ['mobile-sms'],
        });
        completeVerification = () => verification.complete();
        resolve();
      });
    });
    const statuses: string[] = [];
    account.on('system.login.qrcode.status', (data) => {
      statuses.push(data.status);
    });

    const login = account.login();
    await qrReady;
    const continuation = account.continueLogin();
    await verificationReady;
    await completeVerification();
    await continuation;
    await login;

    expect(statuses).toEqual(['verifying', 'verified', 'confirmed']);
    expect(poll).toHaveBeenNthCalledWith(2, 'qr-token', {
      std_verify_flow_id: 'flow-id',
      std_verify_token: 'verify-token',
    });
    expect(verificationCount).toBe(1);
    expect(account.online).toBe(true);
  });

  it('replays a QR poll after a nested verify-center challenge', async () => {
    const transport = new ApiConnection();
    transport.jar.set('sessionid', 'nested-qr-session');
    jest.spyOn(transport, 'getSelfProfile').mockResolvedValue({ user: {} });
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'getQrcode').mockResolvedValue({
      token: 'nested-qr-token',
      qrcodeBase64: 'base64',
      expireTime: 9999999999,
    });
    const poll = jest.spyOn(transport, 'checkQrconnect')
      .mockResolvedValueOnce({
        message: 'error',
        data: {
          status: 'scanned',
          data: {
            error_code: 1105,
            description: '请完成滑块验证',
            verify_center_decision_conf: JSON.stringify({
              verify_from: 'captcha',
              captcha: 'nested-qr-captcha',
            }),
          },
        },
      })
      .mockResolvedValueOnce({
        message: 'success',
        data: {
          status: 'confirmed',
          error_code: 0,
          user_data: { user_id_str: '10012', screen_name: 'nested qr user' },
        },
      });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      { },
    );
    const qrReady = new Promise<void>((resolve) => account.once('system.login.qrcode', resolve));
    account.once('system.login.verification', ({ verification }) => {
      expect(verification).toMatchObject({
        source: 'qr-connect',
        operation: 'qr-connect',
        errorCode: 1105,
        methods: ['captcha'],
      });
      void verification.complete({ fp: 'nested-qr-fingerprint' });
    });

    const login = account.login();
    await qrReady;
    await account.continueLogin();
    await login;

    expect(poll).toHaveBeenNthCalledWith(2, 'nested-qr-token', {}, {
      fp: 'nested-qr-fingerprint',
      retry: await poll.mock.results[0]!.value,
    });
    expect(account.uid).toBe('10012');
  });

  it('replays password login with the captcha fingerprint', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    const request = jest.spyOn(transport, 'userLogin')
      .mockResolvedValueOnce({
        message: 'error',
        data: {
          error_code: 1105,
          description: '请完成滑块验证',
          verify_center_decision_conf: JSON.stringify({
            verify_from: 'captcha',
            captcha: 'captcha-data',
          }),
        },
      })
      .mockImplementationOnce(async () => {
        transport.jar.set('sessionid', 'captcha-session');
        return {
          message: 'success',
          data: { user_id_str: '10007', screen_name: 'captcha user' },
        };
      });
    const account = Account.create(transport, new AccountStore({ dataDir }), {
      login: { method: 'password', mobile: '13800000000', password: 'Password1' },
    });
    account.once('system.login.verification', ({ verification }) => {
      expect(verification.methods).toContain('captcha');
      void verification.complete({ fp: 'verify-fingerprint' });
    });

    await account.login();

    expect(request).toHaveBeenNthCalledWith(2, '13800000000', 'Password1', {
      fp: 'verify-fingerprint',
      retry: await request.mock.results[0]!.value,
    });
  });

  it('keeps Desktop nested-primary verification precedence over outer secondary data', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    const request = jest.spyOn(transport, 'userLogin')
      .mockResolvedValueOnce({
        message: 'error',
        data: {
          error_code: 2046,
          verify_center_secondary_decision_conf: JSON.stringify({
            verify_from: 'verify_center',
            verify_ways: [{ verify_way: 'mobile_sms_verify' }],
          }),
          data: {
            error_code: 1105,
            verify_center_decision_conf: JSON.stringify({
              verify_from: 'captcha',
              captcha: 'nested-primary-captcha',
            }),
          },
        },
      })
      .mockImplementationOnce(async () => {
        transport.jar.set('sessionid', 'nested-primary-session');
        return {
          message: 'success',
          data: { user_id_str: '10011', screen_name: 'nested primary user' },
        };
      });
    const account = Account.create(transport, new AccountStore({ dataDir }), {
      login: { method: 'password', mobile: '13800000000', password: 'Password1' },
    });
    account.once('system.login.verification', ({ verification }) => {
      expect(verification.methods).toContain('captcha');
      expect(verification.methods).not.toContain('auxiliary-mobile-sms');
      void verification.complete({ fp: 'nested-primary-fingerprint' });
    });

    await account.login();

    expect(request).toHaveBeenNthCalledWith(2, '13800000000', 'Password1', {
      fp: 'nested-primary-fingerprint',
      retry: await request.mock.results[0]!.value,
    });
  });

  it('finishes verify-center before exposing a 1454 account selection', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    const loginRequest = jest.spyOn(transport, 'userLogin')
      .mockResolvedValueOnce({
        message: 'error',
        data: {
          error_code: 1454,
          sms_code_key: 'selection-key',
          sub_account: [{
            sec_uid: 'MS4wLjABAAAAselected',
            user_id: '10010',
            name: 'selected after verify',
            is_bind_login_mobile: true,
          }],
          verify_center_decision_conf: JSON.stringify({
            verify_from: 'captcha',
            captcha: 'captcha-data',
          }),
        },
      })
      .mockResolvedValueOnce({
        message: 'error',
        data: {
          error_code: 1454,
          sms_code_key: 'selection-key',
          sub_account: [{
            sec_uid: 'MS4wLjABAAAAselected',
            user_id: '10010',
            name: 'selected after verify',
            is_bind_login_mobile: true,
          }],
        },
      })
      .mockImplementationOnce(async () => {
        transport.jar.set('sessionid', 'verified-selection-session');
        return {
          message: 'success',
          data: { user_id_str: '10010', screen_name: 'selected after verify' },
        };
      });
    const account = Account.create(
      transport,
      new AccountStore({ dataDir }),
      {
        login: { method: 'password', mobile: '13800000000', password: 'Password1' },
      },
    );
    const order: string[] = [];
    const selectionReady = new Promise<void>((resolve) => {
      account.once('system.login.accounts', () => {
        order.push('accounts');
        resolve();
      });
    });
    account.once('system.login.verification', ({ verification }) => {
      order.push('verification');
      void verification.complete({ fp: 'verified-fingerprint' });
    });

    const login = account.login();
    await selectionReady;
    expect(order).toEqual(['verification', 'accounts']);
    await account.continueLoginWithSubAccount({ secUid: 'MS4wLjABAAAAselected' });
    await login;

    expect(loginRequest).toHaveBeenNthCalledWith(2, '13800000000', 'Password1', {
      fp: 'verified-fingerprint',
      retry: await loginRequest.mock.results[0]!.value,
    });
    expect(loginRequest).toHaveBeenNthCalledWith(3, '13800000000', 'Password1', {
      subAccount: {
        smsCodeKey: 'selection-key',
        secUid: 'MS4wLjABAAAAselected',
      },
    });
  });

  it('patches only the source request sms_code_key into the SMS login retry', async () => {
    const transport = new ApiConnection();
    jest.spyOn(transport, 'ttwidCheck').mockRejectedValue(new Error('optional warm-up failed'));
    jest.spyOn(transport, 'sendCode').mockResolvedValue({
      message: 'success',
      data: { mobile: '138****0000' },
    });
    const request = jest.spyOn(transport, 'smsLogin')
      .mockResolvedValueOnce({
        message: 'error',
        data: {
          error_code: 2046,
          description: '需要辅助验证',
          sms_code_key: 'secondary-sms-key',
          verify_center_secondary_decision_conf: JSON.stringify({
            verify_from: 'verify_center',
            verify_ways: [
              { verify_way: 'mobile_sms_verify' },
              { verify_way: 'scan_qrcode' },
            ],
          }),
        },
      })
      .mockImplementationOnce(async () => {
        transport.jar.set('sessionid', 'secondary-session');
        return {
          message: 'success',
          data: { user_id_str: '10008', screen_name: 'secondary user' },
        };
      });
    const account = Account.create(transport, new AccountStore({ dataDir }), {
      login: { method: 'sms', mobile: '13800000000' },
    });
    const smsReady = new Promise<void>((resolve) => account.once('system.login.sms', resolve));
    account.once('system.login.verification', ({ verification }) => {
      expect(verification.methods).toEqual(['auxiliary-mobile-sms', 'mobile-qr']);
      void verification.complete({ fields: { verify_ticket: 'secondary-ticket' } });
    });

    const login = account.login();
    await smsReady;
    await account.continueLoginWithSms('123456');
    await login;

    expect(request).toHaveBeenNthCalledWith(2, '13800000000', '123456', {
      retry: await request.mock.results[0]!.value,
      verificationFields: {
        sms_code_key: 'secondary-sms-key',
      },
    });
  });
});
