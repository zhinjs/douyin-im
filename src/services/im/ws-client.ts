import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { decodeResponseRaw } from './codec.js';
import { decodeFrame, encodeFrontierAck, type ImFrame } from './frame.js';
import { buildFrontierWsUrl, IM_WS_CONFIG } from './credentials.js';
import { formatWsLogEvent, summarizeResponseBody, type WsLogEvent } from './ws-log.js';
import { getLogger } from '../../logger.js';
import type { MessageReferenceInfo, MessagePropertyItem } from './types.js';
import { mapMessageProperties } from './message-property.js';
import { messageContentBytes, messageContentText } from './message-content.js';
import { FrontierCursors } from './frontier-cursors.js';

const logger = getLogger('IM:FrontierClient');

export interface FrontierWsOptions {
  deviceId: string;
  installId?: string;
  cookies: string;
  userAgent?: string;
  /** 为每个入站帧 emit('log')，并在 verbose 时写入 debug 日志。 */
  verbose?: boolean;
  cursors?: FrontierCursors;
}

export interface ImPushMessage {
  cmd: number;
  inboxType?: number;
  conversationId: string;
  conversationShortId: string;
  conversationType: number;
  senderUid: string;
  senderSecUid?: string;
  content: string;
  /** Binary form used by Desktop command messages such as message properties. */
  contentBytes?: Uint8Array;
  messageType: number;
  serverMessageId?: string;
  clientMessageId?: string;
  createTime?: string;
  status?: number;
  version?: string;
  orderInConversation?: string;
  indexInConversation?: string;
  indexInConversationV2?: string;
  ext?: Readonly<Record<string, string>>;
  referenceInfo?: MessageReferenceInfo;
  propertyList?: Readonly<Record<string, readonly MessagePropertyItem[]>>;
  raw: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return String(value);
  }
  return '';
}

function stringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const entries = Object.entries(source)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

function referenceInfo(value: unknown): MessageReferenceInfo | undefined {
  const source = record(value);
  if (!source) return undefined;
  const refMessageId = stringField(
    source,
    'referencedMessageId',
    'referenced_message_id',
    'refMessageId',
    'ref_message_id',
  );
  const hint = String(source['hint'] ?? '');
  if (!refMessageId || refMessageId === '0' || !hint) return undefined;
  const rootMessageId = stringField(source, 'rootMessageId', 'root_message_id');
  const rootMessageConvIndex = stringField(source, 'rootMessageConvIndex', 'root_message_conv_index');
  return Object.freeze({
    refMessageId,
    hint,
    refMessageType: Number(source['refMessageType'] ?? source['ref_message_type'] ?? 0),
    refMessageStatus: Number(
      source['referencedMessageStatus']
        ?? source['referenced_message_status']
        ?? source['refMessageStatus']
        ?? source['ref_message_status']
        ?? 0,
    ),
    ...(rootMessageId && rootMessageId !== '0' ? { rootMessageId } : {}),
    ...(rootMessageConvIndex && rootMessageConvIndex !== '0' ? { rootMessageConvIndex } : {}),
  });
}

/** Convert native message notifications (cmd 500/504/1099; body tags 500/504/503) into one DTO. */
export function pushFromResponse(
  cmd: number,
  resp: Record<string, unknown>,
): ImPushMessage | null {
  const body = record(resp['body']);
  if (!body) return null;

  const notify =
    record(body['hasNewMessageNotify']) ??
    record(body['has_new_message_notify']) ??
    record(body['strangerHasNewMessageNotify']) ??
    record(body['stranger_has_new_message_notify']) ??
    record(body['hasNewP2pMessageNotify']) ??
    record(body['has_new_p2p_message_notify']);

  if (notify) {
    // cmd 504 / NewP2PMessageNotify is flat in the Desktop descriptor; the
    // regular and stranger notifications wrap a ConversationMessage.
    const message = record(notify['message']) ??
      (cmd === 504 || notify['sendType'] !== undefined || notify['send_type'] !== undefined
        ? notify
        : undefined);
    if (!message) return null;
    const senderSecUid = stringField(message, 'secSender', 'sec_sender');
    const ext = stringMap(message['ext']);
    const clientMessageId = String(
      message['clientId'] ?? message['clientMessageId'] ?? message['client_message_id'] ??
      ext?.['s:client_message_id'] ?? '',
    );
    const refInfo = referenceInfo(
      message['refInfo']
        ?? message['referenceInfo']
        ?? message['reference_info']
        ?? notify['refMsgInfo']
        ?? notify['ref_msg_info'],
    );
    const contentBytes = messageContentBytes(message['content'] ?? message['text']);
    const propertyList = mapMessageProperties(message['propertyList']);
    return {
      cmd,
      inboxType: Number(resp['inboxType'] ?? resp['inbox_type'] ?? 0),
      conversationId:
        stringField(notify, 'conversationId', 'conversation_id') ||
        stringField(message, 'conversationId', 'conversation_id'),
      conversationShortId:
        stringField(notify, 'conversationShortId', 'conversation_short_id') ||
        stringField(message, 'conversationShortId', 'conversation_short_id') ||
        String(message['convShortId'] ?? ''),
      conversationType: Number(
        notify['conversationType'] ?? notify['conversation_type'] ??
        message['conversationType'] ?? message['conversation_type'] ?? message['convType'] ?? 1,
      ),
      senderUid: String(message['sender'] ?? ''),
      ...(senderSecUid ? { senderSecUid } : {}),
      content: messageContentText(message['content'] ?? message['text']),
      ...(contentBytes.length > 0 ? { contentBytes } : {}),
      messageType: Number(message['messageType'] ?? message['message_type'] ?? message['type'] ?? 0),
      serverMessageId:
        stringField(message, 'serverMessageId', 'server_message_id') || String(message['serverId'] ?? ''),
      ...(clientMessageId ? { clientMessageId } : {}),
      createTime:
        stringField(message, 'createTime', 'create_time') || String(message['createdAt'] ?? ''),
      status: Number(message['status'] ?? message['serverStatus'] ?? message['server_status'] ?? 0),
      version: stringField(message, 'version', 'version'),
      orderInConversation: stringField(message, 'orderInConversation', 'order_in_conversation'),
      indexInConversation: stringField(message, 'indexInConversation', 'index_in_conversation'),
      indexInConversationV2: stringField(message, 'indexInConversationV2', 'index_in_conversation_v2'),
      ...(ext ? { ext } : {}),
      ...(refInfo ? { referenceInfo: refInfo } : {}),
      ...(propertyList ? { propertyList } : {}),
      raw: resp,
    };
  }

  // A recognized push without a decodable message remains observable for protocol diagnosis.
  if (cmd === 500 || cmd === 504 || cmd === 1099) {
    return {
      cmd,
      conversationId: '',
      conversationShortId: '',
      conversationType: 0,
      senderUid: '',
      content: JSON.stringify(summarizeResponseBody(body)),
      messageType: 0,
      raw: resp,
    };
  }

  return null;
}

/**
 * Frontier IM WebSocket（wss://frontier-im.douyin.com/ws/v2）
 */
export class FrontierImWs extends EventEmitter {
  private readonly cursors: FrontierCursors;
  private ws: WebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: FrontierWsOptions) {
    super();
    this.cursors = opts.cursors ?? new FrontierCursors(opts.deviceId);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const url = buildFrontierWsUrl({
      deviceId: this.opts.deviceId,
      ...(this.opts.installId ? { installId: this.opts.installId } : {}),
    });
    this.log({ kind: 'open', at: Date.now(), note: IM_WS_CONFIG.frontierUrl });

    const wsHeaders: Record<string, string> = {
      Origin: 'https://imdesktop.douyin.com',
      Referer: 'https://imdesktop.douyin.com/',
      Cookie: this.opts.cookies,
      'x-support-qos2': '1',
      'x-support-ack': '1',
    };
    if (this.opts.userAgent) wsHeaders['User-Agent'] = this.opts.userAgent;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, IM_WS_CONFIG.wsProtocols, { headers: wsHeaders });
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      const onOpen = () => {
        cleanup();
        this.startHeartbeat();
        this.emit('open');
        resolve();
      };
      const onError = (ev: WebSocket.ErrorEvent) => {
        cleanup();
        const err = ev as unknown as Record<string, unknown>;
        const statusCode = err['statusCode'] ?? err['status'] ?? '';
        const msg = err['message'] ?? 'unknown';
        reject(new Error(`WebSocket error: ${msg} (status=${statusCode})`));
      };
      const onClose = (ev: WebSocket.CloseEvent) => {
        if (ws.readyState !== WebSocket.OPEN) {
          cleanup();
          reject(new Error(`WebSocket closed before open: code=${ev.code} reason=${ev.reason}`));
        }
      };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);

      let messages = Promise.resolve();
      ws.addEventListener('message', (ev) => {
        // Async proto loading must not reorder cursor updates or leak rejected handlers.
        messages = messages.then(async () => {
          if (this.ws === ws && ws.readyState === WebSocket.OPEN) await this.onMessage(ev);
        }).catch((error: unknown) => { this.emit('error', error); });
      });
      ws.addEventListener('close', (ev) => {
        this.stopHeartbeat();
        this.log({ kind: 'close', at: Date.now(), note: `code=${ev.code} reason=${ev.reason || '-'}` });
        this.emit('close', ev.code ?? 1006, ev.reason ?? '');
      });
    });
  }

  close(): void {
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = undefined;
  }

  private log(ev: WsLogEvent): void {
    this.emit('log', ev);
    if (this.opts.verbose) {
      logger.debug(formatWsLogEvent(ev));
    }
  }

  private async onMessage(ev: WebSocket.MessageEvent): Promise<void> {
    if (typeof ev.data === 'string') {
      const text = ev.data;
      // Frontier 心跳：客户端每 15s 发 "hi"，服务端常回 "hi"/"ok"（非业务消息）
      const isHeartbeat = text === 'hi' || text === 'ok';
      if (!isHeartbeat) {
        this.log({ kind: 'text', at: Date.now(), text });
      }
      this.emit('text', text);
      return;
    }

    const raw = ev.data;
    const buf = typeof raw === 'string'
      ? Buffer.from(raw)
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw as ArrayBuffer);
    if (buf.length === 0) return;

    let frame: ImFrame;
    try {
      frame = await decodeFrame(buf);
      this.log({ kind: 'frame', at: Date.now(), frame });
      this.emit('frame', frame);
      const acknowledgement = await encodeFrontierAck(frame);
      if (acknowledgement && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(acknowledgement);
        this.log({
          kind: 'ack',
          at: Date.now(),
          note: `frontier ack id=${frame.logIdNew || frame.logidString}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log({
        kind: 'decode_error',
        at: Date.now(),
        error: `frame: ${msg}`,
        note: `hex=${Buffer.from(buf).toString('hex').slice(0, 64)}…`,
      });
      this.emit('error', err);
      return;
    }

    const control = await this.cursors.control(frame);
    if (control.handled) {
      if (control.reply && this.ws?.readyState === WebSocket.OPEN) this.ws.send(control.reply);
      return;
    }
    if (this.cursors.isDuplicate(frame)) return;
    if (frame.payloadType !== 'pb' || frame.payload.length === 0) {
      this.log({
        kind: 'ignored',
        at: Date.now(),
        note: `non-pb payload type=${frame.payloadType ?? 'none'} len=${frame.payload.length}`,
      });
      return;
    }

    let resp: Record<string, unknown>;
    try {
      resp = await decodeResponseRaw(frame.payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log({
        kind: 'decode_error',
        at: Date.now(),
        error: `protobuf: ${msg}`,
        frame,
        note: `payloadHex=${Buffer.from(frame.payload).toString('hex').slice(0, 64)}…`,
      });
      this.emit('error', err);
      return;
    }

    this.log({ kind: 'protobuf', at: Date.now(), frame, response: resp });
    this.emit('protobuf', resp, frame);

    const cmd = (resp['cmd'] as number) ?? 0;
    const push = pushFromResponse(cmd, resp);
    if (push) {
      this.emit('message', push);
    }
    this.cursors.commit(frame);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('hi');
      }
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
