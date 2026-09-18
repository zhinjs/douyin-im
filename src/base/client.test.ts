import { BaseAccount } from './account.js';
import {
  BaseClient,
  type AccountContext,
  type BaseClientAccountOptions,
} from './client.js';

interface StubOptions extends BaseClientAccountOptions {
  label?: string;
}

class StubAccount extends BaseAccount {
  private readonly stableUid: string | undefined;
  private running = false;
  readonly calls: string[] = [];
  failLogout = false;

  constructor(uid?: string) {
    super();
    this.stableUid = uid;
  }

  override get uid(): string | undefined {
    return this.stableUid;
  }

  override get imUid(): string | undefined {
    return this.stableUid ? `im-${this.stableUid}` : undefined;
  }

  override get online(): boolean {
    return this.running;
  }

  override async login(): Promise<void> {
    this.calls.push('login');
    this.running = true;
  }

  override async logout(): Promise<void> {
    this.calls.push('logout');
    if (this.failLogout) throw new Error('logout failed');
    this.running = false;
  }

  protected override async beginLogin(generation: number): Promise<void> {
    void generation;
  }

  protected override cancelLogin(): void {}

  protected override async stopRuntime(): Promise<void> {}
}

class StubClient extends BaseClient<StubAccount, StubOptions> {
  readonly created: AccountContext[] = [];
  readonly removed: StubAccount[] = [];
  readonly order: string[] = [];
  storedIds: string[] = [];
  readonly resolved = new Map<string, string>();

  constructor() {
    super();
  }

  protected override instantiateAccount(options: StubOptions, context: AccountContext): StubAccount {
    this.created.push(context);
    const account = new StubAccount(options.accountId);
    const login = account.login.bind(account);
    account.login = async () => {
      this.order.push(`login:${options.accountId ?? 'anonymous'}`);
      await login();
    };
    return account;
  }

  protected override listStoredAccountIds(): readonly string[] {
    return this.storedIds;
  }

  protected override resolveStoredAccountId(accountId: string): string | undefined {
    return this.resolved.get(accountId);
  }

  protected override normalizeAccountOptions(
    options: StubOptions,
    context: AccountContext,
  ): StubOptions {
    return context.resolvedAccountId
      ? { ...options, accountId: context.resolvedAccountId }
      : options;
  }

  protected override onAccountRemoved(account: StubAccount): void {
    this.removed.push(account);
  }
}

describe('BaseClient', () => {
  it('keeps aliases and anonymous account identity inside the base collection', () => {
    const client = new StubClient();
    client.resolved.set('passport-a', '10001');

    const first = client.createAccount({ accountId: 'passport-a' });
    const anonymous = client.createAccount();

    expect(client.createAccount({ accountId: '10001' })).toBe(first);
    expect(client.pickAccount('passport-a')).toBe(first);
    expect(client.pickAccount('im-10001')).toBe(first);
    expect(client.createAccount()).toBe(anonymous);
    expect(client.accounts).toEqual([first, anonymous]);
  });

  it('loads stored accounts and logs them in registration order', async () => {
    const client = new StubClient();
    client.storedIds = ['10001', '10002'];

    client.loadAccounts();
    await client.login();

    expect(client.accounts).toHaveLength(2);
    expect(client.order).toEqual(['login:10001', 'login:10002']);
  });

  it('removes a stopped account but keeps a failing account registered', async () => {
    const client = new StubClient();
    const first = client.createAccount({ accountId: '10001' });
    const second = client.createAccount({ accountId: '10002' });
    second.failLogout = true;

    await expect(client.removeAccount('10001')).resolves.toBe(true);
    await expect(client.removeAccount('10002')).rejects.toThrow('logout failed');

    expect(client.accounts).toEqual([second]);
    expect(client.removed).toEqual([first]);
    expect(() => client.pickAccount('10001')).toThrow('账号不存在');
  });

  it('aggregates logout failures after asking every account to stop', async () => {
    const client = new StubClient();
    const first = client.createAccount({ accountId: '10001' });
    const second = client.createAccount({ accountId: '10002' });
    first.failLogout = true;

    await expect(client.logout()).rejects.toThrow('1 个账号下线失败');
    expect(first.calls).toContain('logout');
    expect(second.calls).toContain('logout');
  });
});
