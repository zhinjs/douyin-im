// Original Desktop reducer/adapter/JSON worker versus built SDK. No network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

function readSource(file, hash) {
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), hash, `Re-audit changed source: ${file}`);
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function findFactories(ast) {
  const modules = new Map();
  function walk(node) {
    if (ts.isPropertyAssignment(node) && /^\d+$/.test(node.name.getText(ast)) && ts.isArrowFunction(node.initializer)) {
      modules.set(Number(node.name.getText(ast)), node.initializer.getText(ast));
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return modules;
}

function moduleLoader(factories, overrides = new Map()) {
  const cache = new Map();
  function load(id) {
    if (overrides.has(id)) return overrides.get(id);
    if (cache.has(id)) return cache.get(id).exports;
    assert(factories.has(id), `Unexpected original dependency ${id}`);
    const module = { exports: {} };
    cache.set(id, module);
    vm.runInNewContext(`(${factories.get(id)})`, Object.create(null))(module, module.exports, load);
    return module.exports;
  }
  load.g = {};
  load.nmd = module => module;
  load.n = value => { const getter = () => value; getter.a = getter; return getter; };
  load.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { enumerable: true, get });
  };
  return load;
}

function originalReducers(ast, factories, load) {
  const reducers = {};
  function walk(node) {
    if (ts.isPropertyAssignment(node) && ['loadedFavoriteEmojiList', 'addToFavoriteEmojiList'].includes(node.name.getText(ast))) {
      reducers[node.name.getText(ast)] = node.initializer.getText(ast);
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  assert.equal(Object.keys(reducers).length, 2);
  const adapterAst = ts.createSourceFile('original-adapter.js', factories.get(60258), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const adapterFunctions = {};
  function findAdapter(node) {
    if (ts.isFunctionDeclaration(node) && ['R', 'A', 'C'].includes(node.name?.text)) {
      adapterFunctions[node.name.text] = node.getText(adapterAst);
    }
    ts.forEachChild(node, findAdapter);
  }
  findAdapter(adapterAst);
  assert.equal(Object.keys(adapterFunctions).length, 3);
  // Only Immer's action wrapper is replaced: actual unsorted adapter algorithms
  // operate on mutable fixtures. This does not claim full Redux scheduling parity.
  const adapter = vm.runInNewContext(`(() => { ${Object.values(adapterFunctions).join('\n')} return R(item => item.id); })()`, {
    T: fn => (state, payload) => fn(payload, state),
  });
  const imports = { o: { Im: load(62193), $1: load(56170) }, m: adapter };
  return Object.fromEntries(Object.entries(reducers).map(([key, source]) => [key, vm.runInNewContext(`(${source})`, imports)]));
}

const plain = value => JSON.parse(JSON.stringify(value));
function project(state) {
  const value = state.customSticker;
  return plain({ stickers: value.favoriteEmojiList.ids.map(id => value.favoriteEmojiList.entities[id]),
    nextCursor: String(value.next_cusor), hasMore: value.has_more,
    ...(value.sticker_enabled_status === undefined ? {} : { stickerEnabledStatus: value.sticker_enabled_status }) });
}
function initialState() {
  return { customSticker: { sticker_enabled_status: 1, next_cusor: 0, has_more: false,
    favoriteEmojiList: { ids: [], entities: {} } } };
}

async function main() {
  const root = process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET/renderer';
  const ast = readSource(path.join(root, 'main/main_4eaa703b51f46c257250.js'),
    '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
  const workerAst = readSource(path.join(root, 'json-parse-worker/json-parse-worker_144691b8fad08378f36a.js'),
    '1b0ed08cff515ea6cbab5a3bf9bbd758a41f19b62e189e82409a48c829ee338d');
  const factories = findFactories(ast);
  const load = moduleLoader(factories);
  const reducers = originalReducers(ast, factories, load);
  const parseOriginal = moduleLoader(findFactories(workerAst))(21392)({ storeAsString: true });
  const requests = [];
  let originalBody;
  const requestLoad = moduleLoader(factories, new Map([
    [61604, { c: { get: async (url, query) => { requests.push({ url, query }); return originalBody; } } }],
    // Non-pagination imports used only by the unrelated periodic resource loader.
    [14352, {}], [50596, {}], [13129, {}], [5662, {}], [20660, {}], [8069, {}],
  ]));
  const originalFetch = requestLoad(91285).a;
  const { ImEmojiApi, mergeCollectedEmojiPage, addCollectedEmoji } = await import(
    pathToFileURL(path.resolve(__dirname, '../../lib/services/im/emoji.js')).href);
  assert.equal(typeof ImEmojiApi.prototype.getCollected, 'function', 'Build SDK first');
  const sdkRequests = [];
  let rawBody;
  const api = new ImEmojiApi({
    requestRaw: async (url, init, passport) => {
      sdkRequests.push({ url, init, passport });
      return { ok: true, status: 200, headers: new Headers(), data: '', rawText: rawBody };
    }, getInstallId: () => 'iid',
  }, 'did', 'guid');
  const state = initialState();
  let snapshot = project(state);
  let checkpoints = 0;
  async function page(name, body, firstPage, cursor = 0) {
    rawBody = typeof body === 'string' ? body : JSON.stringify(body);
    originalBody = parseOriginal(rawBody);
    const original = await originalFetch(cursor);
    reducers.loadedFavoriteEmojiList(state, { payload: { resp: original.custom_sticker_page_list, firstPage } });
    const sdk = await api.getCollected(String(cursor));
    // Do not gate on sdk.statusCode: Desktop consumes valid nested pages even
    // when the root status is nonzero. Still assert the SDK exposes that status.
    if (sdk.page) snapshot = mergeCollectedEmojiPage(snapshot, sdk.page, firstPage);
    assert.deepEqual(plain(snapshot), project(state), name);
    const status = original.status_code ?? 0;
    assert.equal(sdk.statusCode, status === 200 ? 0 : status, `${name}: status remains visible`);
    const actual = sdkRequests.at(-1), expected = requests.at(-1), url = new URL(actual.url);
    assert.equal(url.pathname, expected.url, name);
    assert.equal(actual.init.method, 'GET');
    assert.equal(actual.init.body, undefined);
    assert.equal(actual.passport, false);
    assert.equal(actual.init.headers.bgint_json_parser, '2');
    for (const [key, value] of Object.entries(expected.query)) assert.equal(url.searchParams.get(key), String(value), `${name}: ${key}`);
    checkpoints++;
    return sdk;
  }
  const response = (resources, extras = {}, status = undefined) => ({
    ...(status === undefined ? {} : { status_code: status }),
    custom_sticker_page_list: { resources, next_cursor: 7, is_completed: false, sticker_enabled_status: 0, ...extras },
  });
  await page('initial reverse', response([{ stickers: [{ id: '2' }, { id: '10' }, { id: 'a' }] }]), true);
  const confirmed = { id: 'new', title: 'confirmed first success item' };
  reducers.addToFavoriteEmojiList(state, { payload: confirmed });
  snapshot = addCollectedEmoji(snapshot, confirmed);
  assert.deepEqual(plain(snapshot), project(state), 'confirmed collect sorts numerical entity keys');
  assert.deepEqual(snapshot.stickers.map(item => item.id), ['new', '2', '10', 'a']);
  checkpoints++;
  reducers.addToFavoriteEmojiList(state, { payload: { id: '2', title: 'must not replace existing' } });
  snapshot = addCollectedEmoji(snapshot, { id: '2', title: 'must not replace existing' });
  assert.deepEqual(plain(snapshot), project(state), 'existing collection unchanged');
  checkpoints++;
  await page('empty resources keeps all state', response([]), true);
  const metadata = await page('empty resource only updates metadata', response([{}], { next_cursor: '9', is_completed: 1 }), true, '0');
  assert.equal(metadata.page.stickers, undefined);
  await page('later empty stickers keeps entities', response([{ stickers: [] }]), false, 9);
  const duplicates = [{ id: 'dup', value: 1 }, { id: 'dup', value: 2 },
    { id: 'number', video_id: 12 }, { id: 'string', video_id: '12' }, { id: 'cross', video_id: '13' }];
  await page('first duplicate last-write and typed forbidden', response([{ stickers: duplicates }], { forbidden_sticker_ids: [12, '12', 13] }), true);
  assert.equal(snapshot.stickers.find(item => item.id === 'dup').value, 1);
  await page('first empty stickers clears', response([{ stickers: [] }]), true);
  await page('later duplicate first-write', response([{ stickers: duplicates }], { forbidden_sticker_ids: [12, '12', 13] }), false, '0');
  assert.equal(snapshot.stickers.find(item => item.id === 'dup').value, 2);
  await page('later existing duplicate retains prior', response([{ stickers: [{ id: 'dup', value: 99 }] }]), false, '7');
  await page('missing stickers in nonempty object clears first page', response([{ marker: true }]), true);
  await page('valid page despite nonzero root status', response([{ stickers: [{ id: 'accepted' }] }], {}, 7), true);
  await page('root status 200 accepted', response([{ stickers: [{ id: 1, value: 'number' }, { id: '1', value: 'string' }] }], {}, 200), true);
  await page('worker large IDs preserve types', '{"custom_sticker_page_list":{"resources":[{"stickers":[{"id":9007199254740993,"video_id":9007199254740993},{"id":"safe","video_id":9007199254740991},{"id":"cross","video_id":"12"},{"id":9007199254740995}]}],"forbidden_sticker_ids":[9007199254740993,9007199254740991,12],"next_cursor":9007199254740997,"is_completed":true}}', true);
  assert.deepEqual(snapshot.stickers.map(item => item.id), ['9007199254740995', 'cross', 'safe']);
  assert.equal(snapshot.nextCursor, '9007199254740997');
  console.log(`Desktop emoji pagination: ${checkpoints} original/built-SDK checkpoints passed (${requests.length} query contracts); no network.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
