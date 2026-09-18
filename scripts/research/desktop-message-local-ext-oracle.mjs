// Original main-process bridge only. No network, native module, account data or browser automation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

assert(process.argv[2], 'Usage: node scripts/research/desktop-message-local-ext-oracle.mjs <extracted-desktop-root>');
const bytes = readFileSync(join(process.argv[2], 'index.js'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '5103dc3c67df781c04396b7494207804999f793f8fccf815638a52a4a8e42a45');
const source = ts.createSourceFile('index.js', bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const methods = [];
function visit(node) {
  if (ts.isMethodDeclaration(node) && ['modifyMessageLocalExt', 'batchModifyMessageLocalExt'].includes(node.name.getText(source))) methods.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(methods.length, 2);
const calls = [];
const result = { recorded: true };
const realm = createContext({
  // Only valid string IDs used below. This fixture does not claim arbitrary-type vo parity.
  vo: value => value === '', Uo: { debug() {}, warn() {} }, Bi: 'fixture', Yo: value => value,
  Wo: { ModifyMsgLoaclExtReq: { create: value => value }, BatchModifyMsgLoaclExtReq: { create: value => value },
    ImSDKCallType: { modifyMessageLocalExt: 33, batchModifyMessageLocalExt: 34 } },
});
const bridge = runInContext(`({${methods.map(node => node.getText(source)).join(',')}})`, realm, { timeout: 1000 });
bridge.callSdk = (...args) => { calls.push(JSON.parse(JSON.stringify(args))); return result; };
let count = 0;
for (const [convId, clientId] of [['', 'client'], ['conv', ''], ['', '']]) {
  calls.length = 0;
  assert.equal(await bridge.modifyMessageLocalExt(convId, clientId, { key: 'value' }), undefined);
  assert.equal(calls.length, 0); count++;
}
for (const ext of [{}, { key: 'value', empty: '' }, { 'a:comment_detail': '{"text":"fixture"}' }]) {
  calls.length = 0;
  assert.equal(await bridge.modifyMessageLocalExt('conv', 'client', ext), result);
  assert.deepEqual(calls, [[33, { modifyMsgLoaclExtReq: { convId: 'conv', clientId: 'client', ext } }]]);
  count++;
}
for (const batch of [[], [{ convId: 'conv', clientdId: 'client', ext: { key: '' } }],
  [{ convId: 'one', clientdId: 'a', ext: {} }, { convId: 'two', clientdId: 'b', ext: { key: 'value' } }]]) {
  calls.length = 0;
  assert.equal(bridge.batchModifyMessageLocalExt(batch), undefined);
  assert.deepEqual(calls, [[34, { batchModifyMsgLoaclExtReq: { batchExt: batch.map(item => ({
    convId: item.convId, clientId: item.clientdId, ext: item.ext,
  })) } }, -1]]);
  count++;
}
console.log(`Original Desktop message-local-ext main bridge: ${count} cases passed.`);
console.log('Recorded protobuf construction only: native map merge, storage, callbacks and SDK parity require separate evidence.');
