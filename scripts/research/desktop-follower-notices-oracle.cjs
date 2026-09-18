// Offline: execute hash-pinned Desktop functions against synthetic pages, then compare
// the built SDK. No account files, login, native module, network or real read marking.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

async function main() {
  const root = process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET';
  function source(file, hash) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(createHash('sha256').update(text).digest('hex'), hash, `Re-audit changed source: ${file}`);
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  }
  function find(ast, match) {
    const found = [];
    function walk(node) { if (match(node)) found.push(node); ts.forEachChild(node, walk); }
    walk(ast); assert.equal(found.length, 1, 'Expected exactly one original source node'); return found[0];
  }
  const renderer = source('renderer/main/main_4eaa703b51f46c257250.js', '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
  const service = source('renderer/320/320_75874aaf00102d177b13.js', '701165fcaa4e60bf8017c7125fcc2e6b673e783c3046f3368eb8d6c14fa3ad3d');
  const ui = source('renderer/184/184_1e858cac92da7469ccaf.js', 'f6ae4001556e9b74e51128308065b97887485a12198fd91e0dbd9eaf1f296722');
  const routes = find(renderer, node => ts.isPropertyAssignment(node) && node.name.getText(renderer) === '14486');
  const routeExports = {};
  const requireRoute = () => { throw new Error('Unexpected route dependency'); };
  requireRoute.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
  };
  vm.runInNewContext(`(${routes.initializer.getText(renderer)})`, Object.create(null))({}, routeExports, requireRoute);
  const head = find(renderer, node => ts.isPropertyAssignment(node) && node.name.getText(renderer) === '912');
  const headModule = { exports: undefined };
  vm.runInNewContext(`(${head.initializer.getText(renderer)})`, Object.create(null))(headModule);
  const request = find(service, node => ts.isFunctionDeclaration(node) && node.name?.text === 'v'
    && node.body?.getText(service).includes('notice_list_v2'));
  const call = find(ui, node => ts.isCallExpression(node) && node.expression.getText(ui) === '(0,se.on)');
  const then = call.parent.parent;
  assert(ts.isCallExpression(then) && then.expression.getText(ui).endsWith('.then'));
  let consumed;
  const consume = vm.runInNewContext(`(${then.arguments[0].getText(ui)})`, {
    ve: { xp() {} }, Er: 'fixture', te() {}, Lr: { NewFriendGroup: 0 }, v(value) { consumed = value; },
  });
  let pages, originalIndex, sdkIndex;
  const originalRequests = [], sdkRequests = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const original = vm.runInNewContext(`(${request.getText(service)})`, {
    _: routeExports, m: { $1: headModule.exports },
    N: { c: { get: async (url, query) => {
      assert(originalIndex < pages.length, 'Desktop read unexpected extra page');
      originalRequests.push({ url, query: clone(query) }); return clone(pages[originalIndex++]);
    } } },
  });
  const { ImFriendApi } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/friends.js')).href);
  const { Account } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/sdk/account.js')).href);
  const api = new ImFriendApi({
    getUserAgent: () => 'fixture-UA', getDeviceId: () => '123', getInstallId: () => '456',
    requestRaw: async (url, init, passport) => {
      assert(sdkIndex < pages.length, 'SDK read unexpected extra page'); sdkRequests.push({ url, init, passport });
      return { ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(pages[sdkIndex++]) };
    },
  });
  // Only supplies account lifecycle state; real Account lifecycle transitions are
  // covered separately in account.test.ts, not simulated by this source oracle.
  const host = { online: true, loginGeneration: 1, ensureOnline() {}, im: { readFollowerNoticePage: (...args) => api.readFollowerNoticePage(...args) } };
  const item = (uid, name = 'first', avatars = ['https://image.invalid/one', 'https://image.invalid/two']) => ({
    create_time: 0, has_read: 0, follow: { content: '', from_user: { uid, sec_uid: `sec-${uid}`, nickname: name,
      remark_name: '', follow_status: 4, follower_status: 1, avatar_300x300: { url_list: avatars, uri: 'avatar-uri' } } },
  });
  const page = (rows, more = 0, max = 10, min = 1) => ({ notice_list_v2: rows, has_more: more, max_time: max, min_time: min });
  const cases = [
    [page([])],
    [page([item('22'), item('33', '', [])])],
    [page([item('22')], '1', '9007199254740993', 0), page([item('22', 'later'), item('33')])],
    Array.from({ length: 8 }, (_, n) => page(Array.from({ length: 20 }, (_, i) => item(String(i + 1))), 1, n + 1)),
    Array.from({ length: 7 }, (_, n) => page(Array.from({ length: 20 }, (_, i) => item(String(n * 20 + i + 1))), n < 6 ? 1 : 0, n + 1)),
  ];
  for (pages of cases) {
    originalIndex = 0; sdkIndex = 0; originalRequests.length = 0; sdkRequests.length = 0;
    consume(await original());
    const result = await Account.prototype.readFollowerNotices.call(host);
    assert.equal(result.statusCode, 0);
    const expected = consumed.map(row => ({ uid: row.uid, secUid: row.secUserID, nickname: row.nickname,
      remark: row.remark_name, avatar: row.avatar, avatarUri: row.uri, createTime: row.create_time,
      hasRead: row.hasRead, followStatus: row.follow_status, followerStatus: row.follower_status, content: row.content }));
    assert.deepEqual(clone(result.notices), clone(expected));
    assert.equal(result.truncated, pages[originalIndex - 1].has_more == 1);
    assert.equal(sdkIndex, originalIndex);
    for (let i = 0; i < sdkRequests.length; i++) {
      const sent = sdkRequests[i], originalRequest = originalRequests[i], url = new URL(sent.url);
      assert.equal(url.origin, 'https://imdesktop.douyin.com'); assert.equal(url.pathname, originalRequest.url);
      assert.equal(sent.init.method, 'GET'); assert.equal(sent.init.body, undefined); assert.equal(sent.passport, false);
      assert.equal(new Headers(sent.init.headers).has('bgint_json_parser'), false);
      for (const [key, value] of Object.entries(originalRequest.query)) assert.equal(url.searchParams.get(key), String(value));
    }
  }
  console.log(`Desktop follower notices: ${cases.length} original-request/consumer/built-SDK contracts passed; no network.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
