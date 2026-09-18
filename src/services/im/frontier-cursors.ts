import { encodeFrame, frameHeader, type ImFrame } from './frame.js';

export interface FrontierCursor {
  service: number;
  name: string;
  value: string;
}

export interface FrontierCursorStore {
  getFrontierCursors(namespace: string): FrontierCursor[] | undefined;
  setFrontierCursors(namespace: string, cursors: FrontierCursor[]): void;
}

/** Desktop Frontier chunk720: reserved byte + uint32 BE + name length + UTF8 + uint64 BE. */
export function encodeCursors(cursors: readonly FrontierCursor[]): Buffer {
  return Buffer.concat(cursors.map((cursor) => {
    const name = Buffer.from(cursor.name, 'utf8');
    if (!name.length || name.length > 255) throw new Error('Invalid Frontier cursor name length');
    if (!Number.isInteger(cursor.service) || cursor.service < 0 || cursor.service > 0xffffffff) {
      throw new Error('Invalid Frontier cursor service');
    }
    if (!/^\d+$/.test(cursor.value)) throw new Error('Invalid Frontier cursor value');
    const result = Buffer.alloc(14 + name.length);
    result.writeUInt32BE(cursor.service, 1);
    result[5] = name.length;
    name.copy(result, 6);
    result.writeBigUInt64BE(BigInt(cursor.value), 6 + name.length);
    return result;
  }));
}

export function decodeCursors(payload: Uint8Array): FrontierCursor[] {
  const data = Buffer.from(payload);
  const cursors: FrontierCursor[] = [];
  for (let offset = 0; offset < data.length;) {
    if (data.length - offset < 14) throw new Error('Truncated Frontier cursor record');
    const nameLength = data[offset + 5]!;
    const end = offset + 14 + nameLength;
    if (!nameLength || end > data.length) throw new Error('Truncated Frontier cursor name');
    cursors.push({
      service: data.readUInt32BE(offset + 1),
      name: new TextDecoder('utf8', { fatal: true }).decode(data.subarray(offset + 6, offset + 6 + nameLength)),
      value: data.readBigUInt64BE(offset + 6 + nameLength).toString(),
    });
    offset = end;
  }
  return cursors;
}

/** Account/device-scoped cursor state, retained across socket reconnects. */
export class FrontierCursors {
  private fileName?: string;
  private readonly files = new Map<string, FrontierCursor[]>();
  private seq = 0;

  constructor(private readonly deviceId: string, private readonly store?: FrontierCursorStore) {}

  async control(frame: ImFrame): Promise<{ handled: boolean; reply?: Uint8Array }> {
    if (frame.frameType !== 16 && frame.frameType !== 32) return { handled: false };
    const fileName = frameHeader(frame, 'cursor_file_name');
    if (!fileName) throw new Error('Frontier cursor control missing file name');
    const namespace = JSON.stringify([this.deviceId, fileName]);
    const cursors = this.files.get(namespace) ?? this.store?.getFrontierCursors(namespace) ?? [];
    if (frame.frameType === 32) {
      // Validate the entire batch before changing or persisting any cursor.
      const incoming = decodeCursors(frame.payload);
      const merged = new Map(cursors.map((cursor) => [cursor.name, cursor]));
      for (const cursor of incoming) merged.set(cursor.name, cursor);
      this.save(namespace, [...merged.values()]);
      this.fileName = fileName;
      return { handled: true };
    }
    this.fileName = fileName;
    this.files.set(namespace, cursors);
    return {
      handled: true,
      reply: await encodeFrame({
        service: 9000, method: 5, frameType: 32,
        seqid: this.seq++, logid: Date.now(), payloadType: '',
        headers: [{ key: 'cursor_file_name', value: cursors.length ? fileName : 'FILE_NOT_EXIST' }],
        ...(cursors.length ? { payload: encodeCursors(cursors) } : {}),
      }),
    };
  }

  isDuplicate(frame: ImFrame): boolean {
    const cursor = this.messageCursor(frame);
    if (!cursor || !this.fileName) return false;
    const current = this.files.get(JSON.stringify([this.deviceId, this.fileName]))?.find((item) => item.name === cursor.name);
    return current !== undefined && BigInt(current.value) >= BigInt(cursor.value);
  }

  /** Called only after the message was decoded and synchronously handed to the account. */
  commit(frame: ImFrame): void {
    const cursor = this.messageCursor(frame);
    if (!cursor || !this.fileName) return;
    const namespace = JSON.stringify([this.deviceId, this.fileName]);
    const merged = new Map((this.files.get(namespace) ?? []).map((item) => [item.name, item]));
    const previous = merged.get(cursor.name);
    if (previous && BigInt(previous.value) >= BigInt(cursor.value)) return;
    merged.set(cursor.name, cursor);
    this.save(namespace, [...merged.values()]);
  }

  private save(namespace: string, cursors: FrontierCursor[]): void {
    this.store?.setFrontierCursors(namespace, cursors);
    this.files.set(namespace, cursors);
  }

  private messageCursor(frame: ImFrame): FrontierCursor | undefined {
    if (frameHeader(frame, 'x-msg-qos') !== '2') return undefined;
    const name = frameHeader(frame, 'x-msg-cursor_name');
    const value = frameHeader(frame, 'x-msg-cursor_value');
    if (!name || !value || !/^\d+$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
      throw new Error('Invalid Frontier message cursor');
    }
    return { service: frame.service, name, value };
  }
}
