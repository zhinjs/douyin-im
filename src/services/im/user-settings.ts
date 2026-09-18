import type { ImHttpClient } from './service.js';
import type { ImActionResponse } from './types.js';
import { parseJsonResponse } from '../../http/response.js';
import { desktopFingerprintParams } from './desktop.js';

const ORIGIN = 'https://imdesktop.douyin.com';

export interface UserSettingsResponse extends ImActionResponse {
  imReadStatusShow?: number;
  closeConsecutiveChat?: number;
  /** Desktop hides the read display only for -1. Unknown/missing values stay absent. */
  enableReadState?: boolean;
}

export interface ReadReceiptPrivacyResponse extends ImActionResponse {
  currentUserSwitch?: number;
  enableReadState?: boolean;
}

export interface MessageReadPrivacyQuery {
  serverMessageId: string;
  conversationId: string;
  conversationShortId: string;
  conversationType: 1 | 2;
  /** Pass the protocol/native createTime unchanged; do not infer a unit here. */
  createTime: number;
}

export interface MessageReadPrivacy {
  serverMessageId: string;
  errorCode: number;
  on: readonly string[];
  off: readonly string[];
}

export interface MessageReadPrivacyResponse extends ReadReceiptPrivacyResponse {
  messages: MessageReadPrivacy[];
}

function decimalId(value: unknown): string | undefined {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  return /^[1-9]\d*$/.test(text) && BigInt(text) <= 9223372036854775807n ? text : undefined;
}

/** Shared validation before either a cache lookup or an HTTP request. */
export function normalizeMessageReadPrivacyQueries(queries: readonly MessageReadPrivacyQuery[]): MessageReadPrivacyQuery[] {
  const unique = new Map<string, MessageReadPrivacyQuery>();
  for (const query of queries) {
    if (query.serverMessageId === '0') continue;
    if (typeof query.serverMessageId !== 'string' || typeof query.conversationShortId !== 'string' ||
        !decimalId(query.serverMessageId) || !decimalId(query.conversationShortId) ||
        typeof query.conversationId !== 'string' || !query.conversationId || ![1, 2].includes(query.conversationType) ||
        !Number.isSafeInteger(query.createTime) || query.createTime < 0) throw new Error('Invalid message read privacy query');
    const previous = unique.get(query.serverMessageId);
    if (previous && (previous.conversationId !== query.conversationId || previous.conversationShortId !== query.conversationShortId ||
        previous.conversationType !== query.conversationType || previous.createTime !== query.createTime)) {
      throw new Error('Conflicting message read privacy query');
    }
    unique.set(query.serverMessageId, { ...query });
  }
  return [...unique.values()];
}

/** Only project actual protocol readUsers; this must never be fed a group member list. */
export function filterReadReceipt<T extends { uid: string }>(
  native: { serverMessageId: string; readUsers: readonly T[]; isAllRead: boolean },
  response: MessageReadPrivacyResponse,
): { readUsers: T[]; isAllRead: boolean } {
  const policy = response.messages.find(item => item.serverMessageId === native.serverMessageId);
  if (response.statusCode !== 0 || response.enableReadState !== true) {
    return { readUsers: [], isAllRead: false };
  }
  const on = new Set(policy?.on), off = new Set(policy?.off);
  const readUsers = policy?.errorCode === 0
    ? native.readUsers.filter(user => on.size ? on.has(user.uid) : !off.has(user.uid)) : [];
  return { readUsers: structuredClone(readUsers), isAllRead: native.isAllRead && readUsers.length === native.readUsers.length };
}

/** Read-only user settings, separate from sending a message's mark-read command. */
export class ImUserSettingsApi {
  constructor(private readonly client: ImHttpClient, private readonly deviceId: string) {}

  async getSettings(): Promise<UserSettingsResponse> {
    const params = this.params();
    params.set('is_fetch_frequency_control', 'true');
    params.set('has_local_cache', 'false');
    params.set('request_source', 'settings_page');
    const body = await this.request(`/aweme/v1/web/user/settings/?${params}`, { method: 'GET' });
    const result = this.result(body, 'im_read_status_show');
    return { ...result, ...(result.statusCode === 0 ? {
      imReadStatusShow: body['im_read_status_show'] as number,
      enableReadState: body['im_read_status_show'] !== -1,
      ...(typeof body['close_consecutive_chat'] === 'number' && Number.isSafeInteger(body['close_consecutive_chat'])
        ? { closeConsecutiveChat: body['close_consecutive_chat'] } : {}),
    } : {}) };
  }

  async getReadReceiptPrivacy(): Promise<ReadReceiptPrivacyResponse> {
    const body = await this.request(`/aweme/v1/im_communication/msg_read_switch/?${this.params()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8', bgint_json_parser: '2' },
      body: JSON.stringify({ source: 'only_current_user', is_retry: false }),
    });
    const result = this.result(body, 'current_user_switch');
    return { ...result, ...(result.statusCode === 0 ? {
      currentUserSwitch: body['current_user_switch'] as number,
      enableReadState: body['current_user_switch'] !== -1,
    } : {}) };
  }

  /** Fresh batch query, not a claim that the supplied messages have been read. */
  async getMessageReadPrivacy(queries: readonly MessageReadPrivacyQuery[]): Promise<MessageReadPrivacyResponse> {
    const all = normalizeMessageReadPrivacyQueries(queries);
    const messages: MessageReadPrivacy[] = [];
    let currentUserSwitch: number | undefined;
    let incomplete = false;
    for (let offset = 0; offset < all.length; offset += 50) {
      const batch = all.slice(offset, offset + 50);
      // Desktop JSON-BigInt emits naked decimal ID literals, not quoted strings.
      const items = batch.map(q => `{"msg_id":${q.serverMessageId},"conv_id":${JSON.stringify(q.conversationId)},"conv_short_id":${q.conversationShortId},"create_time":${q.createTime},"conv_type":${q.conversationType}}`);
      let body: Record<string, unknown> = {};
      for (let attempt = 0; ; attempt++) {
        try {
          body = await this.request(`/aweme/v1/im_communication/msg_read_switch/?${this.params()}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8', bgint_json_parser: '2' },
            body: `{"source":"msg_tab","is_retry":${attempt > 0},"msg_ids":[${items.join(',')}]}`,
          });
          break;
        } catch (error) { if (attempt >= 4) throw error; }
      }
      const result = this.result(body, 'current_user_switch');
      if (result.statusCode !== 0) return { ...result, messages: [] };
      currentUserSwitch = body['current_user_switch'] as number;
      const rawItems = body['msg_ids_resp'];
      if (!Array.isArray(rawItems)) return { statusCode: -3, statusMsg: 'Desktop response missing msg_ids_resp', messages: [] };
      const requested = new Set(batch.map(q => q.serverMessageId));
      const received = new Set<string>();
      for (const raw of rawItems) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const id = decimalId(item['msg_id']);
        if (!id || !requested.has(id)) continue; // Never accept unsolicited policies.
        if (received.has(id)) return { statusCode: -3, statusMsg: 'Desktop duplicate read privacy policy', messages: [] };
        const lists = [item['on'] ?? [], item['off'] ?? []];
        if (!lists.every(list => Array.isArray(list) && list.every(uid => decimalId(uid) !== undefined)) ||
            typeof item['err_code'] !== 'number' || !Number.isSafeInteger(item['err_code'])) {
          return { statusCode: -3, statusMsg: 'Desktop invalid read privacy policy', messages: [] };
        }
        messages.push({ serverMessageId: id, errorCode: item['err_code'],
          on: (lists[0] as unknown[]).map(uid => decimalId(uid)!), off: (lists[1] as unknown[]).map(uid => decimalId(uid)!) });
        received.add(id);
      }
      if (received.size !== requested.size) incomplete = true;
    }
    // Desktop aggregates every page, then uses the final current-user switch.
    if (currentUserSwitch === -1) return { statusCode: 0, statusMsg: '', currentUserSwitch, enableReadState: false, messages: [] };
    if (incomplete) return { statusCode: -3, statusMsg: 'Desktop incomplete read privacy response', messages: [] };
    return { statusCode: 0, statusMsg: '', messages,
      ...(currentUserSwitch !== undefined ? { currentUserSwitch, enableReadState: currentUserSwitch !== -1 } : {}) };
  }

  private params(): URLSearchParams {
    const params = desktopFingerprintParams((this.client.getDeviceId?.() ?? this.deviceId) || '0', this.client.getGuid?.() || '0',
      this.client.getScreenSize?.() ?? { width: 1728, height: 1117 }, this.client.getUserAgent());
    params.set('iid', this.client.getInstallId?.() || '0');
    return params;
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const url = `${ORIGIN}${path}`;
    const response = await this.client.requestRaw(url, {
      ...init, headers: { Referer: ORIGIN, 'User-Agent': this.client.getUserAgent(), ...init.headers },
      signal: AbortSignal.timeout(15_000),
    }, false);
    return parseJsonResponse(response, url, { preserveLargeIntegers: true });
  }

  private result(body: Record<string, unknown>, field: string): ImActionResponse {
    // These Desktop consumers read the HTTP JSON root, without requiring a
    // status_code field. An explicit error wins; absent status needs valid data.
    const statusCode = body['status_code'] === undefined ? 0
      : typeof body['status_code'] === 'number' && Number.isSafeInteger(body['status_code'])
        ? body['status_code'] : -3;
    if (statusCode === 0 && (typeof body[field] !== 'number' || !Number.isSafeInteger(body[field]))) {
      return { statusCode: -3, statusMsg: `Desktop response missing or invalid ${field}` };
    }
    return { statusCode, statusMsg: typeof body['status_msg'] === 'string' ? body['status_msg'] : '' };
  }
}
