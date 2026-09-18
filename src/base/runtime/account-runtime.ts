import type { ApiConnection } from '../../desktop/api-connection.js';
import type { AccountStore } from '../../store/account-store.js';
import type { StoredAccount } from '../../store/types.js';

export interface BoundAccountProtocol {
  readonly client: ApiConnection;
  readonly account: StoredAccount;
  readonly platformUid: string;
  readonly deviceId: string;
}

/** Owns the persisted session and HTTP connection for one BaseAccount. */
export class AccountRuntime {
  private stored?: StoredAccount;
  private bindingGeneration = 0;

  constructor(
    private readonly store: AccountStore,
    private apiConnection: ApiConnection,
    private readonly onDeviceUpdate?: () => void,
  ) {}

  get connection(): ApiConnection {
    return this.apiConnection;
  }

  get platformUid(): string | undefined {
    return this.stored?.platformUid;
  }

  get bound(): BoundAccountProtocol {
    if (!this.stored || !this.apiConnection) {
      throw new Error('账号未绑定，请先登录或 Wake');
    }
    const profile = this.store.ensureDeviceProfile(this.stored);
    return {
      client: this.apiConnection,
      account: this.stored,
      platformUid: this.stored.platformUid,
      deviceId: profile.deviceId!,
    };
  }

  /** Wake path: merge the restored persisted cookie snapshot into the connection. */
  bindRestored(client: ApiConnection, account: StoredAccount): void {
    client.jar.merge(account.session.cookies);
    this.bindPromoted(client, account);
  }

  /** Login promote path: the connection already owns the current cookies. */
  bindPromoted(client: ApiConnection, account: StoredAccount): void {
    if (this.apiConnection !== client || (this.stored && this.stored !== account)) this.suspend();
    this.apiConnection = client;
    this.stored = account;
    const generation = ++this.bindingGeneration;
    client.setDeviceUpdateHandler?.(device => {
      if (generation !== this.bindingGeneration || this.apiConnection !== client || this.stored !== account) return;
      Object.assign(account.deviceProfile, device);
      this.store.save(account);
      this.onDeviceUpdate?.();
    });
    client.enableTicketGuard?.(state => {
      // Late responses from an old/cleared binding must not resurrect it on disk.
      if (generation !== this.bindingGeneration || this.apiConnection !== client || this.stored !== account) return;
      account.session = { ...account.session, cookies: client.getCookies(), desktopTicketGuard: state };
      this.store.save(account);
    });
  }

  /** Stop account writes immediately; keep identity and saved credentials for recovery. */
  suspend(): void {
    this.bindingGeneration++;
    this.apiConnection.invalidateAuthenticationResponses();
  }

  clear(): void {
    this.suspend();
    delete this.stored;
  }
}
