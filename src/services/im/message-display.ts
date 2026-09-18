import { DESKTOP_APP_VERSION } from '../../desktop/constants.js';
import type { PrivateMessage } from './types.js';
import { messageClientId } from './message-cache.js';
import { readJsonInteger } from '../../http/lossless-json.js';

/** Native versionCompare uses dot-separated signed int32 accumulators, not semver. */
function compareVersions(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  const segment = (part = ''): number => [...Buffer.from(part)].reduce((value, byte) => (Math.imul(value, 10) + byte - 48) | 0, 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = segment(a[index]);
    const y = segment(b[index]);
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Native isVisible + main yr() gates for update projection; not a read-user allow/deny list. */
export function isDesktopMessageDisplayable(message: PrivateMessage, appVersion = DESKTOP_APP_VERSION): boolean {
  return !!message.content && isDesktopMessageVisible(message, appVersion);
}

/** Native visibility for message selection, before main yr() rejects empty content. */
export function isDesktopMessageVisible(message: PrivateMessage, appVersion = DESKTOP_APP_VERSION): boolean {
  if (!messageClientId(message) || message.status === 1) return false;
  if (message.msgType < 0 || message.msgType >= 2000) return false;
  if (message.msgType !== 1 && message.msgType !== 1002) return true;
  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(message.content);
    content = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    // Retain the SDK's malformed-body fallback; native non-object exception handling is not proven.
    content = {};
  }
  if (message.msgType === 1002) {
    return !Object.hasOwn(content, 'aweType') || readJsonInteger(message.content, 'aweType', 32) !== 100200n;
  }
  const min = typeof content['pc_filter_min_version'] === 'string' ? content['pc_filter_min_version'] : '';
  const max = typeof content['pc_filter_max_version'] === 'string' ? content['pc_filter_max_version'] : '';
  // Native's failed two-bound check falls through to the min-only check: min takes precedence.
  if (min) return compareVersions(appVersion, min) < 0;
  if (max) return compareVersions(appVersion, max) > 0;
  return true;
}
