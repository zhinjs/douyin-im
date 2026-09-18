import type { BaseEvent } from '../../base/event.js';
import type { Account } from '../account.js';
import { emitEventRoutes, registeredEventChannels } from './router.js';

function event(postType: 'message' | 'notice' | 'request', type: string): BaseEvent<Account> {
  return { postType, type } as BaseEvent<Account>;
}

describe('EventRouter', () => {
  it('keeps min-index updates separate from deletion and generic conversation updates', () => {
    expect(registeredEventChannels('notice.conversation.min-index')).toEqual([
      'notice', 'notice.conversation', 'notice.conversation.min-index',
    ]);
  });
  it('dispatches the same leaf instance to explicitly registered parent channels', () => {
    const payload = event('notice', 'group.member-increase');
    const received: Array<readonly [string, unknown]> = [];

    emitEventRoutes((channel, value) => {
      received.push([channel, value]);
      return true;
    }, payload);

    expect(received.map(([channel]) => channel)).toEqual([
      'notice',
      'notice.conversation',
      'notice.group',
      'notice.group.member-change',
      'notice.group.member-increase',
    ]);
    expect(received.every(([, value]) => value === payload)).toBe(true);
  });

  it('does not infer channels from string prefixes', () => {
    expect(registeredEventChannels('notice.group.unknown')).toBeUndefined();
    expect(() => emitEventRoutes(() => true, event('notice', 'group.unknown')))
      .toThrow('事件路由未注册: notice.group.unknown');
  });

  it('routes reaction updates through message-notice parents', () => {
    expect(registeredEventChannels('notice.message.reaction')).toEqual([
      'notice',
      'notice.conversation',
      'notice.message',
      'notice.message.reaction',
    ]);
  });

  it('routes message updates as notices, never as new messages', () => {
    expect(registeredEventChannels('notice.message.update')).toEqual([
      'notice', 'notice.conversation', 'notice.message', 'notice.message.update',
    ]);
  });

  it('routes deletion independently of recall and batch updates', () => {
    expect(registeredEventChannels('notice.message.delete')).toEqual([
      'notice', 'notice.conversation', 'notice.message', 'notice.message.delete',
    ]);
  });

  it('does not route a multi-conversation batch through single-conversation notice channels', () => {
    expect(registeredEventChannels('notice.message.batch-update')).toEqual([
      'notice', 'notice.message', 'notice.message.batch-update',
    ]);
  });

  it('normalizes message event keys without duplicating the post type', () => {
    const channels: string[] = [];
    emitEventRoutes((channel) => {
      channels.push(channel);
      return true;
    }, event('message', 'message.private'));
    expect(channels).toEqual(['message', 'message.private']);
  });

  it('routes read summary batches without pretending they are single-conversation marked-read notices', () => {
    expect(registeredEventChannels('notice.conversation.read-summary')).toEqual(['notice', 'notice.conversation.read-summary']);
  });
});
