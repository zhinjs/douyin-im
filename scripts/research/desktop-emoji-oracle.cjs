// Offline Desktop module vs built SDK request contract. No browser or real network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

async function main() {
  const sourcePath = process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET/renderer/main/main_4eaa703b51f46c257250.js';
  const source = fs.readFileSync(sourcePath, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  assert.equal(hash, '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67', 'Unexpected Desktop source; re-audit before running');
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const modules = new Map();
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ['7688', '14486'].includes(node.name.getText(ast))) {
      modules.set(Number(node.name.getText(ast)), node.initializer.getText(ast));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(modules.size, 2);
  const originalRequests = [];
  const response = { status_code: 0, android_emoji_resource: { resource_url: 'https://example.invalid/emoji.zip', md5: 'version' },
    success_items: [{ id: '9007199254740993123' }] };
  const exportsById = new Map([[61604, { c: {
    get: async (url, query) => { originalRequests.push({ method: 'GET', url, query }); return response; },
    post: async (url, body, query) => { originalRequests.push({ method: 'POST', url, body, query }); return response; },
  } }]]);
  function load(id) {
    if (exportsById.has(id)) return exportsById.get(id);
    assert(modules.has(id), `Unexpected dependency ${id}`);
    const exports = {};
    exportsById.set(id, exports);
    const factory = vm.runInNewContext(`(${modules.get(id)})`, Object.create(null));
    factory({ exports }, exports, load);
    return exports;
  }
  load.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { enumerable: true, get });
  };
  const original = load(7688);
  const { ImEmojiApi } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/emoji.js')).href);
  const sdkRequests = [];
  const api = new ImEmojiApi({
    requestRaw: async (url, init, passport) => {
      sdkRequests.push({ url, init, passport });
      return { ok: true, status: 200, headers: new Headers(), data: '', rawText: JSON.stringify(response) };
    },
    getInstallId: () => 'iid',
  }, 'did', 'guid');
  assert.equal(await original._q(), response);
  await api.getResources();
  const cases = [
    { imageId: '9007199254740993123', stickerUri: '', stickerUrl: '', resourceId: '0', stickerType: 0 },
    { imageId: '0', stickerUri: 'uri', stickerUrl: 'https://example.invalid/a?x=1&y=2', stickerType: 1 },
    { imageId: '10', resourceId: '0', stickerType: 3 },
    { stickerUri: 'uri', stickerUrl: '', stickerType: 1 },
  ];
  for (const value of cases) {
    const query = { action: 1, sticker_ids: `[${value.imageId ?? ''}]`, sticker_uri: value.stickerUri,
      sticker_url: value.stickerUrl, resource_id: value.resourceId, sticker_type: value.stickerType };
    assert.equal(await original.rN(query), response);
    assert.equal(originalRequests.at(-1).query, query);
    await api.collect(value);
  }
  assert.equal(originalRequests.length, sdkRequests.length);
  for (let i = 0; i < originalRequests.length; i++) {
    const source = originalRequests[i], sdk = sdkRequests[i], url = new URL(sdk.url);
    assert.equal(source.url, url.pathname);
    assert.equal(source.method, sdk.init.method);
    assert.equal(sdk.passport, false);
    assert.equal(sdk.init.headers.bgint_json_parser, '2');
    if (source.method === 'POST') { assert.equal(source.body, null); assert.equal(sdk.init.body, ''); }
    else assert.equal(sdk.init.body, undefined);
    for (const key of ['action', 'sticker_ids', 'sticker_uri', 'sticker_url', 'resource_id', 'sticker_type']) {
      const value = source.query?.[key];
      assert.equal(url.searchParams.get(key), value == null ? null : String(value), `case ${i}: ${key}`);
    }
  }
  console.log(`Desktop emoji: ${originalRequests.length} original-module/built-SDK request contracts passed; no network.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
