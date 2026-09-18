import { parseJsonWithBigInts } from '../../http/lossless-json.js';
import type { ImConversation } from './types.js';

export interface SettingExtEntry { key: string; value: string; version: string; op: number }
export interface SettingCommand { conversationId: string; version: string; entries: SettingExtEntry[] }
export type SettingExtState = Pick<ImConversation, 'settingExt' | 'settingExtVersions'>;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}
function integer(value: unknown, bits: 32 | 64): bigint {
  return typeof value === 'bigint' ? BigInt.asIntN(bits, value) : 0n;
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }

/** Native CommandMessage/ExtData safeGet helpers: do not coerce quoted/floating integers. */
export function settingCommand(messageType: number, content: string): SettingCommand | undefined {
  if (messageType !== 50001) return undefined;
  let raw: unknown;
  try { raw = parseJsonWithBigInts(content); } catch { return undefined; }
  if (integer(field(raw, 'command_type'), 32) !== 4n) return undefined;
  const entries = field(raw, 'ext_data');
  return {
    conversationId: string(field(raw, 'conversation_id')),
    version: String(integer(field(raw, 'conversation_version'), 64)),
    entries: Array.isArray(entries) ? entries.map(entry => ({
      key: string(field(entry, 'key')), value: string(field(entry, 'value')),
      version: String(integer(field(entry, 'version'), 64)), op: Number(integer(field(entry, 'op_type'), 32)),
    })) : [],
  };
}

/** Exact map-string test; derived only at native save/recompute boundaries, never a live getter. */
export function conversationIsFolded(ext: ImConversation['settingExt']): boolean {
  return !!ext && Object.hasOwn(ext, 'a:s_is_folded') && ext['a:s_is_folded'] === '1';
}

/** ResourceManager::updateConversationWithExtData@0x57894c. No rollback on a later zero-version failure. */
export function applySettingExt(current: SettingExtState, entries: readonly SettingExtEntry[]): {
  state: SettingExtState; handled: boolean; changed: boolean;
} {
  const values = new Map(Object.entries(current.settingExt ?? {}));
  const versions = new Map(Object.entries(current.settingExtVersions ?? {}));
  let changed = false;
  const result = (handled: boolean) => ({ handled, changed,
    state: { settingExt: Object.fromEntries(values), settingExtVersions: Object.fromEntries(versions) } });
  if (!entries.length || !versions.size) return result(false);
  for (const entry of entries) {
    if (entry.op !== 1 && entry.op !== 2) continue;
    const version = BigInt(entry.version);
    const previous = BigInt(versions.get(entry.key) ?? '0');
    if (version > previous) {
      if (entry.op === 1) { values.set(entry.key, entry.value); versions.set(entry.key, entry.version); }
      else { values.delete(entry.key); versions.delete(entry.key); } // No tombstone.
      changed = true;
    } else if (version === 0n) return result(false);
  }
  return result(true);
}
