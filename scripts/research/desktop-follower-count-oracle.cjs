// Offline source-consumer vs built SDK contract. Does not load account state or native code.
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
    walk(ast);
    assert.equal(found.length, 1, 'Expected exactly one source consumer');
    return found[0];
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
  const request = find(service, node => ts.isFunctionDeclaration(node) && node.name?.text === 'S'
    && node.body?.getText(service) === '{return await N.c.get(_.E$,e)}');
  const call = find(ui, node => ts.isCallExpression(node) && node.expression.getText(ui) === '(0,se.ce)');
  const then = call.parent.parent;
  assert(ts.isCallExpression(then) && then.expression.getText(ui).endsWith('.then'));
  const params = vm.runInNewContext(`(${call.arguments[0].getText(ui)})`, Object.create(null));
  let response;
  const originalRequests = [];
  const originalRequest = vm.runInNewContext(`(${request.getText(service)})`, {
    _: routeExports,
    N: { c: { get: async (url, query) => { originalRequests.push({ url, query }); return response; } } },
  });
  const updates = [];
  const consume = vm.runInNewContext(`(${then.arguments[0].getText(ui)})`, {
    e: value => updates.push(value), Je: { Vp: value => value },
    // This oracle uses only absent/array notice_count fixtures, not arbitrary lodash inputs.
    E: { Im: value => value == null || value.length === 0 },
  });
  const { ImFriendApi } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/friends.js')).href);
  const sent = [];
  const api = new ImFriendApi({
    getUserAgent: () => 'fixture-UA', getDeviceId: () => '123', getInstallId: () => '456',
    requestRaw: async (url, init, passport) => {
      sent.push({ url, init, passport });
      return { ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(response), data: '' };
    },
  }, 'stale', 'fixture-guid');
  const cases = [
    { notice_count: [{ group: 401, count: 0 }] },
    { status_code: 0, notice_count: [{ group: 400, count: 90 }, { group: 401, count: 7 }] },
    { notice_count: [{ group: '401', count: 3 }, { group: 401, count: 99 }] },
    { notice_count: [] },
    { notice_count: [{ group: 400, count: 7 }] },
  ];
  for (response of cases) {
    updates.length = 0;
    consume(await originalRequest(params));
    const result = await api.getNewFollowerCount();
    assert.equal(result.statusCode, 0);
    assert.equal(result.count, updates[0]?.count);
    assert.equal(Object.hasOwn(result, 'count'), updates.length !== 0);
    const sourceRequest = originalRequests.at(-1), sdk = sent.at(-1), url = new URL(sdk.url);
    assert.equal(url.origin, 'https://imdesktop.douyin.com');
    assert.equal(url.pathname, sourceRequest.url);
    assert.equal(sdk.init.method, 'GET');
    assert.equal(sdk.init.body, undefined);
    assert.equal(sdk.passport, false);
    for (const [key, value] of Object.entries(sourceRequest.query)) assert.equal(url.searchParams.get(key), String(value));
    for (const key of ['is_mark_read', 'notice_group', 'max_time', 'min_time']) assert.equal(url.searchParams.has(key), false);
  }
  assert.equal(sent.length, cases.length);
  assert.equal(originalRequests.length, cases.length);
  console.log(`Desktop follower count: ${cases.length} original-consumer/built-SDK contracts passed; no network.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
