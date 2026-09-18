import { mergeConversationSettings } from './conversation-settings.js';
import { calculateDesktopSortOrder, desktopCellSortTime } from './conversation-float.js';
import type { ImConversation, RecentStrangerConversation } from './types.js';

const coreKeys = ['coreVersion', 'coreExt', 'mode', 'name', 'description', 'notice', 'avatar', 'ownerUid', 'ownerSecUid'] as const;

/** Mapped core fields of native CoreInfo::merge, then ResourceManager's derived box state. */
export function mergeConversationSnapshot(current: ImConversation | undefined, incoming: ImConversation, selfUid = ''): ImConversation {
  const result = mergeConversationSettings(current, incoming);
  const older = incoming.coreVersion !== undefined && BigInt(incoming.coreVersion) < BigInt(current?.coreVersion ?? '0');
  if (older) {
    for (const key of coreKeys) delete result[key];
    Object.assign(result, { name: '' }, current ? Object.fromEntries(coreKeys
      .filter(key => current[key] !== undefined).map(key => [key, current[key]])) : {});
  }
  result.coreVersion = (older ? current?.coreVersion : incoming.coreVersion ?? current?.coreVersion) ?? '0';
  result.mode = (older ? current?.mode : incoming.mode) ?? 0;
  result.coreExt = { ...(older ? current?.coreExt : incoming.coreExt) };
  result.isInStrangerBox = result.mode !== 0 && selfUid !== '' && result.coreExt['stranger'] === selfUid;
  result.badgeCount = Math.max(current?.badgeCount ?? 0, incoming.badgeCount ?? 0);
  // Network snapshots do not carry these local fields. Explicit local saves bypass this merge.
  if (current?.strangerVersion !== undefined) result.strangerVersion = current.strangerVersion;
  if (current?.localExt !== undefined) result.localExt = { ...current.localExt };
  const order = { lastMessageTime: current?.lastMessageTime ?? incoming.lastMessageTime, sortOrder: current?.sortOrder ?? '0' };
  calculateDesktopSortOrder(order, 0, !!result.pinned, desktopCellSortTime(result.settingExt?.['a:cell_sort_time']));
  result.lastMessageTime = order.lastMessageTime;
  result.sortOrder = order.sortOrder;
  return result;
}

/** Native splitString retains the previous separator offset after removing its prefix. */
export function strangerConversationMode(selfUid: string, id: string): number {
  if (!selfUid || !id) return 0;
  const parts: string[] = [];
  let rest = Buffer.from(id);
  let position = rest.indexOf(58);
  while (position !== -1) {
    parts.push(rest.subarray(0, position).toString());
    rest = rest.subarray(position + 1);
    position = rest.indexOf(58, position);
  }
  parts.push(rest.toString());
  if (parts.length !== 4) return 0;
  return parts[2] === selfUid ? 2 : parts[3] === selfUid ? 1 : 0;
}

/** Native buildConversation_: skeleton only; caller saves it before scheduling cmd608. */
export function buildStrangerConversation(current: ImConversation | undefined, row: RecentStrangerConversation, selfUid: string, inboxType: number): ImConversation | undefined {
  if (!row.conversationId || BigInt(row.conversationShortId) === 0n) return undefined;
  const type = row.messages.at(-1)?.conversationType ?? 1;
  const result: ImConversation = current ? structuredClone(current) : {
    conversationId: row.conversationId, conversationShortId: row.conversationShortId,
    conversationType: type, isGroup: type === 2, inboxType, name: '', members: [], lastMessageTime: 0,
    participantsCount: 2, isParticipant: true, coreExt: { stranger: selfUid },
    mode: strangerConversationMode(selfUid, row.conversationId),
  };
  result.isInStrangerBox = true;
  result.strangerVersion = row.version;
  result.badgeCount = Math.max(result.badgeCount ?? 0, row.badgeCount);
  return result;
}
