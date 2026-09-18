import { EventEmitter } from 'events';
import type { BaseAccount } from './account.js';

export interface BaseClientAccountOptions {
  accountId?: string;
}

export interface AccountContext {
  /** 调用者传入的注册键；默认是持久化账号标识，上层也可用登录账号区分待登录实例。 */
  readonly requestedAccountId?: string;
  /** 存储层解析出的稳定账号标识。 */
  readonly resolvedAccountId?: string;
  /** 是否为尚无稳定标识的扫码账号。 */
  readonly anonymous: boolean;
}

/**
 * 账号集合及总体生命周期基类。
 *
 * BaseClient 只理解账号身份和生命周期，不认识联系人或业务事件。具体 SDK 通过
 * 工厂、存储解析及 added/removed hooks 接入自己的 Account 和事件系统。
 */
export abstract class BaseClient<
  A extends BaseAccount,
  O extends BaseClientAccountOptions,
> extends EventEmitter {
  private readonly registeredAccounts = new Set<A>();
  private readonly accountAliases = new Map<string, A>();
  private anonymousAccount?: A;
  private loginTask?: Promise<void>;
  private logoutTask?: Promise<void>;
  private lifecycleGeneration = 0;

  protected constructor() {
    super({ captureRejections: true });
  }

  /** 当前已注册账号的只读快照，顺序与注册顺序一致。 */
  get accounts(): readonly A[] {
    return [...this.registeredAccounts];
  }

  /** 注册存储中后来新增、但尚未进入当前 Client 的账号。 */
  loadAccounts(): readonly A[] {
    for (const accountId of this.listStoredAccountIds()) {
      if (!this.findAccount(accountId)) this.createAccount({ accountId } as O);
    }
    return this.accounts;
  }

  /**
   * 创建或复用一个账号。
   *
   * 相同账号标识、持久化别名和稳定账号 ID 都只会对应同一个实例；不传 ID 时
   * 重复调用会复用尚未完成登录的匿名扫码账号。
   */
  createAccount(options?: O): A {
    const input = options ?? ({} as O);
    const requestedAccountId = this.accountRegistrationKey(input);
    const resolvedAccountId = requestedAccountId
      ? this.resolveStoredAccountId(requestedAccountId)
      : undefined;
    const lookupId = resolvedAccountId ?? requestedAccountId;

    if (lookupId) {
      const existing = this.findAccount(lookupId);
      if (existing) {
        if (requestedAccountId) this.rememberAccountAlias(existing, requestedAccountId);
        return existing;
      }
    } else if (this.anonymousAccount) {
      return this.anonymousAccount;
    }

    const context: AccountContext = {
      ...(requestedAccountId ? { requestedAccountId } : {}),
      ...(resolvedAccountId ? { resolvedAccountId } : {}),
      anonymous: !requestedAccountId,
    };
    const normalized = this.normalizeAccountOptions(input, context);
    const account = this.instantiateAccount(normalized, context);
    this.registeredAccounts.add(account);
    if (requestedAccountId) this.rememberAccountAlias(account, requestedAccountId);
    if (resolvedAccountId) this.rememberAccountAlias(account, resolvedAccountId);
    if (!requestedAccountId) this.anonymousAccount = account;
    this.refreshAccountAliases(account);
    this.onAccountAdded(account);
    return account;
  }

  /** 选择主动操作使用的账号。 */
  pickAccount(accountId?: string): A {
    if (accountId) {
      const account = this.findAccount(accountId);
      if (account) return account;
      throw new Error(`账号不存在或尚未注册: ${accountId}`);
    }
    if (this.registeredAccounts.size === 1) return this.accounts[0]!;
    if (this.registeredAccounts.size === 0) throw new Error('没有已注册账号');
    throw new Error('存在多个账号，请向 pickAccount(accountId) 传入账号 ID');
  }

  /**
   * 从当前 Client 注销账号实例。持久化凭据不会被删除。
   *
   * 账号必须先成功停止；停止失败时保持注册，调用者可安全重试。
   */
  async removeAccount(accountId: string): Promise<boolean> {
    const account = this.findAccount(accountId);
    if (!account) return false;
    await account.logout();

    this.registeredAccounts.delete(account);
    for (const [alias, candidate] of this.accountAliases) {
      if (candidate === account) this.accountAliases.delete(alias);
    }
    if (this.anonymousAccount === account) delete this.anonymousAccount;
    this.onAccountRemoved(account);
    return true;
  }

  /** 依次登录所有账号；没有账号时创建一个匿名扫码账号。 */
  login(): Promise<void> {
    if (this.loginTask) return this.loginTask;
    const task = this.logoutTask
      ? this.loginAfter(this.logoutTask)
      : this.loginAll(++this.lifecycleGeneration);
    this.loginTask = task;
    void task.then(
      () => this.clearLifecycleTask('login', task),
      () => this.clearLifecycleTask('login', task),
    );
    return task;
  }

  /** 停止所有账号；单个账号失败不会阻止其余账号清理。 */
  logout(): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    this.lifecycleGeneration += 1;
    // 旧 login Promise 仍返回原调用方，但退出期间允许排队下一次 login()。
    delete this.loginTask;
    const task = this.logoutAll();
    this.logoutTask = task;
    void task.then(
      () => this.clearLifecycleTask('logout', task),
      () => this.clearLifecycleTask('logout', task),
    );
    return task;
  }

  /** SDK 工厂：创建一个具体账号实例。 */
  protected abstract instantiateAccount(options: O, context: AccountContext): A;

  /**
   * 一个 Client 内区分账号实例的注册键。底层默认使用稳定账号 ID；上层可在
   * 首次登录尚无稳定 ID 时返回登录账号，但不能把它当作已确认的平台身份。
   */
  protected accountRegistrationKey(options: O): string | undefined {
    return options.accountId;
  }

  /** 存储层账号枚举 seam；没有持久化存储时保持默认空实现。 */
  protected listStoredAccountIds(): readonly string[] {
    return [];
  }

  /** 存储层别名解析 seam。 */
  protected resolveStoredAccountId(accountId: string): string | undefined {
    void accountId;
    return undefined;
  }

  /** SDK 默认参数合并 seam。 */
  protected normalizeAccountOptions(options: O, context: AccountContext): O {
    void context;
    return options;
  }

  /** 注册完成 hook；适合绑定上层事件转发。 */
  protected onAccountAdded(account: A): void {
    void account;
  }

  /** 注销完成 hook。 */
  protected onAccountRemoved(account: A): void {
    void account;
  }

  /** 登录或身份提升后刷新稳定 ID/IM ID 等运行时别名。 */
  protected promoteAccountIdentity(account: A): void {
    this.refreshAccountAliases(account);
    if (this.anonymousAccount === account) delete this.anonymousAccount;
  }

  /** 额外记录由上层协议确认的账号别名。 */
  protected rememberAccountAlias(account: A, alias: string): void {
    if (alias) this.accountAliases.set(alias, account);
  }

  private findAccount(accountId: string): A | undefined {
    const direct = this.accountAliases.get(accountId);
    if (direct) return direct;

    const resolved = this.resolveStoredAccountId(accountId);
    if (resolved) {
      const stored = this.accountAliases.get(resolved);
      if (stored) {
        this.accountAliases.set(accountId, stored);
        return stored;
      }
    }

    for (const account of this.registeredAccounts) {
      if (account.uid === accountId || account.imUid === accountId) {
        this.accountAliases.set(accountId, account);
        return account;
      }
    }
    return undefined;
  }

  private refreshAccountAliases(account: A): void {
    if (account.uid) this.accountAliases.set(account.uid, account);
    if (account.imUid) this.accountAliases.set(account.imUid, account);
  }

  private async loginAfter(logoutTask: Promise<void>): Promise<void> {
    await logoutTask;
    await this.loginAll(++this.lifecycleGeneration);
  }

  private async loginAll(generation: number): Promise<void> {
    if (this.registeredAccounts.size === 0) this.createAccount();
    const failures: unknown[] = [];
    for (const account of this.registeredAccounts) {
      this.ensureLifecycleGeneration(generation);
      if (account.online) continue;
      try {
        await account.login();
      } catch (error) {
        this.ensureLifecycleGeneration(generation);
        failures.push(error);
      }
      this.ensureLifecycleGeneration(generation);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} 个账号登录失败`);
    }
  }

  private async logoutAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.registeredAccounts].map((account) => account.logout()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} 个账号下线失败`);
    }
  }

  private clearLifecycleTask(kind: 'login' | 'logout', task: Promise<void>): void {
    if (kind === 'login' && this.loginTask === task) delete this.loginTask;
    if (kind === 'logout' && this.logoutTask === task) delete this.logoutTask;
  }

  private ensureLifecycleGeneration(generation: number): void {
    if (generation !== this.lifecycleGeneration) throw new Error('Client 登录已取消');
  }
}
