// Fixed-source RemarkEditor vs built SDK. Synthetic responses only; no platform or account state.
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
  function find(ast, predicate) {
    const found = [];
    function walk(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, walk); }
    walk(ast);
    assert.equal(found.length, 1, 'Expected exactly one source node');
    return found[0];
  }
  const renderer = source('renderer/main/main_4eaa703b51f46c257250.js', '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
  const ui = source('renderer/950/950_cfaed590525544ccfae4.js', '8a028616904c1a2a3e0b1a1d3b0b744beac65476afd624add01ee5c46f08528c');
  const routes = find(renderer, node => ts.isPropertyAssignment(node) && node.name.getText(renderer) === '14486');
  const routeExports = {};
  const requireRoute = () => { throw new Error('Unexpected route dependency'); };
  requireRoute.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
  };
  vm.runInNewContext(`(${routes.initializer.getText(renderer)})`, Object.create(null))({}, routeExports, requireRoute);
  const transport = find(renderer, node => ts.isFunctionDeclaration(node) && node.name?.text === '_'
    && node.body?.getText(renderer).includes('i.append("remark_name", n)'));
  const call = find(ui, node => ts.isCallExpression(node) && node.expression.getText(ui) === '(0,le.VJ)');
  const then = call.parent.parent;
  assert(ts.isCallExpression(then) && then.expression.getText(ui).endsWith('.then'));
  const normalization = find(ui, node => ts.isVariableDeclaration(node) && node.name.getText(ui) === 'n'
    && node.initializer?.getText(ui) === '/^\\s*$/.test(b)?"":b');
  let response;
  const originalRequests = [], sent = [];
  const originalRequest = vm.runInNewContext(`(${transport.getText(renderer)})`, {
    FormData, s: routeExports,
    r: { c: { post: async (url, body) => { originalRequests.push({ url, body }); return response; } } },
  });
  const { ImFriendApi } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/friends.js')).href);
  const api = new ImFriendApi({ getUserAgent: () => 'fixture-UA', requestRaw: async (url, init) => {
    sent.push({ url, init });
    return { ok: true, status: 200, headers: new Headers(), rawText: JSON.stringify(response), data: '' };
  } });
  const cases = [
    ['new', { status_code: 0, remark_name: 'new' }],
    ['new', { status_code: 200, remark_name: 'new' }],
    ['new', { status_code: '0', remark_name: 'new' }],
    ['new', { status_code: '200', remark_name: 'new' }],
    ['', { status_code: 0, remark_name: '' }],
    [' \t\n', { status_code: 0, remark_name: '' }],
    ['\u3000', { status_code: 0, remark_name: '' }],
    ['  new  ', { status_code: 0, remark_name: '  new  ' }],
    ['new', { status_code: 0, remark_name: 'other' }],
    ['new', { status_code: 0 }],
    ['new', { status_code: 8, remark_name: 'new' }],
    ['new', { remark_name: 'new' }],
  ];
  for (const [remark, body] of cases) {
    response = body;
    const normalized = vm.runInNewContext(normalization.initializer.getText(ui), { b: remark });
    const updates = [];
    const consume = vm.runInNewContext(`(${then.arguments[0].getText(ui)})`, {
      n: normalized, e: '22', ie: 'fixture',
      re: { b: { instance: { error() {} } } }, j: { A: { info() {} } },
      v: payload => updates.push(payload), r: { ob: payload => payload },
    });
    consume(await originalRequest('22', 'fixture-sec', normalized));
    const result = await api.setRemark({ uid: '22', secUid: 'fixture-sec', remark });
    const original = originalRequests.at(-1), sdk = sent.at(-1), url = new URL(sdk.url);
    assert.equal(url.origin, 'https://imdesktop.douyin.com');
    assert.equal(url.pathname, original.url); assert.equal(sdk.init.method, 'POST');
    assert.deepEqual(Object.fromEntries(sdk.init.body.entries()), Object.fromEntries(original.body.entries()));
    assert.equal(result.statusCode === 0, updates.length === 1);
    assert.equal(Object.hasOwn(result, 'remark'), updates.length === 1);
    if (updates.length) assert.equal(result.remark, updates[0][0].remarkName);
  }
  assert.equal(sent.length, cases.length);
  console.log(`Desktop remark: ${cases.length} original request/editor vs built SDK contracts passed; no network.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
