import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiConnection } from '../../desktop/api-connection.js';
import { AccountStore } from '../../store/account-store.js';
import { AccountAuth } from './account-auth.js';

describe('Desktop login account-selection eligibility', () => {
  let directory: string;
  const pending: AccountAuth[] = [];
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douyin-selection-')); });
  afterEach(() => {
    for (const auth of pending.splice(0)) auth.cancel();
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture(method: 'password' | 'sms', candidate: Record<string, unknown>, errorCode: unknown = 1454) {
    const connection = new ApiConnection({ enableABogus: false });
    jest.spyOn(connection, 'startTicketGuard').mockImplementation(() => undefined);
    jest.spyOn(connection, 'startDeviceLifecycle').mockResolvedValue({ deviceId: '0', installId: '0' });
    jest.spyOn(connection, 'ttwidCheck').mockRejectedValue(new Error('optional warmup'));
    const store = new AccountStore({ dataDir: directory });
    const path = method === 'password' ? '/passport/web/user/login/' : '/passport/web/sms_login/';
    const loginBodies: URLSearchParams[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (method === 'sms' && url.pathname === '/passport/web/send_code/') return Response.json({ message: 'success', data: {} });
      expect(url.pathname).toBe(path);
      loginBodies.push(new URLSearchParams(String(init?.body)));
      if (loginBodies.length === 1) return Response.json({ message: 'error', data: {
        error_code: errorCode, sms_code_key: 'fixture-selection-key',
        sub_account: [{ sec_uid: 'fixture-selected', user_id: '10001', ...candidate }],
      } });
      return Response.json({ message: 'success', data: { user_id_str: '10001' } }, {
        headers: { 'set-cookie': 'sessionid=fixture-selected-session; Path=/' },
      });
    });
    const hooks = {
      onQrcode: jest.fn(), onQrStatus: jest.fn(), onSms: jest.fn(), onVoice: jest.fn(),
      onAccountSelection: jest.fn(), onSmsRequired: jest.fn(), onVerification: jest.fn(), onLoggedIn: jest.fn(),
    };
    const auth = new AccountAuth({ client: connection, store, loginMethod: method,
      mobile: '13800000000', password: 'fixture-password' }, hooks);
    pending.push(auth);
    const start = async () => { await auth.beginLogin(); if (method === 'sms') await auth.continueSmsLogin('123456'); };
    return { auth, hooks, store, loginBodies, start };
  }

  describe.each(['password', 'sms'] as const)('%s', method => {
    it.each([
      [6, undefined, false], [6, null, false], [6, 0, false], [6, '', false], [6, false, false],
      [6, true, true], [6, 1, true], ['6', false, true], [undefined, undefined, true],
    ] as const)('matches enterprise type=%j active=%j eligibility', async (type, active, permitted) => {
      const { auth, hooks, store, loginBodies, start } = fixture(method, {
        passport_enterprise_user_type: type, business_account_active: active,
      });
      await start();
      expect(hooks.onAccountSelection).toHaveBeenCalledTimes(1);
      const account = hooks.onAccountSelection.mock.calls[0]![0].accounts[0];
      expect(store.listUids()).toEqual([]);
      if (permitted) {
        await auth.continueWithSubAccount({ secUid: account.secUid });
        expect(loginBodies).toHaveLength(2);
        expect(loginBodies[1]!.get('sec_uid')).toBe('fixture-selected');
        expect(loginBodies[1]!.get('sms_code_key')).toBe('fixture-selection-key');
        expect(loginBodies[1]!.has('register_new_user')).toBe(false);
        expect(hooks.onLoggedIn).toHaveBeenCalledTimes(1);
        expect(store.listUids()).toEqual(['10001']);
      } else {
        await expect(auth.continueWithSubAccount({ secUid: account.secUid })).rejects.toThrow('企业账号尚未激活');
        expect(loginBodies).toHaveLength(1);
        expect(hooks.onLoggedIn).not.toHaveBeenCalled();
        expect(store.listUids()).toEqual([]);
      }
      expect(account.isEnterprise).toBe(type === 6);
      expect(account.isActive).toBe(Boolean(active));
    });

    it.each([true, false, 1, 0, 'main', null])('uses the source truth value of the main-account flag %j', async flag => {
      const { auth, hooks, loginBodies, start } = fixture(method, { is_bind_login_mobile: flag });
      await start();
      const selection = hooks.onAccountSelection.mock.calls[0]![0];
      if (flag) {
        await expect(auth.continueWithSubAccount({ registerNewUser: true })).rejects.toThrow('已有关联主账号');
        expect(loginBodies).toHaveLength(1);
      }
      expect(selection.accounts[0].isMainAccount).toBe(Boolean(flag));
      expect(selection.canRegisterNewUser).toBe(!flag);
    });

    it.each(['1454', '1039'])('does not coerce string error code %s into a login branch', async errorCode => {
      const { start, hooks, loginBodies } = fixture(method, {}, errorCode);
      await expect(start()).rejects.toThrow('登录失败');
      expect(hooks.onAccountSelection).not.toHaveBeenCalled();
      expect(hooks.onSmsRequired).not.toHaveBeenCalled();
      expect(loginBodies).toHaveLength(1);
    });
  });
});
