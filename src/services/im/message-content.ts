/** Preserve binary command content while keeping ordinary message content ergonomic. */
export function messageContentBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return new Uint8Array(0);
}

export function messageContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return new TextDecoder().decode(messageContentBytes(value));
}
