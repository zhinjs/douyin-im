/**
 * LZ4 block decompress (from BytedIM SDK module 45331).
 * Used when WS Frame has payload_encoding = "__lz4".
 */
export function decodeLz4Block(
  src: Uint8Array,
  dst: Uint8Array,
  srcOffset = 0,
  srcLength?: number,
): number {
  let i = srcOffset;
  const end = srcOffset + (srcLength ?? src.length - srcOffset);
  let o = 0;

  while (i < end) {
    const token = src[i++]!;
    let literalLen = token >> 4;
    if (literalLen > 0) {
      let extra = literalLen + 240;
      while (extra === 255) {
        extra = src[i++]!;
        literalLen += extra;
      }
      const litEnd = i + literalLen;
      while (i < litEnd) {
        dst[o++] = src[i++]!;
      }
      if (i === end) return o;
    }

    const offset = src[i++]! | (src[i++]! << 8);
    if (offset === 0 || offset > o) return -(i - 2);

    let matchLen = token & 0x0f;
    let extra = matchLen + 240;
    while (extra === 255) {
      extra = src[i++]!;
      matchLen += extra;
    }

    let pos = o - offset;
    const matchEnd = o + matchLen + 4;
    while (o < matchEnd) {
      dst[o++] = dst[pos++]!;
    }
  }
  return o;
}

export function decompressLz4Payload(compressed: Uint8Array): Uint8Array {
  let out = new Uint8Array(compressed.length * 10);
  let written = decodeLz4Block(compressed, out);
  if (written < 0 || written > out.length) {
    out = new Uint8Array(1024 * 1024);
    written = decodeLz4Block(compressed, out);
  }
  if (written < 0) {
    throw new Error('lz4 decompress failed');
  }
  return out.slice(0, written);
}
