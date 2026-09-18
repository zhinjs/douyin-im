import type { ImService } from '../../services/im/service.js';
import type { ImStateStore } from '../../services/im/state-store.js';
import type { ImConversation } from '../../services/im/types.js';
import type {
  FriendListResponse,
  GroupListResponse,
} from './inbox-types.js';



/** IM 收件箱只读查询 — 将 Desktop 完整列表映射为 SDK 联系人视图。 */
export class ImInboxQueries {
  constructor(
    private readonly im: ImService,
    private readonly myUid = '',
    private readonly stateStore?: ImStateStore,
  ) {}

  async friendList(options?: { cursor?: string | number; count?: number }): Promise<FriendListResponse> {
    const roster = await this.im.listFriends(options);
    if (roster.statusCode !== 0) {
      return {
        statusCode: roster.statusCode,
        statusMsg: roster.statusMsg,
        hasMore: false,
        userList: [],
        friendUids: [],
        cursor: roster.cursor,
        total: roster.total,
      };
    }
    const userList = roster.userList.map((entry) => {
      const base = {
        uid: entry.uid,
        nickname: entry.nickname,
        threadId: privateConversationId(this.myUid, entry.uid),
        unreadCount: 0,
        updateTime: 0,
      };
      return {
        ...base,
        ...(entry.avatar ? { avatarThumb: entry.avatar } : {}),
        ...(entry.secUid ? { secUid: entry.secUid } : {}),
        ...(entry.remark !== undefined ? { remark: entry.remark } : {}),
        ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
      };
    });
    return {
      statusCode: roster.statusCode,
      statusMsg: roster.statusMsg,
      hasMore: roster.hasMore,
      userList,
      friendUids: roster.friendUids,
      ...(roster.closeFriendUids !== undefined ? { closeFriendUids: roster.closeFriendUids } : {}),
      cursor: roster.cursor,
      total: roster.total,
    };
  }

  async groupList(force = false): Promise<GroupListResponse> {
    const cached = force ? undefined : this.stateStore?.listGroups();
    if (cached) {
      return { statusCode: 0, statusMsg: '', groups: cached, fromCache: true };
    }
    const rawGroups = new Map<string, ImConversation>();
    const seen = new Set<string>();
    let cursor = '0';
    for (;;) {
      const result = await this.im.listThreads({ cursor, count: 50, inboxType: 1 });
      if (result.statusCode !== 0) {
        return { statusCode: result.statusCode, statusMsg: result.statusMsg, groups: [] };
      }
      for (const conversation of result.conversations) {
        if (conversation.isGroup) {
          rawGroups.set(conversation.conversationId, conversation);
        }
      }
      if (!result.hasMore) {
        return { statusCode: 0, statusMsg: result.statusMsg,
          groups: [...rawGroups.values()] };
      }
      if (!result.cursor || result.cursor === cursor || seen.has(result.cursor)) {
        return { statusCode: -1, statusMsg: 'conversation cursor did not advance', groups: [] };
      }
      seen.add(cursor);
      cursor = result.cursor;
    }
  }


}

function privateConversationId(selfUid: string, peerUid: string): string {
  const ordered = [selfUid, peerUid].sort((left, right) => {
    const a = BigInt(left || '0');
    const b = BigInt(right || '0');
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return `0:1:${ordered[0]}:${ordered[1]}`;
}
