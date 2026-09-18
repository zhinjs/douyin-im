export interface ReconnectEvent {
  attempt: number;
  delayMs: number;
  code?: number;
  reason?: string;
}

/** Exponential reconnect delay capped at 30 seconds. */
export function reconnectDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 30_000);
}
