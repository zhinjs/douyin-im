import { fileURLToPath } from 'node:url';

import protobuf from 'protobufjs';
import { DESKTOP_IM_PROFILE } from './desktop.js';

const PROTO_PATH = fileURLToPath(new URL('./proto/im.proto', import.meta.url));

const SDK_VERSION = DESKTOP_IM_PROFILE.version;
const BUILD_NUMBER = DESKTOP_IM_PROFILE.buildNumber;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rootPromise: Promise<any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadRoot(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!rootPromise) {
    rootPromise = protobuf.load(PROTO_PATH);
  }
  return rootPromise;
}

function assertKnownMessageFields(
  type: protobuf.Type,
  value: unknown,
  path: string,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const field = type.fields[key];
    if (!field) throw new Error(`unknown protobuf field: ${path}.${key}`);
    if (!(field.resolvedType instanceof protobuf.Type)) continue;
    if (field.map) {
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
      for (const [mapKey, mapValue] of Object.entries(child as Record<string, unknown>)) {
        assertKnownMessageFields(field.resolvedType, mapValue, `${path}.${key}[${mapKey}]`);
      }
      continue;
    }
    const children = field.repeated && Array.isArray(child) ? child : [child];
    children.forEach((item, index) => {
      const childPath = field.repeated ? `${path}.${key}[${index}]` : `${path}.${key}`;
      assertKnownMessageFields(field.resolvedType as protobuf.Type, item, childPath);
    });
  }
}

export interface EncodeRequestOptions {
  token: string;
  cmd: number;
  inboxType?: number;
  body?: Record<string, unknown>;
  sequenceId?: number;
  authType?: number;
  /** Desktop native IM access 字段。 */
  access?: string;
  /** device_id（浏览器发消息为空字符串） */
  deviceId?: string;
  /** 覆盖 device_platform。 */
  devicePlatform?: string;
  /** 覆盖 Desktop envelope headers。 */
  headers?: Record<string, string>;
  sdkVersion?: string;
  buildNumber?: string;
  refer?: number;
  versionCode?: string;
  biz?: string;
}

export interface DecodedResponse {
  cmd: number;
  sequenceId: number;
  statusCode: number;
  errorDesc: string;
  inboxType: number;
  body: Record<string, unknown> | null;
  logId: string;
}

let sequenceCounter = 0;

export async function encodeRequest(opts: EncodeRequestOptions): Promise<Uint8Array> {
  const root = await loadRoot();
  const RequestEnvelope = root.lookupType('im_proto.Request');

  sequenceCounter += 1;
  const access = opts.access ?? DESKTOP_IM_PROFILE.access;
  const envelope: Record<string, unknown> = {
    cmd: opts.cmd,
    sequenceId: opts.sequenceId ?? sequenceCounter,
    sdkVersion: opts.sdkVersion ?? SDK_VERSION,
    token: opts.token,
    refer: opts.refer ?? 3,
    inboxType: opts.inboxType ?? 1,
    buildNumber: opts.buildNumber ?? BUILD_NUMBER,
    deviceId: opts.deviceId ?? '',
    devicePlatform: opts.devicePlatform ?? (process.platform === 'win32' ? 'windows' : 'mac'),
    versionCode: opts.versionCode ?? '',
    headers: opts.headers ?? {},
    authType: opts.authType ?? 1,
    biz: opts.biz ?? DESKTOP_IM_PROFILE.biz,
    access,
  };

  if (opts.body) {
    assertKnownMessageFields(root.lookupType('im_proto.RequestBody'), opts.body, 'Request.body');
    envelope['body'] = opts.body;
  }

  const errMsg = RequestEnvelope.verify(envelope);
  if (errMsg) {
    throw new Error(`protobuf verify failed: ${errMsg}`);
  }

  const message = RequestEnvelope.create(envelope);
  return RequestEnvelope.encode(message).finish();
}


export async function decodeResponse(buffer: Uint8Array): Promise<DecodedResponse> {
  const root = await loadRoot();
  const ResponseEnvelope = root.lookupType('im_proto.Response');

  const decoded = ResponseEnvelope.decode(buffer) as unknown as {
    cmd?: number;
    sequenceId?: { low?: number; toNumber?: () => number } | number;
    statusCode?: number;
    errorDesc?: string;
    inboxType?: number;
    body?: Record<string, unknown>;
    logId?: string;
  };

  const seqId = decoded.sequenceId;
  let sequenceId = 0;
  if (typeof seqId === 'number') {
    sequenceId = seqId;
  } else if (seqId && typeof seqId.toNumber === 'function') {
    sequenceId = seqId.toNumber();
  }

  return {
    cmd: decoded.cmd ?? 0,
    sequenceId,
    statusCode: decoded.statusCode ?? 0,
    errorDesc: decoded.errorDesc ?? '',
    inboxType: decoded.inboxType ?? 0,
    body: decoded.body ?? null,
    logId: decoded.logId ?? '',
  };
}

export async function decodeRequestRaw(buffer: Uint8Array): Promise<Record<string, unknown>> {
  const root = await loadRoot();
  const RequestEnvelope = root.lookupType('im_proto.Request');
  const decoded = RequestEnvelope.decode(buffer);
  return RequestEnvelope.toObject(decoded, {
    longs: String,
    enums: String,
    defaults: false,
  }) as Record<string, unknown>;
}

export async function decodeResponseRaw(buffer: Uint8Array): Promise<Record<string, unknown>> {
  const root = await loadRoot();
  const ResponseEnvelope = root.lookupType('im_proto.Response');
  const decoded = ResponseEnvelope.decode(buffer);
  return ResponseEnvelope.toObject(decoded, {
    longs: String,
    enums: Number,
    defaults: false,
  }) as Record<string, unknown>;
}
