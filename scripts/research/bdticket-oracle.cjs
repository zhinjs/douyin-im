// Developer-only oracle. Fresh state and synthetic Sessions; no network requests.
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/bdticket-oracle.cjs /path/to/bdticket.node');
const addon = require(resolve(process.argv[2]));
const dir = mkdtempSync(join(tmpdir(), 'bdticket-offline-'));
const { execFileSync } = require('node:child_process');
const { readFileSync, rmSync } = require('node:fs');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createHmac } = require('node:crypto');
execFileSync('openssl', ['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-keyout',join(dir,'fixture.key'),'-out',join(dir,'fixture.pem'),'-subj','/CN=offline-fixture','-days','1'], {stdio:'ignore'});
const pem = readFileSync(join(dir,'fixture.pem'),'utf8');
addon.registerEventEmitter((event, ...args) => {
  if (event === 'pc_request_cert') {
    console.log('cert request', args[0]);
    args[1]({message:'success',data:{cert:pem,server_cert:Buffer.from(pem).toString('base64'),server_sn:'fixture-serial'}}, '', {httpStatusCode:0,message:''});
  }
});
addon.refreshSettings({session_guard_config:{enable:true,ree_enable_symmetric:true,ree_path:['/passport/account/info/v2/','/aweme/v1/web/commit/follow/user/','/passport/token/beat/v2/']},enable_full_path_track:true});
console.log('started', addon.startBDTicket(dir));
setTimeout(() => {
  const loginPath='/passport/web/check_qrconnect/';
  const req=addon.handleRequest('imdesktop.douyin.com',loginPath,{},'','');
  const serverData=Buffer.from(JSON.stringify({ticket:'fixture-session',ts_sign_ree:'fixture-ticket-sign'})).toString('base64');
  addon.handleResponse('imdesktop.douyin.com',loginPath,{'bd-ticket-guard-server-data':[serverData]},'fixture-session',req.headers,'','',req.associated);
  for (const path of ['/passport/web/user/login/','/passport/web/sms_login/','/passport/web/check_qrconnect/','/aweme/v1/web/commit/follow/user/','/passport/account/info/v2/','/passport/token/beat/v2/']) {
    for (const session of ['', 'fixture-session']) {
      const result=addon.handleRequest('imdesktop.douyin.com',path,{},session,session);
      const encoded=result.headers['bd-ticket-guard-client-data'];
      if(encoded){
        const data=JSON.parse(Buffer.from(encoded,'base64'));
        const raw=Buffer.from(result.headers['bd-ticket-guard-ree-public-key'],'base64');
        const peer=createPublicKey({key:{kty:'EC',crv:'P-256',x:raw.subarray(1,33).toString('base64url'),y:raw.subarray(33).toString('base64url')},format:'jwk'});
        const shared=diffieHellman({privateKey:createPrivateKey(readFileSync(join(dir,'fixture.key'))),publicKey:peer});
        const key=hkdfSync('sha256',shared,Buffer.alloc(0),Buffer.alloc(0),32);
        const content=`ticket=${session}&path=${path}&timestamp=${data.timestamp}`;
        const expected=createHmac('sha256',Buffer.from(key)).update(content).digest('base64');
        assert.equal(data.req_sign_ree, expected);
        assert.equal(data.ts_sign_ree, 'fixture-ticket-sign');
        assert.equal(result.headers['bd-ticket-guard-iteration-version'], '3');
        assert.equal(result.associated.kTicketGuardUseTicketErrorCodeKey, undefined);
        console.log('PASS HMAC + ticket binding', path);
      }
    }
  }
  const follow='/aweme/v1/web/commit/follow/user/';
  const inspect=()=>{const r=addon.handleRequest('imdesktop.douyin.com',follow,{},'fixture-session','other-ss');return {data:JSON.parse(Buffer.from(r.headers['bd-ticket-guard-client-data'],'base64')),associated:r.associated};};
  assert.equal(inspect().data.ts_sign_ree, 'fixture-ticket-sign');
  for (const [label,body,cookie] of [
    ['array',{tickets:[{ticket:'fixture-session',ts_sign_ree:'array-sign'}]},'fixture-session'],
    ['absent ticket',{ts_sign_ree:'absent-sign'},'fixture-session'],
    ['no cookie',{ticket:'fixture-session',ts_sign_ree:'no-cookie-sign'},''],
    ['wrong cookie',{ticket:'fixture-session',ts_sign_ree:'wrong-cookie-sign'},'other-session'],
  ]){
    const r=addon.handleRequest('imdesktop.douyin.com',loginPath,{},'fixture-session','other-ss');
    addon.handleResponse('imdesktop.douyin.com',loginPath,{'bd-ticket-guard-server-data':[Buffer.from(JSON.stringify(body)).toString('base64')]},cookie,r.headers,'fixture-session','other-ss',r.associated);
    assert.equal(inspect().data.ts_sign_ree, 'array-sign');
    console.log('PASS binding condition', label);
  }
  process.exit(0);
}, 2000);
