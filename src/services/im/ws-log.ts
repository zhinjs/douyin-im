import type { ImFrame } from './frame.js';

export type WsEventKind = 'open' | 'close' | 'text' | 'frame' | 'protobuf' | 'decode_error' | 'ignored' | 'ack';

export interface WsLogEvent {
  kind: WsEventKind;
  at: number;
  /** 文本帧（hi/ok 等） */
  text?: string;
  frame?: ImFrame;
  /** decodeResponseRaw 结果 */
  response?: Record<string, unknown>;
  error?: string;
  note?: string;
}

const CMD_NAMES: Record<number, string> = {
  100: 'SEND_MESSAGE',
  203: 'GET_BY_USER_INIT',
  301: 'GET_BY_CONVERSATION',
  500: 'NEW_MESSAGE_NOTIFY',
  504: 'NEW_P2P_MESSAGE_NOTIFY',
  1099: 'UNKNOWN_PUSH_1099',
  1001: 'STRANGER_CONV_LIST',
};

export function cmdLabel(cmd: number): string {
  const name = CMD_NAMES[cmd];
  return name ? `${cmd}(${name})` : String(cmd);
}

function parseTextFromContent(content: unknown): string | undefined {
  if (typeof content !== 'string' || !content) return undefined;
  try {
    const j = JSON.parse(content) as { text?: string };
    if (typeof j.text === 'string') return j.text;
  } catch {
    /* */
  }
  return content.length > 120 ? `${content.slice(0, 120)}…` : content;
}

function summarizeMessage(msg: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!msg) return null;
  return {
    conversationId: msg['conversationId'],
    conversationShortId: msg['conversationShortId'],
    sender: msg['sender'],
    messageType: msg['messageType'],
    text: parseTextFromContent(msg['content']),
    createTime: msg['createTime'],
  };
}

export function summarizeResponseBody(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!body) return {};
  const out: Record<string, unknown> = {};

  const inbox = body['messagesPerUserInitV2Body'] as Record<string, unknown> | null;
  if (inbox) {
    const convs = inbox['conversations'] as unknown[] | undefined;
    out['messagesPerUserInitV2Body'] = {
      conversationCount: convs?.length ?? 0,
      nextCursor: inbox['nextCursor'],
      hasMore: inbox['hasMore'],
      preview: (convs ?? []).slice(0, 3).map((c) => {
        const row = c as Record<string, unknown>;
        const core = row['conversationCoreInfo'] as Record<string, unknown> | undefined;
        return {
          id: row['conversationId'],
          shortId: row['conversationShortId'],
          type: row['conversationType'],
          name: core?.['name'],
        };
      }),
    };
  }

  const notify =
    (body['hasNewMessageNotify'] as Record<string, unknown> | null) ??
    (body['strangerHasNewMessageNotify'] as Record<string, unknown> | null) ??
    (body['hasNewP2pMessageNotify'] as Record<string, unknown> | null);
  if (notify) {
    const message =
      (notify['message'] as Record<string, unknown> | null) ??
      (notify['sendType'] !== undefined || notify['send_type'] !== undefined
        ? notify
        : null);
    out['notify'] = {
      conversationId: notify['conversationId'],
      conversationType: notify['conversationType'],
      message: summarizeMessage(message),
    };
  }

  const sendMsg = body['sendMessageBody'] as Record<string, unknown> | null;
  if (sendMsg) {
    out['sendMessageBody'] = {
      serverMessageId: sendMsg['serverMessageId'],
      status: sendMsg['status'],
      clientMessageId: sendMsg['clientMessageId'],
      checkMessage: typeof sendMsg['checkMessage'] === 'string' ? sendMsg['checkMessage'].slice(0, 200) : sendMsg['checkMessage'],
    };
  }

  const cm = body['messagesInConversationBody'] as Record<string, unknown> | null;
  if (cm) {
    const msgs = cm['messages'] as unknown[] | undefined;
    out['messagesInConversationBody'] = { count: msgs?.length ?? 0, hasMore: cm['hasMore'] };
  }

  const otherKeys = Object.keys(body).filter(
    (k) => body[k] != null && ![
      'messagesPerUserInitV2Body',
      'hasNewMessageNotify',
      'strangerHasNewMessageNotify',
      'hasNewP2pMessageNotify',
      'sendMessageBody',
      'messagesInConversationBody',
    ].includes(k),
  );
  if (otherKeys.length > 0) {
    out['_otherBodyFields'] = otherKeys;
  }

  return out;
}

export function formatWsLogEvent(ev: WsLogEvent): string {
  const ts = new Date(ev.at).toISOString().slice(11, 23);
  switch (ev.kind) {
    case 'text':
      return `[${ts}] TEXT ${JSON.stringify(ev.text)}`;
    case 'ack':
      return `[${ts}] ACK${ev.note ? ` ${ev.note}` : ''}`;
    case 'ignored':
      return `[${ts}] IGNORED${ev.note ? ` ${ev.note}` : ''}`;
    case 'decode_error':
      return `[${ts}] DECODE_ERR ${ev.error}${ev.note ? ` (${ev.note})` : ''}`;
    case 'frame':
      return `[${ts}] FRAME seq=${ev.frame?.seqidString ?? '0'} svc=${ev.frame?.service} method=${ev.frame?.method} enc=${ev.frame?.payloadEncoding ?? '-'} type=${ev.frame?.payloadType ?? '-'} payloadBytes=${ev.frame?.payload.length ?? 0}`;
    case 'protobuf': {
      const r = ev.response;
      if (!r) return `[${ts}] PB${ev.note ? ` ${ev.note}` : ''}`;
      const cmd = (r['cmd'] as number) ?? 0;
      const body = summarizeResponseBody(r['body'] as Record<string, unknown> | null);
      return `[${ts}] PB cmd=${cmdLabel(cmd)} status=${r['statusCode']} seq=${r['sequenceId']} inbox=${r['inboxType']} body=${JSON.stringify(body)}`;
    }
    default:
      return `[${ts}] ${ev.kind}${ev.note ? ` ${ev.note}` : ''}`;
  }
}
