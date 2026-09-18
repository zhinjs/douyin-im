import { AccountStore } from './account-store.js';
import { checkSessionHealth } from './session-health.js';
import type { StoredAccount, StoredSession, ClientFactory, SessionProbeResult } from './types.js';

export type WakeStatus = 'ok' | 'expired' | 'error';

export interface WakeResult {
  status: WakeStatus;
  account: StoredAccount;
  client: ReturnType<ClientFactory>;
  /** 是否已经通过远端登录态与抖音身份校验。 */
  verified: boolean;
  /** 探针或本地健康检查给出的可诊断原因。 */
  reason: string;
  /** 若 status === 'ok'，screenName 取自 API 或缓存。 */
  screenName?: string;
}

export interface WakeOptions {
  /** 跳过网络验证，直接用磁盘 Session 构造 client */
  skipVerify?: boolean;
  /** Cancels the identity probe and prevents late responses from saving account state. */
  signal?: AbortSignal;
  /** Auth owner may provide human-verification continuation; store still owns UID-gated commit. */
  probeSession?: (client: ReturnType<ClientFactory>, signal?: AbortSignal) => Promise<SessionProbeResult>;
}

export type RestoreOutcome = 'ok' | 'expired' | 'error' | 'missing';

export interface RestoreSessionResult {
  outcome: RestoreOutcome;
  /** `missing` 时为 undefined */
  wake?: WakeResult;
}

/**
 * 尝试从本地落盘恢复 Session：无账号、本地 TTL 已过期、远端确认失效和
 * 暂时无法验证分别返回对应 outcome。网络错误不能等同于 Session 失效。
 */
export async function tryRestoreSession(
  store: AccountStore,
  createClient: ClientFactory,
  platformUid?: string,
  options: WakeOptions = {},
): Promise<RestoreSessionResult> {
  options.signal?.throwIfAborted();
  const uid = store.resolvePlatformUid(platformUid);
  if (!uid) {
    return { outcome: 'missing' };
  }

  const account = store.load(uid);
  if (!account?.session.cookies?.trim()) {
    return { outcome: 'missing' };
  }

  const local = checkSessionHealth(account);
  if (local.expired) {
    const clientCfg = store.toClientConfig(account);
    const client = createClient(clientCfg as Record<string, unknown>);
    return {
      outcome: 'expired',
      wake: {
        status: 'expired',
        account,
        client,
        verified: false,
        reason: 'sid_guard 已过期',
      },
    };
  }

  const wake = await wakeAccount(store, createClient, uid, options);
  if (wake.status === 'ok') {
    return { outcome: 'ok', wake };
  }
  return { outcome: wake.status === 'error' ? 'error' : 'expired', wake };
}

/**
 * Wake：从磁盘恢复 Account 并验证 Session 可用。
 * 探针先检查 Desktop Passport 登录态，再通过自资料接口核对抖音 UID。
 */
export async function wakeAccount(
  store: AccountStore,
  createClient: ClientFactory,
  platformUid: string,
  options: WakeOptions = {},
): Promise<WakeResult> {
  options.signal?.throwIfAborted();
  const account = store.load(platformUid);
  if (!account) {
    throw new Error(`Account ${platformUid} not found in store`);
  }

  const clientCfg = store.toClientConfig(account);
  const client = createClient(clientCfg as Record<string, unknown>);
  let probing = false;
  let accepted = false;
  let active = true;
  let ticketState = account.session.desktopTicketGuard;
  const cancel = (): void => {
    active = false;
    client.invalidateAuthenticationResponses?.();
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    client.setDeviceUpdateHandler?.(device => {
      if (!active || options.signal?.aborted) return;
      Object.assign(account.deviceProfile, device);
      // Device-only refresh must not commit the unverified probe's Cookie/ticket candidate.
      store.save(account);
    });
    client.enableTicketGuard?.(state => {
      if (!active || options.signal?.aborted) return;
      ticketState = state;
      // The private key is saved before the probe. Its response may rotate to a
      // different identity: stage that whole Cookie/ticket candidate until UID
      // validation, rather than overwriting the saved account during interception.
      if (probing) return;
      account.session = { ...account.session, cookies: client.getCookies(), desktopTicketGuard: state };
      store.save(account);
    });

    // Separate explicit startup from callback rebinding after promote/restore.
    client.startTicketGuard?.();
    if (client.startDeviceLifecycle || client.initializeDevice) {
      const device = await (client.startDeviceLifecycle?.() ?? client.initializeDevice!());
      options.signal?.throwIfAborted();
      Object.assign(account.deviceProfile, device);
      store.save(account);
    }

    if (options.skipVerify) {
      accepted = true;
      return {
        status: 'ok',
        account,
        client,
        verified: false,
        reason: '已按配置跳过远端 Session 校验',
        ...(account.meta.screenName ? { screenName: account.meta.screenName } : {}),
      };
    }

    probing = true;
    const probe = options.probeSession
      ? await options.probeSession(client, options.signal)
      : await client.probeSession(options.signal);
    options.signal?.throwIfAborted();
    if (probe.status === 'alive') {
      if (!probe.uid || probe.uid !== platformUid) {
        return {
          status: 'error', account, client, verified: false,
          reason: probe.uid
            ? `Session 身份不匹配：预期 ${platformUid}，远端 ${probe.uid}`
            : 'Session 校验未返回账号 UID',
        };
      }
      const session: StoredSession = {
        ...account.session,
        cookies: client.getCookies(),
        ...(ticketState ? { desktopTicketGuard: ticketState } : {}),
        verifiedAt: new Date().toISOString(),
      };
      const refreshed: StoredAccount = {
        ...account,
        session,
        meta: {
          ...account.meta,
          ...(probe.screenName ? { screenName: probe.screenName } : {}),
          updatedAt: new Date().toISOString(),
        },
      };
      store.save(refreshed);
      // The installed persistence callback and returned result must share the
      // refreshed object; a late certificate must not restore pre-probe metadata.
      Object.assign(account, refreshed);
      probing = false;
      accepted = true;
      return {
        status: 'ok',
        account,
        client,
        verified: true,
        reason: probe.reason,
        ...(probe.screenName || account.meta.screenName
          ? { screenName: probe.screenName ?? account.meta.screenName }
          : {}),
      };
    }

    return {
      status: probe.status,
      account,
      client,
      verified: probe.status === 'expired',
      reason: probe.reason,
      ...(account.meta.screenName ? { screenName: account.meta.screenName } : {}),
    };
  } finally {
    // Rejected/failed restores never retain authority to save late responses.
    active = accepted;
    options.signal?.removeEventListener('abort', cancel);
    if (!accepted) client.invalidateAuthenticationResponses?.();
  }
}
