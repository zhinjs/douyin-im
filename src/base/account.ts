import { EventEmitter } from 'events';
import {
  ConnectionManager,
  type ConnectionManagerOptions,
} from './runtime/connection-manager.js';
import { AccountRuntime } from './runtime/account-runtime.js';
import type { AccountStore } from '../store/account-store.js';
import type { ApiConnection } from '../desktop/api-connection.js';
import { PassportTokenBeat } from '../desktop/token-beat.js';
import { getAccountLogger, type Logger } from '../logger.js';

export type AccountState =
  | 'idle'
  | 'logging-in'
  | 'online'
  | 'reconnecting'
  | 'stopping'
  | 'offline'
  | 'error';

export interface AccountIdentity {
  platformUid?: string;
  imUid?: string;
}

/**
 * 单账号协议运行时的生命周期 seam。
 *
 * 认证方式、连接实现和业务缓存由子类提供；并发登录、取消、旧任务隔离与
 * 幂等退出集中在这里，避免每个上层账号实现各自维护一套状态机。
 */
export abstract class BaseAccount extends EventEmitter {
  private accountState: AccountState = 'idle';
  private lifecycleGeneration = 0;
  private loginTask?: Promise<void>;
  private logoutTask?: Promise<void>;
  private resolveLogin?: () => void;
  private rejectLogin?: (error: unknown) => void;
  private connectionManager?: ConnectionManager;
  private accountRuntime?: AccountRuntime;
  private accountLogger: Logger = getAccountLogger();
  private sessionRenewal?: PassportTokenBeat;

  abstract get uid(): string | undefined;
  abstract get imUid(): string | undefined;

  /** oicq 风格的账号级 Logger；业务日志以账号而不是内部模块作为类别。 */
  get logger(): Logger {
    return this.accountLogger;
  }

  get identity(): Readonly<AccountIdentity> {
    const identity: AccountIdentity = {};
    if (this.uid !== undefined) identity.platformUid = this.uid;
    if (this.imUid !== undefined) identity.imUid = this.imUid;
    return Object.freeze(identity);
  }

  get state(): AccountState {
    return this.accountState;
  }

  get online(): boolean {
    return this.accountState === 'online' || this.accountState === 'reconnecting';
  }

  /** 报告真实使用活动；空闲时暂停 Session 续期，收消息不自动视为用户活动。 */
  markActive(): void {
    if (!this.online) throw new Error('账号未上线，不能报告活动');
    this.sessionRenewal?.activity();
  }

  protected startSessionRenewal(request: ConstructorParameters<typeof PassportTokenBeat>[0]): void {
    this.sessionRenewal?.stop();
    const generation = this.lifecycleGeneration;
    const renewal = new PassportTokenBeat(request, () => {
      if (generation !== this.lifecycleGeneration || !this.online) return;
      this.logger.warn('Session 续期被拒绝，账号已退出登录');
      void this.logout().catch(error => this.logger.error(error, '停止失效账号失败'));
    });
    this.sessionRenewal = renewal;
    renewal.start();
  }

  login(): Promise<void> {
    if (this.online) return Promise.resolve();
    if (this.loginTask) return this.loginTask;
    const task = this.performLogin();
    this.loginTask = task;
    void task.then(
      () => this.clearLifecycleTask('login', task),
      () => this.clearLifecycleTask('login', task),
    );
    return task;
  }

  logout(): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    if (this.accountState === 'idle' || this.accountState === 'offline') {
      return Promise.resolve();
    }
    const task = this.performLogout();
    this.logoutTask = task;
    // 旧登录 Promise 仍会被拒绝；允许调用方立即排队下一次登录。
    delete this.loginTask;
    void task.then(
      () => this.clearLifecycleTask('logout', task),
      () => this.clearLifecycleTask('logout', task),
    );
    return task;
  }

  protected get loginGeneration(): number {
    return this.lifecycleGeneration;
  }

  protected installAccountRuntime(store: AccountStore, connection: ApiConnection): void {
    if (this.accountRuntime) throw new Error('account runtime already installed');
    const runtime = new AccountRuntime(store, connection, () => this.onDeviceUpdated());
    this.accountRuntime = runtime;
  }

  protected onDeviceUpdated(): void {}

  /** 账号恢复或首次登录得到稳定 UID 后，切换到稳定日志类别。 */
  protected refreshLoggerIdentity(): void {
    this.accountLogger = getAccountLogger(this.uid);
  }

  protected get runtime(): AccountRuntime {
    if (!this.accountRuntime) throw new Error('account runtime is not installed');
    return this.accountRuntime;
  }

  protected setAccountState(state: AccountState): void {
    this.accountState = state;
  }

  protected assertLoginGeneration(generation: number): void {
    if (generation !== this.lifecycleGeneration || this.accountState !== 'logging-in') {
      throw new Error('登录已取消');
    }
  }

  protected completeLogin(): void {
    this.assertLoginGeneration(this.lifecycleGeneration);
    this.accountState = 'online';
    const resolve = this.resolveLogin;
    this.clearPendingLogin();
    resolve?.();
  }

  protected failLogin(error: unknown): void {
    if (this.accountState !== 'logging-in') return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.cancelLogin();
    this.accountState = 'error';
    const reject = this.rejectLogin;
    this.clearPendingLogin();
    reject?.(normalized);
    this.emit('system.login.error', normalized);
  }

  protected async continueLoginAction(action: () => Promise<void>): Promise<void> {
    if (this.accountState !== 'logging-in') throw new Error('账号当前不在登录流程中');
    const generation = this.lifecycleGeneration;
    try {
      await action();
    } catch (error) {
      if (generation === this.lifecycleGeneration) this.failLogin(error);
      throw error;
    }
  }

  protected abstract beginLogin(generation: number): Promise<void>;

  protected abstract cancelLogin(): void;

  /** Install and start the only inbound runtime owned by this account. */
  protected async startConnection(
    options: ConnectionManagerOptions,
  ): Promise<void> {
    if (this.connectionManager) await this.connectionManager.stop();
    const manager = new ConnectionManager(options);
    this.connectionManager = manager;
    try {
      await manager.start();
    } catch (error) {
      if (this.connectionManager === manager) delete this.connectionManager;
      await manager.stop();
      throw error;
    }
  }

  protected async stopRuntime(): Promise<void> {
    this.sessionRenewal?.stop(); delete this.sessionRenewal;
    const manager = this.connectionManager;
    delete this.connectionManager;
    await manager?.stop();
  }

  protected onLoggedOut(): void {}

  private async performLogin(): Promise<void> {
    if (this.accountState === 'stopping') await this.logoutTask;
    if (this.online) return;
    this.accountState = 'logging-in';
    const generation = ++this.lifecycleGeneration;
    const online = new Promise<void>((resolve, reject) => {
      this.resolveLogin = resolve;
      this.rejectLogin = reject;
    });
    void this.beginLogin(generation).catch((error: unknown) => {
      if (generation === this.lifecycleGeneration) this.failLogin(error);
    });
    await online;
  }

  private async performLogout(): Promise<void> {
    this.accountState = 'stopping';
    this.lifecycleGeneration += 1;
    this.sessionRenewal?.stop(); delete this.sessionRenewal;
    this.accountRuntime?.suspend();
    this.cancelLogin();
    const reject = this.rejectLogin;
    this.clearPendingLogin();
    reject?.(new Error('登录已取消'));
    try {
      await this.stopRuntime();
    } finally {
      this.onLoggedOut();
      this.accountState = 'offline';
      this.emit('system.offline');
    }
  }

  private clearPendingLogin(): void {
    delete this.resolveLogin;
    delete this.rejectLogin;
  }

  private clearLifecycleTask(kind: 'login' | 'logout', task: Promise<void>): void {
    if (kind === 'login' && this.loginTask === task) delete this.loginTask;
    if (kind === 'logout' && this.logoutTask === task) delete this.logoutTask;
  }
}
