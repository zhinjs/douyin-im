import type { Account } from '../account.js';
import { MessageEvent } from '../events/message.js';
import type { ChatContact } from './chat-contact.js';
import { Friend } from './friend.js';
import { Group } from './group.js';
import { Stranger } from './stranger.js';

class SourceMessage extends MessageEvent {
  readonly type = 'message.private' as const;
  readonly chatType = 'private' as const;
  constructor(account: Account, contact: ChatContact) {
    super({ threadId: '0:1:11:33', conversationShortId: '9002', conversationType: 1,
      senderUid: '33', serverMessageId: '99', text: 'source', rawContent: '{"text":"source"}',
      messageType: 7, raw: {} }, account, contact);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const delivered = { statusCode: 0, statusMsg: 'OK', serverMessageId: '100', clientMessageId: 'fixture' };
function sender() {
  return { sendMessage: jest.fn().mockResolvedValue(delivered), forwardMessage: jest.fn().mockResolvedValue(delivered) };
}
function fixture(kind: 'friend' | 'group' | 'stranger') {
  const outbound = sender();
  const account = { online: true, im: {}, outbound,
    getUserRelation: jest.fn(),
    resolveShortId: (_id: string, hint: string) => hint } as unknown as Account;
  const contact = kind === 'friend' ? Friend.bind('22', '0:1:11:22', '9001', account)
    : kind === 'group' ? Group.bind('700', '700', account)
      : Stranger.bind('22', '0:1:11:22', '9001', account);
  return { account, contact, outbound, source: new SourceMessage(account, contact) };
}

describe.each(['friend', 'group', 'stranger'] as const)('%s send lifecycle', kind => {
  it.each(['send', 'forward'] as const)('does not dispatch %s across a login change during address preparation', async action => {
    const { account, contact, outbound, source } = fixture(kind);
    const replacement = sender();
    const task = action === 'send' ? contact.sendMsg('hello') : source.forwardTo(contact);
    // Even an already known address yields before dispatch. No timing sleeps are needed.
    Object.assign(account, { im: {}, outbound: replacement });
    await expect(task).rejects.toThrow('账号连接已变化');
    for (const transport of [outbound, replacement]) {
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(transport.forwardMessage).not.toHaveBeenCalled();
    }
  });

  it.each(['send', 'forward'] as const)('does not dispatch %s after logout during address preparation', async action => {
    const { account, contact, outbound, source } = fixture(kind);
    const task = action === 'send' ? contact.sendMsg('hello') : source.forwardTo(contact);
    Object.assign(account, { online: false });
    await expect(task).rejects.toThrow('账号连接已变化');
    expect(outbound.sendMessage).not.toHaveBeenCalled();
    expect(outbound.forwardMessage).not.toHaveBeenCalled();
  });

  it.each(['send', 'forward'] as const)('returns the actual late %s acknowledgement without retrying on the new login', async action => {
    const { account, contact, outbound, source } = fixture(kind);
    const response = deferred<typeof delivered>();
    const dispatched = deferred<void>();
    const send = action === 'send' ? outbound.sendMessage : outbound.forwardMessage;
    send.mockImplementation(() => { dispatched.resolve(); return response.promise; });
    const task = action === 'send' ? contact.sendMsg('hello') : source.forwardTo(contact);
    await dispatched.promise;
    const replacement = sender();
    Object.assign(account, { im: {}, outbound: replacement });
    response.resolve(delivered);
    await expect(task).resolves.toBe(delivered);
    expect(send).toHaveBeenCalledTimes(1);
    expect(replacement.sendMessage).not.toHaveBeenCalled();
    expect(replacement.forwardMessage).not.toHaveBeenCalled();
  });
});

it.each(['send', 'forward'] as const)('does not resume %s on a new login after lazy private conversation creation', async action => {
  const { account, outbound, source } = fixture('friend');
  const ready = deferred<void>();
  const started = deferred<void>();
  const contact = Friend.bind('22', '0:1:11:22', '', account);
  Object.assign(account, { ensureFriendConversation: jest.fn(async () => {
    started.resolve(); await ready.promise;
    contact.bindConversation('0:1:11:22', '9001');
  }) });
  const task = action === 'send' ? contact.sendMsg('hello') : source.forwardTo(contact);
  await started.promise;
  const replacement = sender();
  Object.assign(account, { im: {}, outbound: replacement });
  ready.resolve();
  await expect(task).rejects.toThrow('账号连接已变化');
  expect(outbound.sendMessage).not.toHaveBeenCalled(); expect(outbound.forwardMessage).not.toHaveBeenCalled();
  expect(replacement.sendMessage).not.toHaveBeenCalled(); expect(replacement.forwardMessage).not.toHaveBeenCalled();
});
