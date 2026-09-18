import type { BaseAccount } from './account.js';

export type EventPostType = 'message' | 'notice' | 'request';
export type EventRawPayload = Readonly<Record<string, unknown>>;

/**
 * Protocol context shared by all SDK events.
 *
 * The base layer deliberately knows nothing about contacts or high-level event
 * routing. It only preserves the account, normalized timestamp, and raw
 * protocol payload from which the SDK event was assembled.
 */
export abstract class BaseEvent<
  A extends BaseAccount = BaseAccount,
  R extends EventRawPayload = EventRawPayload,
> {
  abstract readonly postType: EventPostType;
  abstract readonly type: string;

  readonly account: A;
  readonly time: number;
  readonly raw: R;

  protected constructor(account: A, raw: R, time?: number | string) {
    this.account = account;
    this.raw = raw;
    this.time = normalizeEventTime(time);
  }
}

/** @internal Event times are exposed as integer Unix seconds, like oicq. */
export function normalizeEventTime(value?: number | string): number {
  const parsed = typeof value === 'string'
    ? (Number.isNaN(Number(value)) ? Date.parse(value) : Number(value))
    : value;
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    return Math.floor(Date.now() / 1_000);
  }
  return Math.floor(parsed > 10_000_000_000 ? parsed / 1_000 : parsed);
}
