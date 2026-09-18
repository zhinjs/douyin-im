/** Explicit real-account READ probe. No login, QR, device registration, or store writes. */
import { readFileSync } from 'node:fs';
import { ApiConnection } from '../../src/desktop/api-connection.js';
import { ImUserSettingsApi } from '../../src/services/im/user-settings.js';
import { ImService } from '../../src/services/im/service.js';
import type { StoredAccount } from '../../src/store/types.js';

const uid = '1150530166719210';
const account = JSON.parse(readFileSync(new URL(`../../data/accounts/${uid}/account.json`, import.meta.url), 'utf8')) as StoredAccount;
if (account.platformUid !== uid || !account.session.cookies) throw new Error('Authorized account unavailable');
const p = account.deviceProfile;
if (!p.deviceId || !p.installId || !p.guid) throw new Error('Stored Desktop device identity incomplete');
const client = new ApiConnection({
  initialCookies: account.session.cookies,
  desktopTicketGuard: account.session.desktopTicketGuard,
  userAgent: p.userAgent, bizTraceId: p.bizTraceId, deviceId: p.deviceId, installId: p.installId,
  guid: p.guid, screenWidth: String(p.screenWidth ?? 1728), screenHeight: String(p.screenHeight ?? 1117),
});
const probe = await client.probeSession();
console.log(JSON.stringify({ phase: 'identity', status: probe.status, matchesAuthorizedAccount: probe.uid === uid, boundTicket: client.hasBoundTicket() }));
if (probe.status === 'alive' && probe.uid === uid && !process.argv.includes('--identity-only')) {
  const api = new ImUserSettingsApi(client, p.deviceId);
  for (const [phase, run] of [
    ['settings', () => api.getSettings()],
    ['read-privacy', () => api.getReadReceiptPrivacy()],
  ] as const) {
    try { console.log(JSON.stringify({ phase, ...await run() })); }
    catch (error) {
      // No response bodies, URLs, cookies, ticket material or error stacks.
      const e = error as { name?: string; kind?: string; status?: number };
      console.log(JSON.stringify({ phase, error: e.name, kind: e.kind, httpStatus: e.status }));
    }
  }
  if (process.argv.includes('--message-privacy')) {
    // Only the explicitly authorized dedicated test group, never another conversation.
    const groupId = '7684206858655056410';
    const im = new ImService(client, { platformUid: uid, deviceId: p.deviceId, guid: p.guid });
    const history = await im.getMessages({ threadId: groupId, conversationShortId: groupId, conversationType: 2, inboxType: 1, count: 1 });
    console.log(JSON.stringify({ phase: 'test-group-history', statusCode: history.statusCode, count: history.messages.length }));
    const message = history.statusCode === 0 ? history.messages[0] : undefined;
    if (message?.msgId && message.threadId === groupId) {
      const result = await api.getMessageReadPrivacy([{ serverMessageId: message.msgId, conversationId: groupId,
        conversationShortId: groupId, conversationType: 2, createTime: message.createTime }]);
      console.log(JSON.stringify({ phase: 'message-privacy', statusCode: result.statusCode,
        currentUserSwitch: result.currentUserSwitch, enableReadState: result.enableReadState,
        count: result.messages.length, policies: result.messages.map(item => ({ errorCode: item.errorCode, onCount: item.on.length, offCount: item.off.length })) }));
    }
  }
  if (process.argv.includes('--read-state')) {
    const groupId = '7684206858655056410';
    const im = new ImService(client, { platformUid: uid, deviceId: p.deviceId, guid: p.guid });
    const address = { threadId: groupId, conversationShortId: groupId, conversationType: 2 as const };
    const state = await im.getConversationReadState(address);
    console.log(JSON.stringify({ phase: 'test-group-read-state', statusCode: state.statusCode,
      readCount: state.readIndexes.length, minCount: state.minIndexes.length,
      reads: state.readIndexes.map(row => ({ self: row.uid === uid, testPeer: row.uid === '3138463854771706',
        hasIndex: row.index !== undefined, hasV2: row.indexV2 !== undefined, hasMin: row.minIndex !== undefined })),
      minimums: state.minIndexes.map(row => ({ self: row.uid === uid, testPeer: row.uid === '3138463854771706', hasIndex: row.index !== undefined })) }));
    const batch = await im.getBatchConversationReadIndexes([address]);
    console.log(JSON.stringify({ phase: 'test-group-batch-read-state', statusCode: batch.statusCode,
      conversations: batch.conversations.length, missingCount: batch.missingConversationIds.length,
      indexCounts: batch.conversations.map(item => item.indexes.length) }));
  }
}
