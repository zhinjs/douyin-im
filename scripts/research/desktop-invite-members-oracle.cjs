// Hash-pinned Desktop bridge mapper versus built SDK. Synthetic responses only; no network/native execution.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

async function main() {
  const file = path.join(process.argv[2] || '/private/tmp/douyin-chat-audit.nDCHET', 'index.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'),
    '5103dc3c67df781c04396b7494207804999f793f8fccf815638a52a4a8e42a45', 'Re-audit changed Desktop source');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'addConversationParticipants'
      && node.body.getText(ast).includes('secSuccessParticipants:')) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(matches.length, 1);
  const original = vm.runInNewContext(`({${matches[0].getText(ast)}})`, {
    vo: value => value == null,
    Uo: { error() { throw new Error('Unexpected Desktop mapper failure'); } }, Ji: 'fixture',
  });
  const { ImConversationActions } = await import(pathToFileURL(path.resolve(__dirname, '../../lib/services/im/actions.js')).href);
  const bodyFixtures = [
    { status: 0, successParticipants: ['22', '22'], failedParticipants: ['33'] },
    { status: 0 },
    {},
    { status: 0, secSuccessParticipants: [{ uid: '9007199254740993', secUid: 'sec1' }],
      secFailedParticipants: [{ secUid: 'sec-only' }] },
    { status: 1, checkCode: '2', checkMessage: '{"status_code":7505,"status_msg":"confirmation","invalid_members":[{"uid":33}]}',
      extraInfo: 'extra', successParticipants: ['22'], failedParticipants: ['33'] },
    { status: 0, checkCode: '9007199254740993', checkMessage: '{"status_code":0,"status_msg":"success"}',
      successParticipants: ['22'], secSuccessParticipants: [{ uid: '22', secUid: 'sec22' }],
      failedParticipants: ['33'], secFailedParticipants: [{ uid: '33', secUid: 'sec33' }] },
  ];
  for (const [index, body] of bodyFixtures.entries()) {
    let originalCalls = 0;
    original.cppSDK = { async addConversationParticipants(...args) {
      originalCalls++;
      assert.deepEqual(args, ['800', '9007199254740993', 2, ['22', '33', '44'], {}]);
      return body;
    } };
    const mapped = await original.addConversationParticipants('800', '9007199254740993', 2, ['22', '33', '44'], {});
    const expected = JSON.parse(JSON.stringify(mapped));
    for (const key of ['successParticipants', 'failedParticipants', 'secSuccessParticipants', 'secFailedParticipants']) {
      expected[key] ??= [];
    }
    const calls = [];
    const actions = new ImConversationActions({ async sendCookieProto(...args) {
      calls.push(args);
      return { statusCode: index % 2 ? 200 : 0, body: { conversationAddParticipantsBody: body } };
    } }, 'fixture-device', () => '11');
    const result = await actions.inviteParticipants({ threadId: '800', conversationShortId: '9007199254740993',
      conversationType: 2, inboxType: 9, uids: ['22', '33', '44'] });
    assert.deepEqual(result.details, expected);
    assert.deepEqual(result.succeededUids, [...expected.successParticipants,
      ...expected.secSuccessParticipants.flatMap(item => item.uid === undefined ? [] : [item.uid])]);
    assert.deepEqual(result.failedUids, [...expected.failedParticipants,
      ...expected.secFailedParticipants.flatMap(item => item.uid === undefined ? [] : [item.uid])]);
    assert.equal(result.succeededUids.includes('44'), false);
    assert.equal(result.statusCode, index === 4 ? 7505 : 0);
    assert.equal(originalCalls, 1); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), [650, 1, '/v1/conversation/add_participants']);
    const request = calls[0][3].conversationAddParticipantsBody;
    assert.equal(request.conversationShortId.toString(), '9007199254740993');
    assert.deepEqual(request.participants.map(String), ['22', '33', '44']);
    assert.deepEqual(request.bizExt, { invitation: '{"invitee":{"source_app_id":339757},"invitor":{"im_user_id":11},"source_type":6}', ticket: '' });
  }
  console.log(`Desktop invitation mapper: ${bodyFixtures.length} original bridge vs built SDK fixtures passed; no network.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
