import type { ImWebSocketReceiver } from './adapters/frontier-websocket.js';
import {
  ConnectionManager,
  type ConnectionManagerOptions,
  type ImWebSocketReceiverFactory,
} from './connection-manager.js';

function options(): ConnectionManagerOptions {
  return {
    platformUid: '10001',
    deviceId: '3240000001',
    sessionCookies: 'sessionid=test',
    deviceUserAgent: 'test',
    imService: {} as ConnectionManagerOptions['imService'],
    onInbound: jest.fn(),
    onHistoryBatch: jest.fn(),
  };
}

function factory(receiver: ImWebSocketReceiver): ImWebSocketReceiverFactory {
  return jest.fn(() => receiver);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function recoveryHarness() {
  const message = { msgId: '99', clientMessageId: 'client', threadId: '700', senderUid: '20002',
    content: '{"text":"history"}', msgType: 7, createTime: 123, status: 0, indexInConversationV2: '10' };
  const listed = { statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', conversations: [],
    threads: [{ threadId: '700', conversationShortId: '700', conversationType: 2,
      peer: { uid: '', nickname: '' }, unreadCount: 0, updateTime: 0, lastMessage: message }] };
  const history = { statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', direction: 'older', messages: [message] };
  const listThreads = jest.fn().mockResolvedValue(listed);
  const getMessages = jest.fn().mockResolvedValue(history);
  const opts = { ...options(), onOpen: jest.fn(), onNotice: jest.fn(), onRaw: jest.fn(),
    onClose: jest.fn(), onReconnecting: jest.fn(),
    imService: { listThreads, getMessages } as unknown as ConnectionManagerOptions['imService'] };
  const receivers: ConstructorParameters<typeof ImWebSocketReceiver>[0][] = [];
  const manager = new ConnectionManager(opts, created => {
    receivers.push(created);
    return { isConnected: true, start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined) } as unknown as ImWebSocketReceiver;
  });
  return { manager, opts, receivers, listThreads, getMessages, listed, history };
}

describe('ConnectionManager lifecycle', () => {
  it('reuses one start task and stops the owned receiver once', async () => {
    const receiver = {
      isConnected: true,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as ImWebSocketReceiver;
    const createReceiver = factory(receiver);
    const manager = new ConnectionManager(options(), createReceiver);

    const first = manager.start();
    const second = manager.start();
    expect(first).toBe(second);
    await first;
    await Promise.all([manager.stop(), manager.stop()]);

    expect(createReceiver).toHaveBeenCalledTimes(1);
    expect(receiver.start).toHaveBeenCalledTimes(1);
    expect(receiver.stop).toHaveBeenCalledTimes(1);
    expect(manager.connected).toBe(false);
  });

  it('cancels a late connection and does not let it resurrect after stop', async () => {
    let finishStart!: () => void;
    const pending = new Promise<void>((resolve) => { finishStart = resolve; });
    const receiver = {
      isConnected: false,
      start: jest.fn(() => pending),
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as ImWebSocketReceiver;
    const manager = new ConnectionManager(options(), factory(receiver));

    const start = manager.start();
    const stop = manager.stop();
    finishStart();

    await expect(start).rejects.toThrow('connection start cancelled');
    await stop;
    expect(receiver.stop).toHaveBeenCalled();
    expect(manager.connected).toBe(false);
  });

  it('keeps receiver state isolated across accounts', async () => {
    const one = {
      isConnected: true,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as ImWebSocketReceiver;
    const two = {
      isConnected: true,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as ImWebSocketReceiver;
    const first = new ConnectionManager(options(), factory(one));
    const second = new ConnectionManager({ ...options(), platformUid: '20002' }, factory(two));

    await Promise.all([first.start(), second.start()]);
    await first.stop();

    expect(one.stop).toHaveBeenCalledTimes(1);
    expect(two.stop).not.toHaveBeenCalled();
    expect(second.connected).toBe(true);
    await second.stop();
  });

  it('merges the whole pulled page as history, never as live inbound messages', async () => {
    let receiverOptions!: ConstructorParameters<typeof ImWebSocketReceiver>[0];
    const message = (index: string, text: string) => ({
      msgId: `msg-${index}`,
      threadId: 'group-1',
      senderUid: '20002',
      content: JSON.stringify({ text }),
      msgType: 7,
      createTime: Date.now(),
      status: 0,
      indexInConversationV2: index,
    });
    const listThreads = jest.fn()
      .mockResolvedValueOnce({
        statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', conversations: [],
        threads: [{
          threadId: 'group-1', conversationShortId: '88', conversationType: 2,
          peer: { uid: '', nickname: '' }, unreadCount: 0, updateTime: 0,
          lastMessage: message('10', 'seed'),
        }],
      })
      .mockResolvedValueOnce({
        statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', conversations: [],
        threads: [{
          threadId: 'group-1', conversationShortId: '88', conversationType: 2,
          peer: { uid: '', nickname: '' }, unreadCount: 2, updateTime: 0,
          lastMessage: message('12', 'second'),
        }],
      });
    const getMessages = jest.fn().mockResolvedValue({
      statusCode: 0, statusMsg: '', hasMore: false, cursor: '0', direction: 'older',
      messages: [message('12', 'second'), message('10', 'old'), message('11', 'first')],
    });
    const onInbound = jest.fn();
    const onHistoryBatch = jest.fn();
    const opts = {
      ...options(),
      imService: { listThreads, getMessages } as unknown as ConnectionManagerOptions['imService'],
      onInbound,
      onHistoryBatch,
    };
    const receiver = {
      isConnected: true,
      start: jest.fn(async () => receiverOptions.onOpen?.()),
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as ImWebSocketReceiver;
    const createReceiver: ImWebSocketReceiverFactory = jest.fn((created) => {
      receiverOptions = created;
      return receiver;
    });
    const manager = new ConnectionManager(opts, createReceiver);

    await manager.start();
    await manager.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    receiverOptions.onReconnecting?.({ attempt: 1, delayMs: 1000 });
    receiverOptions.onOpen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getMessages).toHaveBeenCalledWith({
      threadId: 'group-1', conversationShortId: '88', conversationType: 2, count: 50,
    });
    expect(onInbound).not.toHaveBeenCalled();
    expect(onHistoryBatch.mock.calls[1]![0].map((event: { text: string }) => event.text)).toEqual(['second', 'old', 'first']);
    // A later version of the same message must reach Account for merge, not vanish at transport.
    const received = onHistoryBatch.mock.calls[1]![0][0];
    receiverOptions.onInbound({ ...received, version: '2', rawContent: '' });
    expect(onInbound).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it.each(['list', 'history'] as const)('discards a late recovery %s response after stop', async stage => {
    const { manager, opts, receivers, listThreads, getMessages, listed, history } = recoveryHarness();
    const pendingList = deferred<typeof listed>();
    const pendingHistory = deferred<typeof history>();
    if (stage === 'list') listThreads.mockReturnValueOnce(pendingList.promise);
    else getMessages.mockReturnValueOnce(pendingHistory.promise);
    await manager.start();
    manager['hasOpened'] = true;
    receivers[0]!.onReconnecting?.({ attempt: 1, delayMs: 1 });
    receivers[0]!.onOpen?.();
    await settle();
    const deliveredBeforeStop = (opts.onHistoryBatch as jest.Mock).mock.calls.length;
    await manager.stop();
    pendingList.resolve(listed); pendingHistory.resolve(history);
    await settle();
    expect(opts.onHistoryBatch).toHaveBeenCalledTimes(deliveredBeforeStop);
    expect(manager['checkpoints'].size).toBe(0);
    expect(opts.onInbound).not.toHaveBeenCalled();
    if (stage === 'list') expect(getMessages).not.toHaveBeenCalled();
  });

  it('invalidates an older seed and recovery page when another reconnect supersedes them', async () => {
    const { manager, opts, receivers, listThreads, getMessages, listed, history } = recoveryHarness();
    const oldSeed = deferred<typeof listed>();
    const oldHistory = deferred<typeof history>();
    listThreads.mockReturnValueOnce(oldSeed.promise);
    getMessages.mockReturnValueOnce(oldHistory.promise);
    await manager.start();
    const receiver = receivers[0]!;
    receiver.onOpen?.();
    receiver.onReconnecting?.({ attempt: 1, delayMs: 1 }); receiver.onOpen?.();
    await settle();
    receiver.onReconnecting?.({ attempt: 2, delayMs: 1 }); receiver.onOpen?.();
    await settle();
    expect(opts.onHistoryBatch).toHaveBeenCalledTimes(3); // two snapshots, only latest page
    expect(manager['checkpoints'].get('700')).toBe('10');
    oldSeed.resolve({ ...listed, threads: [{ ...listed.threads[0]!, lastMessage: { ...history.messages[0]!, indexInConversationV2: '999' } }] });
    oldHistory.resolve({ ...history, messages: [{ ...history.messages[0]!, indexInConversationV2: '1000' }] });
    await settle();
    expect(opts.onHistoryBatch).toHaveBeenCalledTimes(3);
    expect(manager['checkpoints'].get('700')).toBe('10');
    expect(opts.onInbound).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('ignores every old receiver callback after a restart', async () => {
    const { manager, opts, receivers, listThreads } = recoveryHarness();
    await manager.start(); const old = receivers[0]!;
    await manager.stop(); await manager.start();
    old.onInbound({ threadId: 'stale', conversationShortId: '700', conversationType: 2, senderUid: '22', text: 'old', rawContent: 'old', messageType: 7, raw: {} });
    old.onNotice?.({ type: 'im.command', conversationId: 'stale', conversationType: 2, messageType: 50001, content: '{}', raw: {} });
    old.onRaw?.(1, {}); old.onClose?.(1000, 'old');
    old.onReconnecting?.({ attempt: 1, delayMs: 1 }); old.onOpen?.();
    await settle();
    for (const callback of [opts.onInbound, opts.onNotice, opts.onRaw, opts.onClose, opts.onReconnecting, opts.onOpen, opts.onHistoryBatch]) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(listThreads).not.toHaveBeenCalled();
    expect(manager['checkpoints'].size).toBe(0);
    await manager.stop();
  });

  it.each(['open', 'snapshot', 'page'] as const)('does not resume recovery if the %s callback stops it', async stage => {
    const { manager, opts, receivers, getMessages } = recoveryHarness();
    let stopped: Promise<void> | undefined;
    if (stage === 'open') opts.onOpen.mockImplementation(() => { stopped = manager.stop(); });
    else (opts.onHistoryBatch as jest.Mock).mockImplementation(messages => {
      if ((stage === 'snapshot') === (messages.length === 0)) stopped = manager.stop();
    });
    await manager.start();
    manager['hasOpened'] = true;
    receivers[0]!.onReconnecting?.({ attempt: 1, delayMs: 1 }); receivers[0]!.onOpen?.();
    await settle(); await stopped;
    expect(manager['checkpoints'].size).toBe(0);
    expect(getMessages).toHaveBeenCalledTimes(stage === 'page' ? 1 : 0);
  });
});
