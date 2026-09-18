import type { Account } from '../account.js';
import { Group } from '../contacts/group.js';
import {
  ConversationReadSummaryNoticeEvent,
  GroupInviteNoticeEvent,
  GroupMemberChangeNoticeEvent,
  MessageReactionNoticeEvent,
  MessageUpdateNoticeEvent,
  MessageNoticeEvent,
  NoticeEvent,
  bindNoticeAccount,
  bindGroupMemberDecreaseNotices,
  bindGroupMemberIncreaseNotices,
} from './notice.js';

function stubAccount(identity: Partial<Account> = {}): Account {
  return {
    upsertCachedGroupMembers: () => undefined,
    removeCachedGroupMembers: () => undefined,
    ...identity,
  } as Account;
}

describe('SDK group notices', () => {
  it('exposes an immutable multi-conversation raw read summary batch', () => {
    const account = stubAccount();
    const summaries = [{ conversationId: '700', conversationShortId: '700', conversationType: 2,
      clientMessageId: 'client', serverMessageId: '90', createTime: '1000', isAllRead: true,
      readUsers: [{ uid: '22', secUid: 'sec22', readIndex: '10', minIndex: '0' }] }];
    const event = new ConversationReadSummaryNoticeEvent(account, summaries);
    expect(event).toBeInstanceOf(NoticeEvent);
    expect(event.account).toBe(account);
    expect(event.type).toBe('conversation.read-summary');
    expect(event).not.toHaveProperty('conversationId');
    summaries[0]!.readUsers[0]!.secUid = 'changed';
    expect(event.summaries[0]!.readUsers[0]!.secUid).toBe('sec22');
    expect(Object.isFrozen(event.summaries)).toBe(true);
    expect(Object.isFrozen(event.summaries[0])).toBe(true);
    expect(Object.isFrozen(event.summaries[0]!.readUsers)).toBe(true);
    expect(Object.isFrozen(event.summaries[0]!.readUsers[0])).toBe(true);
  });
  it('exposes an isolated merged update snapshot without reply actions', () => {
    const account = stubAccount();
    const message = { msgId: '99', threadId: '700', senderUid: '22', content: 'body', msgType: 7, createTime: 1, status: 0,
      clientMessageId: 'client', ext: { kept: 'value' } };
    const event = new MessageUpdateNoticeEvent(account, 2, message, {});
    expect(event).toBeInstanceOf(MessageNoticeEvent);
    expect(event).toBeInstanceOf(NoticeEvent);
    expect(event).toMatchObject({ account, type: 'message.update', postType: 'notice', conversationId: '700', conversationType: 2,
      serverMessageId: '99', clientMessageId: 'client', message });
    expect(event).not.toHaveProperty('reply');
    message.ext.kept = 'changed';
    expect(event.message.ext!['kept']).toBe('value');
    expect(Object.isFrozen(event.message)).toBe(true);
  });

  it('binds Desktop property updates to a typed reaction event', () => {
    const account = stubAccount();
    const event = bindNoticeAccount({
      type: 'message.reaction',
      conversationId: '0:1:12:34',
      conversationType: 1,
      operatorUid: '34',
      emoji: '赞',
      enabled: true,
      serverMessageId: '99',
      raw: {},
    }, account);

    expect(event).toBeInstanceOf(MessageReactionNoticeEvent);
    expect(event).toMatchObject({
      type: 'message.reaction',
      account,
      operatorUid: '34',
      emoji: '赞',
      enabled: true,
      serverMessageId: '99',
    });
  });

  it('creates one event per member and updates stable group member instances first', () => {
    const account = stubAccount();
    const group = Group.bind(
      '70001',
      '70001',
      account,
      { members: [{ uid: '11', role: 2, nickname: '旧名字' }] },
    );

    const events = bindGroupMemberIncreaseNotices({
      type: 'group.member-increase',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      source: 'apply',
      operators: [{ uid: '11', nickname: '管理员' }],
      members: [
        { uid: '22', secUid: 'MS4member', nickname: '甲' },
        { uid: '23', nickname: '乙' },
      ],
      raw: {},
    }, account, group);

    expect(events).toHaveLength(2);
    expect(events[0]).toBeInstanceOf(NoticeEvent);
    expect(events[0]).toBeInstanceOf(GroupMemberChangeNoticeEvent);
    expect(events[0]).toMatchObject({
      type: 'group.member-increase',
      account,
      group,
      member: { uid: '22', nickname: '甲' },
      operator: { uid: '11', nickname: '管理员', role: 2 },
      source: 'apply',
    });
    expect(events[1]?.member).toBe(group.pickMember('23'));
    expect(group.pickMember('22')).toBe(events[0]?.member);
    expect(group.pickMember('11')).toMatchObject({ role: 2, nickname: '管理员' });
  });

  it('distinguishes a completed invite as a non-actionable member-increase subclass', () => {
    const account = stubAccount();
    const group = Group.bind('70001', '70001', account);
    const raw = { createTime: '1720000000000' };

    const [event] = bindGroupMemberIncreaseNotices({
      type: 'group.member-increase',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      source: 'invite',
      operators: [{ uid: '11' }],
      members: [{ uid: '22' }],
      raw,
    }, account, group);

    expect(event).toBeInstanceOf(GroupInviteNoticeEvent);
    expect(event).toMatchObject({
      postType: 'notice',
      type: 'group.invite',
      source: 'invite',
      time: 1_720_000_000,
      raw,
    });
    expect('approve' in (event ?? {})).toBe(false);
  });

  it('detaches a leaving member before exposing the event and uses self as operator', () => {
    const account = stubAccount({ uid: '10001', imUid: '22' });
    const group = Group.bind(
      '70001',
      '70001',
      account,
      { members: [{ uid: '22', role: 0, nickname: '退出成员' }] },
    );
    const original = group.pickMember('22');

    const [event] = bindGroupMemberDecreaseNotices({
      type: 'group.member-decrease',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      source: 'leave',
      operators: [],
      members: [{ uid: '22', nickname: '退出成员' }],
      raw: {},
    }, account, group);

    expect(event).toMatchObject({
      type: 'group.member-decrease',
      member: original,
      operator: original,
      operators: [original],
      source: 'leave',
      isSelf: true,
    });
    expect(group.pickMember('22')).toBeUndefined();
  });

  it('keeps a kick operator cached while removing only the passive member', () => {
    const account = stubAccount({ uid: '10001', imUid: '10001' });
    const group = Group.bind(
      '70001',
      '70001',
      account,
      { members: [{ uid: '11', role: 2 }, { uid: '22', role: 0 }] },
    );

    const [event] = bindGroupMemberDecreaseNotices({
      type: 'group.member-decrease',
      conversationId: '70001',
      conversationShortId: '70001',
      conversationType: 2,
      source: 'kick',
      operators: [{ uid: '11' }],
      members: [{ uid: '22' }],
      raw: {},
    }, account, group);

    expect(event?.operator).toBe(group.pickMember('11'));
    expect(event?.isSelf).toBe(false);
    expect(group.pickMember('22')).toBeUndefined();
  });
});
