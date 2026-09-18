// Offline Desktop fetchOnceActive -> FormData request vs built SDK. No account/native/network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

async function main() {
  const file = process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET/renderer/main/main_4eaa703b51f46c257250.js';
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const modules = new Map();
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ['14486', '89660', '47743', '68137'].includes(node.name.getText(ast))) {
      modules.set(Number(node.name.getText(ast)), node.initializer.getText(ast)); return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(modules.size, 4);
  let response, originalRequest;
  const fail = () => { throw new Error('Unexpected background/report/logging path'); };
  const exportsById = new Map([
    [61604, { c: { post: async (url, body) => { originalRequest = { url, body }; return response; }, get: fail } }],
    [87046, { J: class { call() { fail(); } } }],
    [6501, { gm: { isLogout: false, register: fail } }],
    [5662, { b: { instance: { error: fail } } }],
    [14352, { Im: value => value == null || value.length === 0 }],
  ]);
  function load(id) {
    if (exportsById.has(id)) return exportsById.get(id);
    assert(modules.has(id), `Unexpected dependency ${id}`);
    const exports = {}; exportsById.set(id, exports);
    vm.runInNewContext(`(${modules.get(id)})`, { FormData })({ exports }, exports, load);
    return exports;
  }
  load.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
  };
  const manager = load(47743).J.instance;
  const { ImUserDirectory } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/user-directory.js')).href);
  const sent = [];
  const directory = new ImUserDirectory({ getUserAgent: () => 'fixture-UA', getDeviceId: () => '123', getInstallId: () => '456',
    requestRaw: async (url, init, passport) => {
      sent.push({ url, init, passport });
      return { ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(response) };
    },
  }, 'stale');
  const cases = [
    { data: [], conv_data: [] },
    { status_code: 0, data: [{ sec_user_id: 'sec-one', last_active_time: 0 }, { sec_user_id: 'sec-two', last_active_time: 12345 }],
      conv_data: [{ conv_id: '9007199254740993123', online: 1, toast: [{ lang: 'zh', content: '有人在线' }] }] },
    { data: [{ sec_user_id: 'sec-one' }] },
    { conv_data: [{ conv_id: '0:1:10:20', online: false, toast: [] }] },
  ];
  const secUids = ['sec-one', 'sec-two', 'sec-two'], convIds = ['9007199254740993123', '0:1:10:20'];
  for (response of cases) {
    const received = await new Promise(resolve => manager.fetchOnceActive(secUids, convIds, resolve));
    assert.equal(received, response);
    const result = await directory.getActiveStatus(secUids, convIds);
    assert.equal(result.statusCode, 0);
    assert.deepEqual(result.users, response.data?.map(value => ({ secUid: value.sec_user_id,
      ...(value.last_active_time !== undefined ? { lastActiveTime: value.last_active_time } : {}) })));
    assert.deepEqual(result.conversations, response.conv_data?.map(value => ({ conversationId: value.conv_id,
      ...(value.online !== undefined ? { online: value.online } : {}), ...(value.toast !== undefined ? { toast: value.toast } : {}) })));
    const sdk = sent.at(-1), url = new URL(sdk.url);
    assert.equal(url.origin, 'https://imdesktop.douyin.com'); assert.equal(url.pathname, originalRequest.url);
    assert.deepEqual(Object.fromEntries(sdk.init.body.entries()), Object.fromEntries(originalRequest.body.entries()));
    assert.equal(sdk.init.method, 'POST'); assert.equal(sdk.passport, false);
    assert.equal(new Headers(sdk.init.headers).has('content-type'), false);
    for (const key of ['action', 'new_user_login', 'source', 'sec_user_ids', 'conv_ids']) assert.equal(url.searchParams.has(key), false);
  }
  assert.equal(sent.length, cases.length);
  console.log(`Desktop active status: ${cases.length} original-manager/request/built-SDK contracts passed; no network.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
