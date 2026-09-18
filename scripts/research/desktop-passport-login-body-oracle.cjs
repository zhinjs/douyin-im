// Installed login wrapper and mix-mode helpers; no AccountSDK, HTTP, or account state.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/desktop-passport-login-body-oracle.cjs /path/to/339.js');
const source = readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),
  '1a76ee048863873ac07a015c4e3816d63bb6e2ce168f236ae804cc55363db712', 'Re-audit changed source first');
const modules = {};
const context = vm.createContext({ global: { webpackChunkawemeim: {
  push(chunk) { Object.assign(modules, chunk[1]); },
} } });
vm.runInContext(source, context, { timeout: 1000 });
function requirePolyfill(id) {
  // These side-effect imports only install platform polyfills, provided by Node here.
  assert([63009, 69956].includes(id), `Unexpected dependency ${id}`);
  return {};
}
requirePolyfill.d = (target, getters) => {
  for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
};
const helpers = {};
modules[83848]({}, helpers, requirePolyfill);
const start = source.indexOf('yl=function(e){var n=this;this.loadApiSDK=');
const end = source.indexOf(',xl=t(14744)', start);
assert(start > 0 && end > start);
const requests = [];
Object.assign(context, {
  pl: helpers, hl: { DH: () => { throw new Error('No portrait generation in body oracle'); } },
  bl: Object.assign,
  // Endpoint values below are not under test: request/body construction is.
  wl: { web: { getQrcode: 'get_qrcode', checkQrconnect: 'check_qrconnect', sendCode: 'send_code',
    sendCodeLogin: 'sms_login', accountPwdLogin: 'user/login' } },
});
vm.runInContext(`var ${source.slice(start, end)}; globalThis.LoginWrapper=yl;`, context, { timeout: 1000 });
const wrapper = new context.LoginWrapper({ aid: 339757, next: 'https://www.douyin.com',
  request: { webInterfaceSdkRequest: { request(input) { requests.push(input); return Promise.resolve(input); } } },
});
let passed = 0;
function pass(label) { console.log('PASS', label); passed++; }
// El's undefined filtering is checked separately in desktop-passport-request-oracle.cjs.
function form(data) { return helpers.qD(Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))); }
const mobile = '+86 13800000000';
(async () => {
  const qr = await wrapper.checkQrconnectRequest({ next: 'https://www.douyin.com', token: 'fixture', is_frontier: true });
  assert.equal(qr.method, 'POST');
  assert.equal(form(qr.data), 'need_logo=false&need_short_url=false&is_frontier=true&token=fixture&is_new_login=1&next=https%3A%2F%2Fwww.douyin.com');
  pass('QR polling wrapper body preserves construction order');
  const send = await wrapper.sendCodeRequest({ mobile });
  assert.equal(form(send.data), 'is6Digits=1&mix_mode=1&mobile=2e3d332534363d3535353535353535&type=3731&fixed_mix_mode=1');
  assert.equal(send.data.verify_ticket, undefined);
  pass('SMS body keeps mix-mode order and omits undefined verify_ticket');
  const voice = await wrapper.sendVoiceCodeRequest({ mobile });
  assert.equal(form(voice.data), form(send.data));
  assert.equal(voice.data.sec_user_id, undefined);
  pass('voice-code initial body is same order, with absent sec_user_id');
  const sms = await wrapper.smsLoginRequest({ mobile, code: '123456', loginOnly: true });
  assert.equal(form(sms.data), 'service=https%3A%2F%2Fwww.douyin.com&mix_mode=1&mobile=2e3d332534363d3535353535353535&code=343736313033&fixed_mix_mode=1&login_only=true');
  assert.equal(sms.data.safe_mobile_register_to_login, undefined);
  pass('initial SMS login has no multi-account flag when Desktop omits config');
  const pwd = await wrapper.userLoginRequest({ mobile, password: 'Password1' });
  assert.equal(form(pwd.data), 'need_check_base_info=true&service=https%3A%2F%2Fwww.douyin.com&account_type=0&mix_mode=1&account=2e3d332534363d3535353535353535&password=55647676726a776134&fixed_mix_mode=1');
  assert.equal(pwd.data.safe_mobile_register_to_login, undefined);
  pass('initial password login has no multi-account flag and preserves body order');
  const extra = { ignore_reused_mobile: 1, sms_code_key: 'selection', sms_code_key_not_mix: 1, sec_uid: 'fixture-sec' };
  for (const method of ['smsLoginRequest', 'userLoginRequest']) {
    const selected = await wrapper[method]({ mobile, code: '123456', password: 'Password1', loginOnly: true, multiAccount: true, extra_params: extra });
    assert.equal(selected.data.safe_mobile_register_to_login, true);
    const wire = form(selected.data);
    assert(wire.startsWith('safe_mobile_register_to_login=true&'));
    assert(wire.includes('&ignore_reused_mobile=1&sms_code_key=selection&sms_code_key_not_mix=1&sec_uid=fixture-sec'));
    assert.equal(selected.data.sms_code_key, 'selection');
  }
  pass('explicit selected-account continuation sets flag and appends unencoded selection key');
  const again = await wrapper.smsLoginRequest({ mobile, code: '123456', loginOnly: true, multiAccount: true,
    extra_params: { ...extra, register_new_user: 1 } });
  assert(form(again.data).endsWith('&register_new_user=1&login_only=true'));
  pass('SMS login_only is appended after extra_params');
  for (const request of requests) {
    assert.equal(request.params.aid, 339757);
    assert.equal(request.params.is_from_iesaccountsaas, 1);
    assert.equal(request.params.is_vcd, undefined);
  }
  pass('Desktop commonRequest injects aid and IES flag without VCD');
  console.log(`${passed} original wrapper groups passed; no network or account state accessed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
