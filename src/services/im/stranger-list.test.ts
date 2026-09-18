import { selectStrangerConversations } from './stranger-list.js';
import type { ImConversation } from './types.js';

function row(id: string, sortOrder: string): ImConversation {
  return { conversationId: id, conversationShortId: id, conversationType: 1, isGroup: false,
    inboxType: 1, name: '', members: [], lastMessageTime: 0, sortOrder, isInStrangerBox: true };
}

describe('native local stranger list selection', () => {
  it('uses signed int64 ordering without inbox/type filtering or a 200-row limit', () => {
    const rows = [row('high', '9007199254740993'), row('lower', '9007199254740992'),
      row('negative', '-1'), row('min', '-9223372036854775808'),
      { ...row('group', '9223372036854775807'), conversationType: 2 as const, isGroup: true, inboxType: 4 },
      ...Array.from({ length: 201 }, (_, i) => row(`extra-${i}`, String(i + 1)))];
    const selected = selectStrangerConversations(rows);
    expect(selected).toHaveLength(206);
    expect(selected.slice(0, 3).map(item => item.conversationId)).toEqual(['group', 'high', 'lower']);
    expect(selected.slice(-2).map(item => item.conversationId)).toEqual(['negative', 'min']);
  });

  it('filters persisted zero, soft-deleted and out-of-box rows and isolates callers', () => {
    const kept = row('keep', '1');
    const selected = selectStrangerConversations([row('zero', '0'), { ...row('deleted', '3'), deleted: true },
      { ...row('out', '3'), isInStrangerBox: false }, kept]);
    expect(selected.map(item => item.conversationId)).toEqual(['keep']);
    selected[0]!.name = 'changed';
    selected[0]!.members.push({ uid: '22', role: 0 });
    expect(kept.name).toBe('');
    expect(kept.members).toEqual([]);
  });

  it.each(['bad', '1.5', '9223372036854775808', '-9223372036854775809'])('rejects invalid persisted order %s', order => {
    expect(() => selectStrangerConversations([row('bad', order)])).toThrow();
  });
});
