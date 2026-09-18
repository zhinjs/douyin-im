
import type { DesktopTicketGuardState } from '../desktop/ticket-guard.js';

export interface StoredAccount {
  platformUid: string;
  passportUidTt?: string;
  session: StoredSession;
  deviceProfile: StoredDeviceProfile;
  meta: AccountMeta;
}

export interface StoredSession {
  /** Sensitive account-scoped REE identity and Session-bound ticket. */
  desktopTicketGuard?: DesktopTicketGuardState;
  cookies: string;
  /** 上次验证时间 (ISO) */
  verifiedAt?: string;
}

export interface StoredDeviceProfile {
  userAgent: string;
  /** Desktop 注册返回的设备 ID；离线回退值不能当作注册成功。 */
  deviceId?: string;
  installId?: string;
  /** Electron `app.getGuid()` 对应的稳定应用实例 GUID。 */
  guid?: string;
  /** Renderer `screen.width` / `screen.height`，与 GUID 一起作为稳定设备画像。 */
  screenWidth?: number;
  screenHeight?: number;
  screenFingerprint?: string;
  bizTraceId: string;
}

export interface AccountMeta {
  screenName?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 登录进行中的临时本地记录，存放在 `<dataDir>/accounts/_pending/<id>/`。
 * 成功后 Promote 为正式 Account。
 */
export interface PendingAccount {
  desktopTicketGuard?: DesktopTicketGuardState;
  id: string;
  loginMethod: 'qr' | 'sms' | 'password';
  startedAt: string;
  deviceProfile: StoredDeviceProfile;
  /** 登录中途积累的 cookies（ttwid, csrf 等） */
  cookies?: string;
}

/**
 * Store 层所需的 HTTP 客户端最小接口。
 * 与 ApiConnection 解耦——store 不直接依赖 Desktop 协议模块。
 */
export interface HttpClient {
  enableTicketGuard?(persist: (state: DesktopTicketGuardState) => void): void;
  startTicketGuard?(): void;
  getTicketGuardState?(): DesktopTicketGuardState | undefined;
  requestRaw(url: string, init: RequestInit): Promise<{
    ok: boolean;
    status: number;
    headers: Headers;
    data: string;
    rawText: string;
  }>;
  getCookies(): string;
  getUserAgent(): string;
  probeSession(signal?: AbortSignal): Promise<SessionProbeResult>;
  initializeDevice?(): Promise<{ deviceId: string; installId: string }>;
  startDeviceLifecycle?(): Promise<{ deviceId: string; installId: string }>;
  setDeviceUpdateHandler?(handler: (device: { deviceId: string; installId: string }) => void): void;
  invalidateAuthenticationResponses?(): void;
}

export interface SessionProbeResult {
  status: 'alive' | 'expired' | 'error';
  uid?: string;
  screenName?: string;
  reason: string;
}

/**
 * 从 StoredAccount 配置重建 HttpClient 的工厂函数。
 * 由应用层注入，store 模块不持有 ApiConnection 引用。
 */
export type ClientFactory = (config: Record<string, unknown>) => HttpClient;
