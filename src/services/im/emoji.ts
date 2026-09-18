import { DouyinResponseError, parseJsonResponse } from '../../http/response.js';
import { ActionChallengeError } from '../../http/action-challenge.js';
import { desktopFingerprintParams, type DesktopScreenSize } from './desktop.js';
import type { ImHttpClient } from './service.js';
import type { ImActionResponse } from './types.js';

const ORIGIN = 'https://imdesktop.douyin.com';

/** Resource manifest only: Desktop downloads and decodes the archive separately. */
export interface EmojiResourcesResponse extends ImActionResponse {
  androidResource?: { url: string; md5: string };
  /** Desktop skips refreshing the resource archive when this is 1. */
  androidResourceStatus?: number;
}

/** Values from a Desktop message, search result or custom sticker entry, not a local file. */
export interface CollectEmojiOptions {
  /** Omit only for URI-based stickers without an image ID. IDs retain decimal precision. */
  imageId?: string;
  /** Undefined is omitted from query; an explicit empty string is preserved. */
  stickerUri?: string;
  stickerUrl?: string;
  resourceId?: string;
  /** Desktop uses 1 for message collection, 0 for ID-only collection, or the search result's type. */
  stickerType: number;
}

export interface CollectEmojiResponse extends ImActionResponse {
  /** Server-returned sticker records; unknown fields and large integer IDs are preserved. */
  successItems: Record<string, unknown>[];
}

/** Keep the JSON scalar: Desktop checks this setting with == 0, not === 0. */
export type CollectedStickerEnabledStatus = number | string | boolean | null;

export interface CollectedEmojiPage {
  nextCursor: string;
  hasMore: boolean;
  stickerEnabledStatus?: CollectedStickerEnabledStatus;
  /** Missing means metadata-only: Desktop keeps the prior sticker entities. */
  stickers?: Record<string, unknown>[];
}

export interface CollectedEmojisResponse extends ImActionResponse {
  /** Missing for resources=[]: Desktop makes no state update, not an empty-list replacement. */
  /** A valid page is projected even with a nonzero root status, matching Desktop's page consumer. */
  page?: CollectedEmojiPage;
}

export interface CollectedEmojiListOptions {
  cursor?: string;
  /** Defaults to true only when cursor is omitted. A supplied next cursor appends, even if it is "0". */
  firstPage?: boolean;
}

export interface CollectedEmojiSnapshot {
  stickers: Record<string, unknown>[];
  nextCursor: string;
  hasMore: boolean;
  stickerEnabledStatus?: CollectedStickerEnabledStatus;
}

/** Desktop renderer HTTP operations, distinct from sending emoji messages. */
export class ImEmojiApi {
  constructor(
    private readonly client: ImHttpClient,
    private readonly deviceId = '',
    private readonly guid = '',
    private readonly screenSize: DesktopScreenSize = { width: 1728, height: 1117 },
  ) {}

  async getResources(): Promise<EmojiResourcesResponse> {
    const body = await this.request('/aweme/v1/web/im/resources/emoji/', 'GET');
    const status = result(body, true);
    if (status.statusCode !== 0) return status;
    const resource = record(body['android_emoji_resource']);
    const resourceStatus = body['android_emoji_status'];
    if (resource && resourceStatus === 1) return { ...status, androidResourceStatus: 1 };
    // A missing manifest is not a successfully fetched empty emoji list.
    if (!resource || typeof resource['resource_url'] !== 'string' || !resource['resource_url'] ||
        typeof resource['md5'] !== 'string' || !resource['md5']) {
      return { statusCode: -3, statusMsg: 'Desktop response missing emoji resource manifest' };
    }
    return { ...status, androidResource: { url: resource['resource_url'], md5: resource['md5'] },
      ...(typeof resourceStatus === 'number' && Number.isSafeInteger(resourceStatus)
        ? { androidResourceStatus: resourceStatus } : {}) };
  }

  async collect(options: CollectEmojiOptions): Promise<CollectEmojiResponse> {
    const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
    if ((options.imageId !== undefined && !decimal(options.imageId)) ||
        (options.resourceId !== undefined && !decimal(options.resourceId)) ||
        (options.stickerUri !== undefined && typeof options.stickerUri !== 'string') ||
        (options.stickerUrl !== undefined && typeof options.stickerUrl !== 'string') ||
        !Number.isSafeInteger(options.stickerType) || options.stickerType < 0 ||
        (!options.imageId && !options.stickerUri && !options.stickerUrl)) {
      throw new TypeError('Invalid Desktop emoji collection options');
    }
    const query = new URLSearchParams({ action: '1', sticker_ids: `[${options.imageId ?? ''}]` });
    if (options.stickerUri !== undefined) query.set('sticker_uri', options.stickerUri);
    if (options.stickerUrl !== undefined) query.set('sticker_url', options.stickerUrl);
    if (options.resourceId !== undefined) query.set('resource_id', options.resourceId);
    query.set('sticker_type', String(options.stickerType));
    const body = await this.request('/aweme/v1/web/im/resources/sticker/collect/', 'POST', query);
    const status = result(body);
    if (status.statusCode !== 0) return { ...status, successItems: [] };
    const items = body['success_items'];
    if (!Array.isArray(items) || !items.length || !items.every(item => record(item) !== undefined) ||
        !Object.keys(items[0] as Record<string, unknown>).length) {
      return { statusCode: -3, statusMsg: 'Desktop response missing collected sticker records', successItems: [] };
    }
    return { ...status, successItems: items as Record<string, unknown>[] };
  }

  async getCollected(cursor = '0'): Promise<CollectedEmojisResponse> {
    if (typeof cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(cursor)) throw new TypeError('Invalid Desktop emoji cursor');
    const query = new URLSearchParams({ scenes: 'CUSTOM_STICKER_PAGE', need_ai_emoji: 'true', custom_cursor: cursor, custom_limit: '50' });
    const body = await this.request('/aweme/v1/web/im_communication/resources/list/aggregation/', 'GET', query);
    const status = result(body, true);
    // Desktop passes the nested page to its reducer without checking root status.
    // Keep that status visible to callers, but don't silently discard valid page data.
    const invalid = (): CollectedEmojisResponse => status.statusCode !== 0 ? status : invalidPage();
    const data = record(body['custom_sticker_page_list']);
    if (!data || !Array.isArray(data['resources'])) return invalid();
    if (!data['resources'].length) return status;
    const first = record(data['resources'][0]);
    const nextCursor = decimalId(data['next_cursor']);
    const completed = data['is_completed'];
    const enabled = data['sticker_enabled_status'];
    if (!first || nextCursor === undefined || ![true, false, 0, 1].includes(completed as boolean | number) ||
        (enabled !== undefined && enabled !== null && !['number', 'string', 'boolean'].includes(typeof enabled))) return invalid();
    const page: CollectedEmojiPage = { nextCursor, hasMore: !completed,
      ...(enabled !== undefined ? { stickerEnabledStatus: enabled as CollectedStickerEnabledStatus } : {}) };
    if (!Object.keys(first).length) return { ...status, page };
    const stickers = first['stickers'] ?? [];
    const forbidden = data['forbidden_sticker_ids'] ?? [];
    if (!Array.isArray(stickers) || !Array.isArray(forbidden) || !stickers.every(item => record(item) && emojiKey(item['id']) !== undefined) ||
        !forbidden.every(id => typeof id === 'string' || typeof id === 'number')) return invalid();
    // Source lodash isEmpty(number) is true: numeric video_id does not enter the
    // forbidden check. String IDs use native includes, without coercing types.
    page.stickers = (stickers as Record<string, unknown>[]).filter(item =>
      typeof item['video_id'] !== 'string' || item['video_id'].length === 0 || !forbidden.includes(item['video_id']),
    ).reverse();
    return { ...status, page };
  }

  private async request(path: string, method: 'GET' | 'POST', query?: URLSearchParams): Promise<Record<string, unknown>> {
    const params = desktopFingerprintParams((this.client.getDeviceId?.() ?? this.deviceId) || '0', this.guid || '0', this.screenSize, this.client.getUserAgent());
    params.set('iid', this.client.getInstallId?.() || '0');
    query?.forEach((value, key) => params.set(key, value));
    const url = `${ORIGIN}${path}?${params}`;
    const response = await this.client.requestRaw(url, {
      method, headers: { Accept: 'application/json, text/plain, */*', Referer: ORIGIN,
        'User-Agent': this.client.getUserAgent(), bgint_json_parser: '2' },
      ...(method === 'POST' ? { body: '' } : {}), signal: AbortSignal.timeout(15_000),
    }, false);
    if (response.headers.get('x-tt-verify-passport-decision')) {
      throw new ActionChallengeError('passport-decision', response.headers.get('x-tt-verify-passport-decision')!);
    }
    if (response.headers.get('bdturing-verify')) throw new ActionChallengeError('bdturing', response.headers.get('bdturing-verify')!);
    if (response.headers.get('x-vc-bdturing-parameters')) throw new DouyinResponseError('captcha', response.status, url, response.headers);
    const body = parseJsonResponse<unknown>(response, url, { preserveLargeIntegers: true });
    if (!record(body)) throw new DouyinResponseError('invalid-json', response.status, url, response.headers);
    const data = body as Record<string, unknown>;
    if (typeof data['verifyData'] === 'string' && data['verifyData']) throw new ActionChallengeError('bdturing', data['verifyData']);
    if (data['verifyData']) throw new DouyinResponseError('captcha', response.status, url, response.headers);
    return data;
  }
}

/** Account-local equivalent of first-page setMany versus subsequent addMany. */
export function mergeCollectedEmojiPage(
  current: CollectedEmojiSnapshot | undefined, page: CollectedEmojiPage, firstPage: boolean,
): CollectedEmojiSnapshot {
  const entries = new Map<string, Record<string, unknown>>();
  if (!(firstPage && page.stickers !== undefined)) {
    for (const item of current?.stickers ?? []) entries.set(String(item['id']), item);
  }
  for (const item of page.stickers ?? []) {
    const id = String(item['id']);
    if (firstPage || !entries.has(id)) entries.set(id, item);
  }
  return structuredClone({ stickers: [...entries.values()], nextCursor: page.nextCursor,
    hasMore: page.hasMore, ...(page.stickerEnabledStatus !== undefined ? { stickerEnabledStatus: page.stickerEnabledStatus } : {}) });
}

/** Insert only a confirmed first success item, not the input or an optimistic placeholder. */
export function addCollectedEmoji(
  current: CollectedEmojiSnapshot | undefined, item: Record<string, unknown>,
): CollectedEmojiSnapshot | undefined {
  const id = emojiKey(item['id']);
  if (id === undefined) return current;
  const base = current ?? { stickers: [], nextCursor: '0', hasMore: false, stickerEnabledStatus: 1 };
  if (base.stickers.some(existing => String(existing['id']) === id)) return current;
  // Desktop explicitly rebuilds from Object.values(entities), whose integer
  // keys precede other keys regardless of the page's ids array order.
  const entities = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const existing of base.stickers) entities[String(existing['id'])] = existing;
  return structuredClone({ ...base, stickers: [item, ...Object.values(entities)] });
}

function emojiKey(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined;
}

function decimalId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? value : undefined;
}

function invalidPage(): CollectedEmojisResponse {
  return { statusCode: -3, statusMsg: 'Desktop response missing or invalid collected emoji page' };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function result(body: Record<string, unknown>, optionalStatus = false): ImActionResponse {
  const raw = body['status_code'];
  const code = raw === undefined && optionalStatus ? 0 : typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : -3;
  return { statusCode: code === 200 ? 0 : code, statusMsg: typeof body['status_msg'] === 'string' ? body['status_msg'] : '' };
}
