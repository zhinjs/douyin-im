import { createVerificationRequests, type VerificationRequestChallenge } from './verification-request.js';

function response(body: unknown, status = 200) {
  return { rawText: JSON.stringify(body), status, statusText: 'fixture', headers: {} };
}
function fixture() {
  const transport = jest.fn().mockResolvedValue(response({ message: 'success', data: { fixture: true } }));
  const verify = jest.fn<Promise<never>, [VerificationRequestChallenge]>().mockRejectedValue(new Error('unexpected challenge'));
  return { transport, verify, api: createVerificationRequests({ origin: 'https://imdesktop.douyin.com', transport, verify }) };
}

it('keeps raw and fetch status validation distinct', async () => {
  const { api, transport } = fixture();
  transport.mockResolvedValue(response({ message: 'success' }, 503));
  await expect(api.request({ url: '/fixture' })).resolves.toEqual({ message: 'success' });
  await expect(api.fetch({ url: '/fixture' })).rejects.toThrow('503');
  await expect(api.fetch({ url: '/fixture', validateStatus: status => status === 503 })).resolves.toEqual({ message: 'success' });
});

it.each([undefined, [], ['code']])('applies the configured encryption field set %j to params and data only', async encryptFields => {
  const { api, transport } = fixture();
  await api.fetch({ url: '/fixture', method: 'POST', data: { code: '1', mobile: '2' }, params: { code: '3' },
    commonParams: { code: 'from-common' }, ...(encryptFields ? { encryptFields } : {}) });
  const sent = transport.mock.calls[0]![0];
  expect(new URL(sent.url).searchParams.get('code')).toBe('from-common');
  expect(new URLSearchParams(sent.body).get('code')).toBe(encryptFields?.length === 0 ? '1' : '34');
  expect(new URLSearchParams(sent.body).get('mobile')).toBe(encryptFields ? '2' : '37');
  expect(transport.mock.calls[0]![1]).toBe('fetch');
});

it('preserves header spelling and source query semantics without mutating the caller', async () => {
  const { api, transport } = fixture();
  const config = { url: '/fixture?q=a+b&dup=1&dup=2&eq=a=b#fragment', params: { arr: [1, 2], nullable: null },
    data: { label: '中文 😀' }, header: { 'X-Fixture': 'yes' }, timeout: 0 };
  const before = structuredClone(config);
  await api.fetch(config);
  expect(config).toEqual(before);
  const sent = transport.mock.calls[0]![0];
  expect(sent.url).toContain('q=a%2Bb&dup=2&eq=a&mix_mode=0&arr=1%2C2&nullable=null&fixed_mix_mode=0#fragment');
  expect(sent.timeout).toBe(0);
  expect(sent.headers['X-Fixture']).toBe('yes');
  expect(new URLSearchParams(sent.body).get('label')).toBe('中文 😀');
});

it('retains raw payloads and omits Content-Type for an absent body', async () => {
  const { api, transport } = fixture();
  const data = { code: '1' };
  await api.request({ url: '/fixture', data, header: { 'Content-Type': 'application/custom' } });
  expect(transport.mock.calls[0]![0].body).toBe(data);
  await api.fetch({ url: '/fixture' });
  expect(transport.mock.calls[1]![0].headers).not.toHaveProperty('Content-Type');
});

it.each([
  { body: { error_code: 0 }, pathType: 'sso', success: true },
  { body: { error_code: '0' }, pathType: 'sso', success: false },
  { body: { message: 'error', data: { error_code: 0 } }, pathType: 'passport', success: false },
  { body: { message: 'success', data: { value: 1 } }, pathType: 'passport', success: true },
])('uses source business response projection: %j', async ({ body, pathType, success }) => {
  const { api, transport } = fixture(); transport.mockResolvedValue(response(body));
  const result = api.fetch({ url: '/fixture', pathType });
  if (success) await expect(result).resolves.toEqual(body);
  else await expect(result).rejects.toEqual(body);
});

it('rejects malformed JSON and missing Passport envelopes instead of inventing success', async () => {
  const { api, transport } = fixture();
  transport.mockResolvedValue({ ...response({}), rawText: 'not-json' });
  await expect(api.fetch({ url: '/fixture' })).rejects.toBe('not-json');
  transport.mockResolvedValue(response({ status_code: 0 }));
  await expect(api.fetch({ url: '/fixture' })).rejects.toMatchObject({ data: { status_code: 0 }, status: 200 });
});

it('replays captcha with a new fp and without encrypting fields again, then unwraps once', async () => {
  const { transport } = fixture();
  transport.mockResolvedValueOnce(response({ message: 'error', data: { verify_center_decision_conf: '{"code":"10000"}' } }));
  const verify = jest.fn(async (challenge: VerificationRequestChallenge) => {
    expect(challenge.responseContext.config.data).toBe('mix_mode=1&code=34&fixed_mix_mode=1');
    return challenge.retry('captcha', 'source-wrapper-fp');
  });
  const api = createVerificationRequests({ origin: 'https://imdesktop.douyin.com', transport, verify });
  await expect(api.fetchSec({ url: '/fixture', method: 'POST', data: { code: '1' }, params: { fp: 'old' } })).resolves.toEqual({ message: 'success', data: { fixture: true } });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1]![0].body).toBe(transport.mock.calls[0]![0].body);
  expect(new URL(transport.mock.calls[1]![0].url).searchParams.get('fp')).toBe('source-wrapper-fp');
});

it.each([2046, '2046', 1105])('merges only server SMS key for numeric 2046 (code=%j)', async error_code => {
  const { transport } = fixture();
  transport.mockResolvedValueOnce(response({ message: 'error', data: {
    verify_center_secondary_decision_conf: '{}', error_code, sms_code_key: 'server+key',
  } }));
  const api = createVerificationRequests({ origin: 'https://imdesktop.douyin.com', transport,
    verify: async challenge => challenge.retry('secondary') });
  await api.fetchSec({ url: '/fixture', method: 'POST', data: 'code=ALREADY&obj=%7B%22x%22%3A%201%7D' });
  const body = transport.mock.calls[1]![0].body;
  expect(body).toBe(error_code === 2046
    ? 'code=ALREADY&obj=%7B%22x%22%3A1%7D&sms_code_key=server%2Bkey'
    : 'code=ALREADY&obj=%7B%22x%22%3A%201%7D');
});

it.each([undefined, null, false, 0, ''])('normalizes a falsy secondary retry body without losing form headers (%j)', async data => {
  const { transport } = fixture();
  transport.mockResolvedValueOnce(response({ message: 'error', verify_center_decision_conf: '{}' }));
  const api = createVerificationRequests({ origin: 'https://imdesktop.douyin.com', transport,
    verify: challenge => challenge.retry('secondary') });
  await api.fetchSec({ url: '/fixture', method: 'POST', data });
  const sent = transport.mock.calls[1]![0];
  expect(sent.body).toBeNull();
  expect(sent.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
});

it.each([
  ['flag&empty=&=anonymous&value=a=b', 'flag=undefined&empty=&=anonymous&value=a&sms_code_key=fixture%2Bkey'],
  ['obj=%7B%22a%22%3A1%7D&bad=%7Bbroken%7D&plus=a+b', 'obj=%7B%22a%22%3A1%7D&bad=%7Bbroken%7D&plus=a%2Bb&sms_code_key=fixture%2Bkey'],
])('uses the secondary callback form parser, not the URL query parser (%s)', async (data, expected) => {
  const { transport } = fixture();
  transport.mockResolvedValueOnce(response({ message: 'error', data: {
    error_code: 2046, sms_code_key: 'fixture+key', verify_center_secondary_decision_conf: '{}',
  } }));
  const api = createVerificationRequests({ origin: 'https://imdesktop.douyin.com', transport,
    verify: challenge => challenge.retry('secondary') });
  await api.fetchSec({ url: '/fixture', method: 'POST', data });
  expect(transport.mock.calls[1]![0].body).toBe(expected);
});

it('does not show a challenge for Request.fetch or retry a cancelled fetchSec challenge', async () => {
  const { api, transport, verify } = fixture();
  const body = { message: 'error', verify_center_decision_conf: '{}' };
  transport.mockResolvedValue(response(body));
  await expect(api.fetch({ url: '/fixture' })).rejects.toEqual(body);
  expect(verify).not.toHaveBeenCalled();
  verify.mockImplementation(async challenge => { throw { ...challenge.responseContext, errorHandled: true }; });
  await expect(api.fetchSec({ url: '/fixture' })).rejects.toMatchObject({ errorHandled: true });
  expect(transport).toHaveBeenCalledTimes(2);
});

it('keeps secure initialization per page and uses getCacheInfo before the first request', async () => {
  const { transport } = fixture();
  const initialized = jest.fn();
  const info = { aid: 339757, did: 'fixture-did', iid: 'fixture-iid' };
  const getCacheInfo = jest.fn().mockResolvedValue(info);
  const api = createVerificationRequests({ origin: 'https://imdesktop.douyin.com', transport, initializeVerification: initialized,
    verify: async () => { throw new Error('unexpected'); } });
  await api.fetchSec({ url: '/fixture', getCacheInfo, commonParams: { aid: 1 } });
  await api.fetchSec({ url: '/fixture', getCacheInfo });
  expect(getCacheInfo).toHaveBeenCalledTimes(1);
  expect(initialized).toHaveBeenCalledWith(info);
  expect(initialized.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]!);
});
