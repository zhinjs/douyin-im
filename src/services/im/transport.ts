/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { encodeRequest, decodeResponseRaw } from './codec.js';
import { DESKTOP_IM_PROFILE } from './desktop.js';

/** Cronet SetMD5Header value, including empty bodies; not an authentication signature. */
export function desktopBodyDigest(body: Uint8Array): string {
  return createHash('md5').update(body).digest('hex');
}

export interface ImProtoTransportClient {
  getUserAgent(): string;
  getCookies(): string;
  getInstallId?(): string;
}

export interface CookieProtoOptions {
  deviceId: string;
  sdkVersion: string;
  buildNumber: string;
  versionCode: string;
  devicePlatform: string;
  biz: string;
  access: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  httpUserAgent: string;
}

/** Failure after request preparation, distinct from a local encoding/configuration error. */
export class ImProtoTransportError extends Error {
  override readonly name = 'ImProtoTransportError';
  constructor(readonly stage: 'network' | 'http' | 'decode', readonly cmd: number,
    readonly endpoint: string, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** HTTP protobuf 通道（imapi.snssdk.com） */
export class ImProtoTransport {
  private readonly installId: string | undefined;

  constructor(private readonly client: ImProtoTransportClient) {
    // Native xi()/init serializes ImOption once; renderer didUpdate does not
    // update that option or rebuild the active IM/Frontier connection.
    this.installId = client.getInstallId?.();
  }

  /** Desktop Cookie HTTP transport。 */
  async sendCookieProto(
    cmd: number,
    inboxType: number,
    endpoint: string,
    body: Record<string, unknown>,
    opts: CookieProtoOptions,
  ): Promise<Record<string, unknown>> {
    const payload = await encodeRequest({
      token: '',
      cmd,
      inboxType,
      body,
      authType: 1,
      deviceId: opts.deviceId,
      sdkVersion: opts.sdkVersion,
      buildNumber: opts.buildNumber,
      versionCode: opts.versionCode,
      devicePlatform: opts.devicePlatform,
      biz: opts.biz,
      access: opts.access,
      headers: opts.headers,
    });
    const url = new URL(endpoint, DESKTOP_IM_PROFILE.apiUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(key, value);
    }
    if (this.installId !== undefined) url.searchParams.set('iid', this.installId);
    const requestBody = Buffer.from(payload);
    const request: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        Accept: 'x-protobuf',
        'User-Agent': opts.httpUserAgent,
        Cookie: this.client.getCookies(),
        Referer: 'https://imdesktop.douyin.com',
        // Native Cronet SetMD5Header hashes the serialized bytes, then lowercases its hex output.
        'x-ss-stub': desktopBodyDigest(requestBody),
      },
      body: requestBody,
      signal: AbortSignal.timeout(20_000),
    };
    let response: Response;
    let bytes: Buffer;
    try {
      response = await fetch(url, request);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      throw new ImProtoTransportError('network', cmd, endpoint, `IM Cookie network failed cmd=${cmd} ${endpoint}`, { cause });
    }
    if (!response.ok) {
      throw new ImProtoTransportError('http', cmd, endpoint, `IM Cookie HTTP ${response.status} ${endpoint}`);
    }
    try {
      return await decodeResponseRaw(bytes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ImProtoTransportError('decode', cmd, endpoint, `IM Cookie response decode failed cmd=${cmd} ${endpoint}: ${detail}`, { cause: error });
    }
  }
}
