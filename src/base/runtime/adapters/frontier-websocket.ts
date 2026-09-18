import type { ImNotice } from '../../../services/im/types.js';
import { extractProtoNotices, noticeFromPush } from '../../../services/im/notifications.js';
import { FrontierImWs, type ImPushMessage } from '../../../services/im/ws-client.js';
import { reconnectDelay, type ReconnectEvent } from '../reconnect.js';
import { inboundFromPush } from '../../raw/inbound-message.js';
import type { RawInboundMessage } from '../../raw/inbound-message.js';
import { getLogger } from '../../../logger.js';
import { FrontierCursors, type FrontierCursorStore } from '../../../services/im/frontier-cursors.js';

const logger = getLogger('Runtime:FrontierWS');

export interface ImWebSocketReceiverOptions {
  deviceId: string;
  installId?: string;
  cookies: string;
  cursorStore?: FrontierCursorStore;
  userAgent?: string;
  verbose?: boolean;
  /** 入站消息回调（纯 DTO，不含发送能力） */
  onInbound: (message: RawInboundMessage) => void;
  onNotice?: (notice: ImNotice) => void;
  onRaw?: (cmd: number, response: Record<string, unknown>) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onReconnecting?: (payload: ReconnectEvent) => void;
}

export class ImWebSocketReceiver {
  private ws: FrontierImWs | undefined;
  private readonly opts: ImWebSocketReceiverOptions;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private stopped = true;
  private hasConnected = false;
  private readonly cursors: FrontierCursors;

  constructor(opts: ImWebSocketReceiverOptions) {
    this.opts = opts;
    this.cursors = new FrontierCursors(opts.deviceId, opts.cursorStore);
  }

  get frontierWs(): FrontierImWs | undefined {
    return this.ws;
  }

  get isConnected(): boolean {
    return this.ws?.connected ?? false;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const wsOpts: ConstructorParameters<typeof FrontierImWs>[0] = {
      deviceId: this.opts.deviceId,
      cookies: this.opts.cookies,
      verbose: true,
      cursors: this.cursors,
      ...(this.opts.installId ? { installId: this.opts.installId } : {}),
    };
    if (this.opts.userAgent) wsOpts.userAgent = this.opts.userAgent;
    if (this.opts.verbose != null) wsOpts.verbose = this.opts.verbose;
    this.ws = new FrontierImWs(wsOpts);

    this.ws.on('message', (push: ImPushMessage) => {
      const notice = noticeFromPush(push);
      if (notice) {
        this.opts.onNotice?.(notice);
        return;
      }
      const tag = `会话类型${push.conversationType}`;
      logger.debug('收到%s消息 from=%s type=%s', tag, push.senderUid, push.messageType);
      if (push.content) {
        const preview = push.content.length > 80 ? push.content.slice(0, 80) + '…' : push.content;
        logger.debug('消息内容: %s', preview);
      }
      if (!push.conversationShortId) {
        logger.warn('push 缺少 conversationShortId thread=%s', push.conversationId);
      }

      const inbound = inboundFromPush(push);
      if (inbound) {
        logger.debug(
          '组装入站消息 type=%s text=%j',
          inbound.conversationType,
          inbound.text.slice(0, 40),
        );
        try {
          this.opts.onInbound(inbound);
        } catch (err) {
          logger.error(err, '入站消息 handler 执行失败');
        }
      }
    });

    this.ws.on('protobuf', (resp: Record<string, unknown>) => {
      const cmd = (resp['cmd'] as number) ?? 0;
      const body = resp['body'] as Record<string, unknown> | undefined;
      const bodyKeys = body ? Object.keys(body).join(',') : '(no body)';
      logger.debug('protobuf cmd=%s bodyKeys=[%s]', cmd, bodyKeys);
      this.opts.onRaw?.(cmd, resp);
      for (const notice of extractProtoNotices(resp)) this.opts.onNotice?.(notice);
    });

    this.ws.on('open', () => {
      this.hasConnected = true;
      this.reconnectAttempt = 0;
      logger.success('WebSocket 已连接');
      this.opts.onOpen?.();
    });
    this.ws.on('close', (code: number, reason: string) => {
      logger.warn('WebSocket 断开 code=%s reason=%s', code, reason);
      this.opts.onClose?.(code, reason);
      if (!this.stopped && this.hasConnected) this.scheduleReconnect(code, reason);
    });
    this.ws.on('error', (error: unknown) => {
      logger.warn('WebSocket error: %o', error);
    });

    await this.ws.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.hasConnected = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    delete this.reconnectTimer;
    this.ws?.close();
    this.ws = undefined;
  }

  private scheduleReconnect(code?: number, reason?: string): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = ++this.reconnectAttempt;
    const delayMs = reconnectDelay(attempt);
    const payload: ReconnectEvent = { attempt, delayMs };
    if (code != null) payload.code = code;
    if (reason) payload.reason = reason;
    this.opts.onReconnecting?.(payload);
    this.reconnectTimer = setTimeout(() => {
      delete this.reconnectTimer;
      if (this.stopped) return;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delayMs);
  }
}
