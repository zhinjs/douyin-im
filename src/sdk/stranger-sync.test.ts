import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiConnection } from '../desktop/api-connection.js';
import { AccountStore } from '../store/account-store.js';
import { ConnectionManager } from '../base/runtime/connection-manager.js';
import { ImService } from '../services/im/service.js';
import { mapProtoConversationListItem } from '../services/im/mappers.js';
import { noticeFromPush } from '../services/im/notifications.js';
import { ImProtoTransport, ImProtoTransportError } from '../services/im/transport.js';
import { Account } from './account.js';
import { Friend } from './contacts/friend.js';
import { Stranger } from './contacts/stranger.js';
import { Group } from './contacts/group.js';
import { MessageEvent } from './events/message.js';
import { inboundFromPush } from '../base/raw/inbound-message.js';
import type { ConversationInfoListResponse, RecentStrangerMessagesResponse } from '../services/im/types.js';

const id = '0:1:10001:20002';
function page(version = '90'): RecentStrangerMessagesResponse {
  return { statusCode: 0, statusMsg: '', nextStrangerVersion: '50', hasMore: false, logId: 'offline', messages: [{
    conversationId: id, conversationShortId: '700', version, badgeCount: 3, messages: [{
      threadId: id, conversationShortId: '700', conversationType: 1, inboxType: 1, msgId: '80',
      senderUid: '20002', content: '{"text":"/ping"}', msgType: 7, createTime: 1000, status: 0,
      indexInConversation: '5', orderInConversation: '5', clientMessageId: 'client-80',
      ext: { 's:client_message_id': 'client-80' },
    }],
  }] };
}
function details(inBox = true): ConversationInfoListResponse {
  return { statusCode: 0, statusMsg: '', conversations: [mapProtoConversationListItem({
    conversationId: id, conversationShortId: '700', conversationType: 1, inboxType: 1, badgeCount: 1,
    conversationCoreInfo: { infoVersion: '12', name: 'detail', mode: 2, ext: inBox ? { stranger: '10001' } : {} },
  })] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe.each(['sqlite', 'json', 'memory'] as const)('Account stranger sync (%s)', backend => {
  let directory: string;
  let account: Account;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'douyin-account-stranger-'));
    // These scenarios explicitly control sync pages and cursor transitions.
    jest.spyOn(Account.prototype as unknown as { loadOnlineContacts(generation: number): Promise<void> },
      'loadOnlineContacts').mockResolvedValue(undefined);
    jest.spyOn(ApiConnection.prototype, 'startTicketGuard').mockImplementation(() => undefined);
    jest.spyOn(ApiConnection.prototype, 'startDeviceLifecycle').mockImplementation(function (this: ApiConnection) { return this.initializeDevice(); });
    jest.spyOn(ApiConnection.prototype, 'initializeDevice').mockImplementation(async function (this: ApiConnection) {
      return { deviceId: this.getDeviceId(), installId: this.getInstallId() };
    });
    jest.spyOn(ApiConnection.prototype, 'getApplicationSettings').mockResolvedValue({});
    jest.spyOn(ApiConnection.prototype, 'sendPassportTokenBeat').mockResolvedValue({ message: 'success', data: {} });
    jest.spyOn(ConnectionManager.prototype, 'start').mockResolvedValue(undefined);
    jest.spyOn(ConnectionManager.prototype, 'stop').mockResolvedValue(undefined);
    jest.spyOn(ImService.prototype, 'listThreads').mockResolvedValue({ statusCode: 0, statusMsg: '', threads: [], hasMore: false, cursor: '0', conversations: [] });
    const client = new ApiConnection(); client.jar.set('sessionid', 'offline-session');
    jest.spyOn(client, 'getSelfProfile').mockResolvedValue({ user: {} });
    jest.spyOn(client, 'ttwidCheck').mockRejectedValue(new Error('offline optional warm-up'));
    jest.spyOn(client, 'getQrcode').mockResolvedValue({ token: 'offline-qr', qrcodeBase64: '', expireTime: 9999999999 });
    jest.spyOn(client, 'checkQrconnect').mockResolvedValue({ message: 'success', data: {
      status: 'confirmed', error_code: 0, user_data: { user_id_str: '10001', screen_name: 'offline' },
    } });
    account = Account.create(client, new AccountStore({ dataDir: directory }), {
      skipVerify: true, localState: backend === 'memory' ? false : { backend },
    });
    const ready = new Promise<void>(resolve => account.once('system.login.qrcode', resolve));
    const login = account.login(); await ready; await account.continueLogin(); await login;
  });
  afterEach(async () => { await account.logout(); jest.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

  function push(content: string, messageType = 50001, outerId = 'outer'): void {
    const notice = noticeFromPush({ cmd: 500, conversationId: outerId, conversationShortId: '999',
      conversationType: 1, senderUid: '0', messageType, content, indexInConversation: '9999', raw: { source: 'fixture' } });
    if (notice) account['assembler']!.receiveNotice(notice);
  }

  function knownGroup(): Group {
    account.applyConversationInfo({ conversationId: '800', conversationShortId: '9007199254740993', conversationType: 2,
      inboxType: 3, isGroup: true, name: 'fixture', isParticipant: true, minIndex: '0', lastMessageTime: 0,
      members: [{ uid: '20002', role: 0 }] });
    account.cacheMessages([{ ...page().messages[0]!.messages[0]!, threadId: '800', conversationType: 2 }]);
    return account.cachedGroup('800')!;
  }

  function participantUpdate(fields: string, target = '800'): string {
    return `{"command_type":7,"conversation_id":"${target}","conversation_type":2,"inbox_type":4,${fields}}`;
  }

  it.each(['send', 'forward'] as const)('blocks %s dispatch when the real account logs out during address preparation', async action => {
    const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in send lifecycle fixture'));
    const group = knownGroup();
    const inbound = inboundFromPush({ cmd: 500, conversationId: '800', conversationShortId: '9007199254740993',
      conversationType: 2, senderUid: '20002', serverMessageId: '80', messageType: 7,
      content: '{"text":"source"}', raw: {} });
    if (!inbound) throw new Error('Expected synthetic source message');
    const source = MessageEvent.fromInbound(inbound, account);
    const send = jest.spyOn(account.im, 'send').mockResolvedValue({ statusCode: 0, statusMsg: '', clientMessageId: 'fixture' });
    const pending = action === 'send' ? group.sendMsg('fixture') : source.forwardTo(group);
    const rejected = expect(pending).rejects.toThrow('账号连接已变化');
    await account.logout();
    await rejected;
    expect(send).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['send', 'forward'] as const)('keeps a late %s acknowledgement out of a restarted account cache', async action => {
    const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in send lifecycle fixture'));
    const group = knownGroup();
    const inbound = inboundFromPush({ cmd: 500, conversationId: '800', conversationShortId: '9007199254740993',
      conversationType: 2, senderUid: '20002', serverMessageId: '80', messageType: 7,
      content: '{"text":"source"}', raw: {} });
    if (!inbound) throw new Error('Expected synthetic source message');
    const source = MessageEvent.fromInbound(inbound, account);
    const response = deferred<{ statusCode: number; statusMsg: string; serverMessageId: string; clientMessageId: string }>();
    const dispatched = deferred<void>();
    const old = account.im;
    const send = jest.spyOn(old, 'send').mockImplementation(() => { dispatched.resolve(); return response.promise; });
    const pending = action === 'send' ? group.sendMsg('fixture') : source.forwardTo(group);
    await dispatched.promise;
    await account.logout(); await account.login();
    expect(account.im).not.toBe(old);
    const newSend = jest.spyOn(account.im, 'send');
    const result = { statusCode: 0, statusMsg: 'OK', serverMessageId: '900', clientMessageId: 'late-send-fixture' };
    response.resolve(result);
    await expect(pending).resolves.toBe(result);
    expect(send).toHaveBeenCalledTimes(1);
    expect(newSend).not.toHaveBeenCalled();
    expect(account.cachedMessage('800', '900', 'server')).toBeUndefined();
    // Check persisted state too, not just the live cache.
    await account.logout(); await account.login();
    expect(account.cachedMessage('800', '900', 'server')).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps cmd651 acknowledgement separate from authoritative member removal (noticeFirst=%s)', async noticeFirst => {
    const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in removal fixture'));
    const group = knownGroup();
    const members = [{ uid: '20002', role: 0 }, { uid: '30003', role: 0 }];
    account.applyConversationInfo({ ...account.cachedConversation('800')!, members, participantsCount: 10 });
    account.replaceCachedGroupMembers('800', members);
    for (const member of members) account.applyParticipantReadIndex('800', member.uid, '5');
    const member = group.pickMember('20002');
    const response = deferred<Record<string, unknown>>();
    const transport = jest.spyOn(ImProtoTransport.prototype, 'sendCookieProto').mockReturnValue(response.promise);
    const refresh = jest.spyOn(account.im, 'getConversationInfos');
    const list = jest.spyOn(account.im, 'listConversationParticipants');
    const removed = jest.fn(); account.on('notice.conversation.members-remove', removed);
    const pending = group.removeMembers(['20002', '30003']);
    const publishNotice = async () => {
      push(participantUpdate('"removed_participant":[20002]'));
      await Promise.resolve(); await Promise.resolve();
    };
    expect(group.pickMember('20002')).toBe(member);
    if (noticeFirst) await publishNotice();
    response.resolve({ statusCode: 0, errorDesc: 'OK', body: { conversationRemoveParticipantsBody: {
      status: 1, checkCode: '2', failedParticipants: ['30003'], failedSecParticipants: [{ uid: '30003', secUid: 'fixture' }],
    } } });
    await expect(pending).resolves.toEqual({ statusCode: 0, statusMsg: 'OK' });
    if (!noticeFirst) {
      expect(group.pickMember('20002')).toBe(member);
      expect(account.cachedConversation('800')?.members).toEqual(members);
      expect(account.cachedReadCursors('800')).toHaveLength(2);
      if (backend !== 'memory') expect(account.cachedGroupMembers('800')).toEqual(members);
      expect(removed).not.toHaveBeenCalled();
      // Restart proves that the HTTP acknowledgement did not delete durable rows either.
      if (backend !== 'memory') {
        await account.logout(); await account.login();
        const restored = account.cachedConversation('800')!;
        expect(restored.members).toEqual(members);
        // This fixture has a partial snapshot, not a complete group-list marker. Bind only
        // the retained row; getGroupList would perform a separate mocked remote refresh.
        account.rememberGroup(Group.bind('800', restored.conversationShortId, account, {
          members: restored.members, inboxType: restored.inboxType ?? 0,
        }));
      }
      expect(account.cachedConversation('800')?.members).toEqual(members);
      await publishNotice();
    }
    expect(account.cachedGroup('800')?.memberList.has('20002')).toBe(false);
    expect(account.cachedGroup('800')?.memberList.has('30003')).toBe(true);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0]![0].memberUids).toEqual(['20002']);
    if (backend !== 'memory') { await account.logout(); await account.login(); }
    expect(account.cachedConversation('800')).toMatchObject({ members: [members[1]], participantsCount: 10, isParticipant: true });
    expect(account.cachedReadCursors('800')).toEqual([{ uid: '30003', readIndex: '5', minIndex: '0' }]);
    if (backend !== 'memory') {
      expect(account.cachedGroupMembers('800')).toEqual([members[1]]);
      expect(account.cachedMessages('800')).toHaveLength(1);
    }
    expect(transport).toHaveBeenCalledTimes(1);
    const [cmd, inbox, path, body] = transport.mock.calls[0]!;
    expect([cmd, inbox, path]).toEqual([651, 3, '/v1/conversation/remove_participants']);
    const request = body['conversationRemoveParticipantsBody'] as Record<string, unknown>;
    expect(String(request['conversationShortId'])).toBe('9007199254740993');
    expect(request['conversationId']).toBe('800'); expect(request['conversationType']).toBe(2);
    expect(refresh).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });

  it.each([[650, false], [650, true], [651, false], [651, true]] as const)(
    'rejects a retired cmd%s response without changing member state (relogin=%s)', async (cmd, relogin) => {
    const group = knownGroup();
    const response = deferred<Record<string, unknown>>();
    const transport = jest.spyOn(ImProtoTransport.prototype, 'sendCookieProto').mockReturnValue(response.promise);
    const pending = cmd === 650 ? group.inviteMembers(['20002']) : group.removeMembers(['20002']);
    const rejected = expect(pending).rejects.toThrow('账号连接已变化');
    await account.logout();
    if (relogin) { await account.login(); knownGroup(); account.applyParticipantReadIndex('800', '20002', '7'); }
    const removed = jest.fn(); account.on('notice.conversation.members-remove', removed);
    response.resolve({ statusCode: 0, errorDesc: 'OK' });
    await rejected;
    if (relogin) {
      expect(account.cachedGroup('800')?.memberList.has('20002')).toBe(true);
      expect(account.cachedReadCursors('800')).toEqual([{ uid: '20002', readIndex: '7', minIndex: '0' }]);
    }
    expect(removed).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([0, 7505])('keeps explicit cmd650 outcomes separate from membership and never sends fallback invitations (business=%s)', async business => {
    const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in invitation fixture'));
    const group = knownGroup();
    const members = [{ uid: '20002', role: 0 }];
    account.replaceCachedGroupMembers('800', members);
    account.applyParticipantReadIndex('800', '20002', '5');
    const member = group.pickMember('20002');
    const before = account.cachedConversation('800');
    const transport = jest.spyOn(ImProtoTransport.prototype, 'sendCookieProto').mockResolvedValue({
      statusCode: 200, errorDesc: 'OK', body: { conversationAddParticipantsBody: {
        status: 0, successParticipants: ['30003'], failedParticipants: business ? ['40004'] : [],
        checkCode: '2', checkMessage: JSON.stringify({ status_code: business, status_msg: business ? 'needs confirmation' : 'success',
          invalid_members: business ? [{ uid: '40004' }] : [] }),
      } },
    });
    const refresh = jest.spyOn(account.im, 'getConversationInfos');
    const list = jest.spyOn(account.im, 'listConversationParticipants');
    const notice = jest.fn(); account.on('notice', notice);
    await expect(group.inviteMembers(['30003', '40004', '50005'])).resolves.toEqual({
      statusCode: business, statusMsg: business ? 'needs confirmation' : 'success',
      ...(business ? { checkCode: business } : {}), succeededUids: ['30003'], failedUids: business ? ['40004'] : [],
      details: expect.objectContaining({ status: 0, checkCode: '2', successParticipants: ['30003'],
        failedParticipants: business ? ['40004'] : [], secSuccessParticipants: [], secFailedParticipants: [] }),
    });
    expect(account.cachedConversation('800')).toEqual(before);
    expect(group.pickMember('20002')).toBe(member);
    expect([...group.memberList.keys()]).toEqual(['20002']);
    expect(account.cachedReadCursors('800')).toEqual([{ uid: '20002', readIndex: '5', minIndex: '0' }]);
    if (backend !== 'memory') {
      await account.logout(); await account.login();
      expect(account.cachedGroupMembers('800')).toEqual(members);
      expect(account.cachedConversation('800')?.members).toEqual(members);
      expect(account.cachedMessages('800')).toHaveLength(1);
    }
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]!.slice(0, 3)).toEqual([650, 1, '/v1/conversation/add_participants']);
    expect(refresh).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });

  it('applies UID-only removal without deleting history or fabricating a kick/member instance', async () => {
    const group = knownGroup();
    group.ensureMember({ uid: '10001', role: 0 });
    account.applyConversationInfo({ ...account.cachedConversation('800')!, participantsCount: 10 });
    account.applyParticipantReadIndex('800', '20002', '5');
    const update = jest.fn(); const removed = jest.fn(); const decrease = jest.fn(); const parent = jest.fn();
    account.on('notice.conversation.update', update); account.on('notice.conversation.members-remove', removed);
    account.on('notice.group.member-decrease', decrease); account.on('notice.conversation', parent);
    const refresh = jest.spyOn(account.im, 'getConversationInfos');
    const getMembers = jest.spyOn(account.im, 'listConversationParticipants');
    push(participantUpdate('"removed_participant":[20002,10001,20002,99999]'));
    await Promise.resolve(); await Promise.resolve();
    expect(account.cachedConversation('800')).toMatchObject({ isParticipant: false, participantsCount: 10, members: [] });
    expect(account.cachedGroup('800')).toBe(group);
    expect([...group.memberList.keys()]).toEqual([]);
    expect(account.cachedReadCursors('800')).toEqual([]);
    if (backend !== 'memory') {
      expect(account.cachedMessages('800')).toHaveLength(1);
      expect(account.cachedGroupMembers('800') ?? []).toEqual([]);
    }
    expect(removed).toHaveBeenCalledTimes(1);
    const event = removed.mock.calls[0]![0];
    expect(event).toMatchObject({ account, conversationId: '800', conversationType: 2, memberUids: ['20002', '10001', '20002', '99999'] });
    expect(Object.isFrozen(event.memberUids)).toBe(true); expect(event.operator).toBeUndefined(); expect(event.source).toBeUndefined();
    expect(parent.mock.calls.some(([value]) => value === event)).toBe(true);
    expect(parent.mock.calls.map(([value]) => value.type)).toEqual(['im.command', 'conversation.update', 'conversation.update', 'conversation.members-remove']);
    expect(decrease).not.toHaveBeenCalled(); expect(update).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled(); expect(getMembers).not.toHaveBeenCalled();
  });

  it('still emits removal for absent UIDs in a known conversation, but not an unknown conversation', async () => {
    knownGroup(); const removed = jest.fn(); const update = jest.fn();
    account.on('notice.conversation.members-remove', removed); account.on('notice.conversation.update', update);
    push(participantUpdate('"removed_participant":[99999]'));
    push(participantUpdate('"removed_participant":[99999]', 'missing'));
    await Promise.resolve(); await Promise.resolve();
    expect(removed).toHaveBeenCalledTimes(1); expect(update).not.toHaveBeenCalled();
    expect(account.cachedConversation('missing')).toBeUndefined();
  });

  if (backend !== 'memory') it.each([false, true])('reports a rejected member commit without an uncaught task or in-memory deletion (self=%s)', async self => {
    const group = knownGroup(); account.applyParticipantReadIndex('800', '20002', '5');
    const warning = jest.spyOn(account.logger, 'warn').mockImplementation(() => undefined);
    const commit = jest.spyOn(account['stateStore']!, 'removeConversationMembers').mockImplementation(() => { throw new Error('fixture disk failure'); });
    const removed = jest.fn(); const update = jest.fn();
    account.on('notice.conversation.members-remove', removed); account.on('notice.conversation.update', update);
    push(participantUpdate(`"removed_participant":[20002${self ? ',10001' : ''}]`));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1); expect(warning).toHaveBeenCalledWith('成员移除本地同步失败: %s', 'fixture disk failure');
    expect(removed).not.toHaveBeenCalled(); expect(update).toHaveBeenCalledTimes(self ? 1 : 0);
    // Native self-participation is a separate preceding operation, not rolled back with member rows.
    expect(account.cachedConversation('800')?.isParticipant).toBe(!self);
    expect(group.memberList.has('20002')).toBe(true);
    expect(account.cachedConversation('800')?.members?.map(member => member.uid)).toEqual(['20002']);
    expect(account.cachedReadCursors('800')).toEqual([{ uid: '20002', readIndex: '5', minIndex: '0' }]);
  });

  it.each(['added_participant', 'modified_participant'])('refreshes 608 using body address for %s without creating placeholder members', async field => {
    const group = knownGroup(); const pending = deferred<ConversationInfoListResponse>();
    const refresh = jest.spyOn(account.im, 'getConversationInfos').mockReturnValue(pending.promise);
    const getMembers = jest.spyOn(account.im, 'listConversationParticipants');
    push(participantUpdate(`"${field}":[30003]`));
    expect(refresh).toHaveBeenCalledWith([{ threadId: '800', conversationShortId: '800', conversationType: 2, inboxType: 4 }]);
    expect(group.memberList.has('30003')).toBe(false);
    pending.resolve({ statusCode: 0, statusMsg: '', conversations: [{ ...account.cachedConversation('800')!,
      name: 'refreshed', members: [{ uid: '30003', role: 0 }] }] });
    await Promise.resolve(); await Promise.resolve();
    expect(account.cachedGroup('800')).toBe(group); expect(group.memberList.has('30003')).toBe(true);
    expect(account.cachedConversation('800')?.name).toBe('refreshed'); expect(getMembers).not.toHaveBeenCalled();
  });

  it('refreshes an uncached target from added/modified, with decimal prefix rather than outer shortId', async () => {
    const refresh = jest.spyOn(account.im, 'getConversationInfos').mockResolvedValue({ statusCode: 0, statusMsg: '', conversations: [] });
    push(participantUpdate('"added_participant":[30003],"modified_participant":[40004]', '0:1:10001:30003'));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith([{ threadId: '0:1:10001:30003', conversationShortId: '0', conversationType: 2, inboxType: 4 }]);
    expect(account.cachedConversation('0:1:10001:30003')).toBeUndefined();
  });

  it('does not retry a failed 608 or invent added members', async () => {
    const group = knownGroup(); const warning = jest.spyOn(account.logger, 'warn').mockImplementation(() => undefined);
    const refresh = jest.spyOn(account.im, 'getConversationInfos').mockResolvedValue({ statusCode: 8, statusMsg: 'fixture', conversations: [] });
    push(participantUpdate('"added_participant":[30003]'));
    await Promise.resolve(); await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1); expect(warning).toHaveBeenCalledTimes(1);
    expect([...group.memberList.keys()]).toEqual(['20002']);
  });

  it('discards member workers and 608 responses from the previous login', async () => {
    knownGroup(); const pending = deferred<ConversationInfoListResponse>();
    const previous = account.cachedConversation('800')!;
    jest.spyOn(account.im, 'getConversationInfos').mockReturnValue(pending.promise);
    push(participantUpdate('"removed_participant":[20002],"added_participant":[30003]'));
    await account.logout(); await account.login();
    knownGroup(); const removed = jest.fn(); account.on('notice.conversation.members-remove', removed);
    pending.resolve({ statusCode: 0, statusMsg: '', conversations: [{ ...previous, name: 'obsolete' }] });
    await Promise.resolve(); await Promise.resolve();
    expect(account.cachedConversation('800')?.name).toBe('fixture');
    expect(account.cachedGroup('800')?.memberList.has('20002')).toBe(true); expect(removed).not.toHaveBeenCalled();
  });

  it('processes a history command in order, but never executes send-ack controls', async () => {
    knownGroup(); const ordinary = { ...page().messages[0]!.messages[0]!, threadId: '800', conversationType: 2 };
    const control = { ...ordinary, msgId: '81', clientMessageId: 'control-81', msgType: 50001,
      content: participantUpdate('"removed_participant":[20002]') };
    account.cacheMessages([control], 'send-ack'); await Promise.resolve();
    expect(account.cachedGroup('800')?.memberList.has('20002')).toBe(true);
    account.cacheMessages([ordinary, control]); await Promise.resolve(); await Promise.resolve();
    expect(account.cachedGroup('800')?.memberList.has('20002')).toBe(false);
    if (backend !== 'memory') expect(account.cachedMessages('800').filter(message => message.msgType === 7)).toHaveLength(1);
  });

  it('handles command7 in the pull-batch path and marks the outer conversation identity', async () => {
    const group = knownGroup(); const batch = jest.spyOn(account['assembler']!, 'receiveMessageBatch');
    const removed = jest.fn(); account.on('notice.conversation.members-remove', removed);
    const manager = jest.mocked(ConnectionManager.prototype.start).mock.instances[0]! as unknown as ConnectionManager;
    manager['options'].onHistoryBatch([{
      threadId: 'outer', conversationShortId: '999', conversationType: 1, senderUid: '0',
      messageType: 50001, rawContent: participantUpdate('"removed_participant":[20002]'), text: '',
      raw: { source: 'fixture' },
    }], []);
    await Promise.resolve(); await Promise.resolve();
    expect(batch.mock.calls[0]?.[3]).toEqual(['outer']);
    expect(group.memberList.has('20002')).toBe(false); expect(removed).toHaveBeenCalledTimes(1);
  });

  it('rejects leave before any remote effect when the local conversation or deletion boundary is unavailable', async () => {
    const leave = jest.spyOn(account.im, 'leaveConversation'); const cleanup = jest.spyOn(account.im, 'deleteConversation');
    await expect(Group.bind('missing', 'missing', account).leave()).rejects.toThrow('本地会话不存在');
    if (backend === 'memory') await expect(knownGroup().leave()).rejects.toThrow('删除会话需要本地消息库');
    expect(leave).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
  });

  it('does not turn a self-removal system notice into a physical conversation deletion', () => {
    const group = knownGroup();
    group.ensureMember({ uid: '10001', role: 0 });
    const notice = jest.fn(); account.on('notice.group.member-decrease', notice);
    account['assembler']!.receiveNotice({ type: 'group.member-decrease', conversationId: '800', conversationShortId: '800',
      conversationType: 2, source: 'kick', members: [{ uid: '10001' }], operators: [{ uid: '20002' }], raw: {} });
    expect(notice).toHaveBeenCalledTimes(1); expect(notice.mock.calls[0]![0]).toMatchObject({ isSelf: true, group });
    expect(account.cachedGroup('800')).toBe(group); expect(group.pickMember('20002')).toBeDefined();
    expect(account.cachedConversation('800')).toBeDefined();
    if (backend !== 'memory') expect(account.cachedMessages('800')).toHaveLength(1);
  });

  if (backend !== 'memory') {
    it.each([0, 8, 200, 'throw'] as const)('leaves before bounded cleanup and preserves newer messages even when cleanup returns %s', async cleanupStatus => {
      const group = knownGroup();
      const leaving = deferred<{ statusCode: number; statusMsg: string }>();
      const leave = jest.spyOn(account.im, 'leaveConversation').mockReturnValue(leaving.promise);
      const cleanup = jest.spyOn(account.im, 'deleteConversation');
      if (cleanupStatus === 'throw') cleanup.mockRejectedValue(new ImProtoTransportError('network', 603,
        '/v1/conversation/delete', 'fixture lost cleanup response'));
      else cleanup.mockResolvedValue({ statusCode: cleanupStatus, statusMsg: 'fixture' });
      const warning = jest.spyOn(account.logger, 'warn').mockImplementation(() => undefined);
      const update = jest.fn(); const deleted = jest.fn();
      account.on('notice.conversation.update', update); account.on('notice.conversation.delete', deleted);
      const result = group.leave();
      expect(leave).toHaveBeenCalledWith({ threadId: '800', conversationShortId: '9007199254740993', conversationType: 2, inboxType: 3 });
      expect(cleanup).not.toHaveBeenCalled();
      account.cacheMessages([{ ...page().messages[0]!.messages[0]!, threadId: '800', conversationType: 2,
        msgId: '81', clientMessageId: 'new', ext: { 's:client_message_id': 'new' }, indexInConversation: '6', orderInConversation: '6' }]);
      leaving.resolve({ statusCode: 0, statusMsg: 'left' });
      await expect(result).resolves.toEqual({ statusCode: 0, statusMsg: 'left' });
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledWith({ threadId: '800', conversationShortId: '9007199254740993', conversationType: 2, inboxType: 3, lastMessageIndex: '5' });
      expect(account.cachedMessages('800').map(message => message.msgId)).toEqual(['81']);
      expect(account.cachedMessage('800', '80', 'server')).toMatchObject({ deleted: true });
      expect(account.cachedConversation('800')).toMatchObject({ minIndex: '5', isParticipant: true }); // No invented native setParticipant.
      expect(account.cachedGroup('800')).toBe(group); expect(group.pickMember('20002')).toBeDefined();
      expect(update).toHaveBeenCalledTimes(1); expect(deleted).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(cleanupStatus === 0 ? 0 : 1);
    });

    it('soft deletes a fully covered conversation after leaving, without a fabricated delete notice', async () => {
      const group = knownGroup();
      jest.spyOn(account.im, 'leaveConversation').mockResolvedValue({ statusCode: 0, statusMsg: '' });
      jest.spyOn(account.im, 'deleteConversation').mockResolvedValue({ statusCode: 0, statusMsg: '' });
      const update = jest.fn(); const deleted = jest.fn();
      account.on('notice.conversation.update', update); account.on('notice.conversation.delete', deleted);
      await group.leave();
      expect(account.cachedGroup('800')).toBeUndefined(); expect(account.cachedConversation('800')).toBeUndefined();
      expect(account.cachedMessage('800', '80', 'server')).toMatchObject({ deleted: true, content: '{"text":"/ping"}' });
      expect(update).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled();
      await account.logout(); await account.login();
      expect(account.cachedMessage('800', '80', 'server')).toMatchObject({ deleted: true });
    });

    it.each([3, 200, 'throw'] as const)('does not clean up or change local state when leave fails (%s)', async status => {
      const group = knownGroup(); const leave = jest.spyOn(account.im, 'leaveConversation');
      if (status === 'throw') leave.mockRejectedValue(new Error('fixture unknown leave outcome'));
      else leave.mockResolvedValue({ statusCode: status, statusMsg: 'rejected' });
      const cleanup = jest.spyOn(account.im, 'deleteConversation'); const update = jest.fn();
      account.on('notice.conversation.update', update);
      if (status === 'throw') await expect(group.leave()).rejects.toThrow('fixture unknown leave outcome');
      else await expect(group.leave()).resolves.toMatchObject({ statusCode: status });
      expect(cleanup).not.toHaveBeenCalled(); expect(account.cachedGroup('800')).toBe(group);
      expect(account.cachedMessages('800')).toHaveLength(1); expect(update).not.toHaveBeenCalled();
    });

    it.each(['leave', 'cleanup'] as const)('ignores the late %s response after logout/relogin', async phase => {
      const group = knownGroup(); const pending = deferred<{ statusCode: number; statusMsg: string }>();
      const leave = jest.spyOn(account.im, 'leaveConversation').mockResolvedValue({ statusCode: 0, statusMsg: '' });
      const cleanup = jest.spyOn(account.im, 'deleteConversation').mockReturnValue(pending.promise);
      if (phase === 'leave') leave.mockReturnValue(pending.promise);
      const result = group.leave().then(() => '', (error: Error) => error.message);
      await Promise.resolve();
      expect(cleanup).toHaveBeenCalledTimes(phase === 'leave' ? 0 : 1);
      await account.logout(); await account.login();
      const update = jest.fn(); account.on('notice.conversation.update', update);
      pending.resolve({ statusCode: 0, statusMsg: '' });
      expect(await result).toContain('账号连接已变化');
      expect(account.cachedMessages('800')).toHaveLength(1); expect(update).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledTimes(phase === 'leave' ? 0 : 1);
    });

    it('reports a local cleanup write failure after confirmed remote leave without retrying either request', async () => {
      const group = knownGroup();
      const leave = jest.spyOn(account.im, 'leaveConversation').mockResolvedValue({ statusCode: 0, statusMsg: '' });
      const cleanup = jest.spyOn(account.im, 'deleteConversation').mockResolvedValue({ statusCode: 0, statusMsg: '' });
      jest.spyOn(account['stateStore']!, 'applyConversationDeletion').mockImplementation(() => { throw new Error('fixture local write'); });
      const update = jest.fn(); account.on('notice.conversation.update', update);
      await expect(group.leave()).rejects.toThrow('fixture local write');
      expect(leave).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1);
      expect(account.cachedMessages('800')).toHaveLength(1); expect(account.cachedGroup('800')).toBe(group);
      expect(update).not.toHaveBeenCalled();
    });

    it('does not hide an unexpected local error as an ordinary cleanup network failure', async () => {
      const group = knownGroup();
      jest.spyOn(account.im, 'leaveConversation').mockResolvedValue({ statusCode: 0, statusMsg: '' });
      jest.spyOn(account.im, 'deleteConversation').mockRejectedValue(new TypeError('fixture programming error'));
      await expect(group.leave()).rejects.toThrow('fixture programming error');
      expect(account.cachedMessages('800')).toHaveLength(1);
    });
  }

  it('treats repeated 50005 as participation updates, keeping group instances, members and messages', async () => {
    account.applyConversationInfo({ conversationId: '700', conversationShortId: '700', conversationType: 2,
      isGroup: true, name: 'group', isParticipant: true, lastMessageTime: 0, members: [{ uid: '20002', role: 0 }] });
    account.cacheMessages([{ ...page().messages[0]!.messages[0]!, threadId: '700', conversationType: 2 }]);
    const group = account.cachedGroup('700')!;
    const updates = jest.fn(); const deleted = jest.fn(); const members = jest.fn();
    account.on('notice.conversation.update', updates); account.on('notice.conversation.delete', deleted);
    account.on('notice.group.member-decrease', members);
    for (let count = 1; count <= 2; count++) {
      push('{"conversation_id":"not-the-target","last_message_index":9999}', 50005, '700');
      await Promise.resolve();
      expect(updates).toHaveBeenCalledTimes(count);
      expect(updates.mock.calls[count - 1]![0]).toMatchObject({ account, conversationId: '700', conversation: { isParticipant: false } });
      expect(account.cachedGroup('700')).toBe(group); expect(group.isParticipant).toBe(false);
      expect(group.pickMember('20002')).toBeDefined();
      if (backend !== 'memory') expect(account.cachedMessages('700')).toHaveLength(1);
    }
    expect(deleted).not.toHaveBeenCalled(); expect(members).not.toHaveBeenCalled();
    push('{}', 50005, 'missing'); await Promise.resolve(); expect(updates).toHaveBeenCalledTimes(2);
    expect(account.cachedConversation('missing')).toBeUndefined();
  });

  it.each(['retained', 'all', 'already-min'] as const)('applies passive deletion %s with independent min-index/delete callbacks', async scenario => {
    account.applyConversationInfo({ ...details().conversations[0]!, minIndex: scenario === 'already-min' ? '5' : '0',
      lastMessageIndex: scenario === 'all' ? '5' : '6' });
    const old = page().messages[0]!.messages[0]!;
    account.cacheMessages([old]);
    if (scenario !== 'all') account.cacheMessages([{ ...old, msgId: '81', clientMessageId: 'client-81',
      ext: { 's:client_message_id': 'client-81' }, indexInConversation: '6', orderInConversation: '6' }]);
    const deleted = jest.fn(); const min = jest.fn(); const update = jest.fn(); const message = jest.fn();
    account.on('notice.conversation.delete', deleted); account.on('notice.conversation.min-index', min);
    account.on('notice.conversation.update', update); account.on('message', message);
    push(`{"command_type":3,"conversation_id":"${id}","last_message_index":5}`);
    await Promise.resolve();
    expect(deleted).toHaveBeenCalledTimes(scenario === 'all' ? 1 : 0);
    expect(min).toHaveBeenCalledTimes(scenario === 'all' ? 0 : 1);
    expect(update).toHaveBeenCalledTimes(scenario === 'retained' ? 1 : 0);
    const event = scenario === 'all' ? deleted.mock.calls[0]![0] : min.mock.calls[0]![0];
    expect(event).toMatchObject({ account, conversationId: id, conversationType: 1 });
    if (scenario !== 'all') expect(event.minIndex).toBe('5');
    expect(account.cachedConversation(id)?.minIndex).toBe(scenario === 'retained' ? '5' : undefined);
    if (backend !== 'memory') {
      expect(account.cachedMessage(id, '80', 'server')).toMatchObject({ deleted: true });
      expect(account.cachedMessages(id).map(row => row.msgId)).toEqual(scenario === 'all' ? [] : ['81']);
    }
    expect(message).not.toHaveBeenCalled();
  });

  it('keeps unknown/malformed delete commands observable without creating or clearing state', async () => {
    account.applyConversationInfo(details().conversations[0]!); account.cacheMessages(page().messages[0]!.messages);
    const deleted = jest.fn(); const min = jest.fn(); const raw = jest.fn();
    account.on('notice.conversation.delete', deleted); account.on('notice.conversation.min-index', min);
    account.on('notice.im.command', raw);
    push('{"command_type":3,"conversation_id":"missing","last_message_index":1}');
    push(`{"command_type":3,"conversation_id":"${id}","last_message_index":"5"}`);
    await Promise.resolve();
    expect(deleted).not.toHaveBeenCalled(); expect(min).not.toHaveBeenCalled(); expect(raw).toHaveBeenCalledTimes(2);
    expect(account.cachedConversation('missing')).toBeUndefined(); expect(account.cachedConversation(id)).toBeDefined();
    if (backend !== 'memory') expect(account.cachedMessages(id)).toHaveLength(1);
  });

  it('drops queued passive callbacks on logout, and projection alone never physically clears history', async () => {
    account.applyConversationInfo({ ...details().conversations[0]!, minIndex: '0', lastMessageIndex: '6' });
    account.cacheMessages([{ ...page().messages[0]!.messages[0]!, indexInConversation: '6' }]);
    account['assembler']!.receiveNotice({ type: 'conversation.delete', conversationId: id, conversationType: 1, raw: {} });
    expect(account.cachedConversation(id)).toBeDefined();
    const removed = jest.fn(); const min = jest.fn(); const update = jest.fn();
    account.on('notice.conversation.delete', removed); account.on('notice.conversation.min-index', min);
    account.on('notice.conversation.update', update);
    push(`{"command_type":620,"conversation_id":"${id}","last_message_index":5}`);
    await account.logout(); await account.login();
    expect(removed).not.toHaveBeenCalled(); expect(min).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it('applies historical DeleteConv before projecting the outer conversation batch', async () => {
    account.applyConversationInfo({ ...details().conversations[0]!, minIndex: '0', lastMessageIndex: '5' });
    account.applyConversationInfo({ ...details().conversations[0]!, conversationId: 'outer', name: 'outer' });
    account.cacheMessages(page().messages[0]!.messages);
    const batch = jest.fn(); const deleted = jest.fn(); account.on('notice.message.batch-update', batch);
    account.on('notice.conversation.delete', deleted);
    const manager = jest.mocked(ConnectionManager.prototype.start).mock.instances[0]! as unknown as ConnectionManager;
    manager['options'].onHistoryBatch([{ threadId: 'outer', conversationShortId: '999', conversationType: 1,
      senderUid: '0', text: '', rawContent: `{"command_type":1010,"conversation_id":"${id}","last_message_index":5}`,
      messageType: 50001, raw: {} }], []);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0].updates.map((row: { conversation: { conversationId: string } }) => row.conversation.conversationId)).toEqual(['outer']);
    await Promise.resolve(); expect(deleted).toHaveBeenCalledTimes(1);
    expect(account.cachedConversation(id)).toBeUndefined();
  });

  it('keeps 50005 in a pull batch as a conversation-only update with no standalone or delete event', async () => {
    account.applyConversationInfo({ ...details().conversations[0]!, isParticipant: true });
    const batch = jest.fn(); const update = jest.fn(); const deleted = jest.fn();
    account.on('notice.message.batch-update', batch); account.on('notice.conversation.update', update);
    account.on('notice.conversation.delete', deleted);
    const manager = jest.mocked(ConnectionManager.prototype.start).mock.instances[0]! as unknown as ConnectionManager;
    manager['options'].onHistoryBatch([{ threadId: id, conversationShortId: '700', conversationType: 1,
      senderUid: '0', text: '', rawContent: '{}', messageType: 50005, raw: {} }], []);
    await Promise.resolve();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toMatchObject({ updates: [{ conversation: { conversationId: id, isParticipant: false }, messages: [] }] });
    expect(update).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled();
    if (backend !== 'memory') {
      await account.logout(); await account.login();
      expect(account.cachedConversation(id)).toMatchObject({ isParticipant: false });
    }
  });

  it('processes direct history commands in order, without caching the control message as ordinary content', async () => {
    account.applyConversationInfo({ ...details().conversations[0]!, minIndex: '0', lastMessageIndex: '5' });
    const deleted = jest.fn(); account.on('notice.conversation.delete', deleted);
    const old = page().messages[0]!.messages[0]!;
    account.cacheMessages([old, { ...old, msgId: 'control', clientMessageId: 'control',
      content: `{"command_type":620,"conversation_id":"${id}","last_message_index":5}`, msgType: 50001 }]);
    await Promise.resolve(); expect(deleted).toHaveBeenCalledTimes(1);
    expect(account.cachedConversation(id)).toBeUndefined();
    if (backend !== 'memory') {
      expect(account.cachedMessage(id, old.msgId, 'server')).toMatchObject({ deleted: true });
      expect(account.cachedMessage(id, 'control', 'server')).toBeUndefined();
    }
  });

  it.each(['friend', 'stranger', 'group'] as const)('bounds %s deletion to stored messages, rejecting it when local storage is disabled', async kind => {
    const conversationId = kind === 'group' ? '800' : id;
    const type = kind === 'group' ? 2 : 1;
    account.applyConversationInfo({ conversationId, conversationShortId: '700', conversationType: type, inboxType: 3,
      isGroup: type === 2, name: 'fixture', members: [], lastMessageTime: 0, minIndex: '0',
      mode: kind === 'stranger' ? 2 : 0, coreExt: kind === 'stranger' ? { stranger: '10001' } : {} });
    const old = { ...page().messages[0]!.messages[0]!, threadId: conversationId, conversationType: type };
    account.cacheMessages([old]);
    const contact = kind === 'group' ? Group.bind(conversationId, 'outdated', account)
      : kind === 'stranger' ? Stranger.bind('20002', conversationId, 'outdated', account)
        : Friend.bind('20002', conversationId, 'outdated', account);
    const pending = deferred<{ statusCode: number; statusMsg: string }>();
    const send = jest.spyOn(account.im, 'deleteConversation').mockReturnValue(pending.promise);
    const removed = jest.fn(); account.on('notice.conversation.delete', removed);
    const deletion = contact.deleteConversation();
    if (backend === 'memory') {
      await expect(deletion).rejects.toThrow('删除会话需要本地消息库');
      expect(send).not.toHaveBeenCalled(); return;
    }
    expect(send).toHaveBeenCalledWith({ threadId: conversationId, conversationShortId: '700', conversationType: type,
      inboxType: 3, lastMessageIndex: '5' });
    account.cacheMessages([{ ...old, msgId: '81', clientMessageId: 'client-81', ext: { 's:client_message_id': 'client-81' },
      indexInConversation: '6', orderInConversation: '6' }]);
    pending.resolve({ statusCode: 0, statusMsg: '' });
    await expect(deletion).resolves.toMatchObject({ statusCode: 0 });
    expect(account.cachedConversation(conversationId)).toMatchObject({ minIndex: '5', lastMessageIndex: '6' });
    expect(account.cachedMessages(conversationId).map(message => message.msgId)).toEqual(['81']);
    expect(account.cachedMessage(conversationId, '80', 'server')).toMatchObject({ deleted: true });
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0]![0]).toMatchObject({ account, conversationId, type: 'conversation.delete' });
  });

  if (backend !== 'memory') {
  it.each([0, 8, 200])('changes local stranger state only for a successful delete response (%s)', async statusCode => {
    const info = details().conversations[0]!;
    account.applyConversationInfo({ ...info, minIndex: '0', settingExt: { 'a:cell_sort_time': '1' } });
    account.cacheMessages(page().messages[0]!.messages);
    await account.getStrangerList();
    const contact = account.sl.get('20002')!;
    const notice = jest.fn(); account.on('notice.conversation.delete', notice);
    jest.spyOn(account.im, 'deleteConversation').mockResolvedValue({ statusCode, statusMsg: 'fixture' });
    await expect(contact.deleteConversation()).resolves.toMatchObject({ statusCode });
    if (statusCode === 0) {
      expect(account.sl.size).toBe(0); expect(account.cachedConversation(id)).toBeUndefined();
      expect(await account.getStrangerList()).toEqual([]); expect(account.cachedMessages(id)).toEqual([]);
    } else {
      expect(account.sl.get('20002')).toBe(contact); expect(account.cachedMessages(id)).toHaveLength(1);
    }
    expect(notice).toHaveBeenCalledTimes(statusCode === 0 ? 1 : 0);
  });

  it('rejects a stale successful stranger deletion after relogin without applying its boundary or event', async () => {
    account.applyConversationInfo(details().conversations[0]!); account.cacheMessages(page().messages[0]!.messages);
    const contact = Stranger.bind('20002', id, '700', account);
    const pending = deferred<{ statusCode: number; statusMsg: string }>();
    jest.spyOn(account.im, 'deleteConversation').mockReturnValue(pending.promise);
    const deletion = contact.deleteConversation().then(() => '', (error: Error) => error.message);
    await account.logout(); await account.login();
    const notice = jest.fn(); account.on('notice.conversation.delete', notice);
    pending.resolve({ statusCode: 0, statusMsg: '' });
    expect(await deletion).toContain('账号连接已变化');
    expect(account.cachedMessages(id)).toHaveLength(1); expect(notice).not.toHaveBeenCalled();
  });
  }

  it('does not create or fetch a missing Friend conversation merely to delete it', async () => {
    const ensure = jest.spyOn(account, 'ensureFriendConversation');
    const send = jest.spyOn(account.im, 'deleteConversation');
    await expect(Friend.bind('22', 'missing', '', account).deleteConversation()).rejects.toThrow('本地会话不存在');
    expect(ensure).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('saves skeletons before asynchronous deduplicated details, and publishes batches without passive replies', async () => {
    const pending = deferred<ConversationInfoListResponse>();
    const detail = jest.spyOn(ImService.prototype, 'getConversationInfos').mockReturnValue(pending.promise);
    const response = page(); response.messages.push({ ...response.messages[0]!, version: '80', badgeCount: 1, messages: [] });
    jest.spyOn(ImService.prototype, 'getRecentStrangerMessages').mockResolvedValue(response);
    const batch = jest.fn(); const incoming = jest.fn(); const notice = jest.fn();
    account.on('notice.message.batch-update', batch); account.on('message', incoming); account.on('notice.conversation.update', notice);
    await expect(account.refreshStrangerConversations()).resolves.toMatchObject({ statusCode: 0, pages: 1, conversations: 2 });
    expect(detail).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledWith([{ threadId: id, conversationShortId: '700', conversationType: 1, inboxType: 1 }]);
    expect(account.cachedConversation(id)).toMatchObject({ isInStrangerBox: true, strangerVersion: '80', badgeCount: 3, name: '', coreExt: { stranger: '10001' } });
    expect(account.sl.has('20002')).toBe(true); expect(account.fl.has('20002')).toBe(false);
    expect(batch).toHaveBeenCalledTimes(1); expect(incoming).not.toHaveBeenCalled(); expect(notice).not.toHaveBeenCalled();
    const updated = new Promise<void>(resolve => account.once('notice.conversation.update', () => resolve()));
    pending.resolve(details()); await updated;
    expect(account.cachedConversation(id)).toMatchObject({ name: 'detail', coreVersion: '12', strangerVersion: '80', badgeCount: 3, isInStrangerBox: true });
    if (backend !== 'memory') expect(account.cachedMessages(id)).toHaveLength(1);
  });

  it('uses the real account generation to reject an old successful page after logout and relogin', async () => {
    const pending = deferred<RecentStrangerMessagesResponse>();
    const fetch = jest.spyOn(ImService.prototype, 'getRecentStrangerMessages').mockReturnValueOnce(pending.promise);
    const detail = jest.spyOn(ImService.prototype, 'getConversationInfos').mockResolvedValue(details());
    const outcome = account.refreshStrangerConversations().then(() => '', (error: Error) => error.message);
    await account.logout(); await account.login();
    pending.resolve(page()); expect(await outcome).not.toBe('');
    expect(account.cachedConversation(id)).toBeUndefined(); expect(detail).not.toHaveBeenCalled();
    fetch.mockResolvedValue({ ...page(), messages: [] });
    await account.loadMoreStrangerConversations();
    expect(fetch).toHaveBeenLastCalledWith({ inboxType: 1, latestStrangerVersion: '-1', earliestStrangerVersion: '0' });
  });

  it('drops old details after relogin, but restores durable cursors for the new sync instance', async () => {
    const pending = deferred<ConversationInfoListResponse>();
    jest.spyOn(ImService.prototype, 'getConversationInfos').mockReturnValueOnce(pending.promise);
    const fetch = jest.spyOn(ImService.prototype, 'getRecentStrangerMessages').mockResolvedValue(page());
    await account.refreshStrangerConversations(); await account.logout(); await account.login();
    const notice = jest.fn(); account.on('notice.conversation.update', notice);
    pending.resolve(details()); for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(notice).not.toHaveBeenCalled();
    expect(account.cachedConversation(id)?.name).not.toBe('detail');
    fetch.mockResolvedValue({ ...page(), messages: [] });
    await account.refreshStrangerConversations();
    expect(fetch).toHaveBeenLastCalledWith({ inboxType: 1, latestStrangerVersion: '9223372036854775807', earliestStrangerVersion: backend === 'memory' ? '0' : '90' });
  });

  it('allows confirmed details to remove box membership despite inbox 1 without manufacturing a friend-increase event', async () => {
    const pending = deferred<ConversationInfoListResponse>();
    jest.spyOn(ImService.prototype, 'getConversationInfos').mockReturnValue(pending.promise);
    jest.spyOn(ImService.prototype, 'getRecentStrangerMessages').mockResolvedValue(page());
    await account.refreshStrangerConversations(); expect(account.sl.has('20002')).toBe(true);
    const increased = jest.fn(); account.on('notice.friend.increase', increased);
    const updated = new Promise<void>(resolve => account.once('notice.conversation.update', () => resolve()));
    pending.resolve(details(false)); await updated;
    expect(account.cachedConversation(id)?.isInStrangerBox).toBe(false);
    expect(account.sl.has('20002')).toBe(false); expect(increased).not.toHaveBeenCalled();
  });

  it('does not commit a page if a synchronous batch listener logs out', async () => {
    const pendingDetails = deferred<ConversationInfoListResponse>();
    jest.spyOn(ImService.prototype, 'getConversationInfos').mockReturnValue(pendingDetails.promise);
    const fetch = jest.spyOn(ImService.prototype, 'getRecentStrangerMessages').mockResolvedValue(page());
    let logout: Promise<void> | undefined;
    account.once('notice.message.batch-update', () => { logout = account.logout(); });
    await expect(account.refreshStrangerConversations()).rejects.toThrow();
    await logout; await account.login();
    pendingDetails.resolve(details());
    fetch.mockResolvedValue({ ...page(), messages: [] });
    await account.refreshStrangerConversations();
    expect(fetch).toHaveBeenLastCalledWith({ inboxType: 1, latestStrangerVersion: '9223372036854775807', earliestStrangerVersion: '0' });
  });

  it('keeps page success independent of a rejected detail request and only retries details on a later explicit refresh', async () => {
    const warning = jest.spyOn(account.logger, 'warn').mockImplementation(() => undefined);
    const detail = jest.spyOn(ImService.prototype, 'getConversationInfos').mockRejectedValue(new Error('offline detail failure'));
    jest.spyOn(ImService.prototype, 'getRecentStrangerMessages').mockResolvedValue(page());
    await expect(account.refreshStrangerConversations()).resolves.toMatchObject({ statusCode: 0 });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(detail).toHaveBeenCalledTimes(1); expect(warning).toHaveBeenCalledTimes(1);
    expect(account.cachedConversation(id)?.isInStrangerBox).toBe(true);
    await account.refreshStrangerConversations();
    expect(detail).toHaveBeenCalledTimes(2);
  });
});
