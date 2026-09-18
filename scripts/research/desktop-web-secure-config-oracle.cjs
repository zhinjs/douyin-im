// Pure source-function / built SDK differential. No application, network or account data.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/desktop-web-secure-config-oracle.cjs /path/to/860.js');
const source = readFileSync(resolve(process.argv[2]), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
assert.equal(source.length, 255014);
const page = 'file:///Applications/Test.app/renderer/login/index.html';
const stub = { cryptoSDK: { setConfig() {}, setAid() {} }, secureProxy: { setConfig() {} }, emit() {} };
const context = vm.createContext({ URL, window: { location: { href: page } }, n: stub });
vm.runInContext('var ' + source.slice(166675, 167258) + ';var ' + source.slice(168897, 169107)
  + ';var ' + source.slice(170463, 172452) + ';this.classify=so;' + source.slice(201051, 201411), context);
const configs = [
  null, {}, { login: [{ aid: 339757, scene: 'login', certType: 'header' }] },
  { login: [{ providerPathList: ['/passport'] }] },
  { login: [{ onlyProviderPathList: ['/passport'] }, { consumerPathList: ['/passport'] }] },
  { login: [{ providerPathList: ['/passport'] }, { excludeConsumerPathList: ['/passport'], onlyProviderPathList: ['/no'] }] },
  { login: [{ excludeConsumerPathList: ['/passport'], consumerPathList: ['/passport'] }] },
  { login: [{ providerPathList: ['/passport'] }, { excludeConsumerPathList: ['/passport'], onlyProviderPathList: ['/no'], consumerPathList: ['/passport'] }] },
  { login: [{ consumerHostList: ['imdesktop.douyin.com'] }] },
  { login: [{ providerHostPathList: ['imdesktop.douyin.com:8443/passport'] }] },
  { login: [{ consumerHostPathList: ['imdesktop.douyin.com/passport'] }] },
  { login: [{ providerPathList: null, consumerPathList: ['/'] }] },
  { login: [{ ignorePathList: ['/'], consumerPathList: ['/'], excludeReportPathList: ['/passport'] }] },
  { login: [{ consumerPathList: '/p' }] },
  { login: [{ consumerPathList: [''] }] },
  { login: [{ consumerPathList: [123, null, undefined, {}] }] },
  { login: { consumerPathList: ['/'] } },
  { login: [null, false, 123, 'text', { consumerPathList: ['/'] }] },
  { z: [{ providerPathList: ['/'] }], '2': [{ onlyProviderPathList: ['/'] }], '1': [{ consumerPathList: ['/'] }] },
  { login: [{ consumerPathList: ['/passport'] }, { excludeConsumerPathList: ['/passport'], onlyProviderPathList: ['/no'] }] },
];
const urls = [undefined, '', '/passport/test', 'http://[',
  'https://imdesktop.douyin.com/passport/test?x=1&x=2#hash', 'https://imdesktop.douyin.com:8443/passportXYZ',
  'https://imdesktop.douyin.com.example/passport/', 'https://mcs.zijieapi.com/passport/',
  'https://mon.zijieapi.com/passport/', 'https://mcs.zijieapi.com:444/passport/',
  'https://imdesktop.douyin.com/other/', 'file:///passport/entry',
];
void (async () => {
  const { classifyDesktopWebSecureRequest, DesktopWebSecureConfiguration } = await import(
    pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-config.js')).href);
  let count = 0;
  for (const config of configs) for (const url of urls) {
    const actual = context.classify({ url }, config, 'pubKey', 'cert');
    const expected = classifyDesktopWebSecureRequest({ url }, config, page, 'pubKey', 'cert');
    // Retain undefined keys and the original selected-config references across realms.
    assert.deepEqual(Object.fromEntries(Object.entries(actual)), expected, `config=${configs.indexOf(config)} url=${url}`);
    count++;
  }
  const state = new DesktopWebSecureConfiguration();
  const sequence = [{ aid: 339757, scene: 'login', certType: 'header' },
    { scene: 'extra', consumerPathList: ['/passport'] }, { aid: 42, scene: 'login' }, {},
    { aid: 339757, scene: 'login', onlyProviderPathList: ['/passport'] }];
  sequence.push(sequence[0]);
  for (const entry of sequence) {
    stub.setConfig(entry); state.setConfig(entry);
    assert.equal(stub.aid, state.aid);
    assert.deepEqual(JSON.parse(JSON.stringify(stub.config)), state.config);
    assert.equal(stub.config[String(entry.scene)].at(-1), entry);
    assert.equal(state.config[String(entry.scene)].at(-1), entry);
  }
  console.log(`PASS ${count} original / built SDK classifications and ${sequence.length} cumulative-config checkpoints`);
})().catch(error => { console.error(error); process.exitCode = 1; });
