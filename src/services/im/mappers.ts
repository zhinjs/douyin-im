import type {
  ImConversation,
  MessageReferenceInfo,
  PrivateMessage,
  PrivateThread,
} from './types.js';
import { messageContentText } from './message-content.js';
import { mapMessageProperties } from './message-property.js';

function stringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

function mapReferenceInfo(value: unknown): MessageReferenceInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const refMessageId = String(raw['refMessageId'] ?? raw['referencedMessageId'] ?? '');
  const hint = String(raw['hint'] ?? '');
  if (!refMessageId || refMessageId === '0' || !hint) return undefined;
  const rootMessageId = String(raw['rootMessageId'] ?? '');
  const rootMessageConvIndex = String(raw['rootMessageConvIndex'] ?? '');
  return Object.freeze({
    refMessageId,
    hint,
    refMessageType: Number(raw['refMessageType'] ?? 0),
    refMessageStatus: Number(raw['referencedMessageStatus'] ?? raw['refMessageStatus'] ?? 0),
    ...(rootMessageId && rootMessageId !== '0' ? { rootMessageId } : {}),
    ...(rootMessageConvIndex && rootMessageConvIndex !== '0' ? { rootMessageConvIndex } : {}),
  });
}

export function isGroupConversationId(conversationId: string): boolean {
  return /^\d+$/.test(conversationId.trim());
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === '0' || value === 'false') return false;
  if (value === 1 || value === '1' || value === 'true') return true;
  return undefined;
}

export function mapProtoConversationListItem(raw: Record<string, unknown>): ImConversation {
  const conversationId = String(raw['conversationId'] ?? '');
  const conversationType = Number(raw['conversationType'] ?? 0);
  const core = raw['conversationCoreInfo'] as Record<string, unknown> | undefined;
  const setting = raw['conversationSettingInfo'] as
    | Record<string, unknown>
    | undefined;
  const participantPage = raw['firstPageParticipants'] as
    | { participants?: Array<Record<string, unknown>> }
    | undefined;
  const avatar = String(core?.['icon'] ?? '');
  const description = String(core?.['desc'] ?? '');
  const notice = String(core?.['notice'] ?? '');
  const ownerUid = String(core?.['owner'] ?? '');
  const ownerSecUid = core?.['secOwner'];
  const ticket = String(raw['ticket'] ?? '');
  const readIndex = String(setting?.['readIndex'] ?? '');
  const readIndexV2 = String(setting?.['readIndexV2'] ?? '');
  const minIndex = String(setting?.['minIndex'] ?? '');
  const minIndexV2 = String(setting?.['minIndexV2'] ?? '');
  const members = participantPage?.participants ?? [];
  const muted = optionalBoolean(setting?.['mute']);
  const pinned = optionalBoolean(setting?.['stickOnTop']);
  const favorite = optionalBoolean(setting?.['favorite']);
  const settingVersion = setting?.['settingVersion'];
  const extVersions = setting?.['extVersion'];
  const isParticipant = optionalBoolean(raw['isParticipant']);
  return {
    conversationId,
    conversationShortId: String(raw['conversationShortId'] ?? ''),
    conversationType,
    isGroup: conversationType === 2 || isGroupConversationId(conversationId),
    name: String(core?.['name'] ?? ''),
    ...(core?.['infoVersion'] != null ? { coreVersion: String(core['infoVersion']) } : {}),
    ...(core?.['mode'] != null ? { mode: Number(core['mode']) } : {}),
    ...(core?.['ext'] && typeof core['ext'] === 'object' && !Array.isArray(core['ext'])
      ? { coreExt: Object.fromEntries(Object.entries(core['ext']).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }
      : {}),
    ...(description ? { description } : {}),
    ...(notice ? { notice } : {}),
    ...(avatar ? { avatar } : {}),
    ...(ownerUid && ownerUid !== '0' ? { ownerUid } : {}),
    ...(typeof ownerSecUid === 'string' ? { ownerSecUid } : {}),
    ...(ticket ? { ticket } : {}),
    ...(isParticipant !== undefined ? { isParticipant } : {}),
    ...(raw['inboxType'] !== undefined || core?.['inboxType'] !== undefined
      ? { inboxType: Number(raw['inboxType'] ?? core?.['inboxType']) }
      : {}),
    ...(raw['badgeCount'] !== undefined
      ? { badgeCount: Number(raw['badgeCount'] ?? 0) }
      : {}),
    ...(raw['participantsCount'] !== undefined
      ? { participantsCount: Number(raw['participantsCount']) }
      : {}),
    ...(muted !== undefined ? { muted } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(favorite !== undefined ? { favorite } : {}),
    ...(setting?.['setTopTime'] != null ? { setTopTime: String(setting['setTopTime']) } : {}),
    ...(setting?.['setFavoriteTime'] != null ? { setFavoriteTime: String(setting['setFavoriteTime']) } : {}),
    ...(setting?.['readBadgeCount'] != null ? { readBadgeCount: Number(setting['readBadgeCount']) } : {}),
    ...(settingVersion !== undefined && settingVersion !== null ? { settingVersion: String(settingVersion) } : {}),
    ...(Array.isArray(extVersions) ? { settingExtVersions: Object.fromEntries(extVersions
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
      .map(entry => [String(entry['key'] ?? ''), String(entry['version'] ?? '0')])) } : {}),
    ...(setting?.['ext'] && typeof setting['ext'] === 'object' && !Array.isArray(setting['ext'])
      ? { settingExt: Object.fromEntries(Object.entries(setting['ext']).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }
      : {}),
    ...(readIndex ? { readIndex } : {}),
    ...(readIndexV2 ? { readIndexV2 } : {}),
    ...(minIndex ? { minIndex } : {}),
    ...(minIndexV2 ? { minIndexV2 } : {}),
    lastMessageTime: 0,
    members: members.map((member) => {
      const secUid = String(member['secUid'] ?? '');
      const nickname = String(member['nickname'] ?? '');
      const avatar = String(member['avatar'] ?? '');
      const alias = String(member['alias'] ?? '');
      const sortOrder = String(member['sortOrder'] ?? '');
      const leftBlockTime = String(member['leftBlockTime'] ?? '');
      return {
        uid: String(member['uid'] ?? member['userId'] ?? ''),
        role: Number(member['role'] ?? 0),
        ...(secUid ? { secUid } : {}),
        ...(nickname ? { nickname } : {}),
        ...(avatar ? { avatar } : {}),
        ...(alias ? { alias } : {}),
        ...(sortOrder ? { sortOrder } : {}),
        ...(member['blocked'] !== undefined ? { blocked: Number(member['blocked']) } : {}),
        ...(leftBlockTime ? { leftBlockTime } : {}),
      };
    }).filter((member) => member.uid && member.uid !== '0'),
  };
}

/**
 * 从 conversationId 解析对端 UID。
 * jumpbyte 私信格式: "0:1:{uid_a}:{uid_b}"
 */
export function parsePeerFromConversationId(conversationId: string, myUid: string): string {
  const parts = conversationId.split(':');
  if (parts.length >= 4 && parts[1] === '1') {
    const uidA = parts[2]!;
    const uidB = parts[3]!;
    if (uidA === myUid) return uidB;
    if (uidB === myUid) return uidA;
    return uidB;
  }
  return '';
}

/** 从 conversation 元数据构建 thread */
export function mapProtoConversationMeta(
  conv: Record<string, unknown>,
  messages: Record<string, unknown>[],
  myUid: string,
): PrivateThread {
  const threadId = (conv['conversationId'] as string) ?? '';
  const conversationType = (conv['conversationType'] as number) ?? 1;
  const peerUid = parsePeerFromConversationId(threadId, myUid);

  const participantPage = conv['firstPageParticipants'] as {
    participants?: Array<Record<string, unknown>>;
  } | undefined;
  const userInfo = conv['userInfo'] as Record<string, unknown> | undefined;
  const peerMember = (participantPage?.participants ?? [])
    .find((member) => String(member['userId'] ?? '') === peerUid);
  const peerInfo = peerMember ??
    (String(userInfo?.['userId'] ?? '') === peerUid ? userInfo : undefined);
  const peerSecUid = String(peerInfo?.['secUid'] ?? '');

  const thread: PrivateThread = {
    threadId,
    ...(conv['conversationShortId'] != null
      ? { conversationShortId: String(conv['conversationShortId']) }
      : {}),
    conversationType,
    peer: {
      uid: peerUid,
      nickname: String(peerInfo?.['alias'] ?? ''),
      ...(peerSecUid ? { secUid: peerSecUid } : {}),
    },
    unreadCount: Number(conv['badgeCount'] ?? 0),
    updateTime: 0,
    ...(conv['inboxType'] != null ? { inboxType: conv['inboxType'] as number } : {}),
  };

  const lastMsg = messages.find((m) => (m['conversationId'] as string) === threadId);
  if (lastMsg) {
    thread.lastMessage = mapProtoMessage(lastMsg);
    if (!thread.updateTime) thread.updateTime = thread.lastMessage.createTime;
  }

  return thread;
}

/** 从单条 message 记录构建 thread（无 conversations 字段时） */
export function mapProtoConversation(raw: Record<string, unknown>, myUid: string): PrivateThread {
  const threadId = (raw['conversationId'] as string) ?? '';
  const conversationType = (raw['conversationType'] as number) ?? 1;
  const peerUid = parsePeerFromConversationId(threadId, myUid) ||
    (conversationType === 1 ? String(raw['sender'] ?? '') : '');
  const ext = raw['ext'] as Record<string, string> | undefined;
  const thread: PrivateThread = {
    threadId,
    ...(raw['conversationShortId'] != null
      ? { conversationShortId: String(raw['conversationShortId']) }
      : {}),
    conversationType,
    peer: {
      uid: peerUid,
      nickname: '',
      ...(raw['secSender'] && String(raw['sender']) === peerUid
        ? { secUid: String(raw['secSender']) }
        : {}),
    },
    unreadCount: 0,
    updateTime: (raw['createTime'] as number) ?? 0,
    ...(ext?.['s:is_stranger'] === 'true' ? { isStranger: true } : {}),
  };
  if (raw['content']) {
    thread.lastMessage = mapProtoMessage(raw);
  }
  return thread;
}

export function pickInboxUnread(raw: unknown): { unreadCount?: number } {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return {};
  return { unreadCount: Math.floor(n) };
}

export function dedupeThreads(threads: PrivateThread[]): PrivateThread[] {
  const byId = new Map<string, PrivateThread>();
  for (const t of threads) {
    const prev = byId.get(t.threadId);
    if (!prev || t.updateTime >= prev.updateTime) {
      byId.set(t.threadId, t);
    }
  }
  return [...byId.values()];
}

export function mapProtoMessage(raw: Record<string, unknown>): PrivateMessage {
  const senderSecUid = String(raw['secSender'] ?? '');
  const conversationShortId = String(raw['conversationShortId'] ?? raw['convShortId'] ?? '');
  const indexInConversation = String(raw['indexInConversation'] ?? '');
  const indexInConversationV2 = String(raw['indexInConversationV2'] ?? '');
  const version = String(raw['version'] ?? '');
  const orderInConversation = String(raw['orderInConversation'] ?? '');
  const ext = stringMap(raw['ext']);
  const clientMessageId = String(
    raw['clientId'] ?? raw['clientMessageId'] ?? ext?.['s:client_message_id'] ?? '',
  );
  const referenceInfo = mapReferenceInfo(raw['refInfo'] ?? raw['referenceInfo']);
  const propertyList = mapMessageProperties(raw['propertyList']);
  return {
    msgId: String(raw['serverMessageId'] ?? raw['serverId'] ?? ''),
    threadId: (raw['conversationId'] as string) ?? '',
    ...(conversationShortId && conversationShortId !== '0' ? { conversationShortId } : {}),
    ...(raw['conversationType'] !== undefined || raw['convType'] !== undefined
      ? { conversationType: Number(raw['conversationType'] ?? raw['convType']) }
      : {}),
    ...(raw['inboxType'] !== undefined ? { inboxType: Number(raw['inboxType']) } : {}),
    senderUid: String(raw['sender'] ?? ''),
    ...(senderSecUid ? { senderSecUid } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    content: messageContentText(raw['content']),
    msgType: Number(raw['messageType'] ?? raw['type'] ?? 0),
    createTime: Number(raw['createTime'] ?? raw['createdAt'] ?? 0),
    status: Number(raw['status'] ?? raw['serverStatus'] ?? 0),
    ...(version ? { version } : {}),
    ...(orderInConversation ? { orderInConversation } : {}),
    ...(indexInConversation ? { indexInConversation } : {}),
    ...(indexInConversationV2 ? { indexInConversationV2 } : {}),
    ...(ext ? { ext } : {}),
    ...(referenceInfo ? { referenceInfo } : {}),
    ...(propertyList ? { propertyList } : {}),
  };
}
