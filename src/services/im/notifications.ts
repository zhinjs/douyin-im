import type {
  GroupMemberDecreaseSource,
  GroupMemberIncreaseSource,
  ImGroupNoticeUser,
  ImNotice,
} from './types.js';
import type { ImPushMessage } from './ws-client.js';
import { decodeWire, type WireField } from './wire.js';
import { readIndexFromP2PContent } from './read-state.js';
import { isOrdinaryMessageType } from './message-cache.js';
import { readJsonInteger } from '../../http/lossless-json.js';

/** Only native type50001 / integer command_type=2, not all command messages, deletes a message. */
export function messageDeletionCommand(messageType: number, content: string): { conversationId: string; serverMessageId: string } | undefined {
  if (messageType !== 50001 || readJsonInteger(content, 'command_type', 32) !== 2n) return undefined;
  const payload = commandPayload(content);
  const conversationId = payload?.['conversation_id'];
  const messageId = readJsonInteger(content, 'message_id', 64);
  // Safe rejection for malformed/missing fields; do not reproduce native's unsafe missing-key access.
  if (typeof conversationId !== 'string' || !conversationId || messageId === undefined) return undefined;
  return { conversationId, serverMessageId: messageId.toString() };
}

const GROUP_MEMBER_INCREASE_TYPES = new Map<number, GroupMemberIncreaseSource>([
  [100100, 'invite'],
  [100101, 'command'],
  [100102, 'qrcode'],
  [100107, 'duoshan'],
  [100109, 'apply'],
  [100111, 'search'],
  [100112, 'activity'],
  [100113, 'face-to-face'],
  [100114, 'circle'],
]);

const GROUP_MEMBER_DECREASE_TYPES = new Map<number, GroupMemberDecreaseSource>([
  [100104, 'kick'],
  [100105, 'leave'],
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      const text = String(value);
      if (text && text !== '0') return text;
    }
  }
  return undefined;
}

function commandPayload(content: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function wireField(fields: WireField[], field: number): WireField | undefined {
  return fields.find((item) => item.field === field);
}

function wireString(fields: WireField[], field: number): string | undefined {
  const value = wireField(fields, field);
  return value?.type === 'string' ? value.value : undefined;
}

function wireInt(fields: WireField[], field: number): string | undefined {
  const value = wireField(fields, field);
  return value?.type === 'varint' ? value.value.toString() : undefined;
}

function messageReactionFromPush(push: ImPushMessage): ImNotice | undefined {
  if (push.messageType !== 70001 && push.messageType !== 70002) return undefined;
  const bytes = push.contentBytes;
  if (!bytes?.length) return undefined;
  const root = decodeWire(bytes);
  const reaction = wireField(root, 3);
  if (reaction?.type !== 'message') return undefined;
  const emoji = wireString(reaction.value, 2);
  const status = Number(wireInt(reaction.value, 3) ?? -1);
  const serverMessageId = wireInt(reaction.value, 4);
  const clientMessageId = wireString(reaction.value, 5);
  if (!emoji || (status !== 0 && status !== 1)) return undefined;
  return {
    type: 'message.reaction',
    conversationId: push.conversationId,
    conversationType: push.conversationType,
    operatorUid: push.senderUid,
    emoji,
    enabled: status === 0,
    ...(serverMessageId && serverMessageId !== '0' ? { serverMessageId } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    raw: push.raw,
  };
}

function noticeUsers(value: unknown): ImGroupNoticeUser[] {
  if (!Array.isArray(value)) return [];
  const users: ImGroupNoticeUser[] = [];
  for (const item of value) {
    const user = asRecord(item);
    const uid = firstString(user, ['uid', 'user_id', 'userId']);
    if (!uid) continue;
    const secUid = firstString(user, ['sec_uid', 'secUid', 'sec_user_id', 'secUserId']);
    const nickname = firstString(user, ['nickname', 'nick_name', 'display_name', 'displayName']);
    users.push({
      uid,
      ...(secUid ? { secUid } : {}),
      ...(nickname ? { nickname } : {}),
    });
  }
  return users;
}

function groupMemberIncreaseFromPush(
  push: ImPushMessage,
  payload: Record<string, unknown> | undefined,
): ImNotice | undefined {
  if (push.conversationType !== 2 || !payload) return undefined;
  const aweType = Number(payload['aweType'] ?? payload['awe_type'] ?? 0);
  const source = GROUP_MEMBER_INCREASE_TYPES.get(aweType);
  if (!source) return undefined;
  const members = noticeUsers(payload['passive_users'] ?? payload['passiveUsers']);
  if (members.length === 0) return undefined;
  return {
    type: 'group.member-increase',
    conversationId: push.conversationId,
    conversationShortId: push.conversationShortId || push.conversationId,
    conversationType: 2,
    source,
    members,
    operators: noticeUsers(payload['active_users'] ?? payload['activeUsers']),
    raw: push.raw,
  };
}

function groupMemberDecreaseFromPush(
  push: ImPushMessage,
  payload: Record<string, unknown> | undefined,
): ImNotice | undefined {
  if (push.conversationType !== 2 || !payload) return undefined;
  const aweType = Number(payload['aweType'] ?? payload['awe_type'] ?? 0);
  const source = GROUP_MEMBER_DECREASE_TYPES.get(aweType);
  if (!source) return undefined;
  const activeUsers = noticeUsers(payload['active_users'] ?? payload['activeUsers']);
  const passiveUsers = noticeUsers(payload['passive_users'] ?? payload['passiveUsers']);
  const members = source === 'leave' ? activeUsers : passiveUsers;
  if (members.length === 0) return undefined;
  return {
    type: 'group.member-decrease',
    conversationId: push.conversationId,
    conversationShortId: push.conversationShortId || push.conversationId,
    conversationType: 2,
    source,
    members,
    // 主动退群没有另一位操作者；SDK 层会把 member 自身投影为 operator。
    operators: source === 'leave' ? [] : activeUsers,
    raw: push.raw,
  };
}

function groupMetadataNoticeFromPush(
  push: ImPushMessage,
  payload: Record<string, unknown> | undefined,
): ImNotice | undefined {
  if (push.conversationType !== 2 || !payload) return undefined;
  const aweType = Number(payload['aweType'] ?? payload['awe_type'] ?? 0);
  const base = {
    conversationId: push.conversationId,
    conversationShortId: push.conversationShortId || push.conversationId,
    conversationType: 2 as const,
    operators: noticeUsers(payload['active_users'] ?? payload['activeUsers']),
    raw: push.raw,
  };
  if (aweType === 100110) {
    const members = noticeUsers(payload['passive_users'] ?? payload['passiveUsers']);
    if (members.length === 0) return undefined;
    return { type: 'group.admin', ...base, members, enabled: true };
  }
  if (aweType === 100106) {
    const name = firstString(payload, [
      'new_name', 'newName', 'conversation_name', 'conversationName', 'name',
    ]);
    return { type: 'group.name-change', ...base, ...(name ? { name } : {}) };
  }
  if (aweType === 100115) {
    const avatar = firstString(payload, [
      'new_avatar', 'newAvatar', 'avatar_url', 'avatarUrl', 'avatar',
    ]);
    return { type: 'group.avatar-change', ...base, ...(avatar ? { avatar } : {}) };
  }
  return undefined;
}

/** 把 cmd500 中的协议命令消息与用户可见消息分流。 */
export function noticeFromPush(push: ImPushMessage): ImNotice | undefined {
  // Native processConvDestroy only sets isParticipant=false; it does not delete history.
  if (push.messageType === 50005) return { type: 'im.command', conversationId: push.conversationId,
    conversationType: push.conversationType, messageType: push.messageType, content: push.content, raw: push.raw };
  const deletion = messageDeletionCommand(push.messageType, push.content);
  if (deletion) return { type: 'message.delete', ...deletion, raw: push.raw };
  if (push.cmd === 504 && push.messageType === 50013 && push.conversationId) {
    const cursor = readIndexFromP2PContent(push.content);
    if (cursor) return { type: 'conversation.read', conversationId: push.conversationId,
      conversationType: push.conversationType, readerUid: cursor.uid, readMessageIndex: cursor.index, raw: push.raw };
  }
  const reaction = messageReactionFromPush(push);
  if (reaction) return reaction;
  const payload = commandPayload(push.content);
  const groupIncrease = groupMemberIncreaseFromPush(push, payload);
  if (groupIncrease) return groupIncrease;
  const groupDecrease = groupMemberDecreaseFromPush(push, payload);
  if (groupDecrease) return groupDecrease;
  const groupMetadata = groupMetadataNoticeFromPush(push, payload);
  if (groupMetadata) return groupMetadata;
  if (isOrdinaryMessageType(push.messageType)) return undefined;
  if (push.messageType === 40001) {
    const serverMessageId = push.ext?.['s:target_server_message_id'];
    const clientMessageId = push.ext?.['s:target_client_message_id'];
    return {
      type: 'message.recall',
      conversationId: push.conversationId,
      conversationType: push.conversationType,
      ...(serverMessageId ? { serverMessageId } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(push.createTime !== undefined ? { createTime: push.createTime } : {}),
      raw: push.raw,
    };
  }
  if (push.messageType === 90001) {
    const apply = asRecord(payload?.['apply_info'] ?? payload?.['applyInfo']);
    const groupShortId = firstString(apply ?? payload, [
      'conv_short_id', 'convShortId', 'conversation_short_id', 'conversationShortId',
    ]);
    const requestId = firstString(apply ?? payload, [
      'apply_id', 'applyId', 'request_id', 'requestId',
    ]);
    return {
      type: 'group.join-request',
      conversationId: push.conversationId,
      conversationShortId: groupShortId || push.conversationShortId || push.conversationId,
      conversationType: push.conversationType,
      ...(requestId ? { requestId } : {}),
      content: push.content,
      raw: push.raw,
    };
  }
  return {
    type: 'im.command',
    conversationId: push.conversationId,
    conversationType: push.conversationType,
    messageType: push.messageType,
    content: push.content,
    raw: push.raw,
  };
}

/** 已知 ResponseEnvelope 通知。未知命令仍会走 message.raw，避免静默丢包。 */
export function extractProtoNotices(response: Record<string, unknown>): ImNotice[] {
  const body = asRecord(response['body']);
  if (!body) return [];
  const notices: ImNotice[] = [];
  const friend = asRecord(
    body['newFriendMessageNotify'] ?? body['new_friend_message_notify'],
  );
  if (friend) {
    const messageType = Number(friend['messageType'] ?? friend['message_type'] ?? 0);
    const fromUid = firstString(friend, ['fromId', 'from_id']) ?? '';
    const toUid = firstString(friend, ['toId', 'to_id']) ?? '';
    const peerUid = fromUid || toUid;
    const content = firstString(friend, ['content']);
    const extValue = friend['ext'];
    const ext = extValue && typeof extValue === 'object'
      ? extValue as Record<string, string>
      : undefined;
    if (messageType === 1 && peerUid) {
      notices.push({
        type: 'friend.add-request',
        applicantUid: peerUid,
        ...(fromUid ? { fromUid } : {}),
        ...(toUid ? { toUid } : {}),
        ...(content ? { content } : {}),
        ...(ext ? { ext } : {}),
        raw: response,
      });
    } else if ((messageType === 2 || messageType === 3) && peerUid) {
      notices.push({
        type: messageType === 3 ? 'friend.increase' : 'friend.decrease',
        peerUid,
        ...(fromUid ? { fromUid } : {}),
        ...(toUid ? { toUid } : {}),
        ...(content ? { content } : {}),
        ...(ext ? { ext } : {}),
        raw: response,
      });
    }
  }
  const read = asRecord(
    body['markConversationReadNotify'] ?? body['mark_conversation_read_notify'],
  );
  if (read) {
    notices.push({
      type: 'conversation.read',
      conversationId: firstString(read, ['conversationId', 'conversation_id']) ?? '',
      conversationType: Number(read['conversationType'] ?? read['conversation_type'] ?? 0),
      readMessageIndex: firstString(read, ['readIndex', 'read_index']) ?? '0',
      readMessageIndexV2: firstString(read, ['readIndexV2', 'read_index_v2']) ?? '0',
      raw: response,
    });
  }
  // The native descriptor contains cmd502, but Desktop's unsolicited-push
  // dispatcher does not consume it as onUpdateConversation. Keep it on raw;
  // a schema entry is not evidence that local state has actually been updated.
  return notices;
}
