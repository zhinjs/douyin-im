import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  AccountMeta,
  PendingAccount,
  StoredAccount,
  StoredDeviceProfile,
  StoredSession,
} from './types.js';

const ACCOUNT_FILE = 'account.json';
const PENDING_DIR = '_pending';

function generateGuid(): string {
  return randomUUID().replaceAll('-', '');
}

function screenSizeFromFingerprint(value?: string): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const parts = value.split('|');
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    return undefined;
  }
  return { width, height };
}

export interface AccountStoreOptions {
  /** 数据根目录，默认 `./data` */
  dataDir?: string;
}

export class AccountStore {
  private readonly accountsDir: string;
  private readonly pendingDir: string;

  constructor(options: AccountStoreOptions = {}) {
    const base = options.dataDir ?? './data';
    this.accountsDir = join(base, 'accounts');
    this.pendingDir = join(this.accountsDir, PENDING_DIR);
    mkdirSync(this.accountsDir, { recursive: true });
    mkdirSync(this.pendingDir, { recursive: true });
  }

  /** 单账号所有持久化状态的根目录。 */
  accountDataDir(platformUid: string): string {
    const directory = join(this.accountsDir, platformUid);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  /** 列出所有已落盘的 platformUid */
  listUids(): string[] {
    if (!existsSync(this.accountsDir)) return [];
    return readdirSync(this.accountsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== PENDING_DIR)
      .map((d) => d.name);
  }

  /**
   * 选择要恢复的账号。
   *
   * `preferred` 可以是 platformUid（目录名）或 Passport `uid_tt` 别名。
   * 未指定时取 `meta.updatedAt` 最新。
   */
  resolvePlatformUid(preferred?: string): string | undefined {
    if (preferred) {
      if (this.load(preferred)) return preferred;
      const byField = this.findByField(preferred);
      if (byField) return byField;
      return undefined;
    }
    const uids = this.listUids();
    if (uids.length === 0) return undefined;
    if (uids.length === 1) return uids[0];
    let latestUid = uids[0]!;
    let latestAt = 0;
    for (const uid of uids) {
      const account = this.load(uid);
      if (!account) continue;
      const at = Date.parse(account.meta.updatedAt);
      if (at > latestAt) {
        latestAt = at;
        latestUid = uid;
      }
    }
    return latestUid;
  }

  /** 按 Passport `uid_tt` 别名匹配目录名。 */
  private findByField(value: string): string | undefined {
    for (const uid of this.listUids()) {
      const account = this.load(uid);
      if (!account) continue;
      if (account.passportUidTt === value) {
        return uid;
      }
    }
    return undefined;
  }

  /** 读取单个 Account；不存在返回 undefined */
  load(platformUid: string): StoredAccount | undefined {
    const file = join(this.accountsDir, platformUid, ACCOUNT_FILE);
    if (!existsSync(file)) return undefined;
    const account = JSON.parse(readFileSync(file, 'utf8')) as StoredAccount & Record<string, unknown>;
    let changed = false;
    for (const legacyKey of ['creatorUserId', 'ticketGuard']) {
      if (legacyKey in account) {
        delete account[legacyKey];
        changed = true;
      }
    }
    const device = account.deviceProfile as StoredDeviceProfile & Record<string, unknown>;
    if (device && 'loginFlavor' in device) {
      delete device['loginFlavor'];
      changed = true;
    }
    if (changed) this.save(account);
    return account;
  }

  /** 写入/覆盖 Account */
  save(account: StoredAccount): void {
    const dir = join(this.accountsDir, account.platformUid);
    mkdirSync(dir, { recursive: true });
    writeSensitiveJson(join(dir, ACCOUNT_FILE), account);
  }

  /** 仅更新 Session 部分（不动 deviceProfile / meta） */
  updateSession(platformUid: string, session: StoredSession): void {
    const account = this.load(platformUid);
    if (!account) {
      throw new Error(`Account ${platformUid} not found`);
    }
    account.session = session;
    account.meta.updatedAt = new Date().toISOString();
    this.save(account);
  }

  /** 创建 PendingAccount（登录进行中的临时记录） */
  createPending(pending: PendingAccount): void {
    const dir = join(this.pendingDir, pending.id);
    mkdirSync(dir, { recursive: true });
    writeSensitiveJson(join(dir, 'pending.json'), pending);
  }

  /** 读取 PendingAccount */
  loadPending(id: string): PendingAccount | undefined {
    const file = join(this.pendingDir, id, 'pending.json');
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as PendingAccount;
  }

  /**
   * Promote：将 PendingAccount 升级为正式 Account（幂等）。
   *
   * 若 `platformUid` 对应目录已存在 → 覆盖 session + 更新 meta，保留 createdAt。
   * 这确保同一用户多次登录不会产生多个目录。
   */
  promote(
    pendingId: string,
    platformUid: string,
    session: StoredSession,
    meta: Partial<AccountMeta> & { passportUidTt?: string } = {},
  ): StoredAccount {
    const pending = this.loadPending(pendingId);
    if (!pending) {
      throw new Error(`Pending account ${pendingId} not found`);
    }
    const now = new Date().toISOString();
    const existing = this.load(platformUid);
    let account: StoredAccount;
    if (existing) {
      existing.session = session;
      existing.deviceProfile = pending.deviceProfile;
      existing.meta.updatedAt = now;
      if (meta.screenName) existing.meta.screenName = meta.screenName;
      if (meta.avatarUrl) existing.meta.avatarUrl = meta.avatarUrl;
      if (meta.passportUidTt) existing.passportUidTt = meta.passportUidTt;
      account = existing;
    } else {
      const accountMeta: AccountMeta = { createdAt: now, updatedAt: now };
      if (meta.screenName) accountMeta.screenName = meta.screenName;
      if (meta.avatarUrl) accountMeta.avatarUrl = meta.avatarUrl;
      account = {
        platformUid,
        session,
        deviceProfile: pending.deviceProfile,
        meta: accountMeta,
      };
      if (meta.passportUidTt) account.passportUidTt = meta.passportUidTt;
    }
    this.save(account);
    this.removePending(pendingId);
    return account;
  }

  /** 删除 PendingAccount */
  removePending(id: string): void {
    const dir = join(this.pendingDir, id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  }

  /** 从 StoredAccount 重建 ApiConnectionOptions 所需字段 */
  toClientConfig(account: StoredAccount): Record<string, unknown> {
    const profile = this.ensureDeviceProfile(account);
    const cfg: Record<string, unknown> = {
      initialCookies: account.session.cookies,
      userAgent: profile.userAgent,
      bizTraceId: profile.bizTraceId,
      deviceId: profile.deviceId,
      installId: profile.installId,
      guid: profile.guid,
      screenWidth: String(profile.screenWidth),
      screenHeight: String(profile.screenHeight),
      desktopSettingsDirectory: this.accountDataDir(account.platformUid),
    };
    if (profile.screenFingerprint) {
      cfg['screenFingerprint'] = profile.screenFingerprint;
    }
    // Legacy session.msToken duplicated a Cookie, not BDMS localStorage xmst.
    // Preserve existing files but never restore that value as a signing override.
    if (account.session.desktopTicketGuard) cfg['desktopTicketGuard'] = account.session.desktopTicketGuard;
    return cfg;
  }

  /**
   * 列出所有已落盘账号的摘要信息。
   */
  listAccounts(): Array<{ platformUid: string; screenName: string | undefined; updatedAt: string; path: string }> {
    return this.listUids().map((uid) => {
      const account = this.load(uid);
      return {
        platformUid: uid,
        screenName: account?.meta.screenName,
        updatedAt: account?.meta.updatedAt ?? '',
        path: join(this.accountsDir, uid),
      };
    });
  }

  /**
   * 从 Desktop Passport 登录结果中解析稳定的 user_id。
   *
   * 优先级：userData.user_id_str > userData.user_id。禁止单独使用 uid_tt。
   * 调用方应在登录成功后立即调用，将返回值作为 promote 的 platformUid。
   */
  static resolveCanonicalUserId(
    userData?: Record<string, unknown>,
  ): string {
    const userIdStr = String(userData?.['user_id_str'] ?? '');
    if (/^\d+$/.test(userIdStr) && userIdStr !== '0') return userIdStr;
    const userId = userData?.['user_id'];
    const value = userId == null ? '' : String(userId);
    if (/^\d+$/.test(value) && value !== '0') return value;
    throw new Error('Cannot resolve canonical user ID: login response and self profile contain no numeric user ID');
  }

  /** 辅助：从 ApiConnection 登录结果构建 StoredSession */
  static buildSession(cookies: string, guard?: StoredSession['desktopTicketGuard']): StoredSession {
    const s: StoredSession = {
      cookies,
      verifiedAt: new Date().toISOString(),
    };
    if (guard) s.desktopTicketGuard = guard;
    return s;
  }

  /** 辅助：构建默认 DeviceProfile */
  static buildDeviceProfile(
    userAgent: string,
    bizTraceId: string,
    extras?: Partial<StoredDeviceProfile>,
  ): StoredDeviceProfile {
    const screen = screenSizeFromFingerprint(extras?.screenFingerprint);
    const guid = extras?.guid ?? generateGuid();
    return {
      ...extras,
      userAgent,
      bizTraceId,
      deviceId: extras?.deviceId ?? '0',
      guid,
      screenWidth: extras?.screenWidth ?? screen?.width ?? 1728,
      screenHeight: extras?.screenHeight ?? screen?.height ?? 1117,
    };
  }

  /** 为旧 Account 补齐设备字段；0 表示未注册，不能冒充远端设备身份。 */
  ensureDeviceId(account: StoredAccount): string {
    return this.ensureDeviceProfile(account).deviceId!;
  }

  /** 为旧 Account 一次性补齐 renderer 共用的稳定设备画像。 */
  ensureDeviceProfile(account: StoredAccount): StoredDeviceProfile {
    const profile = account.deviceProfile;
    const screen = screenSizeFromFingerprint(profile.screenFingerprint);
    let changed = false;
    if (!profile.guid?.trim()) {
      profile.guid = generateGuid();
      changed = true;
    }
    if (!profile.deviceId?.trim()) {
      profile.deviceId = '0';
      changed = true;
    }
    if (!Number.isSafeInteger(profile.screenWidth) || profile.screenWidth! <= 0) {
      profile.screenWidth = screen?.width ?? 1728;
      changed = true;
    }
    if (!Number.isSafeInteger(profile.screenHeight) || profile.screenHeight! <= 0) {
      profile.screenHeight = screen?.height ?? 1117;
      changed = true;
    }
    if (changed) this.save(account);
    return profile;
  }
}

/** Atomic replacement also tightens existing files to owner-only on POSIX. */
function writeSensitiveJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
