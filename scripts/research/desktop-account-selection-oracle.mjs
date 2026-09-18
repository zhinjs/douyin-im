// Fixed first-party account-selection UI logic, without mounting React or logging in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = process.argv[2]; assert(root, 'Pass the extracted Desktop 1.2.1 directory');
const bytes = readFileSync(join(root, 'renderer/login/login_ae39b1e613d53592b6df.js'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '0579ce4fbaa0ecc0206910814ea5c795ffadb9bc6b42376e411b69e3951b2737');
const source = ts.createSourceFile('login.js', bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const submits = [], registers = [];
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'onLogin'
    && node.initializer.getText(source).includes('employeeNotActive')) submits.push(node.initializer.getText(source));
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'N'
    && node.initializer?.getText(source).includes('is_bind_login_mobile')) registers.push(node.initializer.getText(source));
  ts.forEachChild(node, visit);
}
visit(source); assert.equal(submits.length, 1); assert.equal(registers.length, 1);
let count = 0;
for (const password of [true, false]) for (const [type, active, permitted] of [
  [6, undefined, false], [6, null, false], [6, 0, false], [6, '', false], [6, false, false],
  [6, true, true], [6, 1, true], ['6', false, true], [undefined, undefined, true],
]) {
  const requests = [], notices = [];
  const candidate = { sec_uid: 'fixture-selected', passport_enterprise_user_type: type, business_account_active: active };
  const request = input => { requests.push(input); return Promise.resolve({}); };
  runInNewContext(`(${submits[0]})(false,candidate)`, {
    candidate, C: false, x() {}, o: 'fixture-key', S: password, k: '+86 13800000000',
    l: 'fixture-password', s: '123456', m: {}, He: Object.assign, Ue() {},
    u: { userLoginRequest: request, smsLoginRequest: request }, c() {}, f: { current: '' },
    _: {}, v: {}, P: notice => notices.push(notice),
  });
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(requests.length, permitted ? 1 : 0);
  assert.equal(notices.length, permitted ? 0 : 1);
  if (permitted) {
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), {
      multiAccount: true,
      extra_params: { ignore_reused_mobile: 1, sms_code_key: 'fixture-key', sms_code_key_not_mix: 1, sec_uid: 'fixture-selected' },
      mobile: '+86 13800000000', ...(password ? { password: 'fixture-password' } : { code: '123456' }),
    });
  }
  count++;
}
for (const flag of [true, false, 1, 0, 'main', null]) {
  const show = runInNewContext(registers[0], {
    r: { useMemo: callback => callback() }, m: {}, n: [{ is_bind_login_mobile: flag }], w: 'LOGIN_ACCOUNT_PWD',
  });
  assert.equal(show, !flag); count++;
}
console.log(`Desktop account selection oracle: ${count} original-source vectors passed, no account/UI/network used.`);
