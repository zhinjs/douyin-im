import type { Account } from '../account.js';
import type { ConversationReadSummary } from '../../services/im/read-state.js';
import type { MessageReadPrivacyResponse } from '../../services/im/user-settings.js';
import { Friend } from './friend.js';
import { Group } from './group.js';
import { Stranger } from './stranger.js';

function fixture(kind: 'friend' | 'group' | 'stranger' = 'group') {
  const id = kind === 'group' ? '700' : '0:1:11:22';
  const summary: ConversationReadSummary = { conversationId: id, conversationShortId: '9007199254740993',
    conversationType: kind === 'group' ? 2 : 1, clientMessageId: 'client', serverMessageId: '9007199254740995',
    createTime: '1789123456789', isAllRead: true,
    readUsers: [{ uid: '22', secUid: 'sec22', readIndex: '10', minIndex: '0' },
      { uid: '33', secUid: 'sec33', readIndex: '11', minIndex: '0' }] };
  const privacy: MessageReadPrivacyResponse = { statusCode: 0, statusMsg: '', enableReadState: true, currentUserSwitch: 0,
    messages: [{ serverMessageId: summary.serverMessageId, errorCode: 0, on: ['22'], off: ['22'] }] };
  const cachedReadSummary = jest.fn<ConversationReadSummary | undefined, [string]>(() => structuredClone(summary));
  const getMessageReadPrivacy = jest.fn<Promise<MessageReadPrivacyResponse>, [unknown, boolean]>().mockResolvedValue(privacy);
  const ensureFriendConversation = jest.fn();
  const account = { online: true, im: {}, cachedReadSummary, getMessageReadPrivacy, ensureFriendConversation } as unknown as Account;
  const contact = kind === 'group' ? Group.bind(id, '', account) : kind === 'friend'
    ? Friend.bind('22', id, '', account) : Stranger.bind('22', id, '', account);
  return { summary, privacy, account, contact, cachedReadSummary, getMessageReadPrivacy, ensureFriendConversation };
}

describe('contact privacy-filtered read receipt', () => {
  it.each(['friend', 'group', 'stranger'] as const)('combines native metadata and privacy for %s without preparing a contact address', async kind => {
    const f = fixture(kind);
    const result = await f.contact.getReadReceipt(true);
    expect(f.getMessageReadPrivacy).toHaveBeenCalledWith([{
      serverMessageId: '9007199254740995', conversationId: f.contact.threadId,
      conversationShortId: '9007199254740993', conversationType: f.summary.conversationType, createTime: 1789123456789,
    }], true);
    expect(result).toMatchObject({ raw: f.summary, privacy: f.privacy, readUsers: [{ uid: '22' }], isAllRead: false });
    expect(f.ensureFriendConversation).not.toHaveBeenCalled();
    result!.readUsers[0]!.secUid = 'mutated';
    expect(result!.raw.readUsers[0]!.secUid).toBe('sec22');
    expect(f.summary.readUsers[0]!.secUid).toBe('sec22');
  });

  it('does not request anything when there is no retained self-message summary', async () => {
    const f = fixture(); f.cachedReadSummary.mockReturnValue(undefined);
    await expect(f.contact.getReadReceipt()).resolves.toBeUndefined();
    expect(f.getMessageReadPrivacy).not.toHaveBeenCalled();
  });

  it.each(['failure', 'disabled', 'missing', 'policy-error'] as const)('hides readers for %s while retaining raw data and the actual privacy response', async mode => {
    const f = fixture();
    if (mode === 'failure') { f.privacy.statusCode = 8; f.privacy.statusMsg = 'not logged in'; }
    if (mode === 'disabled') { f.privacy.currentUserSwitch = -1; f.privacy.enableReadState = false; }
    if (mode === 'missing') f.privacy.messages = [];
    if (mode === 'policy-error') f.privacy.messages[0]!.errorCode = 2;
    const result = await f.contact.getReadReceipt();
    expect(result).toMatchObject({ readUsers: [], isAllRead: false, privacy: f.privacy });
    expect(result!.raw.readUsers).toHaveLength(2);
  });

  it.each(['logout', 'connection', 'removed', 'reader', 'message'] as const)('rejects a pending projection after %s changes', async mode => {
    const f = fixture();
    let finish!: (value: MessageReadPrivacyResponse) => void;
    f.getMessageReadPrivacy.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.contact.getReadReceipt();
    if (mode === 'logout') Object.assign(f.account, { online: false });
    if (mode === 'connection') Object.assign(f.account, { im: {} });
    if (mode === 'removed') f.cachedReadSummary.mockReturnValue(undefined);
    if (mode === 'reader') f.summary.readUsers[0]!.readIndex = '12';
    if (mode === 'message') f.summary.serverMessageId = '9007199254740997';
    finish(f.privacy);
    await expect(pending).rejects.toThrow(mode === 'logout' || mode === 'connection' ? '账号连接已变化' : '摘要已变化');
  });

  it('does not request privacy while offline and does not swallow transport errors', async () => {
    const f = fixture();
    Object.assign(f.account, { online: false });
    await expect(f.contact.getReadReceipt()).rejects.toThrow('账号未上线');
    expect(f.getMessageReadPrivacy).not.toHaveBeenCalled();
    Object.assign(f.account, { online: true });
    f.getMessageReadPrivacy.mockRejectedValue(new Error('transport failed'));
    await expect(f.contact.getReadReceipt()).rejects.toThrow('transport failed');
  });
});
