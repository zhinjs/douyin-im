// Source-only oracle: original renderer reducer + main bridge, recorded storage/IPC.
// No account state, network, native execution or browser automation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

assert(process.argv[2], 'Usage: node scripts/research/desktop-draft-time-oracle.mjs <extracted-desktop-root>');
function read(path, hash) {
  const bytes = readFileSync(join(process.argv[2], path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `Source changed: ${path}`);
  return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
const renderer = read('renderer/main/main_4eaa703b51f46c257250.js',
  '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
const main = read('index.js', '5103dc3c67df781c04396b7494207804999f793f8fccf815638a52a4a8e42a45');
const editorSource = read('renderer/320/320_75874aaf00102d177b13.js',
  '701165fcaa4e60bf8017c7125fcc2e6b673e783c3046f3368eb8d6c14fa3ad3d');
function collect(file, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(file); return found;
}
const modules = new Map(collect(renderer, node => ts.isPropertyAssignment(node)
  && ts.isNumericLiteral(node.name) && ts.isFunctionLike(node.initializer))
  .map(node => [Number(node.name.text), node.initializer.getText(renderer)]));
const reducerNodes = collect(renderer, node => ts.isPropertyAssignment(node)
  && node.name.getText(renderer) === 'updateConversationDraftTime');
assert.equal(reducerNodes.length, 1);
const bridgeNodes = collect(main, node => ts.isMethodDeclaration(node) && node.name.getText(main) === 'updateConvDraftTime');
assert.equal(bridgeNodes.length, 1);
assert(main.text.includes('(t[(e[35] = "updateConvDraftTime")] = 35)'), 'Pinned native call enum changed');

const realm = createContext({});
const moduleCache = new Map();
function load(id) {
  if (moduleCache.has(id)) return moduleCache.get(id).exports;
  assert(modules.has(id), `Missing original utility module ${id}`);
  const module = { exports: {} }; moduleCache.set(id, module);
  runInContext(`(${modules.get(id)})`, realm, { timeout: 1000 })(module, module.exports, load);
  return module.exports;
}
load.g = realm;
load.nmd = module => { module.paths = []; module.children ??= []; return module; };
const trace = [];
const protocol = [];
realm.Vo = () => ({ fromNumber: value => { protocol.push(['fromNumber', value]); return { fixtureLong: value }; } });
realm.Yo = value => value;
realm.Wo = { UpdateConvDraftTimeReq: { create: value => value }, ImSDKCallType: { updateConvDraftTime: 35 } };
const bridge = runInContext(`({${bridgeNodes[0].getText(main)}})`, realm, { timeout: 1000 });
bridge.callSdk = (...args) => { protocol.push(args); return new Promise(() => {}); };
realm.a = { Im: load(62193) }; // Original lodash isEmpty, not an assumed null-only guard.
realm.m = { e: class { constructor(name) { trace.push(['monitor', name]); } endMonitor() { trace.push(['end']); } } };
realm.v = {
  QL: (state, id) => state.conversations[id],
  tV: (_state, entity, patch) => { trace.push(['patch', patch.id, patch.changes.sortOrder]); Object.assign(entity, patch.changes); },
};
realm.window = { api: { im: { updateConvDraftTime: (...args) => {
  trace.push(['bridge', ...args]); return bridge.updateConvDraftTime(...args);
} } } };
const reducer = runInContext(`(${reducerNodes[0].initializer.getText(renderer)})`, realm, { timeout: 1000 });
let count = 0;
for (const entity of [undefined, null, {}, { sortOrder: 100, conversation: {} },
  { sortOrder: 500000000000100, conversation: { settingInfo: { stickOnTop: true } } }]) {
  for (const time of [0, 50, 200, 500000000000001]) {
    trace.length = 0; protocol.length = 0;
    const input = structuredClone(entity);
    const state = { conversations: { fixture: input } };
    const result = reducer(state, { payload: { cId: 'fixture', time } });
    assert.equal(result, undefined); // Bridge is fire-and-forget; unresolved IPC does not block.
    if (!entity || !Object.keys(entity).length) {
      assert.equal(trace.length, 1); assert.equal(protocol.length, 0);
    } else {
      const expected = Math.max(entity.sortOrder, time + (entity.conversation.settingInfo?.stickOnTop ? 5e14 : 0));
      assert.equal(input.sortOrder, expected);
      assert.deepEqual(trace.slice(1), [['patch', 'fixture', expected], ['bridge', 'fixture', time], ['end']]);
      assert.equal(protocol[0][1], time); // Milliseconds forwarded, never divided by 1000.
      assert.equal(protocol[1][0], 35); // Internal native call type, not an HTTP command.
      assert.equal(protocol[1][1].updateConvDraftTimeReq.convId, 'fixture');
      assert.equal(protocol[1][1].updateConvDraftTimeReq.timestamp.fixtureLong, time);
      assert.equal(protocol[1][2], -1);
      assert.equal(input.conversation.lastMessageTime, undefined); // Not a native state simulation.
    }
    count++;
  }
}
console.log(`Original Desktop draft reducer/main bridge: ${count} cases passed.`);
const callers = collect(editorSource, node => ts.isArrowFunction(node) && node.getText(editorSource).includes('(0,$h.PQ)'))
  .sort((left, right) => left.getWidth(editorSource) - right.getWidth(editorSource));
assert(callers[0]?.getText(editorSource).includes('f((0,a.b_)'));
let editorCases = 0;
for (const fixture of [
  { editor: false, text: 'new', old: undefined, expected: [] },
  { editor: true, text: '', old: 'old', expected: ['delete'] },
  { editor: true, text: '', old: undefined, expected: ['delete'] },
  { editor: true, text: 'same', old: 'same', expected: ['get'] },
  { editor: true, text: 'new', old: 'old', expected: ['get', 'save', 'dispatch'] },
  { editor: true, text: '   ', old: undefined, expected: ['get', 'save', 'dispatch'] },
]) {
  const actions = [], deltas = [{ insert: fixture.text }];
  const editor = { getContent: () => ({ deltas }) };
  const environment = createContext({
    b: { current: fixture.editor ? { getEditor: () => editor } : null },
    ih: (current, id) => { assert.equal(current, editor); assert.equal(id, 'fixture'); return { text: fixture.text }; },
    i: { Im: load(62193) },
    $h: {
      AB: id => { assert.equal(id, 'fixture'); actions.push(['delete']); },
      CF: id => { assert.equal(id, 'fixture'); actions.push(['get']); return fixture.old === undefined ? undefined : { text: fixture.old }; },
      PQ: draft => actions.push(['save', JSON.parse(JSON.stringify(draft))]),
    },
    a: { b_: value => value }, f: value => actions.push(['dispatch', JSON.parse(JSON.stringify(value))]),
    Date: { now: () => 1234567890123 },
  });
  const changed = runInContext(`(${callers[0].getText(editorSource)})`, environment, { timeout: 1000 });
  changed('fixture');
  assert.deepEqual(actions.map(([name]) => name), fixture.expected);
  if (fixture.expected.includes('save')) {
    assert.deepEqual(actions[1][1], { cId: 'fixture', text: fixture.text, time: 1234567890123, editorContent: deltas });
    assert.deepEqual(actions[2][1], { cId: 'fixture', time: 1234567890123 });
  }
  editorCases++;
}
console.log(`Original Desktop editor draft trigger: ${editorCases} cases passed (empty/same text does not update time).`);
console.log('No native execution or SDK parity claim: native timestamp limit, cell sort, unread/FTS and persistence are separate.');
