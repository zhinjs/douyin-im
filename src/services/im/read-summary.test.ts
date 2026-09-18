import { calculateConversationReadSummary, equalConversationReadSummaries, selectLastSentMessage } from './read-state.js';
import type { GroupMemberData, PrivateMessage } from './types.js';

const message: PrivateMessage = { threadId: '700', conversationShortId: '701', conversationType: 2,
  msgId: '0', clientMessageId: 'CLIENT', senderUid: '11', content: '', msgType: 7,
  createTime: 1000, status: 0, orderIndex: '10', indexInConversation: '10', indexInConversationV2: '99999' };
const members: GroupMemberData[] = [{ uid: '11', role: 0 }, { uid: '22', secUid: 'sec22', role: 0 }, { uid: '33', role: 0 }];
const cursor = (uid: string, readIndex = '10', minIndex = '0') => ({ uid, readIndex, minIndex });

describe('native raw conversation read summary', () => {
  it('compares every scalar and reader field, ignoring only reader row order without mutating it', () => {
    const value = calculateConversationReadSummary('700', message, '11', members, [cursor('22'), cursor('33')]);
    const reordered = { ...value, readUsers: [...value.readUsers].reverse() };
    expect(equalConversationReadSummaries(value, reordered)).toBe(true);
    expect(value.readUsers.map(row => row.uid)).toEqual(['22', '33']);
    expect(reordered.readUsers.map(row => row.uid)).toEqual(['33', '22']);
    for (const key of ['conversationId', 'conversationShortId', 'clientMessageId', 'serverMessageId', 'createTime'] as const) {
      expect(equalConversationReadSummaries(value, { ...value, [key]: 'different' })).toBe(false);
    }
    expect(equalConversationReadSummaries(value, { ...value, conversationType: 1 })).toBe(false);
    expect(equalConversationReadSummaries(value, { ...value, isAllRead: !value.isAllRead })).toBe(false);
    expect(equalConversationReadSummaries(value, { ...value, readUsers: [] })).toBe(false);
    for (const key of ['uid', 'secUid', 'readIndex', 'minIndex'] as const) {
      const changed = structuredClone(value); changed.readUsers[0]![key] = '9007199254740993';
      expect(equalConversationReadSummaries(value, changed)).toBe(false);
    }
    expect(equalConversationReadSummaries({ ...value, readUsers: [] }, { ...value, readUsers: [] })).toBe(true);
  });
  it('selects by effective order then time, not last received, indexV2, visible_code or local send stage', () => {
    const selected = { ...message, orderInConversation: '100', orderIndex: '11', createTime: 3,
      localStatus: -1, ext: { visible_code: '1' } };
    const rows = [message, { ...selected, createTime: 2 }, selected,
      { ...message, senderUid: '22', orderIndex: '1000' },
      { ...message, threadId: 'elsewhere', orderIndex: '1000' },
      { ...message, orderIndex: '9', createTime: 999999, indexInConversationV2: '999999' }];
    expect(selectLastSentMessage(rows, '700', '11')).toBe(selected);
    expect(selectLastSentMessage([message], '700', '11')).toBe(message); // Empty body, serverId0 and no positive-index requirement.
    const zeroIndex = { ...message, indexInConversation: '0' };
    expect(selectLastSentMessage([zeroIndex], '700', '11')).toBe(zeroIndex);
  });

  it('applies exactly net-status/deleted/recalled/four-type selection filters', () => {
    const excluded = [ { ...message, status: 1 }, { ...message, deleted: true },
      { ...message, ext: { 's:is_recalled': 'true' } },
      ...[1, 1001, 1002, 1010].map(msgType => ({ ...message, msgType })) ];
    expect(selectLastSentMessage(excluded, '700', '11')).toBeUndefined();
    for (const msgType of [0, 2, 9999]) {
      const row = { ...message, msgType, ext: { 's:is_recalled': 'True' } };
      expect(selectLastSentMessage([row], '700', '11')).toBe(row);
    }
  });

  it('joins actual participant rows, ignores self and later joiners, and uses ordinary indexes', () => {
    const result = calculateConversationReadSummary('700', message, '11', members,
      [cursor('11'), cursor('22'), cursor('33', '99999', '-11'), cursor('44')]);
    expect(result).toEqual({ conversationId: '700', conversationShortId: '701', conversationType: 2,
      clientMessageId: '', serverMessageId: '0', createTime: '1000',
      readUsers: [{ ...cursor('22'), secUid: 'sec22' }], isAllRead: true });
    expect(calculateConversationReadSummary('700', message, '11', members, [cursor('22', '9')]).isAllRead).toBe(false);
    expect(calculateConversationReadSummary('700', message, '11', members, []).isAllRead).toBe(false);
    expect(calculateConversationReadSummary('700', message, '11', [], [cursor('22')]).readUsers).toEqual([]);
  });

  it('keeps invisible eligible members in the denominator and gives nonempty visible precedence', () => {
    const both = [cursor('22'), cursor('33')];
    const summarize = (ext: Record<string, string>) => calculateConversationReadSummary('700', { ...message, ext }, '11', members, both);
    expect(summarize({ 's:invisible': '33' })).toMatchObject({ readUsers: [{ uid: '22' }], isAllRead: false });
    expect(summarize({ 's:visible': '22,33', 's:invisible': '22,33' }).isAllRead).toBe(true);
    for (const visible of [' 22, 33', '[22,33]', '022,033', ' ']) {
      expect(summarize({ 's:visible': visible })).toMatchObject({ readUsers: [], isAllRead: false });
    }
    expect(summarize({ 's:visible': '', 's:invisible': '33' }).readUsers.map(row => row.uid)).toEqual(['22']);
    expect(summarize({ 's:visible': ',22,,33,' }).isAllRead).toBe(true);
  });

  it('matches signed-int64 comparisons, including cneg INT64_MIN, without float rounding', () => {
    const big = { ...message, indexInConversation: '9007199254740993' };
    const result = calculateConversationReadSummary('700', big, '11', members,
      [cursor('22', '9007199254740993', '-9223372036854775808'), cursor('33', '9007199254740992')]);
    expect(result).toMatchObject({ readUsers: [{ uid: '22' }], isAllRead: false });
    expect(() => calculateConversationReadSummary('700', { ...message, createTime: 9007199254740992 }, '11', members, [])).toThrow('exact integer');
  });

  it('preserves row order/secUid sources and does not impose caller selection gates on aggregation', () => {
    const input = [{ ...cursor('33'), secUid: 'wrong-response-source' }, cursor('22')];
    const otherMessage = { ...message, senderUid: 'other', status: 1, deleted: true, msgType: 1001 };
    const result = calculateConversationReadSummary('700', otherMessage, '11', members, input);
    expect(result.readUsers.map(row => [row.uid, row.secUid])).toEqual([['33', ''], ['22', 'sec22']]);
    result.readUsers[0]!.readIndex = '999';
    expect(input[0]!.readIndex).toBe('10');
    expect(calculateConversationReadSummary('from-argument', { ...message, ext: { 's:client_message_id': 'from-ext' } }, '11', [], []))
      .toMatchObject({ conversationId: 'from-argument', clientMessageId: 'from-ext' });
  });
});
