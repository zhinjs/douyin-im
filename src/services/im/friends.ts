import { DouyinResponseError, parseJsonResponse } from '../../http/response.js';
import { ActionChallengeError } from '../../http/action-challenge.js';
import {
  desktopFingerprintParams,
  type DesktopScreenSize,
} from './desktop.js';
import type { ImHttpClient } from './service.js';
import type {
  FriendRosterEntry,
  FriendRosterOptions,
  FriendRosterResponse,
  RecommendedContact,
  RecommendedContactsResponse,
  NewFollowerCountResponse,
  FollowerNotice,
  FollowerNoticePage,
  ImActionResponse,
  SetUserRemarkOptions,
  SetUserFollowedOptions,
  UserFollowResponse,
  UserFollowStatus,
  UserRelationResponse,
} from './types.js';

const DESKTOP_ORIGIN = 'https://imdesktop.douyin.com';
const FAMILIAR_LIST_PATH = '/aweme/v1/web/familiar/list/';

/** Desktop 好友关系：列表、备注与带账号票据签名的关注操作。 */
export class ImFriendApi {
  constructor(
    private readonly client: ImHttpClient,
    private readonly deviceId = '',
    private readonly guid = '',
    private readonly screenSize: DesktopScreenSize = { width: 1728, height: 1117 },
  ) {}

  /** Desktop聊天页天窗的一次性查询；不复制UI缓存、活动状态合并或后台重试。 */
  async getRecommendedContacts(): Promise<RecommendedContactsResponse> {
    const params = this.commonParams();
    params.set('source', 'im_desktop');
    const url = `${DESKTOP_ORIGIN}/aweme/v1/web/im/friend/recommend/?${params}`;
    const response = await this.client.requestRaw(url, {
      method: 'GET', headers: { Accept: 'application/json, text/plain, */*',
        Referer: DESKTOP_ORIGIN, 'User-Agent': this.client.getUserAgent() },
      signal: AbortSignal.timeout(15_000),
    }, false);
    const body = parseJsonResponse<Record<string, unknown>>(response, url, { preserveLargeIntegers: true });
    const statusCode = body['status_code'] === undefined ? 0
      : typeof body['status_code'] === 'number' && Number.isSafeInteger(body['status_code']) ? body['status_code'] : -3;
    const statusMsg = typeof body['status_msg'] === 'string' ? body['status_msg'] : '';
    if (statusCode !== 0) return { statusCode, statusMsg, contacts: [] };
    // fetchSkyLightInfo returns [] for an absent/falsy friends value. Unlike its
    // detached catch recursion, a failed explicit SDK query remains observable.
    if (!body['friends']) return { statusCode, statusMsg, contacts: [] };
    const invalid = (): RecommendedContactsResponse => ({ statusCode: -3,
      statusMsg: 'Desktop response invalid recommended contacts', contacts: [] });
    if (!Array.isArray(body['friends'])) return invalid();
    const contacts: RecommendedContact[] = [];
    for (const value of body['friends']) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
      const contact: RecommendedContact = {};
      for (const [key, field] of [['name', 'name'], ['avatar', 'url'], ['secUid', 'sec_uid']] as const) {
        if (value[field] == null) continue;
        if (typeof value[field] !== 'string') return invalid();
        contact[key] = value[field];
      }
      if (value.conversation_id != null) {
        if (typeof value.conversation_id === 'string') contact.conversationId = value.conversation_id;
        else if (typeof value.conversation_id === 'number' && Number.isSafeInteger(value.conversation_id)) {
          contact.conversationId = String(value.conversation_id);
        } else return invalid();
      }
      if (value.active_time != null) {
        if (typeof value.active_time !== 'number' || !Number.isFinite(value.active_time)) return invalid();
        contact.lastActiveTime = value.active_time;
      }
      contacts.push(contact);
    }
    return { statusCode, statusMsg, contacts };
  }

  /** Desktop通知单页；请求包含is_mark_read=1，失败/超时不证明已读副作用未发生。 */
  async readFollowerNoticePage(maxTime = '0', minTime = '1'): Promise<FollowerNoticePage> {
    if (![maxTime, minTime].every(value => typeof value === 'string' && /^\d+$/.test(value))) {
      throw new TypeError('notice cursors must be non-negative decimal strings');
    }
    const params = this.commonParams();
    for (const [key, value] of Object.entries({ address_book_access: '1', appTheme: 'light', count: '20', gps_access: '0',
      is_mark_read: '1', is_new_notice: '1', max_time: maxTime, min_time: minTime, notice_group: '401', top_group: '0',
      user_avatar_shrink: '144_144', video_cover_shrink: '192_192' })) params.set(key, value);
    const url = `${DESKTOP_ORIGIN}/aweme/v1/web/notice/?${params}`;
    const response = await this.client.requestRaw(url, {
      method: 'GET', headers: { Accept: 'application/json, text/plain, */*', Referer: DESKTOP_ORIGIN,
        'User-Agent': this.client.getUserAgent() }, signal: AbortSignal.timeout(15_000),
    }, false);
    const body = parseJsonResponse<Record<string, unknown>>(response, url, { preserveLargeIntegers: true });
    const statusCode = body['status_code'] === undefined ? 0
      : typeof body['status_code'] === 'number' && Number.isSafeInteger(body['status_code']) ? body['status_code'] : -3;
    const statusMsg = typeof body['status_msg'] === 'string' ? body['status_msg'] : '';
    if (statusCode !== 0) return { statusCode, statusMsg, notices: [], hasMore: false };
    const invalid = (): FollowerNoticePage => ({ statusCode: -3, statusMsg: 'Desktop response invalid follower notice page', notices: [], hasMore: false });
    if (!Array.isArray(body['notice_list_v2']) || ![0, 1, '0', '1'].includes(body['has_more'] as number | string)) return invalid();
    const notices: FollowerNotice[] = [];
    for (const raw of body['notice_list_v2']) {
      const notice = mapFollowerNotice(raw);
      if (!notice) return invalid();
      notices.push(notice);
    }
    const hasMore = body['has_more'] === 1 || body['has_more'] === '1';
    const nextMax = noticeCursor(body['max_time']), nextMin = noticeCursor(body['min_time']);
    if (hasMore && (!nextMax || !nextMin)) return invalid();
    return { statusCode: 0, statusMsg, notices, hasMore,
      ...(nextMax !== undefined ? { maxTime: nextMax } : {}), ...(nextMin !== undefined ? { minTime: nextMin } : {}) };
  }

  /** Desktop朋友页独立计数查询；不展开通知列表、不标记已读、不自动轮询。 */
  async getNewFollowerCount(): Promise<NewFollowerCountResponse> {
    const params = this.commonParams();
    params.set('is_new_notice', '1');
    params.set('need_social_count', '1');
    const url = `${DESKTOP_ORIGIN}/aweme/v1/web/notice/count/?${params}`;
    const response = await this.client.requestRaw(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': this.client.getUserAgent(),
        Referer: DESKTOP_ORIGIN,
      },
      signal: AbortSignal.timeout(15_000),
    }, false);
    const body = parseJsonResponse<Record<string, unknown>>(response, url);
    // Renderer consumes this root without requiring status_code, but an explicit
    // business failure must not be converted to a zero unread count.
    const statusCode = body['status_code'] === undefined ? 0
      : typeof body['status_code'] === 'number' && Number.isSafeInteger(body['status_code'])
        ? body['status_code'] : -3;
    const result = { statusCode, statusMsg: typeof body['status_msg'] === 'string' ? body['status_msg'] : '' };
    if (statusCode !== 0) return result;
    const counts = body['notice_count'];
    if (!Array.isArray(counts)) return { statusCode: -3, statusMsg: 'Desktop response missing or invalid notice_count' };
    for (const item of counts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { statusCode: -3, statusMsg: 'Desktop response invalid notice_count entry' };
      }
      // Match the first group401 entry, as the renderer does. Its compact push
      // fields g/c belong to another channel and are not HTTP response aliases.
      if (item.group !== 401 && item.group !== '401') continue;
      if (typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 0) {
        return { statusCode: -3, statusMsg: 'Desktop response invalid group401 count' };
      }
      return { ...result, count: item.count };
    }
    // Desktop leaves its existing badge unchanged when no matching group exists.
    return result;
  }

  async list(options: FriendRosterOptions = {}): Promise<FriendRosterResponse> {
    const count = options.count ?? 100;
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new RangeError('friend list count must be an integer between 1 and 100');
    }
    const params = this.commonParams();
    // Douyin Chat 1.2.1's Friends page deliberately uses the mobile-compatible
    // 21.6.0 familiar-list shape while its common renderer params stay at 1.2.1.
    const sourceParams: Record<string, string> = {
      version_code: '21.6.0',
      cursor: String(options.cursor ?? 0),
      vcd_count: '0',
      hotsoon_has_more: '0',
      only_total: '0',
      count: String(count),
      order_by: '1',
      need_all_friend: '1',
      recommend_type: '22',
    };
    for (const [key, value] of Object.entries(sourceParams)) params.set(key, value);
    const url = `${DESKTOP_ORIGIN}${FAMILIAR_LIST_PATH}?${params}`;
    const response = await this.client.requestRaw(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': this.client.getUserAgent(),
          Referer: DESKTOP_ORIGIN,
          bgint_json_parser: '2',
        },
        signal: AbortSignal.timeout(15_000),
      },
      false,
    );
    const body = parseJsonResponse(response, url, { preserveLargeIntegers: true }) as FamiliarListResponse;
    const apiStatus = body.status_code == null ? -1 : Number(body.status_code);
    const statusCode = response.ok ? apiStatus : response.status;
    const result: ImActionResponse = {
      statusCode,
      statusMsg: String(body.status_msg ?? ''),
    };
    return {
      ...result,
      hasMore: statusCode === 0 && Boolean(body.has_more),
      cursor: String(body.cursor ?? '0'),
      total: String(body.total ?? body.total_count ?? '0'),
      userList: statusCode === 0 ? mapFamiliarUsers(body) : [],
      friendUids: statusCode === 0 ? (body.friend_list ?? []).map(String) : [],
      ...(Array.isArray(body.close_friend_list) ? { closeFriendUids: body.close_friend_list.map(String) } : {}),
    };
  }

  async setFollowed(options: SetUserFollowedOptions): Promise<UserFollowResponse> {
    assertUid(options.uid);
    if (!options.secUid.trim()) throw new Error('secUid is required to follow a user');
    if (typeof options.followed !== 'boolean') throw new TypeError('followed must be a boolean');
    if (this.client.requiresTicket?.(`${DESKTOP_ORIGIN}/aweme/v1/web/commit/follow/user/`) !== false && !this.client.hasBoundTicket?.()) {
      throw new Error('当前 Session 缺少绑定的 Desktop 安全票据，无法关注；需要同一账号登录响应建立 native BDTicket 绑定');
    }
    const params = this.commonParams();
    params.set('user_id', options.uid);
    params.set('secUid', options.secUid);
    params.set('type', options.followed ? '1' : '0');
    params.set('tag', 'frienddetail');
    params.set('verifyFp', `verify_${params.get('device_id')}`);
    const url = `${DESKTOP_ORIGIN}/aweme/v1/web/commit/follow/user/?${params}`;
    const response = await this.client.requestRaw(url, {
      method: 'POST',
      // R61604 nativePost -> Axios dispatch -> XHR retains the form Content-Type
      // even for ''. Without it Node's string-body default is text/plain.
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/x-www-form-urlencoded',
        Referer: DESKTOP_ORIGIN, 'User-Agent': this.client.getUserAgent() },
      body: '',
      signal: AbortSignal.timeout(15_000),
    }, false);
    // Desktop's Axios/nativePost rejects non-2xx before its follow .then handler.
    // Such responses must not enter challenge continuation and replay a mutation.
    if (!response.ok) throw new DouyinResponseError('http', response.status, url, response.headers);
    const bdturing = response.headers.get('bdturing-verify');
    let bdturingBody: unknown;
    if (bdturing) {
      // R61604 writes the header onto Axios data before C950 handles Passport.
      // Silent JSON parsing retains malformed text; assigning to any primitive
      // rejects nativePost. Null uses a temporary object, losing verifyData.
      try { bdturingBody = JSON.parse(response.rawText); }
      catch { bdturingBody = response.rawText; }
      if (bdturingBody !== null && typeof bdturingBody !== 'object') {
        throw new DouyinResponseError(response.rawText.trim() ? 'invalid-json' : 'empty', response.status, url, response.headers);
      }
    }
    // Desktop checks these even when the body is valid JSON. Never retry a
    // relationship mutation before the user actually completes its challenge.
    if (response.headers.get('x-tt-verify-passport-decision')) {
      throw new ActionChallengeError('passport-decision', response.headers.get('x-tt-verify-passport-decision')!);
    }
    if (bdturing && bdturingBody !== null) {
      throw new ActionChallengeError('bdturing', bdturing);
    }
    if (response.headers.get('x-vc-bdturing-parameters')) {
      throw new DouyinResponseError('captcha', response.status, url, response.headers);
    }
    const body = parseJsonResponse<Record<string, unknown>>(response, url);
    if (typeof body['verifyData'] === 'string' && body['verifyData']) throw new ActionChallengeError('bdturing', body['verifyData']);
    if (body['verifyData']) throw new DouyinResponseError('captcha', response.status, url, response.headers);
    const statusCode = typeof body['status_code'] === 'number' && Number.isSafeInteger(body['status_code'])
      ? body['status_code'] : -1;
    const followStatus = body['follow_status'];
    const knownState = typeof followStatus === 'number' && [0, 1, 2, 4].includes(followStatus);
    return {
      // An empty or unknown relationship result must not report success.
      statusCode: statusCode === 0 && !knownState ? -1 : statusCode,
      statusMsg: typeof body['status_msg'] === 'string' ? body['status_msg'] : '',
      ...(statusCode === 0 && knownState ? { followStatus: followStatus as UserFollowStatus } : {}),
    };
  }

  async setRemark(options: SetUserRemarkOptions): Promise<UserRelationResponse> {
    assertUid(options.uid);
    if (!options.secUid.trim()) throw new Error('secUid is required to set a remark');
    if (typeof options.remark !== 'string') throw new TypeError('remark must be a string');
    if (options.remark.length > 20) throw new RangeError('remark must not exceed 20 characters');
    // Desktop RemarkEditor treats wholly blank input as clearing the remark,
    // but preserves surrounding whitespace on nonblank text.
    const remark = /^\s*$/.test(options.remark) ? '' : options.remark;
    const form = new FormData();
    form.append('user_id', options.uid);
    form.append('sec_user_id', options.secUid);
    form.append('remark_name', remark);
    const url = `${DESKTOP_ORIGIN}/aweme/v1/web/user/remark/name/?${this.commonParams()}`;
    const response = await this.client.requestRaw(url, {
      method: 'POST',
      headers: { Referer: DESKTOP_ORIGIN },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const decoded = parseJsonResponse<Record<string, unknown>>(response, url);
    const code = decoded['status_code'];
    // Accept numeric status strings used by Desktop's loose comparison, without
    // letting booleans/arrays/empty strings masquerade as a confirmed mutation.
    const numericCode = typeof code === 'number' || (typeof code === 'string' && /^-?\d+$/.test(code)) ? Number(code) : -1;
    const statusCode = Number.isSafeInteger(numericCode) ? numericCode : -1;
    const statusMsg = typeof decoded['status_msg'] === 'string' ? decoded['status_msg'] : '';
    if (statusCode !== 0 && statusCode !== 200) return { statusCode, statusMsg };
    // A successful HTTP/status response is insufficient: the editor also requires
    // the server echo to match. Never publish a missing or unrelated remark.
    if (typeof decoded['remark_name'] !== 'string' || decoded['remark_name'] !== remark) {
      return { statusCode: -3, statusMsg: 'Desktop response did not confirm requested remark' };
    }
    return { statusCode: 0, statusMsg, remark: decoded['remark_name'] };
  }

  private commonParams(): URLSearchParams {
    const deviceId = this.client.getDeviceId?.() ?? this.deviceId;
    const params = desktopFingerprintParams(deviceId || '0', this.guid || '0', this.screenSize, this.client.getUserAgent());
    params.set('iid', this.client.getInstallId?.() || '0');
    return params;
  }
}

function noticeCursor(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function mapFollowerNotice(value: unknown): FollowerNotice | undefined {
  const object = (raw: unknown): Record<string, unknown> | undefined => raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : undefined;
  const raw = object(value), follow = object(raw?.['follow']), user = object(follow?.['from_user']);
  if (!raw || !follow || !user) return undefined;
  const uid = noticeCursor(user['uid']);
  if (!uid || uid === '0' || typeof user['sec_uid'] !== 'string' || typeof user['nickname'] !== 'string') return undefined;
  const avatar = object(user['avatar_300x300']);
  if (!avatar || !Array.isArray(avatar['url_list']) || avatar['url_list'].some(url => typeof url !== 'string')) return undefined;
  const result: FollowerNotice = { uid, secUid: user['sec_uid'], nickname: user['nickname'] };
  if (avatar['url_list'].length) result.avatar = avatar['url_list'][0] as string;
  for (const [key, source, field] of [
    ['remark', user, 'remark_name'], ['avatarUri', avatar, 'uri'], ['content', follow, 'content'],
  ] as const) {
    const text = source[field];
    if (text !== undefined && text !== null) {
      if (typeof text !== 'string') return undefined;
      result[key] = text;
    }
  }
  for (const [key, source, field] of [
    ['createTime', raw, 'create_time'], ['followStatus', user, 'follow_status'], ['followerStatus', user, 'follower_status'],
  ] as const) {
    const number = source[field];
    if (number !== undefined && number !== null) {
      if (typeof number !== 'number' || !Number.isSafeInteger(number)) return undefined;
      result[key] = number;
    }
  }
  const hasRead = raw['has_read'];
  if (hasRead !== undefined && hasRead !== null) {
    if (typeof hasRead !== 'boolean' && (typeof hasRead !== 'number' || !Number.isSafeInteger(hasRead))) return undefined;
    result.hasRead = hasRead;
  }
  return result;
}

interface FamiliarListUser {
  uid?: string | number;
  sec_uid?: string;
  nickname?: string;
  remark_name?: string;
  signature?: string;
  user_canceled?: string | number;
  avatar_thumb?: { url_list?: string[] };
  avatar_168x168?: { url_list?: string[] };
}

interface FamiliarListResponse {
  status_code?: number;
  status_msg?: string;
  cursor?: string | number;
  has_more?: boolean | number;
  total?: string | number;
  total_count?: string | number;
  user_list?: FamiliarListUser[];
  friend_list?: Array<string | number>;
  close_friend_list?: Array<string | number>;
}

function mapFamiliarUsers(body: FamiliarListResponse): FriendRosterEntry[] {
  return (body.user_list ?? [])
      .filter((user) => Number(user.user_canceled ?? 0) === 0)
    .filter(user => user.uid != null && String(user.uid) !== '' && String(user.uid) !== '0')
    .map(user => {
      const uid = String(user.uid);
      const avatar = firstUrl(user.avatar_thumb) || firstUrl(user.avatar_168x168);
      return {
        uid,
        nickname: String(user.nickname ?? ''),
        ...(avatar ? { avatar } : {}),
        ...(user.sec_uid ? { secUid: user.sec_uid } : {}),
        ...(typeof user.remark_name === 'string' ? { remark: user.remark_name } : {}),
        ...(typeof user.signature === 'string' ? { signature: user.signature } : {}),
      };
    });
}

function firstUrl(value: { url_list?: string[] } | undefined): string {
  return value?.url_list?.find(Boolean) ?? '';
}

function assertUid(uid: string): void {
  if (!/^\d+$/.test(uid)) throw new Error('uid must be a decimal int64 string');
}
