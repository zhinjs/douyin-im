// Hash-pinned first-party request/mapper versus the built SDK. No HTTP or account data.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

async function main() {
  const file = path.join(process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET', 'renderer/main/main_4eaa703b51f46c257250.js');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67', 'Re-audit changed Desktop source');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function find(predicate) {
    const found = [];
    function walk(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, walk); }
    walk(ast); assert.equal(found.length, 1, 'Expected exactly one source node'); return found[0];
  }
  const routes = find(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === '14486');
  const routeExports = {};
  const requireRoute = () => { throw new Error('Unexpected source dependency'); };
  requireRoute.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
  };
  vm.runInNewContext(`(${routes.initializer.getText(ast)})`, Object.create(null))({}, routeExports, requireRoute);
  const requestNode = find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'se'
    && node.body?.getText(ast).includes('fetchSkyLightInfo error'));
  const mapperNode = find(node => ts.isFunctionExpression(node)
    && node.body.getText(ast).includes('const r = await de(e),')
    && node.body.getText(ast).includes('lastActiveTime: e.active_time'));
  let response;
  const originalCalls = [], sdkCalls = [];
  const originalRequest = vm.runInNewContext(`(${requestNode.getText(ast)})`, {
    ie: routeExports, oe: { c: { get: async (url, query) => { originalCalls.push({ url, query }); return response; } } },
    J: { b: { instance: { error() { throw new Error('Unexpected source request error'); } } } },
  });
  const originalMapper = vm.runInNewContext(`(${mapperNode.getText(ast)})`, {
    de: originalRequest, le: { NORMAL: 0 }, M: { yT: () => 'display-placeholder' },
    ae: { lg() { throw new Error('No activity-store merge during explicit query'); } },
  });
  const { ImFriendApi } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/friends.js')).href);
  const api = new ImFriendApi({ getUserAgent: () => 'fixture-UA', getDeviceId: () => '123', getInstallId: () => '456',
    requestRaw: async (url, init, passport) => {
      sdkCalls.push({ url: new URL(url), init, passport });
      return { ok: true, status: 200, headers: new Headers(), data: '', rawText: JSON.stringify(response) };
    } });
  const cases = [
    { friends: [
      { name: 'first', sec_uid: 'repeat', url: 'https://image.invalid/a', active_time: -1 },
      { name: 'second', sec_uid: 'sec2', active_time: 123 },
      { name: 'duplicate', sec_uid: 'repeat', active_time: 0 },
      { name: 'unknown-type', conversation_id: '9007199254740993' },
    ] },
    { friends: [] }, {}, { friends: null }, { friends: [{}] },
    { friends: [{ name: '', sec_uid: '', url: '', active_time: 0 }] },
  ];
  for (const body of cases) {
    response = body;
    const original = await originalMapper(false, {}, () => { throw new Error('Unexpected activity dispatch'); });
    const result = await api.getRecommendedContacts();
    const expected = Array.from(original, item => Object.fromEntries(Object.entries({
      name: item.name, avatar: item.avatarUrl, secUid: item.secUid, lastActiveTime: item.lastActiveTime,
    }).filter(([, value]) => value !== undefined)));
    // conversation_id is retained as a raw optional ID, not as the original UI's
    // secUid/random fallback key and never as an inferred Group identity.
    (body.friends || []).forEach((item, index) => {
      if (item.conversation_id != null) expected[index].conversationId = item.conversation_id;
    });
    assert.deepEqual(result, { statusCode: 0, statusMsg: '', contacts: expected });
    const request = sdkCalls.at(-1), source = originalCalls.at(-1);
    assert.equal(request.url.origin, 'https://imdesktop.douyin.com');
    assert.equal(request.url.pathname, source.url); assert.equal(request.init.method, 'GET');
    assert.deepEqual(Object.keys(source.query), ['source']);
    assert.equal(request.url.searchParams.get('source'), source.query.source);
    assert.equal(request.url.searchParams.get('device_id'), '123'); assert.equal(request.url.searchParams.get('iid'), '456');
    assert.equal(new Headers(request.init.headers).has('bgint_json_parser'), false);
    assert.equal(request.init.body, undefined); assert.equal(request.passport, false);
  }
  assert.equal(originalCalls.length, cases.length); assert.equal(sdkCalls.length, cases.length);
  console.log(`Desktop recommended contacts: ${cases.length} original request/mapper vs built SDK cases passed; no network.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
