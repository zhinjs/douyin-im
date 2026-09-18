import type { Account } from '../account.js';
import { GroupJoinRequestStatus } from '../../services/im/types.js';
import { Group } from './group.js';

function stubAccount(
  im: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Account {
  return {
    im,
    resolveShortId: (_threadId: string, hint?: string) => hint,
    cachedGroupMembers: () => undefined,
    replaceCachedGroupMembers: () => undefined,
    upsertCachedGroupMembers: () => undefined,
    removeCachedGroupMembers: () => undefined,
    patchCachedConversation: () => undefined,
    ...extra,
  } as unknown as Account;
}

describe('Group members', () => {
  const conversation = { conversationId: '70001', conversationShortId: '9007199254740993', conversationType: 2,
    isGroup: true, name: 'fixture', inboxType: 3, lastMessageTime: 0 };

  it('invites with the bound address without requiring a local conversation or publishing members', async () => {
    const response = { statusCode: 0, statusMsg: '', succeededUids: ['22'], failedUids: [] };
    const invite = jest.fn().mockResolvedValue(response);
    const account = stubAccount({ inviteConversationParticipants: invite }, { online: true });
    const group = Group.bind('70001', '9007199254740993', account);
    await expect(group.inviteMembers(['22'])).resolves.toBe(response);
    expect(group.pickMember('22')).toBeUndefined();
    expect(invite).toHaveBeenCalledWith({ threadId: '70001', conversationShortId: '9007199254740993',
      conversationType: 2, inboxType: 0, uids: ['22'] });
  });

  it('refuses an offline invitation before sending', async () => {
    const invite = jest.fn();
    const group = Group.bind('70001', '70001', stubAccount({ inviteConversationParticipants: invite }, { online: false }));
    await expect(group.inviteMembers(['22'])).rejects.toThrow('账号连接已变化');
    expect(invite).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects the old invitation result across logout/replacement (replacement=%s)', async replacement => {
    const response = { statusCode: 0, statusMsg: '', succeededUids: ['22'], failedUids: [] };
    let finish!: (value: typeof response) => void;
    const invite = jest.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const account = stubAccount({ inviteConversationParticipants: invite }, { online: true });
    const group = Group.bind('70001', '70001', account);
    const pending = group.inviteMembers(['22']);
    const rejected = expect(pending).rejects.toThrow('账号连接已变化');
    Object.assign(account, replacement ? { im: {} } : { online: false });
    finish(response); await rejected;
    expect(group.pickMember('22')).toBeUndefined(); expect(invite).toHaveBeenCalledTimes(1);
  });

  it('uses the cached conversation address for remove and does not delete members based on an acknowledgement', async () => {
    const response = { statusCode: 0, statusMsg: 'OK', succeededUids: ['22'], failedUids: [] };
    const remove = jest.fn().mockResolvedValue(response), removeCachedGroupMembers = jest.fn();
    const account = stubAccount({ removeConversationParticipants: remove }, { online: true,
      cachedConversation: () => conversation, removeCachedGroupMembers });
    const group = Group.bind('70001', 'stale-short', account, { members: [{ uid: '22', role: 0 }] });
    const member = group.pickMember('22');
    await expect(group.removeMembers(['22'])).resolves.toBe(response);
    expect(group.pickMember('22')).toBe(member);
    expect(removeCachedGroupMembers).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith({ threadId: '70001', conversationShortId: conversation.conversationShortId,
      conversationType: 2, inboxType: 3, uids: ['22'] });
  });

  it.each(['offline', 'unknown', 'not-group'] as const)('does not send remove for %s local state', async state => {
    const remove = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '', succeededUids: [], failedUids: [] });
    const account = stubAccount({ removeConversationParticipants: remove }, { online: state !== 'offline',
      cachedConversation: () => state === 'unknown' ? undefined : { ...conversation, conversationType: state === 'not-group' ? 1 : 2 } });
    const group = Group.bind('70001', '70001', account);
    await expect(group.removeMembers(['22'])).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not publish a late remove result across logout/replacement (replacement=%s)', async replacement => {
    const response = { statusCode: 0, statusMsg: 'OK', succeededUids: ['22'], failedUids: [] };
    let finish!: (value: typeof response) => void;
    const remove = jest.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const removeCachedGroupMembers = jest.fn();
    const account = stubAccount({ removeConversationParticipants: remove }, { online: true,
      cachedConversation: () => conversation, removeCachedGroupMembers });
    const group = Group.bind('70001', '70001', account, { members: [{ uid: '22', role: 0 }] });
    const member = group.pickMember('22');
    const pending = group.removeMembers(['22']);
    const rejected = expect(pending).rejects.toThrow('账号连接已变化');
    Object.assign(account, replacement ? { im: {} } : { online: false });
    finish(response); await rejected;
    expect(group.pickMember('22')).toBe(member); expect(removeCachedGroupMembers).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('uses a complete local member snapshot and refreshes only when forced', async () => {
    const listConversationParticipants = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      members: [{ uid: '20', role: 2, nickname: '远端成员' }],
    });
    const replaceCachedGroupMembers = jest.fn();
    const account = stubAccount(
      { listConversationParticipants, resolveUsers: jest.fn().mockResolvedValue([]) },
      {
        cachedGroupMembers: jest.fn().mockReturnValue([
          { uid: '10', role: 0, nickname: '本地成员' },
        ]),
        replaceCachedGroupMembers,
      },
    );
    const group = Group.bind('70001', '70001', account);

    expect([...(await group.getMemberList()).keys()]).toEqual(['10']);
    expect(listConversationParticipants).not.toHaveBeenCalled();

    expect([...(await group.getMemberList(true)).keys()]).toEqual(['20']);
    expect(listConversationParticipants).toHaveBeenCalledTimes(1);
    expect(replaceCachedGroupMembers).toHaveBeenCalledWith('70001', [
      expect.objectContaining({ uid: '20' }),
    ]);
  });

  it('refreshes stable Member objects and enriches their display data', async () => {
    const listConversationParticipants = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      members: [
        { uid: '11', secUid: 'owner', role: 1, alias: '群主' },
        { uid: '22', secUid: 'member', role: 0, alias: '成员' },
      ],
    });
    const resolveUsers = jest.fn().mockResolvedValue([{
      uid: '22',
      secUid: 'member',
      nickname: '成员昵称',
      avatarThumb: 'member.webp',
    }]);
    const account = stubAccount({
      listConversationParticipants,
      resolveUsers,
    });
    const group = Group.bind(
      '70001',
      '70001',
      account,
      { members: [{ uid: '22', secUid: 'member', role: 0 }] },
    );
    const before = group.pickMember('22');

    const members = await group.getMemberList();
    const member = group.pickMember('22');

    expect(member).toBe(before);
    expect(members.get('22')).toBe(member);
    expect(member).toMatchObject({
      alias: '成员',
      nickname: '成员昵称',
      avatar: 'member.webp',
      role: 0,
      isAdmin: false,
    });
    await expect(member?.refresh()).resolves.toBe(member);
    expect(listConversationParticipants).toHaveBeenCalledTimes(2);
  });

  it('keeps the complete protocol member list when optional profile enrichment fails', async () => {
    const listConversationParticipants = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      members: [
        { uid: '11', secUid: 'owner', role: 1, alias: '群主' },
        { uid: '22', secUid: 'member', role: 0, alias: '成员' },
      ],
    });
    const account = stubAccount({
      listConversationParticipants,
      resolveUsers: jest.fn().mockRejectedValue(new Error('profile service unavailable')),
    });
    const group = Group.bind('70001', '70001', account);

    const members = await group.getMemberList();

    expect([...members.keys()]).toEqual(['11', '22']);
    expect(members.get('22')).toMatchObject({ uid: '22', alias: '成员', role: 0 });
  });

  it('keeps invitations separate from join-request approval', async () => {
    const inviteConversationParticipants = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      succeededUids: ['22'],
      failedUids: [],
    });
    const getGroupJoinRequestData = jest.fn().mockResolvedValue({
      statusCode: 0,
      statusMsg: '',
      requests: [{
        requestId: '9001',
        applicantUid: '33',
        groupShortId: '70001',
        conversationType: 2,
        status: 1,
        reason: '想加入',
      }, {
        requestId: '9002',
        applicantUid: '44',
        groupShortId: '70001',
        conversationType: 2,
        status: 1,
      }],
    });
    const reviewGroupJoinRequest = jest.fn().mockImplementation(
      async ({ requestId, status }: { requestId: string; status: number }) => ({
        statusCode: 0,
        statusMsg: '',
        request: {
          requestId,
          applicantUid: requestId === '9001' ? '33' : '44',
          groupShortId: '70001',
          conversationType: 2,
          status,
        },
      }),
    );
    const account = stubAccount(
      { inviteConversationParticipants, reviewGroupJoinRequest },
      { getGroupJoinRequestData, online: true },
    );
    const group = Group.bind('70001', '70001', account);

    await expect(group.inviteMembers(['22'])).resolves.toMatchObject({ succeededUids: ['22'] });
    expect(group.pickMember('22')).toBeUndefined();
    const requests = await group.getJoinRequests();
    const request = requests.get('9001');
    expect(request).toMatchObject({ applicantUid: '33', reason: '想加入', isPending: true });
    await expect(request?.approve()).resolves.toMatchObject({ statusCode: 0 });
    expect(request).toMatchObject({ status: 2, isPending: false });
    expect(group.pickMember('33')).toBeUndefined();
    const rejected = requests.get('9002');
    await expect(rejected?.reject()).resolves.toMatchObject({ statusCode: 0 });
    expect(rejected).toMatchObject({ status: 3, isPending: false });
    expect(group.pickMember('44')).toBeUndefined();

    expect(inviteConversationParticipants).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '70001', uids: ['22'] }),
    );
    expect(reviewGroupJoinRequest).toHaveBeenCalledWith({ requestId: '9001', status: 2 });
    expect(reviewGroupJoinRequest).toHaveBeenCalledWith({ requestId: '9002', status: 3 });

    const otherGroup = Group.bind('70002', '70002', account);
    await expect(otherGroup.reviewJoinRequest(request!, GroupJoinRequestStatus.REJECTED))
      .rejects.toThrow('入群申请不属于当前群');
  });

  it('refreshes a contact in place through the batch conversation seam', async () => {
    const refreshContactAddresses = jest.fn();
    const account = stubAccount({}, { refreshContactAddresses });
    const group = Group.bind('70001', '70001', account, { name: '旧群名' });
    refreshContactAddresses.mockImplementation(async () => {
      group.updateMetadata({ name: '刷新后的群名', notice: '新公告' });
      return { statusCode: 0, statusMsg: '', conversations: [] };
    });

    await expect(group.refresh()).resolves.toBe(group);
    expect(group.name).toBe('刷新后的群名');
    expect(group.notice).toBe('新公告');
    expect(refreshContactAddresses).toHaveBeenCalledWith([
      expect.objectContaining({ threadId: '70001' }),
    ]);
  });
});
