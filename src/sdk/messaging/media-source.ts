import { readFile } from 'node:fs/promises';
import type { ImageAsset } from '../../services/im/content.js';
import { sniffImageFormat, type ImageFormat } from '../../services/im/media.js';

/** SDK 可直接消费的图片来源。Buffer 是 Uint8Array 的子类，无需单独包装。 */
export type ImageSource = Uint8Array | string;
export type ImageInput = ImageSource | ImageAsset;

export interface ResolvedImageSource {
  data: Uint8Array;
  format: Exclude<ImageFormat, 'unknown'>;
}

interface MediaSourceDependencies {
  fetcher?: typeof fetch;
  readLocalFile?: (path: string) => Promise<Uint8Array>;
}

function decodeBase64(value: string): Uint8Array | undefined {
  const compact = value.replace(/\s/g, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return undefined;
  }
  const decoded = Buffer.from(compact, 'base64');
  const normalizedInput = compact.replace(/=+$/, '');
  const normalizedOutput = decoded.toString('base64').replace(/=+$/, '');
  return normalizedInput === normalizedOutput ? decoded : undefined;
}

function decodeDataUrl(value: string): Uint8Array {
  const comma = value.indexOf(',');
  if (comma < 0 || !/;base64$/i.test(value.slice(0, comma))) {
    throw new Error('image data URL must use base64 encoding');
  }
  const decoded = decodeBase64(value.slice(comma + 1));
  if (!decoded) throw new Error('image data URL contains invalid base64');
  return decoded;
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENAMETOOLONG' || code === 'EINVAL';
}

async function readHttpsImage(url: URL, fetcher: typeof fetch): Promise<Uint8Array> {
  const response = await fetcher(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`image download failed (HTTP ${response.status})`);
  if (response.url && new URL(response.url).protocol !== 'https:') {
    throw new Error('image URL redirected to a non-HTTPS resource');
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * 将 Buffer/Uint8Array、base64、data URL、本地路径或 HTTPS URL 收敛为图片字节。
 * 解析位于 SDK 边界，协议上传层始终只处理已验证的二进制数据。
 *
 * @internal
 */
export async function resolveImageSource(
  source: ImageSource,
  dependencies: MediaSourceDependencies = {},
): Promise<ResolvedImageSource> {
  let data: Uint8Array;
  if (source instanceof Uint8Array) {
    data = source;
  } else if (/^data:/i.test(source)) {
    data = decodeDataUrl(source);
  } else if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.protocol !== 'https:') throw new Error('remote image URL must use HTTPS');
    data = await readHttpsImage(url, dependencies.fetcher ?? globalThis.fetch);
  } else {
    try {
      data = await (dependencies.readLocalFile ?? readFile)(source);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const decoded = decodeBase64(source);
      if (!decoded) {
        throw new Error('image string must be valid base64, a local file path, or an HTTPS URL');
      }
      data = decoded;
    }
  }

  if (data.length === 0) throw new Error('cannot send an empty image');
  const format = sniffImageFormat(data);
  if (format === 'unknown') {
    throw new Error('unsupported image data; expected JPEG, PNG, GIF, WebP, or HEIC');
  }
  return { data, format };
}

export function isImageAsset(value: ImageInput): value is ImageAsset {
  return typeof value === 'object'
    && value !== null
    && !(value instanceof Uint8Array)
    && typeof value.oid === 'string';
}
