// Offline pinned main-process response hooks. No Electron, native runtime or network.
// The BDTicket collaborator records arguments; its own crypto/state is not tested here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

assert(process.argv[2], 'Pass the extracted Desktop 1.2.1 directory');
const bytes = readFileSync(join(process.argv[2], 'index.js'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),
  '5103dc3c67df781c04396b7494207804999f793f8fccf815638a52a4a8e42a45');
const source = ts.createSourceFile('index.js', bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const matches = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'oa'
    && node.initializer?.getText(source).includes('t.webRequest.onBeforeSendHeaders')) matches.push(node.initializer);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(matches.length, 1, 'Select the unique installed defaultSession hook installer');
let cases = 0;
for (const enabled of [false, true]) for (const responseHeaders of [
  { 'x-ms-token': ['header-only'] },
  { 'x-ms-token': ['header-token'], 'set-cookie': ['msToken=cookie-token; Path=/'] },
  { 'x-ms-token': ['header-token'], 'set-cookie': ['sessionid=fixture-session; Path=/'] },
  { 'x-ms-token': [''] },
]) {
  const registered = {}, calls = [], requestState = new Map();
  const sent = { headers: {}, sessionID: '', sessionSS: '', associated: {} };
  requestState.set(1, sent);
  const context = {
    e: { session: { defaultSession: { webRequest: {
      onBeforeSendHeaders(fn) { registered.before = fn; },
      onHeadersReceived(fn) { registered.headers = fn; },
      onCompleted(filter, fn) {
        assert.equal(filter.urls.length, 1); assert.equal(filter.urls[0], '<all_urls>');
        registered.completed = fn;
      },
    } } } },
    $s: enabled, na: requestState, URL,
    Ks: () => ({ handleResponse(...args) { calls.push(args); } }),
  };
  runInNewContext(`(${matches[0].getText(source)})()`, context, { timeout: 1000 });
  const before = structuredClone(responseHeaders);
  let accepted;
  registered.headers({ responseHeaders }, value => { accepted = value; });
  assert.equal(accepted.responseHeaders, responseHeaders, 'Original callback passes through the same header object');
  registered.completed({ id: 1, url: 'https://imdesktop.douyin.com/passport/web/user/login/', responseHeaders });
  assert.deepEqual(responseHeaders, before, 'No synthetic msToken Set-Cookie added');
  assert.equal(calls.length, enabled ? 1 : 0);
  if (enabled) {
    assert.equal(calls[0][2], responseHeaders, 'Guard receives original headers, not a Cookie conversion');
    assert.equal(calls[0][3], responseHeaders['set-cookie']?.[0].startsWith('sessionid=') ? 'fixture-session' : '');
    assert.equal(requestState.has(1), false);
  }
  cases++;
}
console.log(`Desktop response token hooks: ${cases} original-source cases passed; no network or account state; BDTicket mocked.`);
