import { ImUserSettingsApi } from './user-settings.js';
import type { ImHttpClient } from './service.js';

function fixture(body: unknown) {
  const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(body) });
  const api = new ImUserSettingsApi({ requestRaw, getUserAgent: () => 'fixture-UA', getGuid: () => 'guid', getInstallId: () => 'iid' } as unknown as ImHttpClient, 'did');
  return { api, requestRaw };
}

describe('Desktop user settings and read privacy', () => {
  it('uses the user settings GET root response and exact query without assuming a status_code wrapper', async () => {
    const { api, requestRaw } = fixture({ im_read_status_show: -1, close_consecutive_chat: 1 });
    await expect(api.getSettings()).resolves.toEqual({ statusCode: 0, statusMsg: '', imReadStatusShow: -1, enableReadState: false, closeConsecutiveChat: 1 });
    const [input, init, passport] = requestRaw.mock.calls[0]!;
    const url = new URL(input);
    expect(url.origin).toBe('https://imdesktop.douyin.com');
    expect(url.pathname).toBe('/aweme/v1/web/user/settings/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ aid: '339757', device_id: 'did', did: 'did', iid: 'iid', awemeim_guid: 'guid',
      is_fetch_frequency_control: 'true', has_local_cache: 'false', request_source: 'settings_page' });
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(passport).toBe(false);
  });

  it('queries the current switch with Desktop JSON POST, no message IDs, timers or writes', async () => {
    const { api, requestRaw } = fixture({ current_user_switch: 0 });
    await expect(api.getReadReceiptPrivacy()).resolves.toEqual({ statusCode: 0, statusMsg: '', currentUserSwitch: 0, enableReadState: true });
    const [input, init, passport] = requestRaw.mock.calls[0]!;
    expect(new URL(input).pathname).toBe('/aweme/v1/im_communication/msg_read_switch/');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8', bgint_json_parser: '2' } });
    expect(JSON.parse(init.body)).toEqual({ source: 'only_current_user', is_retry: false });
    expect(passport).toBe(false);
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 0, 1, 2])('preserves the raw setting %i without inventing a 0/1 enum', async (value) => {
    const { api } = fixture({ status_code: 0, im_read_status_show: value, current_user_switch: value });
    await expect(api.getSettings()).resolves.toMatchObject({ imReadStatusShow: value, enableReadState: value !== -1 });
    await expect(api.getReadReceiptPrivacy()).resolves.toMatchObject({ currentUserSwitch: value, enableReadState: value !== -1 });
  });

  it.each([{}, { status_code: 0 }, { im_read_status_show: '-1', current_user_switch: '-1' },
    { data: { im_read_status_show: 0, current_user_switch: 0 } }, { im_read_status_show: null, current_user_switch: null },
    { im_read_status_show: 0.1, current_user_switch: 0.1 }])('does not turn incomplete/invalid settings into permission to show read states: %j', async body => {
    const { api } = fixture(body);
    const settings = await api.getSettings();
    const privacy = await api.getReadReceiptPrivacy();
    expect(settings.statusCode).toBe(-3); expect(settings.enableReadState).toBeUndefined();
    expect(privacy.statusCode).toBe(-3); expect(privacy.enableReadState).toBeUndefined();
  });

  it('preserves business failures and does not retry ambiguous/network failures', async () => {
    const { api, requestRaw } = fixture({ status_code: 8, status_msg: 'not logged in', im_read_status_show: 0, current_user_switch: 0 });
    await expect(api.getSettings()).resolves.toEqual({ statusCode: 8, statusMsg: 'not logged in' });
    await expect(api.getReadReceiptPrivacy()).resolves.toEqual({ statusCode: 8, statusMsg: 'not logged in' });
    requestRaw.mockReset().mockRejectedValue(new Error('timeout'));
    await expect(api.getReadReceiptPrivacy()).rejects.toThrow('timeout');
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });
});
