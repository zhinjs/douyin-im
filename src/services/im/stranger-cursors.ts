import type { StrangerSyncCursors } from './types.js';

/** Native CursorManager defaults; independent from Frontier transport cursors. */
export function normalizeStrangerCursors(value?: StrangerSyncCursors): StrangerSyncCursors {
  const result = value ?? { version: '0', loadMoreVersion: '-1' };
  const normalize = (input: string): string => {
    if (typeof input !== 'string' || !/^-?\d+$/.test(input)) throw new TypeError('Invalid stranger sync cursor');
    const number = BigInt(input);
    if (number < -9223372036854775808n || number > 9223372036854775807n) throw new RangeError('Stranger sync cursor outside int64');
    return number.toString();
  };
  return { version: normalize(result.version), loadMoreVersion: normalize(result.loadMoreVersion) };
}
