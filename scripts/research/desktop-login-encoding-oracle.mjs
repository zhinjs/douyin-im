// Offline differential check of the pinned Desktop password-login encoder.
// No account files/native modules/network. Build the SDK before running.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { mixModeEncode, mixModeEncodeMobile, normalizePassportMobile } from '../../lib/passport/mixMode.js';
import { encodeActionVerificationPack } from '../../lib/desktop/second-verify.js';
import { createVerificationRequests } from '../../lib/sdk/auth/verification-request.js';
import { encodeAccountSdkSourceInfo, encodeBrowserInfo } from '../../lib/passport/accountSdkSourceInfo.js';

const root = process.argv[2];
assert(root, 'Pass the extracted Desktop 1.2.1 directory');
function source(path, hash) {
  const bytes = readFileSync(join(root, path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
const login = source('renderer/login/login_ae39b1e613d53592b6df.js', '0579ce4fbaa0ecc0206910814ea5c795ffadb9bc6b42376e411b69e3951b2737');
const c321 = source('renderer/321/321_32eb617b8bb29d30a181.js', '5948467b5caf5e7a5d99ae65eff814d6a5c1961e293d763a1c2253a102e97919');
const c955 = source('renderer/955/955_28fe0c6f9275a89ab79d.js', 'f91ceceb60de0eb144e5ef60f907efe480e946b8cb0199e5eade4d92a6ce0197');
function unique(source, predicate) {
  const matches = [];
  function visit(node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
  visit(source); assert.equal(matches.length, 1);
  return matches[0];
}
const module = unique(login, node => ts.isPropertyAssignment(node) && node.name.getText(login) === '83848');
const helpers = {}, loader = () => ({});
loader.d = (target, values) => {
  for (const [key, get] of Object.entries(values)) Object.defineProperty(target, key, { get });
};
runInNewContext(`(${module.initializer.getText(login)})({},target,loader)`, { target: helpers, loader });
const pwd = unique(c321, node => ts.isBinaryExpression(node) && node.left.getText(c321) === 'this.pwdLogin'
  && node.right.getText(c321).includes('K.PWD_LOGIN'));
const secondary = unique(c955, node => ts.isVariableDeclaration(node) && node.name.getText(c955) === 'st');
const secondaryEncode = runInNewContext(`(${secondary.initializer.getText(c955)})`);
const sourceInfo = unique(c321, node => ts.isVariableDeclaration(node) && node.name.getText(c321) === 'a'
  && node.initializer?.getText(c321).includes('n.push((5 ^ e[r]).toString(16))'));
const sourceInfoEncode = runInNewContext(`(${sourceInfo.initializer.getText(c321)})`);
const vectors = [
  ['+86 13800000000', '2e3d332534363d3535353535353535'],
  ['123456', '343736313033'], ['24', '3731'], ['A中é', '44e1bda8c6ac'],
  ['a😀b', '6467'], ['\ud800A\udfff', '44'], ['\u0001😀1', '434'], ['\u0005', '0'], ['', ''],
];
for (const [plain, expected] of vectors) {
  let captured;
  await runInNewContext(`(${pwd.right.getText(c321)})({account:'+86 13800000000',password:plain});`, {
    plain, Vu: helpers, mf: Object.assign, K: { PWD_LOGIN: '/passport/web/user/login/' },
    e: { request(config) { captured = config; return Promise.resolve({}); } },
  });
  assert.equal(captured.url, '/passport/web/user/login/');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.data.password, expected, 'Original pwdLogin -> module83848.MF');
  assert.equal(helpers.w(plain), expected);
  assert.equal(secondaryEncode(plain), expected, 'Original C955 uses the same field encoder');
  assert.equal(sourceInfoEncode(plain), expected, 'Original C321 browserInfo encoder');
  assert.equal(encodeAccountSdkSourceInfo(plain), expected, 'Built account_sdk_source_info encoder');
  assert.equal(mixModeEncode(plain), expected, 'Built SDK normal login encoder');
  assert.equal(new URLSearchParams(encodeActionVerificationPack({ password: plain }, 'fixture-did', 'fixture-iid')).get('password'), expected);
  let verificationBody;
  const requests = createVerificationRequests({ origin: 'https://example.invalid',
    transport: async request => {
      verificationBody = request.body;
      return { rawText: '{"message":"success"}', status: 200, statusText: 'fixture', headers: {} };
    }, verify: async () => { throw new Error('Unexpected fixture challenge'); },
  });
  await requests.fetch({ url: '/fixture', method: 'POST', data: { password: plain } });
  assert.equal(new URLSearchParams(verificationBody).get('password'), expected, 'Manual page request pipeline');
}
// Exhaust every individual UTF-16 code unit, including both surrogate ranges.
// This is codec differential evidence, not proof that a server accepts such passwords.
const allCodeUnits = Array.from({ length: 65536 }, (_, index) => String.fromCharCode(index)).join('');
assert.equal(mixModeEncode(allCodeUnits), helpers.w(allCodeUnits));
assert.equal(secondaryEncode(allCodeUnits), helpers.w(allCodeUnits));
assert.equal(sourceInfoEncode(allCodeUnits), helpers.w(allCodeUnits));
assert.equal(encodeAccountSdkSourceInfo(allCodeUnits), sourceInfoEncode(allCodeUnits));
const browserInfos = [{}, { name: 'ASCII profile' }, { name: '抖音聊天', path: '/用户/登录' },
  { permission: 'é', label: '😀', isolated: '\ud800', control: '\u0001', nested: { '中文': '值' } }];
for (const info of browserInfos) {
  // C321 request interceptor serializes the collected object before invoking a().
  assert.equal(encodeBrowserInfo(info), sourceInfoEncode(JSON.stringify(info)));
}
console.log(`Desktop browserInfo encoding: ${browserInfos.length} JSON payloads and all UTF-16 code units matched the original C321 encoder.`);
console.log(`Desktop login encoding oracle: ${vectors.length} original pwdLogin/helper/C955 and built SDK vectors plus all 65536 UTF-16 code units passed; no account or network used.`);

// Execute the actual phone assembly expressions and request wrappers, not a
// country-code lookup or an assumed E.164 split. Inputs have explicit boundaries.
const smsPhone = unique(login, node => ts.isFunctionExpression(node)
  && node.body.getText(login).trim() === '{\n                  return "".concat(l, " ").concat(se);\n                }');
const passwordPhone = unique(login, node => ts.isFunctionExpression(node)
  && node.body.getText(login).trim() === '{\n                  return "".concat(l, " ").concat(F);\n                }');
const voicePhone = unique(login, node => ts.isPropertyAssignment(node) && node.name.getText(login) === 'mobile'
  && node.initializer.getText(login).includes('.concat(a, " ")') && node.initializer.getText(login).includes('s.replace'));
let phoneChecks = 0;
for (const [country, local] of [['+86', '13800000000'], ['+63', '9000000000'], ['+1', '2020000000'], ['+852', '50000000']]) {
  const mobile = `${country} ${local}`;
  const assembled = {
    sms: runInNewContext(`(${smsPhone.getText(login)})()`, { l: country, se: local }),
    password: runInNewContext(`(${passwordPhone.getText(login)})()`, { l: country, F: local }),
    voice: runInNewContext(`(${voicePhone.initializer.getText(login)})`, { a: country, s: local }),
  };
  for (const [name, kind, path, field] of [
    ['sendCodeRequest', 'sms', '/passport/web/send_code/', 'mobile'],
    ['sendVoiceCodeRequest', 'voice', '/passport/web/send_voice_code/', 'mobile'],
    ['smsLoginRequest', 'sms', '/passport/web/sms_login/', 'mobile'],
    ['userLoginRequest', 'password', '/passport/web/user/login/', 'account'],
  ]) {
    assert.equal(assembled[kind], mobile);
    const wrapper = unique(login, node => ts.isBinaryExpression(node) && node.left.getText(login) === `this.${name}`);
    let captured;
    await runInNewContext(`(${wrapper.right.getText(login)})({mobile,password:'fixture',code:'123456'});`, {
      mobile: assembled[kind], gi: helpers, bi: Object.assign,
      Ei: { offline: { sendCode: path, sendCodeLogin: path, accountPwdLogin: path } },
      t: { scope: 'offline', next: 'https://www.douyin.com', commonRequest(config) { captured = config; return Promise.resolve({}); } },
    });
    assert.equal(captured.url, path);
    assert.equal(captured.data[field], helpers.w(mobile));
    assert.equal(normalizePassportMobile(mobile), mobile);
    assert.equal(mixModeEncodeMobile(mobile), captured.data[field], `${country}/${name}`);
    phoneChecks++;
  }
}
console.log(`Desktop phone assembly and original request wrappers: ${phoneChecks} cases passed; no account or network used.`);
