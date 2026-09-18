import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { decompressLz4Payload } from './lz4.js';

const PROTO_PATH = fileURLToPath(new URL('./proto/im.proto', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rootPromise: Promise<any>;

function loadRoot() {
  if (!rootPromise) {
    rootPromise = protobuf.load(PROTO_PATH);
  }
  return rootPromise;
}

export interface ImFrame {
  seqid: number;
  logid: number;
  /** uint64-safe wire values. ACK construction must use these strings. */
  seqidString: string;
  logidString: string;
  service: number;
  method: number;
  headers: { key: string; value: string }[];
  payloadEncoding?: string;
  payloadType?: string;
  payload: Uint8Array;
  logIdNew?: string;
  serverTiming?: string;
  msgId?: string;
  frameType?: number;
}

export async function encodeFrame(opts: {
  service: number;
  method: number;
  payload?: Uint8Array;
  seqid?: number | string;
  logid?: number | string;
  headers?: { key: string; value: string }[];
  payloadEncoding?: string;
  payloadType?: string;
  logIdNew?: string;
  serverTiming?: string;
  msgId?: string;
  frameType?: number;
}): Promise<Uint8Array> {
  const root = await loadRoot();
  const Frame = root.lookupType('im_proto.Frame');
  const msg = Frame.create({
    seqid: opts.seqid ?? Date.now(),
    logid: opts.logid ?? Date.now(),
    service: opts.service,
    method: opts.method,
    headers: opts.headers ?? [],
    payloadEncoding: opts.payloadEncoding ?? '',
    payloadType: opts.payloadType ?? 'pb',
    payload: opts.payload ?? new Uint8Array(0),
    logIdNew: opts.logIdNew ?? '',
    serverTiming: opts.serverTiming ?? '',
    msgId: opts.msgId ?? '',
    frameType: opts.frameType ?? 0,
  });
  return Frame.encode(msg).finish() as Uint8Array;
}

export async function decodeFrame(buffer: Uint8Array): Promise<ImFrame> {
  const root = await loadRoot();
  const Frame = root.lookupType('im_proto.Frame');
  const decoded = Frame.decode(buffer) as {
    seqid?: { toNumber?: () => number; toString?: () => string } | number;
    logid?: { toNumber?: () => number; toString?: () => string } | number;
    service?: number;
    method?: number;
    headers?: { key?: string; value?: string }[];
    payloadEncoding?: string;
    payloadType?: string;
    payload?: Uint8Array;
    logIdNew?: string;
    serverTiming?: string;
    msgId?: string;
    frameType?: number;
  };

  let payload = decoded.payload ?? new Uint8Array(0);
  if (decoded.payloadEncoding === '__lz4' && payload.length > 0) {
    payload = decompressLz4Payload(payload);
  }

  const toNum = (v: { toNumber?: () => number } | number | undefined): number => {
    if (typeof v === 'number') return v;
    if (v && typeof v.toNumber === 'function') return v.toNumber();
    return 0;
  };
  const toString = (v: { toString?: () => string } | number | undefined): string =>
    v == null ? '0' : typeof v === 'number' ? String(v) : v.toString?.() ?? '0';

  const frame: ImFrame = {
    seqid: toNum(decoded.seqid),
    logid: toNum(decoded.logid),
    seqidString: toString(decoded.seqid),
    logidString: toString(decoded.logid),
    service: decoded.service ?? 0,
    method: decoded.method ?? 0,
    headers: (decoded.headers ?? []).map((h) => ({
      key: h.key ?? '',
      value: h.value ?? '',
    })),
    payload,
  };
  if (decoded.payloadEncoding) frame.payloadEncoding = decoded.payloadEncoding;
  if (decoded.payloadType) frame.payloadType = decoded.payloadType;
  if (decoded.logIdNew) frame.logIdNew = decoded.logIdNew;
  if (decoded.serverTiming) frame.serverTiming = decoded.serverTiming;
  if (decoded.msgId) frame.msgId = decoded.msgId;
  if (decoded.frameType != null) frame.frameType = decoded.frameType;
  return frame;
}

export function frameHeader(frame: Pick<ImFrame, 'headers'>, key: string): string | undefined {
  return frame.headers.find((header) => header.key === key)?.value;
}

/** Frontier WebSocket QoS ACK used by the Desktop client. */
export async function encodeFrontierAck(frame: ImFrame): Promise<Uint8Array | undefined> {
  if (frameHeader(frame, 'need_ack') !== '1' || frameHeader(frame, 'is_ack') === '1') {
    return undefined;
  }
  return encodeFrame({
    seqid: frame.seqidString,
    logid: frame.logidString,
    service: frame.service,
    method: frame.method,
    headers: [
      { key: 'is_ack', value: '1' },
      { key: 'ack_id', value: frame.logIdNew ?? '' },
      { key: 'ack_code', value: '0' },
    ],
    payloadType: '',
    logIdNew: frame.logIdNew ?? '',
  });
}
