// Raw co and shared co/uo cache vs built pipeline; synthetic keys, no HTTP or account data.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { source } = require('./desktop-web-secure-keys-oracle.cjs');
const raw = 'var ' + source.slice(source.indexOf('Nn=18e6'), source.indexOf(',qn=function')) + ';' +
  source.slice(source.indexOf('var Zn,'), source.indexOf('var oo=function')) +
  source.slice(source.indexOf('var oo=function'), source.indexOf(',so=function')) + ';var ' +
  source.slice(source.indexOf('co=function'), source.indexOf(',ho=function')) + ';';
const compact = value => JSON.parse(JSON.stringify(value));
async function scenario(kind, sdk, mode) {
  let time = 1000, count = 0;
  const Clock = class { getTime() { return mode === 'clock' ? time++ : time; } static now() { return mode === 'clock' ? time++ : time; } };
  const calls = [], output = [], info = { crypt: { ec_publicKey: 'public', ec_privateKey: 'synthetic-private' }, sign: { ticket: 'stored-ticket', ts_sign: 'stored-ts', client_cert: 'stored-cert' },
    cert: 'pub.point', b64Cert: 'CERT64', b64PubKey: 'POINT64', b64Csr: 'CSR64', dataFrom: '2', getKeysInfoTime: 7 };
  const keys = {
    async getKeysInfoWithOrigin(input) { calls.push(['keys', input]); if (mode === 'keys-reject') throw Error('synthetic'); return mode === 'keys-null' ? null : info; },
    getCookieCryptStatus() { calls.push(['cookie']); if (mode === 'cookie-throw') throw Error('synthetic'); return true; },
    async signWithKeysInfo(input) {
      calls.push(['sign', compact(input)]); if (mode === 'sign-reject') throw Error('synthetic');
      return mode === 'sign-null' ? null : { result: mode === 'sign-empty' ? '' : `signature-${++count}`, algoType: mode === 'hmac' ? 'hmac' : 'ecdsa',
        times: mode === 'time-overrides' ? { calTime: 3, duration: 40, signTime: 50, getKeysInfoTime: 60 } : { calTime: 3 } };
    },
    async checkSignData() { calls.push(['md5']); return {}; },
    getStorageStatus() { calls.push(['storage']); return {}; },
    async getUsage() { calls.push(['usage']); return 'system'; },
    getIframeStatus() { calls.push(['iframe']); return true; },
  };
  const signData = { ticket: 'explicit-ticket', ts_sign: 'ts.2.explicit', path: '/follow' }, options = { signData };
  if (mode === 'no-input') options.signData = undefined;
  if (mode === 'null-input') options.signData = null;
  if (mode === 'no-ticket') delete signData.ticket;
  if (mode === 'no-path') delete signData.path;
  if (mode === 'no-public') delete info.crypt.ec_publicKey;
  if (mode === 'raw-path') signData.path = 'https://synthetic.invalid/follow?query=literal';
  if (mode === 'ts1') signData.ts_sign = 'ts.1.explicit';
  if (mode === 'old-ts') signData.ts_sign = 'other';
  if (mode === 'no-ts') delete signData.ts_sign;
  if (mode === 'bad-ts') signData.ts_sign = {};
  if (mode === 'old-cert') info.cert = 'legacy certificate';
  if (mode === 'cert') options.signType = 'cert';
  if (mode === 'csr') { options.signType = 'cert'; delete info.b64Cert; }
  if (mode === 'cookie') options.certType = 'cookie';
  const match = { needProxy: true, pathname: '/follow', consumerConfig: { scene: 'web_protect', signTimeout: mode === 'auto-ttl' ? 10 : undefined } };
  info.sign.ticket = signData.ticket;
  let manual, automatic;
  if (kind === 'raw') {
    const context = vm.createContext({ Date: Clock, Promise, URL, Array }); vm.runInContext(raw, context);
    manual = () => context.co({ ...options, crypt: mode === 'no-keys' ? undefined : keys });
    automatic = () => context.uo({ url: '/follow', headers: {} }, { crypt: keys }, match, { reportLog() {}, reportEvent() {}, reportError() {} });
  } else {
    const pipeline = new sdk.DesktopWebSecureRequestPipeline({ Date: Clock, pageHref: 'https://synthetic.invalid' }, mode === 'no-keys' ? undefined : keys);
    manual = () => pipeline.createTicketGuardHeaders(options);
    automatic = () => pipeline.prepare({ url: '/follow', headers: {} }, match);
  }
  try {
    if (mode === 'auto-first' || mode === 'auto-ttl') output.push(await automatic());
    output.push(await manual());
    if (mode === 'manual-first') output.push(await automatic());
    if (mode.startsWith('cache-') || mode === 'auto-ttl') {
      if (mode === 'cache-expire') time += 18e6;
      if (mode === 'cache-before') time += 18e6 - 1;
      if (mode === 'auto-ttl') time += 10;
      if (mode === 'cache-ticket') signData.ticket = 'changed';
      if (mode === 'cache-key') { info.crypt.ec_publicKey = 'other'; signData.ts_sign = 'ts.1.changed'; }
      output.push(await manual());
    }
  } catch (error) { output.push({ error: error.name }); }
  return compact({ output, calls, info });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-request.js')).href);
  const modes = ['normal', 'clock', 'no-input', 'null-input', 'no-ticket', 'no-path', 'no-public', 'no-keys', 'keys-null', 'raw-path', 'ts1', 'old-ts', 'no-ts', 'bad-ts',
    'old-cert', 'cert', 'csr', 'cookie', 'hmac', 'time-overrides', 'keys-reject', 'cookie-throw', 'sign-reject', 'sign-null', 'sign-empty',
    'auto-first', 'manual-first', 'auto-ttl', 'cache-hit', 'cache-before', 'cache-expire', 'cache-ticket', 'cache-key'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', sdk, mode), mode);
  console.log(`PASS ${modes.length} raw co/shared-cache vs SDK traces (synthetic keys, no network)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
