import type { ImService } from '../../services/im/service.js';
import type { FrontierCursorStore } from '../../services/im/frontier-cursors.js';
import type { ImNotice, ImConversation } from '../../services/im/types.js';
import type { RawInboundMessage } from '../raw/inbound-message.js';
import { getLogger, type Logger } from '../../logger.js';

const logger = getLogger('Runtime:Connection');
import { inboundFromThread } from '../raw/inbound-message.js';
import { ImWebSocketReceiver } from './adapters/frontier-websocket.js';

export interface ReconnectingSignal {
  attempt: number;
  delayMs: number;
  code?: number;
  reason?: string;
}

export interface ConnectionManagerOptions {
  platformUid: string;
  deviceId: string;
  installId?: string;
  sessionCookies: string;
  cursorStore?: FrontierCursorStore;
  deviceUserAgent: string;
  imService: ImService;
  logger?: Logger;
  onInbound: (message: RawInboundMessage) => void;
  /** Pulled history updates state in batches; never dispatch it as live inbound messages. */
  onHistoryBatch: (messages: readonly RawInboundMessage[], conversations: readonly ImConversation[]) => void;
  onNotice?: (notice: ImNotice) => void;
  onRaw?: (cmd: number, response: Record<string, unknown>) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onReconnecting?: (payload: ReconnectingSignal) => void;
}

export type ImWebSocketReceiverFactory = (
  options: ConstructorParameters<typeof ImWebSocketReceiver>[0],
) => ImWebSocketReceiver;

const DEFAULT_RECEIVER_FACTORY: ImWebSocketReceiverFactory =
  (options) => new ImWebSocketReceiver(options);

/**
 * Owns exactly one account's inbound connection lifecycle.
 *
 * Desktop Frontier, catch-up and cancellation of late connection
 * attempts stay behind start/stop.
 */
export class ConnectionManager {
  private receiver?: ImWebSocketReceiver;
  private generation = 0;
  private startTask?: Promise<void>;
  private stopTask?: Promise<void>;
  private running = false;
  private hasOpened = false;
  private needsCatchUp = false;
  private recoveryEpoch = 0;
  /** conversationId -> last known server index (decimal int64). */
  private readonly checkpoints = new Map<string, string>();

  private get logger(): Logger {
    return this.options.logger ?? logger;
  }

  constructor(
    private readonly options: ConnectionManagerOptions,
    private readonly createReceiver: ImWebSocketReceiverFactory = DEFAULT_RECEIVER_FACTORY,
  ) {}

  get connected(): boolean {
    return this.receiver?.isConnected ?? false;
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.startTask) return this.startTask;
    const generation = ++this.generation;
    const task = this.performStart(generation);
    this.startTask = task;
    void task.finally(() => {
      if (this.startTask === task) delete this.startTask;
    }).catch(() => undefined);
    return task;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const task = this.performStop();
    this.stopTask = task;
    void task.finally(() => {
      if (this.stopTask === task) delete this.stopTask;
    }).catch(() => undefined);
    return task;
  }

  private async performStart(generation: number): Promise<void> {
    await this.activate(this.createDesktopReceiver(generation), generation);
  }

  private async performStop(): Promise<void> {
    this.generation += 1;
    this.running = false;
    const receiver = this.detachReceiver();
    await receiver?.stop();
    const startTask = this.startTask;
    if (startTask) await startTask.catch(() => undefined);
    const lateReceiver = this.detachReceiver();
    if (lateReceiver && lateReceiver !== receiver) await lateReceiver.stop();
    this.hasOpened = false;
    this.needsCatchUp = false;
    this.recoveryEpoch++;
    this.checkpoints.clear();
  }

  private createDesktopReceiver(generation: number): ImWebSocketReceiver {
    return this.createReceiver({
      deviceId: this.options.deviceId,
      cookies: this.options.sessionCookies,
      ...(this.options.cursorStore ? { cursorStore: this.options.cursorStore } : {}),
      ...(this.options.installId ? { installId: this.options.installId } : {}),
      userAgent: this.options.deviceUserAgent,
      onInbound: (message) => { if (generation === this.generation) this.receiveInbound(message); },
      onNotice: (notice) => { if (generation === this.generation) this.options.onNotice?.(notice); },
      onRaw: (cmd, response) => { if (generation === this.generation) this.options.onRaw?.(cmd, response); },
      onOpen: () => { if (generation === this.generation) this.handleOpen(); },
      onClose: (code, reason) => { if (generation === this.generation) this.options.onClose?.(code, reason); },
      onReconnecting: (payload) => { if (generation === this.generation) this.handleReconnecting(payload); },
    });
  }

  private async activate(receiver: ImWebSocketReceiver, generation: number): Promise<void> {
    this.receiver = receiver;
    await receiver.start();
    try {
      this.assertCurrent(generation);
    } catch (error) {
      await receiver.stop();
      if (this.receiver === receiver) delete this.receiver;
      throw error;
    }
    this.running = true;
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('connection start cancelled');
  }

  private detachReceiver(): ImWebSocketReceiver | undefined {
    const receiver = this.receiver;
    delete this.receiver;
    return receiver;
  }

  private receiveInbound(message: RawInboundMessage): void {
    this.advanceCheckpoint(message.threadId, this.messageIndex(message));
    // Repeats and self echoes still carry server state. Account merges before deciding to emit.
    this.options.onInbound(message);
  }

  private handleReconnecting(payload: ReconnectingSignal): void {
    this.needsCatchUp = true;
    this.recoveryEpoch++;
    this.options.onReconnecting?.(payload);
  }

  private handleOpen(): void {
    const generation = this.generation;
    const reconnect = this.hasOpened && this.needsCatchUp;
    this.hasOpened = true;
    this.options.onOpen?.();
    if (generation !== this.generation) return;
    if (reconnect) {
      this.needsCatchUp = false;
      void this.recoverMissedMessages().catch((error) => {
        this.logger.warn('断线消息补拉失败: %s', error instanceof Error ? error.message : error);
      });
    } else if (this.checkpoints.size === 0) {
      void this.seedCheckpoints().catch((error) => {
        this.logger.warn('会话游标初始化失败: %s', error instanceof Error ? error.message : error);
      });
    }
  }

  /**
   * The existing bounded catch-up query is not the full native cursor scheduler.
   * Every returned ordinary history row must merge (including older revisions),
   * and pull results use a batch callback rather than triggering live bot handlers.
   */
  private async recoverMissedMessages(): Promise<void> {
    const generation = this.generation;
    const epoch = ++this.recoveryEpoch;
    const current = () => generation === this.generation && epoch === this.recoveryEpoch;
    const listed = await this.options.imService.listThreads({ count: 50 });
    if (!current()) return;
    if (listed.statusCode !== 0) throw new Error(`${listed.statusCode} ${listed.statusMsg}`.trim());
    this.options.onHistoryBatch([], listed.conversations);

    for (const thread of listed.threads) {
      if (!current()) return;
      const latest = thread.lastMessage;
      if (!latest) continue;
      const known = this.checkpoints.get(thread.threadId);
      const latestIndex = latest.indexInConversationV2 || latest.indexInConversation;
      const isNewConversation = known == null;
      if (!isNewConversation && latestIndex && compareDecimal(latestIndex, known) <= 0) continue;

      const history = await this.options.imService.getMessages({
        threadId: thread.threadId,
        ...(thread.conversationShortId ? { conversationShortId: thread.conversationShortId } : {}),
        ...(thread.conversationType != null ? { conversationType: thread.conversationType } : {}),
        ...(thread.inboxType != null ? { inboxType: thread.inboxType } : {}),
        count: 50,
      });
      if (!current()) return;
      if (history.statusCode !== 0) continue;
      const incoming: RawInboundMessage[] = [];
      for (const message of history.messages) {
        const inbound = inboundFromThread(thread, message, message.inboxType ?? thread.inboxType);
        if (inbound) incoming.push(inbound);
      }
      this.options.onHistoryBatch(incoming, []);
      if (!current()) return;
      for (const message of incoming) this.advanceCheckpoint(message.threadId, this.messageIndex(message));
      this.advanceCheckpoint(thread.threadId, latestIndex);
    }
  }

  private async seedCheckpoints(): Promise<void> {
    const generation = this.generation;
    const epoch = this.recoveryEpoch;
    const listed = await this.options.imService.listThreads({ count: 50 });
    if (generation !== this.generation || epoch !== this.recoveryEpoch) return;
    if (listed.statusCode !== 0) return;
    for (const thread of listed.threads) {
      const latest = thread.lastMessage;
      this.advanceCheckpoint(
        thread.threadId,
        latest?.indexInConversationV2 || latest?.indexInConversation,
      );
    }
  }

  private messageIndex(message: RawInboundMessage): string | undefined {
    return message.indexInConversationV2 || message.indexInConversation;
  }

  private advanceCheckpoint(threadId: string, index?: string): void {
    if (!index) return;
    const current = this.checkpoints.get(threadId);
    if (!current || compareDecimal(index, current) > 0) this.checkpoints.set(threadId, index);
  }
}

function compareDecimal(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}
