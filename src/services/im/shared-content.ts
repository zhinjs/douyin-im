import { parseJsonResponse } from '../../http/response.js';
import {
  desktopFingerprintParams,
  type DesktopScreenSize,
} from './desktop.js';
import type { ImHttpClient } from './service.js';

const DESKTOP_ORIGIN = 'https://imdesktop.douyin.com';
const BATCH_SIZE = 50;

export interface SharedWorkDetail {
  readonly workId: string;
  readonly filtered: boolean;
  readonly detail?: Record<string, unknown>;
  readonly reason?: unknown;
}

export interface SharedCommentStatus {
  readonly commentId: string;
  readonly isShown?: boolean;
  readonly raw: Record<string, unknown>;
}

export interface SharedWorkMediaSource {
  readonly kind: 'video' | 'image';
  /** 抖音聊天实际下载时选择的首个地址。 */
  readonly url: string;
  /** 服务端返回的候选地址，按原顺序保留。 */
  readonly urls: readonly string[];
}

export interface SharedWorkAccess {
  readonly workId: string;
  readonly canShare: boolean;
  readonly canDownload: boolean;
  readonly media: readonly SharedWorkMediaSource[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function normalizeIds(ids: readonly string[], label: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const value = id.trim();
    if (!/^\d+$/.test(value)) throw new Error(`${label} must be a decimal string`);
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
    result.push(values.slice(offset, offset + BATCH_SIZE));
  }
  return result;
}

/** 从作品详情提取抖音聊天播放器实际使用的分享、下载权限和媒体地址。 */
export function resolveSharedWorkAccess(work: SharedWorkDetail): SharedWorkAccess {
  const detail = work.detail;
  const videoControl = objectValue(detail?.['video_control']);
  const awemeControl = objectValue(detail?.['aweme_control']);
  const canDownload = videoControl?.['allow_download'] === true;
  const canShare = typeof awemeControl?.['can_share'] === 'boolean'
    ? awemeControl['can_share']
    : videoControl?.['allow_share'] === true;
  const media: SharedWorkMediaSource[] = [];

  if (canDownload) {
    const images = detail?.['images'];
    if (Array.isArray(images)) {
      for (const image of images) {
        const urls = stringArray(objectValue(image)?.['download_url_list']);
        if (urls[0]) media.push({ kind: 'image', url: urls[0], urls });
      }
    } else {
      const downloadAddress = objectValue(objectValue(detail?.['video'])?.['download_addr']);
      const urls = stringArray(downloadAddress?.['url_list']);
      if (urls[0]) media.push({ kind: 'video', url: urls[0], urls });
    }
  }

  return { workId: work.workId, canShare, canDownload, media };
}

/**
 * 抖音聊天的作品卡片补全模块。
 *
 * 这里只实现桌面客户端存在调用链的两个只读接口，不承载作品发布、点赞或评论写入。
 */
export class ImSharedContent {
  constructor(
    private readonly client: ImHttpClient,
    private readonly resolveDeviceId: () => Promise<string>,
    private readonly guid = '0',
    private readonly screenSize: DesktopScreenSize = { width: 1728, height: 1117 },
  ) {}

  async getWorkDetails(
    conversationShortId: string,
    workIds: readonly string[],
  ): Promise<SharedWorkDetail[]> {
    this.assertConversationShortId(conversationShortId);
    const ids = normalizeIds(workIds, 'work id');
    if (ids.length === 0) return [];
    const result: SharedWorkDetail[] = [];
    for (const batch of batches(ids)) {
      const body = new FormData();
      body.append('aweme_ids', `[${batch.join(',')}]`);
      body.append('origin_type', 'chat');
      body.append('request_source', '3');
      body.append('conversation_short_id', conversationShortId);
      const response = await this.post('/aweme/v1/web/multi/aweme/detail/', body);
      const json = parseJsonResponse<{
        aweme_details?: unknown[];
        filter_list?: unknown[];
      }>(response, response.url);
      for (const raw of json.aweme_details ?? []) {
        const detail = objectValue(raw);
        if (!detail) continue;
        const workId = String(detail['aweme_id'] ?? '');
        if (workId) result.push({ workId, filtered: false, detail });
      }
      for (const raw of json.filter_list ?? []) {
        const item = objectValue(raw);
        if (!item) continue;
        const workId = String(item['aweme_id'] ?? '');
        if (workId) result.push({ workId, filtered: true, reason: item['reason'] });
      }
    }
    return result;
  }

  async getCommentStatuses(
    conversationShortId: string,
    commentIds: readonly string[],
  ): Promise<SharedCommentStatus[]> {
    this.assertConversationShortId(conversationShortId);
    const ids = normalizeIds(commentIds, 'comment id');
    if (ids.length === 0) return [];
    const result: SharedCommentStatus[] = [];
    for (const batch of batches(ids)) {
      const body = new FormData();
      body.append('comments_status_req', JSON.stringify({ comment_id_list: batch }));
      body.append('conversation_short_id', conversationShortId);
      const response = await this.post('/aweme/v1/web/im/message/info/other/', body);
      const json = parseJsonResponse<{
        comment_status_resp?: { comments_status?: unknown[] };
      }>(response, response.url);
      for (const raw of json.comment_status_resp?.comments_status ?? []) {
        const item = objectValue(raw);
        if (!item) continue;
        const commentId = String(item['comment_id'] ?? '');
        if (!commentId) continue;
        const isShow = item['is_show'];
        result.push({
          commentId,
          ...(typeof isShow === 'boolean' ? { isShown: isShow }
            : typeof isShow === 'number' ? { isShown: isShow !== 0 }
              : {}),
          raw: item,
        });
      }
    }
    return result;
  }

  private assertConversationShortId(value: string): void {
    if (!/^\d+$/.test(value)) throw new Error('conversationShortId must be a decimal string');
  }

  private async post(path: string, body: FormData): Promise<{
    ok: boolean;
    status: number;
    headers: Headers;
    data: string;
    rawText: string;
    url: string;
  }> {
    const deviceId = this.client.getDeviceId?.() ?? await this.resolveDeviceId();
    const params = desktopFingerprintParams(deviceId, this.guid, this.screenSize, this.client.getUserAgent());
    params.set('iid', this.client.getInstallId?.() ?? '0');
    const url = `${DESKTOP_ORIGIN}${path}?${params}`;
    const response = await this.client.requestRaw(url, {
      method: 'POST',
      headers: {
        bgint_json_parser: '2',
        'User-Agent': this.client.getUserAgent(),
        Referer: DESKTOP_ORIGIN,
      },
      body,
    });
    return { ...response, url };
  }
}
