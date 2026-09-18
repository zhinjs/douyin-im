import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiConnection } from '../../desktop/api-connection.js';
import { AccountStore } from '../../store/account-store.js';
import { AccountAuth, type AccountAuthHooks } from './account-auth.js';

let directory: string;
beforeEach(() => {
  jest.useFakeTimers({ now: 1_800_000_000_000 });
  directory = mkdtempSync(join(tmpdir(), 'douyin-qr-poll-'));
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });

function fixture(loginMethod: 'qr' | 'sms' | 'password' = 'qr') {
  const client = new ApiConnection({ deviceId: '100', installId: '200', enableABogus: false });
  jest.spyOn(client, 'startTicketGuard').mockImplementation(() => undefined);
  jest.spyOn(client, 'startDeviceLifecycle').mockResolvedValue({ deviceId: '100', installId: '200' });
  jest.spyOn(client, 'ttwidCheck').mockRejectedValue(new Error('fixture optional warmup'));
  jest.spyOn(client, 'getQrcode').mockResolvedValue({ token: 'fixture-qr', qrcodeBase64: 'Zml4dHVyZQ==',
    expireTime: Date.now() / 1000 + 1 });
  client.jar.set('sessionid', 'fixture-session');
  jest.spyOn(client, 'getSelfProfile').mockResolvedValue({ status_code: 0, user: { uid: '10001' } });
  const hooks: AccountAuthHooks = { onQrcode: jest.fn(), onQrStatus: jest.fn(), onSms: jest.fn(), onVoice: jest.fn(),
    onAccountSelection: jest.fn(), onSmsRequired: jest.fn(), onVerification: jest.fn(), onLoggedIn: jest.fn() };
  const auth = new AccountAuth({ client, store: new AccountStore({ dataDir: directory }), loginMethod,
    ...(loginMethod !== 'qr' ? { mobile: '13800000000', password: 'synthetic-password' } : {}),
  }, hooks);
  return { auth, client, hooks };
}

const confirmed = { message: 'success', data: { status: 'confirmed', user_data: { user_id_str: '10001' } } };

const missingDecisions = [
  { error_code: 1105 },
  { error_code: '1105' },
  { error_code: 9001, captcha: 'fixture-not-a-decision' },
  { error_code: 1105, verify_center_decision_conf: '' },
  { error_code: 1105, verify_center_decision_conf: false },
  { error_code: 1105, verify_center_decision_conf: 0 },
];

it.each(missingDecisions)('does not manufacture a verification challenge without a server decision: %j', async data => {
  const { auth, client, hooks } = fixture();
  const verify = jest.fn(({ verification }) => verification.cancel('unexpected fabricated challenge'));
  hooks.onVerification = verify;
  const poll = jest.spyOn(client, 'checkQrconnect');
  jest.mocked(globalThis.fetch).mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
    expect(path).toBe('/passport/web/check_qrconnect/');
    return Response.json({ message: 'error', data });
  });
  try {
    await auth.beginLogin();
    await expect(auth.continueQrLogin()).rejects.toThrow(`error_code=${data.error_code}`);
    expect(verify).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(hooks.onLoggedIn).not.toHaveBeenCalled();
  } finally { auth.cancel(); }
});

for (const method of ['sms', 'password'] as const) {
  it.each(missingDecisions)(`${method} also returns a decisionless error without starting verification: %j`, async data => {
    const { auth, hooks } = fixture(method);
    const verify = jest.fn(({ verification }) => verification.cancel('unexpected fabricated challenge'));
    hooks.onVerification = verify;
    let requests = 0;
    jest.mocked(globalThis.fetch).mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
      expect(path).toBe(method === 'sms' ? '/passport/web/send_code/' : '/passport/web/user/login/');
      requests++;
      return Response.json({ message: 'error', data });
    });
    try {
      await expect(auth.beginLogin()).rejects.toThrow(`error_code=${data.error_code}`);
      expect(verify).not.toHaveBeenCalled();
      expect(hooks.onLoggedIn).not.toHaveBeenCalled();
      expect(requests).toBe(1);
    } finally { auth.cancel(); }
  });
}

it.each([false, 0, ''])('selects a real secondary decision when the primary is falsy (%p)', async primary => {
  const { auth, client, hooks } = fixture();
  const decision = '{"verify_from":"verify_center","code":20000}';
  const poll = jest.spyOn(client, 'checkQrconnect');
  let polls = 0;
  jest.mocked(globalThis.fetch).mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/passport/ticket_guard/get_client_cert/') return Response.json({ message: 'success', data: {} });
    expect(path).toBe('/passport/web/check_qrconnect/');
    return Response.json(++polls === 1 ? { message: 'error', data: {
      error_code: 2046, verify_center_decision_conf: primary, verify_center_secondary_decision_conf: decision,
    } } : confirmed);
  });
  const verify = jest.fn(({ verification }) => {
    expect(verification.decisionConf).toBe(decision);
    void verification.complete();
  });
  hooks.onVerification = verify;
  try {
    await auth.beginLogin();
    await auth.continueQrLogin();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(hooks.onLoggedIn).toHaveBeenCalledTimes(1);
  } finally { auth.cancel(); }
});

it('keeps the missing-code retry budget across successful QR polls', async () => {
  const { auth, client, hooks } = fixture();
  const poll = jest.spyOn(client, 'checkQrconnect')
    .mockRejectedValueOnce(new Error('fixture transport error'))
    .mockResolvedValueOnce({ message: 'success', data: { status: 'new' } })
    .mockRejectedValueOnce(new Error('fixture transport error'))
    .mockRejectedValueOnce(new Error('fixture transport error'))
    .mockRejectedValueOnce(new Error('fixture transport error'))
    .mockResolvedValue(confirmed);
  await auth.beginLogin();
  let failure: unknown;
  const outcome = auth.continueQrLogin().catch(error => { failure = error; });
  try {
    await jest.advanceTimersByTimeAsync(6000); await outcome;
    expect(failure).toBeInstanceOf(Error);
    expect(poll).toHaveBeenCalledTimes(5);
    expect(hooks.onLoggedIn).not.toHaveBeenCalled();
  } finally { auth.cancel(); }
});

it('shares the missing-code retry budget between rejected transport and Passport responses', async () => {
  const { auth, client, hooks } = fixture();
  const poll = jest.spyOn(client, 'checkQrconnect')
    .mockRejectedValueOnce(new Error('fixture transport'))
    .mockResolvedValueOnce({ message: 'error', data: {} })
    .mockRejectedValueOnce(new Error('fixture transport'))
    .mockResolvedValueOnce({ message: 'error', data: {} })
    .mockResolvedValue(confirmed);
  await auth.beginLogin();
  let failure: unknown;
  const outcome = auth.continueQrLogin().catch(error => { failure = error; });
  try {
    await jest.advanceTimersByTimeAsync(6000); await outcome;
    expect(failure).toBeInstanceOf(Error); expect(poll).toHaveBeenCalledTimes(4);
    expect(hooks.onLoggedIn).not.toHaveBeenCalled();
  } finally { auth.cancel(); }
});

it('does not spend the missing-code retry budget on a truthy non-retryable thrown code', async () => {
  const { auth, client, hooks } = fixture();
  const poll = jest.spyOn(client, 'checkQrconnect').mockRejectedValueOnce({ error_code: 7, description: 'fixture rejected' }).mockResolvedValue(confirmed);
  await auth.beginLogin();
  let failure: unknown;
  const outcome = auth.continueQrLogin().catch(error => { failure = error; });
  try {
    await jest.advanceTimersByTimeAsync(1500); await outcome;
    expect(failure).toBeInstanceOf(Error); expect(poll).toHaveBeenCalledTimes(1);
    expect(hooks.onLoggedIn).not.toHaveBeenCalled();
  } finally { auth.cancel(); }
});

it.each([6, 'ECONNABORTED'])('keeps the transient %p budget independent from the missing-code budget', async code => {
  const { auth, client, hooks } = fixture();
  const poll = jest.spyOn(client, 'checkQrconnect');
  for (let i = 0; i < 3; i++) {
    poll.mockRejectedValueOnce({ error_code: code })
      .mockResolvedValueOnce({ message: 'error', data: {} });
  }
  poll.mockResolvedValue(confirmed);
  await auth.beginLogin();
  const outcome = auth.continueQrLogin();
  try {
    await jest.advanceTimersByTimeAsync(6000); await outcome;
    expect(poll).toHaveBeenCalledTimes(7);
    expect(hooks.onLoggedIn).toHaveBeenCalledTimes(1);
  } finally { auth.cancel(); }
});

it('replays a completed challenge even when the QR expire_time passed during human verification', async () => {
  const { auth, client, hooks } = fixture();
  const poll = jest.spyOn(client, 'checkQrconnect').mockResolvedValueOnce({ message: 'error', data: {
    error_code: 1105, verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture' }),
  } }).mockResolvedValueOnce(confirmed);
  hooks.onVerification = ({ verification }) => {
    jest.setSystemTime(Date.now() + 240_000);
    void verification.complete({ fp: 'fixture-fp' });
  };
  try {
    await auth.beginLogin();
    await expect(auth.continueQrLogin()).resolves.toBeUndefined();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poll.mock.calls[1]?.[2]).toMatchObject({ fp: 'fixture-fp' });
    expect(hooks.onLoggedIn).toHaveBeenCalledTimes(1);
  } finally { auth.cancel(); }
});

it('uses completed poll count, not slow request elapsed time, to select the next interval', async () => {
  const { auth, client } = fixture();
  jest.mocked(client.getQrcode).mockResolvedValue({ token: 'fixture-qr', qrcodeBase64: 'Zml4dHVyZQ==', expireTime: 9999999999 });
  const poll = jest.spyOn(client, 'checkQrconnect').mockImplementationOnce(async () => {
    jest.setSystemTime(Date.now() + 70_000);
    return { message: 'success', data: { status: 'new' } };
  }).mockResolvedValueOnce(confirmed);
  await auth.beginLogin();
  const outcome = auth.continueQrLogin().then(() => 'complete', () => 'cancelled');
  try {
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(999);
    expect(poll).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(await outcome).toBe('complete');
  } finally { auth.cancel(); await jest.advanceTimersByTimeAsync(5000); await outcome; }
});

it.each([undefined, '', 'unrecognized'])('stops on unrecognized fulfilled QR status %p instead of reporting pending forever', async status => {
  const { auth, client, hooks } = fixture();
  const poll = jest.spyOn(client, 'checkQrconnect').mockResolvedValue({ message: 'success', data: status === undefined ? {} : { status } });
  await auth.beginLogin();
  let failure: unknown;
  const outcome = auth.continueQrLogin().catch(error => { failure = error; });
  try {
    await jest.advanceTimersByTimeAsync(0);
    expect(failure).toBeInstanceOf(Error);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(hooks.onLoggedIn).not.toHaveBeenCalled();
  } finally { auth.cancel(); await jest.advanceTimersByTimeAsync(5000); await outcome; }
});

it('switches the deterministic polling interval at 60 and 180 outer checks', async () => {
  const { auth, client } = fixture();
  let calls = 0;
  const poll = jest.spyOn(client, 'checkQrconnect').mockImplementation(async () => {
    calls++;
    return calls > 180 ? confirmed : { message: 'success', data: { status: calls % 2 ? 'new' : 'scanned' } };
  });
  await auth.beginLogin();
  const outcome = auth.continueQrLogin().then(() => 'complete', () => 'cancelled');
  try {
    await jest.advanceTimersByTimeAsync(0);
    for (let count = 1; count <= 180; count++) {
      const interval = count >= 180 ? 5000 : count >= 60 ? 3000 : 1000;
      await jest.advanceTimersByTimeAsync(interval - 1);
      expect(poll).toHaveBeenCalledTimes(count);
      await jest.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(count + 1);
    }
    expect(await outcome).toBe('complete');
  } finally { auth.cancel(); await jest.advanceTimersByTimeAsync(5000); await outcome; }
});

it('does not count a challenge replay as the sixtieth outer poll', async () => {
  const { auth, client, hooks } = fixture();
  let calls = 0;
  const poll = jest.spyOn(client, 'checkQrconnect').mockImplementation(async () => {
    calls++;
    if (calls === 59) return { message: 'error', data: { error_code: 1105,
      verify_center_decision_conf: JSON.stringify({ verify_from: 'captcha', captcha: 'fixture' }) } };
    return calls === 61 ? confirmed : { message: 'success', data: { status: 'new' } };
  });
  hooks.onVerification = ({ verification }) => { void verification.complete({ fp: 'fixture-fp' }); };
  await auth.beginLogin();
  const outcome = auth.continueQrLogin().then(() => 'complete', () => 'cancelled');
  try {
    await jest.advanceTimersByTimeAsync(58_000);
    expect(poll).toHaveBeenCalledTimes(60); // 59 fresh checks plus one internal replay.
    expect(poll.mock.calls[59]?.[2]).toMatchObject({ fp: 'fixture-fp' });
    await jest.advanceTimersByTimeAsync(999);
    expect(poll).toHaveBeenCalledTimes(60);
    await jest.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(61);
    expect(await outcome).toBe('complete');
  } finally { auth.cancel(); await jest.advanceTimersByTimeAsync(5000); await outcome; }
});

it('cancellation still ends polling after the display expiry without confirming an account', async () => {
  const { auth, client, hooks } = fixture();
  const poll = jest.spyOn(client, 'checkQrconnect').mockResolvedValue({ message: 'success', data: { status: 'new' } });
  await auth.beginLogin();
  const outcome = auth.continueQrLogin().catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(2000);
  expect(poll).toHaveBeenCalledTimes(3);
  auth.cancel();
  await jest.advanceTimersByTimeAsync(5000);
  expect(await outcome).toMatchObject({ message: '登录已取消' });
  expect(poll).toHaveBeenCalledTimes(3);
  expect(hooks.onLoggedIn).not.toHaveBeenCalled();
});

it('waits the normal interval before polling a server-issued replacement QR', async () => {
  const { auth, client, hooks } = fixture();
  const poll = jest.spyOn(client, 'checkQrconnect').mockResolvedValueOnce({ message: 'success', data: {
    status: 'expired', token: 'replacement', qrcode: 'Zml4dHVyZQ==', expire_time: Date.now() / 1000 + 1,
  } }).mockResolvedValueOnce(confirmed);
  await auth.beginLogin();
  const outcome = auth.continueQrLogin().then(() => 'complete', () => 'cancelled');
  try {
    await jest.advanceTimersByTimeAsync(0);
    expect(hooks.onQrcode).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(999);
    expect(poll).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenNthCalledWith(2, 'replacement', {});
    expect(await outcome).toBe('complete');
  } finally { auth.cancel(); await jest.advanceTimersByTimeAsync(5000); await outcome; }
});
