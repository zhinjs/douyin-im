import { Account } from '../account.js';
import { Friend } from './friend.js';
import { Stranger } from './stranger.js';
import { Member } from './member.js';
import type { Group } from './group.js';

describe('social contact actions', () => {
  it('binds follow to the current account for friends, strangers and group members', async () => {
    const setUserFollowed = jest.fn().mockResolvedValue({ statusCode: 0, followStatus: 4 });
    const account = {
      im: { setUserFollowed }, runVerifiedAction: async (_target: unknown, action: () => Promise<unknown>, publish?: (result: unknown) => void) => {
        const result = await action(); publish?.(result); return result;
      },
      userRelations: new Map(), getUserRelation: Account.prototype.getUserRelation, updateUserRelation: Account.prototype.updateUserRelation,
    } as unknown as Account;
    const friend = Friend.bind('22', '', '', account, { secUid: 'friend-sec' });
    const stranger = Stranger.bind('33', '', '', account, { secUid: 'stranger-sec' });
    const member = Member.bind({ uid: '44', secUid: 'member-sec', role: 0 }, { account } as Group);
    for (const contact of [friend, stranger, member]) {
      await contact.setFollowed();
      expect(contact.followStatus).toBe(4);
    }
    expect(setUserFollowed.mock.calls.map(([input]) => input)).toEqual([
      { uid: '22', secUid: 'friend-sec', followed: true },
      { uid: '33', secUid: 'stranger-sec', followed: true },
      { uid: '44', secUid: 'member-sec', followed: true },
    ]);
    setUserFollowed.mockResolvedValue({ statusCode: 8, followStatus: 0 });
    await friend.setFollowed(false);
    expect(friend.followStatus).toBe(4);
  });

  it('keeps message reactions bound to the same account', async () => {
    const modifyMessageReaction = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '' });
    const account = {
      resolveShortId: (_threadId: string, hint?: string) => hint,
      im: { myUid: '11', modifyMessageReaction },
    } as unknown as Account;
    const friend = Friend.bind('22', '0:1:11:22', '9001', account);

    await friend.reactMsg('9988', '[爱心]', false);

    expect(modifyMessageReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationShortId: '9001',
        serverMessageId: '9988',
        emoji: '[爱心]',
        enabled: false,
        operatorUid: '11',
      }),
    );
  });

  it('keeps stranger conversations out of friend semantics and uses inbox 1', async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      serverMessageId: '1',
    });
    const account = {
      resolveShortId: (_threadId: string, hint?: string) => hint,
      online: true, im: {},
      outbound: { sendMessage },
      getUserRelation: jest.fn(),
    } as unknown as Account;
    const stranger = Stranger.bind('33', '0:1:11:33', '9002', account, {
      nickname: '陌生人',
    });

    await stranger.sendMsg('你好');

    expect(stranger).toMatchObject({ uid: '33', nickname: '陌生人', inboxType: 1 });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inboxType: 1, message: '你好' }),
    );
  });

  it('uses stranger-box read and shared conversation-delete actions, keeping block state on each contact', async () => {
    const im = {
      deleteConversation: jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '' }),
      markStrangerConversationRead: jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '' }),
      setUserBlocked: jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '' }),
    };
    const account = {
      online: true,
      cachedConversation: (id: string) => ({ conversationId: id, conversationShortId: '9002', conversationType: 1, inboxType: 3 }),
      getConversationDeletionBoundary: jest.fn().mockReturnValue('81'),
      applyConversationDeletion: jest.fn(),
      resolveShortId: (_threadId: string, hint?: string) => hint,
      im,
      userRelations: new Map(), getUserRelation: Account.prototype.getUserRelation, updateUserRelation: Account.prototype.updateUserRelation,
    } as unknown as Account;
    const friend = Friend.bind('22', '0:1:11:22', '9001', account, { secUid: 'friend-sec' });
    const stranger = Stranger.bind('33', '0:1:11:33', '9002', account, { secUid: 'stranger-sec' });
    account.readUserProfile = jest.fn().mockImplementation(async uid => {
      account.updateUserRelation(uid, { blocked: uid === '22' });
      return { uid, nickname: 'fixture profile' };
    });

    await stranger.markRead();
    await stranger.deleteConversation();
    await friend.setBlocked();
    await stranger.setBlocked(false);

    expect(im.markStrangerConversationRead).toHaveBeenCalledWith('9002');
    expect(im.deleteConversation).toHaveBeenCalledWith({ threadId: '0:1:11:33', conversationShortId: '9002',
      conversationType: 1, inboxType: 3, lastMessageIndex: '81' });
    expect(account.applyConversationDeletion).toHaveBeenCalledWith('0:1:11:33', 1, '81');
    expect(im.setUserBlocked).toHaveBeenNthCalledWith(1, {
      uid: '22', secUid: 'friend-sec', blocked: true,
    });
    expect(im.setUserBlocked).toHaveBeenNthCalledWith(2, {
      uid: '33', secUid: 'stranger-sec', blocked: false,
    });
    expect(friend.blocked).toBe(true);
    expect(stranger.blocked).toBe(false);
  });
});
