import type { ImConversation } from './types.js';
import { conversationIsFolded } from './setting-command.js';

/** Fields owned by native ConversationSettingInfo, not core info or local summaries. */
const settingKeys = [
  'settingVersion', 'settingExt', 'settingExtVersions', 'minIndex', 'readIndex',
  'muted', 'pinned', 'favorite', 'setTopTime', 'setFavoriteTime',
  'readIndexV2', 'minIndexV2', 'readBadgeCount',
] as const satisfies readonly (keyof ImConversation)[];

const defaults: Required<Pick<ImConversation, typeof settingKeys[number]>> = {
  settingVersion: '0', settingExt: {}, settingExtVersions: {}, minIndex: '0', readIndex: '0',
  muted: false, pinned: false, favorite: false, setTopTime: '0', setFavoriteTime: '0',
  readIndexV2: '0', minIndexV2: '0', readBadgeCount: 0,
};

/**
 * Merge the SDK's mapped setting fields of a full network conversation snapshot.
 * Desktop 1.2.1 ConversationSettingInfo::merge @ 0x297520. This is NOT an
 * ext_data command patch, a local settings action acknowledgement, or core.merge.
 * The DTO retains presence; only this state boundary supplies protobuf defaults.
 * Also performs the full-conversation caller's subsequent folded-state recompute.
 */
export function mergeConversationSettings(
  current: ImConversation | undefined,
  incoming: ImConversation,
): ImConversation {
  const previousVersion = current?.settingVersion ?? '0';
  if (incoming.settingVersion !== undefined && BigInt(incoming.settingVersion) < BigInt(previousVersion)) {
    const result = { ...incoming };
    // Reject only settings. Core fields and the rest of the snapshot still advance.
    for (const key of settingKeys) delete result[key];
    Object.assign(result, defaults, current ? Object.fromEntries(settingKeys
      .filter(key => current[key] !== undefined)
      .map(key => [key, current[key]])) : {});
    result.settingExt = { ...current?.settingExt };
    result.settingExtVersions = { ...current?.settingExtVersions };
    result.isFolded = conversationIsFolded(result.settingExt);
    return result;
  }
  const readIndexV2 = incoming.readIndexV2 ?? '0';
  const previousReadIndexV2 = current?.readIndexV2 ?? '0';
  return {
    ...incoming,
    settingVersion: incoming.settingVersion ?? previousVersion,
    minIndex: incoming.minIndex ?? '0',
    readIndex: incoming.readIndex ?? '0',
    muted: incoming.muted ?? false,
    pinned: incoming.pinned ?? false,
    favorite: incoming.favorite ?? false,
    setTopTime: incoming.setTopTime ?? '0',
    setFavoriteTime: incoming.setFavoriteTime ?? '0',
    readIndexV2: BigInt(readIndexV2) > BigInt(previousReadIndexV2) ? readIndexV2 : previousReadIndexV2,
    minIndexV2: incoming.minIndexV2 ?? '0',
    readBadgeCount: Math.max(current?.readBadgeCount ?? 0, incoming.readBadgeCount ?? 0),
    // Full snapshots clear then rebuild BOTH maps, including absent/empty maps.
    settingExt: { ...incoming.settingExt },
    settingExtVersions: { ...incoming.settingExtVersions },
    isFolded: conversationIsFolded(incoming.settingExt),
  };
}
