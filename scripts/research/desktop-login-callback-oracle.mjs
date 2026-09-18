// Execute only the installed AccountSDK callback/FP wrapper in a synthetic VM.
// No native addon, account files, browser, or network. Requires the pinned source snapshot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = process.argv[2];
assert(root, 'Pass the extracted Desktop 1.2.1 directory');
const bytes = readFileSync(join(root, 'renderer/321/321_32eb617b8bb29d30a181.js'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '5948467b5caf5e7a5d99ae65eff814d6a5c1961e293d763a1c2253a102e97919');
const source = ts.createSourceFile('desktop.js', bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const pluginNames = new Set(['Zu', 'tl', 'el', 'nl', 'rl']);
const names = new Set(['$u', 'Wu', 'Ku', 'zu', 'Uu', 'Hu', 'Ba', 'ka', 'Yu', 'Ju', 'Qu', 'Xu', ...pluginNames]);
const expressions = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(source))) {
    const name = node.name.getText(source);
    assert(!expressions.has(name), `Ambiguous source declaration: ${name}`);
    assert(node.initializer); expressions.set(name, node.initializer.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source); assert.equal(expressions.size, names.size);
const declarations = entries => entries.map(([name, expression]) => `let ${name} = ${expression};`).join('\n');
const extracted = declarations([...expressions].filter(([name]) => !pluginNames.has(name)));
const pluginExtracted = declarations([...expressions].filter(([name]) => pluginNames.has(name)));
const loginBytes = readFileSync(join(root, 'renderer/login/login_ae39b1e613d53592b6df.js'));
assert.equal(createHash('sha256').update(loginBytes).digest('hex'), '0579ce4fbaa0ecc0206910814ea5c795ffadb9bc6b42376e411b69e3951b2737');
const loginSource = ts.createSourceFile('login.js', loginBytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const helperModules = [];
function visitHelpers(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(loginSource) === '83848') helperModules.push(node.initializer.getText(loginSource));
  ts.forEachChild(node, visitHelpers);
}
visitHelpers(loginSource); assert.equal(helperModules.length, 1);
const helpers = {};
const loader = () => ({});
loader.d = (target, exports) => {
  for (const [key, get] of Object.entries(exports)) Object.defineProperty(target, key, { get });
};
runInNewContext(`(${helperModules[0]})({},target,loader)`, { target: helpers, loader });
// Execute the real rejection plugin too: the callback alone cannot establish
// which response is allowed to contribute a secondary form patch.
const selectionCases = [
  [2046, 'key+/=', { sms_code_key: 'key+/=' }],
  ['2046', 'key+/=', undefined],
  [1105, 'key+/=', undefined],
  [2046, '', undefined],
  [2046, 0, undefined],
  [2046, false, undefined],
  [2046, null, undefined],
  [2046, undefined, undefined],
];
for (const [error_code, sms_code_key, expected] of selectionCases) {
  let shown;
  const decision = '{"verify_from":"verify_center"}';
  const input = { error_code, sms_code_key, verify_center_secondary_decision_conf: decision,
    originConfig: { params: {}, data: 'service=https%3A%2F%2Fexample.invalid' } };
  function Base(initProps) { this.initProps = initProps; this.request = {}; }
  await runInNewContext(`${pluginExtracted}\nnew rl({}).processPlugin(input);`, {
    input, P: { A: Base }, Vu: helpers,
    $u: { init() {}, show(value) { shown = value; return Promise.resolve({}); } },
  });
  assert.equal(shown.verifyData, decision);
  assert.equal(shown.requestConfig, input.originConfig);
  assert.deepEqual(shown.requestData && JSON.parse(JSON.stringify(shown.requestData)), expected);
}
// rl selects truthy server decisions, not a fabricated captcha from error_code.
const decisionCases = [
  { error_code: 1105 },
  { error_code: '1105' },
  { error_code: 9001, captcha: 'fixture-not-a-decision' },
  { error_code: 1105, verify_center_decision_conf: '' },
  { error_code: 1105, verify_center_decision_conf: false },
  { error_code: 1105, verify_center_decision_conf: 0 },
  ...[false, 0, ''].map(primary => ({ error_code: 2046,
    verify_center_decision_conf: primary,
    verify_center_secondary_decision_conf: '{"code":20000}',
  })),
];
for (const fields of decisionCases) {
  let shown, rejection;
  const input = { ...fields, originConfig: { params: {}, data: '' } };
  function Base(initProps) { this.initProps = initProps; this.request = {}; }
  await runInNewContext(`${pluginExtracted}\nnew rl({}).processPlugin(input);`, {
    input, P: { A: Base }, Vu: helpers,
    $u: { init() {}, show(value) { shown = value; return Promise.resolve({}); } },
  }).catch(error => { rejection = error; });
  if (fields.verify_center_secondary_decision_conf) {
    assert.equal(shown.verifyData, fields.verify_center_secondary_decision_conf);
    assert.equal(rejection, undefined);
  } else {
    assert.equal(shown, undefined);
    assert.equal(rejection, input, 'Missing decision preserves the original rejection');
  }
}
for (const kind of ['captcha-initial', 'captcha-cookie', 'captcha-storage', 'secondary', 'secondary-encoded']) {
  const secondary = kind.startsWith('secondary');
  let rendered;
  const requests = [];
  const params = { sign: 'keep-sign', qs: 'keep-qs', ts: 'keep-ts' };
  const data = kind === 'secondary-encoded' ? 'token=a%2Bb%2Fc%3D&next=https%3A%2F%2Fexample.invalid%2F&extra=%7B%22x%22%3A1%7D' : 'token=keep-token';
  const expectedFp = kind === 'captcha-initial' ? 'initial-fp' : kind === 'captcha-cookie' ? 'cookie-fp' : 'storage-fp';
  const realm = { Promise, Ea: Promise, it: Object.assign, Sa: 's_v_web_id',
    Ia: { get: () => kind === 'captcha-cookie' ? expectedFp : '' },
    localStorage: { getItem: () => 'storage-fp' },
    qu: options => { rendered = options; },
    Fu: async request => { requests.push(request); return { message: 'success' }; },
    Vu: helpers,
    initial: kind === 'captcha-initial' ? expectedFp : '',
    input: { requestConfig: { params, data }, verifyData: '{"code":20000}',
      ...(secondary ? { requestData: { sms_code_key: 'key+/=' } } : {}) },
  };
  const pending = runInNewContext(`${extracted}\nlet Cu = new Ba({captchaOptions:{fp:initial}}); $u.show(input);`, realm);
  assert.equal(rendered.secondVerifyWebOptions.scene, '4');
  if (secondary) await rendered.secondVerifyWebOptions.callBack({ fp: 'ignored', status: false });
  else await rendered.captchaOptions.successCb({ fp: 'ignored' });
  assert.equal((await pending).message, 'success'); assert.equal(requests.length, 1);
  const request = JSON.parse(JSON.stringify(requests[0]));
  assert.deepEqual(request.params, { ...params, isResend: true,
    ...(secondary ? {} : { fp: expectedFp, verifyFp: expectedFp }) });
  assert.equal(request.data, kind === 'secondary-encoded'
    ? 'token=a%252Bb%252Fc%253D&next=https%253A%252F%252Fexample.invalid%252F&extra=%257B%2522x%2522%253A1%257D&sms_code_key=key%2B%2F%3D'
    : secondary ? 'token=keep-token&sms_code_key=key%2B%2F%3D' : data);
}
// The login entry's own initialization must be used, not C950's follow config.
const methods = [];
function visitLogin(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(loginSource) === 'getAccountConfig') methods.push(node.getText(loginSource));
  ts.forEachChild(node, visitLogin);
}
visitLogin(loginSource); assert.equal(methods.length, 1);
for (const [did, iid] of [['10002', '10003'], ['0', '0']]) {
  // Constants checked against installed module48797; the device is synthetic.
  const input = runInNewContext(`({${methods[0]},getSafeDid:()=>did}).getAccountConfig()`, {
    did, r: { Pv: { aid: 339757, service: 'https://imdesktop.douyin.com' }, C3: '抖音聊天', n5: false, g1: false, hl: '1.2.1' },
    o: { A: { instance: () => ({ installId: iid }) } }, i: { S: { fp: () => `verify_${did}` } },
  });
  const initialized = runInNewContext(`${extracted}\nlet Fu, captured; function Nu(options){captured=new Ba(options).get();} $u.init(input); captured;`,
    { input, it: Object.assign });
  assert.deepEqual(JSON.parse(JSON.stringify(initialized)), {
    commonOptions: { repoId: 579047, aid: 339757, iid, did },
    captchaOptions: { sideSlide: 'disabled', lang: 'zh', showMode: 'mask', region: 'cn', app_name: '抖音聊天',
      host: '', fp: `verify_${did}`, baseEM: 70, h5_check_version: '4.0.12' },
  });
}
console.log('Desktop login oracle: 8 patch-selection, 9 decision-selection, 5 callback/serialization and 2 initialization cases passed. No account or network used.');
