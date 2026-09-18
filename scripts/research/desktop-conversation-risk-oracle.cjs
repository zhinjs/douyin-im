// Compare Desktop's actual Kg + lodash consumer with the built SDK. No network or account access.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

function source(root, file, hash) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), hash, `Re-audit changed ${file}`);
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function loader(ast) {
  const factories = new Map();
  function walk(node) {
    if (ts.isPropertyAssignment(node) && /^\d+$/.test(node.name.getText(ast)) && ts.isArrowFunction(node.initializer)) {
      factories.set(Number(node.name.getText(ast)), node.initializer.getText(ast));
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  const cache = new Map();
  function load(id) {
    if (cache.has(id)) return cache.get(id).exports;
    assert(factories.has(id), `Unexpected original dependency ${id}`);
    const module = { exports: {} };
    cache.set(id, module);
    vm.runInNewContext(`(${factories.get(id)})`, Object.create(null))(module, module.exports, load);
    return module.exports;
  }
  load.g = {};
  load.nmd = value => value;
  return load;
}

function outcome(fn) {
  try { return { value: JSON.stringify(fn()) }; }
  catch (error) { return { error: error.name }; }
}

async function main() {
  const root = process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET/renderer';
  const mainAst = source(root, 'main/main_4eaa703b51f46c257250.js',
    '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
  const roomAst = source(root, '320/320_75874aaf00102d177b13.js',
    '701165fcaa4e60bf8017c7125fcc2e6b673e783c3046f3368eb8d6c14fa3ad3d');
  let originalNode;
  const callOffsets = [];
  function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'Kg') originalNode = node;
    if (ts.isCallExpression(node) && node.expression.getText(roomAst) === 'Kg') callOffsets.push(node.getStart(roomAst));
    ts.forEachChild(node, walk);
  }
  walk(roomAst);
  assert(originalNode, 'Missing original Kg');
  assert.equal(originalNode.getStart(roomAst), 379434);
  assert.equal(originalNode.end, 379659);
  assert.deepEqual(callOffsets, [387275, 390663, 391045, 417769]);
  const original = vm.runInNewContext(`(${originalNode.getText(roomAst)})`, Object.create(null));
  const isEmpty = loader(mainAst)(62193);
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/conversation-risk.js')).href);
  const values = [undefined, '', '[]', ' [] ', '{}', 'null', 'false', 'true', '0', '1', '1e400',
    '""', '"risk"', '"😀risk"', '[{}]', '[null,{"risk":1}]', '[false]', '[1]', '[[]]', '[[0]]',
    '["risk"]', '[{}, {"risk":1}]', '[{"list":1}]', '{"single":1}', '{"__proto__":1}', '{'];
  let checks = 0;
  for (const list of values) for (const single of values) {
    const ext = { ...(list !== undefined ? { 'a:sky_eye_dialog_list': list } : {}),
      ...(single !== undefined ? { 'a:sky_eye_dialog': single } : {}) };
    const label = `list=${list} single=${single}`;
    assert.deepEqual(outcome(() => sdk.readDesktopConversationRisk(ext)), outcome(() => original({ ext })), `${label} selection`);
    assert.deepEqual(outcome(() => sdk.hasDesktopConversationRisk(ext)), outcome(() => !isEmpty(original({ ext }))), `${label} gate`);
    checks++;
  }
  assert.equal(sdk.hasDesktopConversationRisk(), !isEmpty(original()));
  console.log(JSON.stringify({ source: 'Desktop 1.2.1 ROOM Kg + original lodash isEmpty', cases: checks + 1,
    directCallSites: callOffsets.length, selectionAndGate: 'PASS', errors: 'compared by class', nativeNetwork: false }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
