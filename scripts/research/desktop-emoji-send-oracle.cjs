// Extract Desktop's actual favorite-sticker builder; compare built SDK without network.
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
function factories(ast) {
  const result = new Map();
  function visit(node) {
    if (ts.isPropertyAssignment(node) && /^\d+$/.test(node.name.getText(ast)) && ts.isArrowFunction(node.initializer)) {
      result.set(Number(node.name.getText(ast)), node.initializer.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
function loader(modules) {
  const cache = new Map();
  function load(id) {
    if (cache.has(id)) return cache.get(id).exports;
    assert(modules.has(id), `Unexpected original dependency ${id}`);
    const module = { exports: {} };
    cache.set(id, module);
    vm.runInNewContext(`(${modules.get(id)})`, Object.create(null))(module, module.exports, load);
    return module.exports;
  }
  load.g = {};
  load.nmd = value => value;
  load.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { enumerable: true, get });
  };
  load.n = value => { const get = () => value; get.a = get; return get; };
  return load;
}
async function main() {
  const root = process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET/renderer';
  const mainAst = source(root, 'main/main_4eaa703b51f46c257250.js',
    '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
  const roomAst = source(root, '320/320_75874aaf00102d177b13.js',
    '701165fcaa4e60bf8017c7125fcc2e6b673e783c3046f3368eb8d6c14fa3ad3d');
  const workerAst = source(root, 'json-parse-worker/json-parse-worker_144691b8fad08378f36a.js',
    '1b0ed08cff515ea6cbab5a3bf9bbd758a41f19b62e189e82409a48c829ee338d');
  const load = loader(factories(mainAst));
  let callback;
  function visit(node) {
    if (ts.isFunctionExpression(node) && node.getStart(roomAst) === 327350 && node.end === 327790) callback = node;
    ts.forEachChild(node, visit);
  }
  visit(roomAst);
  assert(callback, 'Missing favoriteEmoji callback: re-audit source');
  const original = vm.runInNewContext(`(${callback.getText(roomAst)})`, {
    i: { Im: load(62193) }, Bt: load(20784),
  });
  const parse = loader(factories(workerAst))(21392)({ storeAsString: true });
  const { buildCollectedStickerContent, isCollectedStickerEnabled } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/content.js')).href);
  assert.equal(typeof buildCollectedStickerContent, 'function', 'Build SDK before running oracle');
  const examples = [
    ['minimum', { id: 1 }],
    ['all-fields', { id: 12, width: 88, height: 77, animate_type: 'webp', origin_package_id: 19,
      animate_url: { uri: 'tos/animated', url_list: ['https://example.invalid/a.webp'] } }],
    ['static-only', { id: '3', static_url: { uri: 'tos/static', url_list: ['https://example.invalid/s.png'] } }],
    ['empty-values-do-not-fallback', { id: '4', width: 0, height: 0, animate_type: '', origin_package_id: '',
      animate_url: { uri: '', url_list: [] }, static_url: { uri: 'fallback', url_list: ['fallback'] } }],
    ['independent-uri-fallback', { id: '5', animate_url: { uri: null, url_list: ['animated'] },
      static_url: { uri: 'static', url_list: ['static'] } }],
    ['independent-list-fallback', { id: '6', animate_url: { uri: 'animated' },
      static_url: { uri: 'static', url_list: ['static'] } }],
    ['missing-url-fields', { id: '7', animate_url: {}, static_url: {} }],
    ['explicit-null', { id: '8', width: null, height: null, animate_type: null, origin_package_id: null,
      animate_url: null, static_url: { uri: null, url_list: null } }],
    ['missing-package', { id: '9', width: 1 }],
    ['preserve-types', { id: '12', origin_package_id: 0, animate_type: 2, width: '9', height: false }],
    ['unrelated-fields-ignored', { id: '8', display_name: 'not copied', resource_type: 99, aweType: 507,
      msgHint: 'not copied', extra: { secret: 'not copied' } }],
    ['worker-safe-ids', parse('{"id":9007199254740991,"origin_package_id":5}')],
    ['worker-large-ids', parse('{"id":9007199254740993123,"origin_package_id":9007199254740993999}')],
    ['quoted-large-ids', parse('{"id":"9007199254740993123","origin_package_id":"9007199254740993999"}')],
  ];
  for (const [name, input] of examples) {
    const emitted = [];
    original(value => emitted.push(value), input);
    assert.equal(emitted.length, 1, `${name}: original should emit one message`);
    assert.equal(buildCollectedStickerContent(input), emitted[0], `${name}: exact serialized content differs`);
    const content = JSON.parse(emitted[0]);
    assert.equal(content.aweType, 501);
    assert.equal(content.msgHint, '');
  }
  // SDK deliberately requires a lossless platform ID. Desktop's renderer only
  // rejects empty records; do not mislabel these extra SDK guards as equivalence.
  for (const input of [{ width: 1 }, { id: null }, { id: '' }, { id: 9007199254740992 }]) {
    assert.throws(() => buildCollectedStickerContent(input), /lossless platform ID/);
  }
  let selector;
  function findSelector(node) {
    if (ts.isArrowFunction(node) && node.getText(mainAst) === '(e) => e.emoji.customSticker.sticker_enabled_status == f.Default') selector = node;
    ts.forEachChild(node, findSelector);
  }
  findSelector(mainAst);
  assert(selector, 'Missing original group sticker selector');
  const allowed = vm.runInNewContext(`(${selector.getText(mainAst)})`, { f: { Default: 0 } });
  const enabledCases = [undefined, null, 0, 1, -1, false, true, '', '0', ' 0 ', '1', 'no', NaN];
  for (const value of enabledCases) {
    assert.equal(isCollectedStickerEnabled(value), allowed({ emoji: { customSticker: { sticker_enabled_status: value } } }),
      `Group selector mismatch for ${String(value)}`);
  }
  // UI guard belongs to the caller, not the content serializer. Verify it separately.
  for (const input of [null, undefined, {}]) {
    let calls = 0;
    original(() => calls++, input);
    assert.equal(calls, 0);
  }
  original(undefined, { id: 1 });
  assert.equal(load(30128).G.BIG_EMOJI, 5);
  assert.equal(load(20784).Ou.AWEME_INTERACTIVE_EMOJI, 507);
  console.log(JSON.stringify({ source: 'Desktop 1.2.1 favoriteEmoji callback', cases: examples.length,
    originalGuardCases: 4, sdkExtraIdGuards: 4, enabledScalarCases: enabledCases.length,
    exactSerializedContent: 'PASS', nativeNetwork: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
