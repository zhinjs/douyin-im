import type { ImService } from '../../services/im/service.js';
import type { ImStateStore } from '../../services/im/state-store.js';
import { ImInboxQueries } from './inbox-queries.js';
import { createImStateStore } from '../../services/im/state-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ImInboxQueries friend roster', () => {
  it('returns untouched network snapshots for Account to merge, without overwriting the store early', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douyin-group-settings-'));
    const store = createImStateStore({ accountDir: directory, backend: 'sqlite' });
    try {
      const group = { conversationId: '700', conversationShortId: '700', conversationType: 2,
        isGroup: true, name: 'old core', lastMessageTime: 0, members: [] };
      store.replaceGroups([{ ...group, settingVersion: '10', pinned: true, settingExt: { risk: 'present' } }]);
      const listThreads = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '', hasMore: false,
        cursor: '0', threads: [], conversations: [{ ...group, name: 'new core', settingVersion: '9', pinned: false, settingExt: {} }] });
      const result = await new ImInboxQueries({ listThreads } as unknown as ImService, '10', store).groupList(true);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({ name: 'new core', pinned: false, settingVersion: '9', settingExt: {} });
      expect(store.getConversation('700')).toMatchObject({ name: 'old core', pinned: true, settingVersion: '10', settingExt: { risk: 'present' } });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('maps page-local profiles and membership IDs without depending on existing conversations', async () => {
    const im = {
      listFriends: jest.fn().mockResolvedValue({
        statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', total: '2',
        friendUids: ['20', '30'], closeFriendUids: [],
        userList: [
          { uid: '20', nickname: '已有会话', secUid: 'sec20' },
          { uid: '30', nickname: '尚未聊天', secUid: 'sec30', remark: '备注', signature: '' },
        ],
      }),
    } as unknown as ImService;

    const result = await new ImInboxQueries(im, '10').friendList();

    expect(result).toMatchObject({ statusCode: 0, total: '2', friendUids: ['20', '30'], closeFriendUids: [] });
    expect(result.userList).toEqual([
      expect.objectContaining({ uid: '20', nickname: '已有会话', threadId: '0:1:10:20' }),
      expect.objectContaining({ uid: '30', nickname: '尚未聊天', remark: '备注', signature: '', threadId: '0:1:10:30' }),
    ]);
    expect(result.userList[0]).not.toHaveProperty('conversationShortId');
    expect(result.userList[1]).not.toHaveProperty('conversationShortId');
  });

  it('loads every cmd203 page and filters the full synchronized conversation set to groups', async () => {
    const listThreads = jest.fn()
      .mockResolvedValueOnce({
        statusCode: 0, statusMsg: '', hasMore: true, cursor: '9007199254740993', threads: [],
        conversations: [{
          conversationId: '70001', conversationShortId: '70001', conversationType: 2,
          inboxType: 1, isGroup: true, name: '第一群', lastMessageTime: 20, members: [],
        }],
      })
      .mockResolvedValueOnce({
        statusCode: 0, statusMsg: '', hasMore: false, cursor: '9007199254740994', threads: [],
        conversations: [
          {
            conversationId: '0:1:10:20', conversationShortId: '900', conversationType: 1,
            inboxType: 1, isGroup: false, name: '', lastMessageTime: 19, members: [],
          },
          {
            conversationId: '70002', conversationShortId: '70002', conversationType: 2,
            inboxType: 1, isGroup: true, name: '第二群', lastMessageTime: 18, members: [],
          },
        ],
      });
    const im = { listThreads } as unknown as ImService;

    const result = await new ImInboxQueries(im, '10').groupList();

    expect(result.groups.map((group) => group.conversationId)).toEqual(['70001', '70002']);
    expect(listThreads).toHaveBeenNthCalledWith(1, { cursor: '0', count: 50, inboxType: 1 });
    expect(listThreads).toHaveBeenNthCalledWith(2, {
      cursor: '9007199254740993', count: 50, inboxType: 1,
    });
  });

  it('uses the local group snapshot unless a network refresh is requested', async () => {
    const cached = {
      conversationId: '70001', conversationShortId: '70001', conversationType: 2,
      inboxType: 1, isGroup: true, name: '本地群', lastMessageTime: 20, members: [],
    };
    const fresh = { ...cached, name: '远端群' };
    const listThreads = jest.fn().mockResolvedValue({
      statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', threads: [],
      conversations: [fresh],
    });
    const listGroups = jest.fn().mockReturnValue([cached]);
    const replaceGroups = jest.fn().mockImplementation((groups) => listGroups.mockReturnValue(groups));
    const stateStore = {
      listGroups,
      replaceGroups,
    } as unknown as ImStateStore;
    const queries = new ImInboxQueries(
      { listThreads } as unknown as ImService,
      '10',
      stateStore,
    );

    await expect(queries.groupList()).resolves.toMatchObject({
      groups: [expect.objectContaining({ name: '本地群' })],
    });
    expect(listThreads).not.toHaveBeenCalled();

    await expect(queries.groupList(true)).resolves.toMatchObject({
      groups: [expect.objectContaining({ name: '远端群' })],
    });
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(replaceGroups).not.toHaveBeenCalled();
  });

  it('retains full protocol fields and missing setting-version presence without a state store', async () => {
    const conversation = { conversationId: '700', conversationShortId: '9007199254740993', conversationType: 2,
      isGroup: true, name: 'full', ticket: 'ticket', badgeCount: 3, participantsCount: 2, inboxType: 1,
      lastMessageTime: 0, members: [{ uid: '10', role: 1 }], settingExt: { risk: 'x' }, settingExtVersions: { risk: '9' } };
    const listThreads = jest.fn().mockResolvedValue({ statusCode: 0, statusMsg: '', hasMore: false,
      cursor: '0', threads: [], conversations: [conversation] });
    const result = await new ImInboxQueries({ listThreads } as unknown as ImService).groupList(true);
    expect(result.groups).toEqual([conversation]);
    expect(result.groups[0]).not.toHaveProperty('settingVersion');
  });
});
