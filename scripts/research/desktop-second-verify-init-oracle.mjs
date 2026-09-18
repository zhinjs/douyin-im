// Offline source oracle: execute the installed renderer's actual init expression.
// No native addon, account, HTTP, browser or cookie store is opened.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { encodeActionVerificationPack } from '../../lib/desktop/second-verify.js';

const root = process.argv[2];
assert(root, 'Pass the extracted Desktop 1.2.1 directory');
function source(path, hash) {
  const bytes = readFileSync(join(root, path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, 'Source snapshot changed');
  return bytes.toString();
}
const main = source('renderer/main/main_4eaa703b51f46c257250.js', '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
const follow = source('renderer/950/950_cfaed590525544ccfae4.js', '8a028616904c1a2a3e0b1a1d3b0b744beac65476afd624add01ee5c46f08528c');
const moduleBody = main.match(/48797: \(e, t, n\) => \{([\s\S]*?)\n      \},\n      48948:/)?.[1];
assert(moduleBody, 'Renderer constants module missing');
const start = follow.indexOf('class p{constructor(){const e=');
const end = follow.indexOf(';v.default.init(e)', start);
assert(start >= 0 && end > start, 'SecondVerify constructor missing');
const expression = follow.slice(start + 'class p{constructor(){const e='.length, end);
for (const platform of new Set(['darwin', 'win32', process.platform])) {
  const constants = {};
  runInNewContext(`(function(e,t,n){${moduleBody}})({}, target, loader)`, {
    target: constants, loader: { d: (target, exports) => {
      for (const [key, get] of Object.entries(exports)) Object.defineProperty(target, key, { get });
    } }, process: { platform, arch: 'arm64', getSystemVersion: () => 'fixture' },
  });
  const init = runInNewContext(`(${expression})`, {
    N: constants, o: { A: { instance: () => ({ deviceId: 'did', installId: 'iid' }) } },
    s: { S: { fp: () => 'verify_did' } }, y: { A: 'fixture-ui-only' },
  });
  assert.equal(init.host, 'https://sso.douyin.com');
  assert.equal(init.newSecondVerifyRequestHost, 'https://imdesktop.douyin.com');
  assert.equal(init.isNewVerifyUI, true);
  assert.equal(init.generalParams.device_platform, platform);
  assert.equal(JSON.stringify(init.generalParams), JSON.stringify(init.newSecondVerifyWebOptions));
  assert.equal(init.getGeneralParams, undefined);
  if (platform === process.platform) {
    const actual = Object.fromEntries(new URLSearchParams(encodeActionVerificationPack({}, 'did', 'iid')));
    for (const [key, value] of Object.entries(init.generalParams)) assert.equal(actual[key], String(value), key);
  }
}
console.log('Desktop SecondVerify constructor oracle passed (darwin/win32 + current platform pack).');
