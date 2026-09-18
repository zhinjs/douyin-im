// First-party search request and UI pagination/consumer vs built SDK. Offline only.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

async function main() {
  const root = process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET';
  function read(file, hash) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(createHash('sha256').update(text).digest('hex'), hash, `Re-audit ${file}`);
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  }
  function find(ast, predicate, count = 1) {
    const nodes = [];
    function visit(node) { if (predicate(node)) nodes.push(node); ts.forEachChild(node, visit); }
    visit(ast); assert.equal(nodes.length, count, 'Unexpected number of source consumers'); return nodes;
  }
  const r = read('renderer/main/main_4eaa703b51f46c257250.js', '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
  const s = read('renderer/320/320_75874aaf00102d177b13.js', '701165fcaa4e60bf8017c7125fcc2e6b673e783c3046f3368eb8d6c14fa3ad3d');
  const u = read('renderer/184/184_1e858cac92da7469ccaf.js', 'f6ae4001556e9b74e51128308065b97887485a12198fd91e0dbd9eaf1f296722');
  const [routes] = find(r, n => ts.isPropertyAssignment(n) && n.name.getText(r) === '14486');
  const exports = {};
  const requireRoute = () => { throw new Error('Unexpected dependency'); };
  requireRoute.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
  };
  vm.runInNewContext(`(${routes.initializer.getText(r)})`, Object.create(null))({}, exports, requireRoute);
  const [client] = find(s, n => ts.isVariableDeclaration(n) && n.name.getText(s) === 'y'
    && n.initializer?.getText(s) === 'new N.v({baseURL:"https://www.douyin.com"})');
  const [request] = find(s, n => ts.isFunctionDeclaration(n) && n.name?.text === 'w'
    && n.body?.getText(s) === '{return await y.get(_.OU,e)}');
  const calls = find(u, n => ts.isCallExpression(n) && n.expression.getText(u) === '(0,se.Qx)', 2);
  const [size] = find(u, n => ts.isVariableDeclaration(n) && n.name.getText(u) === 'ye' && n.initializer?.getText(u) === '30');
  const [advance] = find(u, n => ts.isBinaryExpression(n) && n.getText(u) === 'e.cursor.current=e.cursor.current+ye');
  let response, sourceRequest;
  const originalClient = vm.runInNewContext(`(${client.initializer.getText(s)})`, {
    N: { v: class {
      constructor(options) { this.origin = options.baseURL; }
      async get(endpoint, query) { sourceRequest = { origin: this.origin, endpoint, query }; return response; }
    } },
  });
  const originalRequest = vm.runInNewContext(`(${request.getText(s)})`, { y: originalClient, _: exports });
  const { ImUserDirectory } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/user-directory.js')).href);
  const sent = [];
  const directory = new ImUserDirectory({ getUserAgent: () => 'fixture-UA', getDeviceId: () => '123', getInstallId: () => '456',
    requestRaw: async (url, init, passport) => {
      sent.push({ url, init, passport });
      return { ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(response) };
    },
  }, 'stale');
  const keyword = '  凉菜 +?#🌱  ';
  const user = { uid: '9007199254740993123', sec_uid: 'sec-fixture', nickname: '凉菜', unique_id: 'handle' };
  const cases = [
    { cursor: 0, more: 1, users: [user] }, { cursor: 30, more: 1, users: [user, user] },
    { cursor: 60, more: 0, users: [] }, { cursor: 0, more: 0, users: [] },
    { cursor: 0, more: 1, users: [user], mismatch: true },
  ];
  for (const item of cases) {
    response = { status_code: 0, input_keyword: item.mismatch ? 'other' : keyword, has_more: item.more,
      cursor: 987, user_list: item.users.map(user_info => ({ user_info })) };
    let displayed, hasMore;
    const state = { tempKey: { current: keyword }, cursor: { current: item.cursor ? item.cursor - 30 : 0 },
      setIsLoadling: () => {}, setSearchFriendList: value => { displayed = typeof value === 'function' ? value([]) : value; },
      setHasMore: value => { hasMore = value; },
    };
    const context = vm.createContext({ e: state, r: keyword, ye: Number(size.initializer.getText(u)), s: () => {}, E: { Im: value => !value } });
    if (item.cursor) vm.runInContext(advance.getText(u), context);
    const call = calls[item.cursor ? 1 : 0];
    const params = vm.runInContext(`(${call.arguments[0].getText(u)})`, context);
    const then = call.parent.parent;
    assert(ts.isCallExpression(then) && then.expression.getText(u).endsWith('.then'));
    const consume = vm.runInContext(`(${then.arguments[0].getText(u)})`, context);
    consume(await originalRequest(params));
    const result = await directory.searchUsers(keyword, item.cursor);
    if (item.mismatch) { assert.equal(displayed, undefined); assert.equal(result.statusCode, -3); }
    else {
      assert.equal(result.statusCode, 0); assert.equal(result.hasMore, hasMore);
      assert.equal(result.nextCursor, hasMore ? state.cursor.current + Number(size.initializer.getText(u)) : undefined);
      assert.deepEqual(result.users.map(user => [user.uid, user.secUid, user.nickname, user.uniqueId]),
        displayed.map(({ user_info: user }) => [user.uid, user.sec_uid, user.nickname, user.unique_id]));
    }
    const sdk = sent.at(-1), url = new URL(sdk.url);
    assert.equal(url.origin, sourceRequest.origin); assert.equal(url.pathname, sourceRequest.endpoint);
    for (const [key, value] of Object.entries(sourceRequest.query)) assert.equal(url.searchParams.get(key), String(value));
    assert.equal(sdk.init.method, 'GET'); assert.equal(sdk.init.body, undefined); assert.equal(sdk.passport, false);
  }
  assert.equal(sent.length, cases.length);
  console.log(`Desktop user search: ${cases.length} original-request/UI/built-SDK contracts passed; no network.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
