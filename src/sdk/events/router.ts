import type { BaseEvent } from '../../base/event.js';
import type { Account } from '../account.js';

type Emit = (event: string, payload?: unknown) => boolean;

const EVENT_CHANNELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'message.private': ['message', 'message.private'],
  'message.stranger': ['message', 'message.stranger'],
  'message.group': ['message', 'message.group'],
  'request.group.join': ['request', 'request.group', 'request.group.join'],
  'notice.conversation.update': ['notice', 'notice.conversation', 'notice.conversation.update'],
  'notice.conversation.min-index': ['notice', 'notice.conversation', 'notice.conversation.min-index'],
  'notice.conversation.members-remove': ['notice', 'notice.conversation', 'notice.conversation.members-remove'],
  'notice.conversation.delete': ['notice', 'notice.conversation', 'notice.conversation.delete'],
  'notice.conversation.read-summary': ['notice', 'notice.conversation.read-summary'],
  'notice.friend.marked-read': [
    'notice',
    'notice.conversation',
    'notice.conversation.marked-read',
    'notice.friend',
    'notice.friend.marked-read',
  ],
  'notice.friend.add-request': ['notice', 'notice.friend', 'notice.friend.add-request'],
  'notice.group.marked-read': [
    'notice',
    'notice.conversation',
    'notice.conversation.marked-read',
    'notice.group',
    'notice.group.marked-read',
  ],
  'notice.message.recall': ['notice', 'notice.conversation', 'notice.message', 'notice.message.recall'],
  'notice.message.delete': ['notice', 'notice.conversation', 'notice.message', 'notice.message.delete'],
  'notice.message.update': ['notice', 'notice.conversation', 'notice.message', 'notice.message.update'],
  'notice.message.batch-update': ['notice', 'notice.message', 'notice.message.batch-update'],
  'notice.message.list-update': ['notice', 'notice.message', 'notice.message.list-update'],
  'notice.message.reaction': ['notice', 'notice.conversation', 'notice.message', 'notice.message.reaction'],
  'notice.group.member-increase': [
    'notice',
    'notice.conversation',
    'notice.group',
    'notice.group.member-change',
    'notice.group.member-increase',
  ],
  'notice.group.invite': [
    'notice',
    'notice.conversation',
    'notice.group',
    'notice.group.member-change',
    'notice.group.member-increase',
    'notice.group.invite',
  ],
  'notice.group.member-decrease': [
    'notice',
    'notice.conversation',
    'notice.group',
    'notice.group.member-change',
    'notice.group.member-decrease',
  ],
  'notice.group.admin': [
    'notice',
    'notice.conversation',
    'notice.group',
    'notice.group.member-change',
    'notice.group.admin',
  ],
  'notice.group.name-change': [
    'notice',
    'notice.conversation',
    'notice.group',
    'notice.group.metadata-change',
    'notice.group.name-change',
  ],
  'notice.group.avatar-change': [
    'notice',
    'notice.conversation',
    'notice.group',
    'notice.group.metadata-change',
    'notice.group.avatar-change',
  ],
  'notice.friend.increase': ['notice', 'notice.friend', 'notice.friend.increase'],
  'notice.friend.decrease': ['notice', 'notice.friend', 'notice.friend.decrease'],
  'notice.im.command': ['notice', 'notice.conversation', 'notice.im.command'],
});

/**
 * 将同一个最具体事件实例派发到显式登记的全部父级频道。
 * 新事件若未登记会立即失败，避免静默丢失父级事件。
 */
export function emitEventRoutes(emit: Emit, event: BaseEvent<Account>): void {
  const key = event.postType === 'message' ? event.type : `${event.postType}.${event.type}`;
  const registered = EVENT_CHANNELS[key];
  if (!registered) throw new Error(`事件路由未注册: ${key}`);
  for (const channel of registered) emit(channel, event);
}

/** @internal 用于架构测试，调用方不应自行推导事件频道。 */
export function registeredEventChannels(key: string): readonly string[] | undefined {
  return EVENT_CHANNELS[key];
}
