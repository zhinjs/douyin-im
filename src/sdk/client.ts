import { captureRejectionSymbol } from 'events';
import { BaseClient, type AccountContext } from '../base/client.js';
import { ApiConnection } from '../desktop/api-connection.js';
import { DESKTOP_LOGIN_USER_AGENT } from '../desktop/constants.js';
import { AccountStore } from '../store/account-store.js';
import type { AccountEventMap } from './account-events.js';
import { Account, type AccountOptions } from './account.js';
import type { MessageEvent } from './events/message.js';
import { toError } from './errors.js';
import { getLogger } from '../logger.js';
import type { LocalImStateOptions } from '../services/im/state-store.js';

const logger = getLogger('Client');

export interface ClientOptions {
  /** 所有账号共用的数据根目录；每个账号仍写入独立的 accounts/<uid> 目录。 */
  dataDir?: string;
  /** 默认 true：构造时注册 dataDir 中所有已保存账号。 */
  autoLoad?: boolean;
  /** Wake 时是否跳过远端账号校验；默认 false。 */
  skipVerify?: boolean;
  /** 本地 IM 状态库；默认使用每个账号独立的 node:sqlite 数据库，false 可关闭。 */
  localState?: false | LocalImStateOptions;
}

type ClientAccountDefaults = Omit<AccountOptions, 'accountId' | 'login'>;

interface ClientAccountEvent {
  account: Account;
}

type WithAccount<T> = T extends void
  ? ClientAccountEvent
  : T extends Error
    ? ClientAccountEvent & { error: T }
    : ClientAccountEvent & T;

type PassiveMessageEventName =
  | 'message'
  | 'message.private'
  | 'message.stranger'
  | 'message.group';

type PassiveNoticeEventName =
  | 'notice'
  | 'notice.friend'
  | 'notice.friend.marked-read'
  | 'notice.friend.add-request'
  | 'notice.friend.increase'
  | 'notice.friend.decrease'
  | 'notice.conversation'
  | 'notice.conversation.marked-read'
  | 'notice.group'
  | 'notice.group.member-change'
  | 'notice.group.member-increase'
  | 'notice.group.invite'
  | 'notice.group.member-decrease'
  | 'notice.group.admin'
  | 'notice.group.name-change'
  | 'notice.group.avatar-change'
  | 'notice.group.metadata-change'
  | 'notice.group.marked-read'
  | 'notice.conversation.update'
  | 'notice.conversation.delete'
  | 'notice.message.recall'
  | 'notice.message.update'
  | 'notice.message.batch-update'
  | 'notice.message.delete'
  | 'notice.message.reaction'
  | 'notice.conversation.read-summary'
  | 'notice.message'
  | 'notice.im.command';

type PassiveRequestEventName =
  | 'request'
  | 'request.group'
  | 'request.group.join';

type PassiveAccountEventName =
  | PassiveMessageEventName
  | PassiveNoticeEventName
  | PassiveRequestEventName;

export type ClientEventMap = {
  [K in Exclude<keyof AccountEventMap, PassiveAccountEventName>]: WithAccount<AccountEventMap[K]>;
} & Pick<AccountEventMap, PassiveAccountEventName> & {
  'account.added': ClientAccountEvent;
  'account.removed': ClientAccountEvent;
};

const PASSIVE_MESSAGE_EVENTS = new Set<string>([
  'message',
  'message.private',
  'message.stranger',
  'message.group',
  'request',
  'request.group',
  'request.group.join',
  'notice',
  'notice.conversation',
  'notice.conversation.marked-read',
  'notice.friend',
  'notice.friend.marked-read',
  'notice.friend.add-request',
  'notice.friend.increase',
  'notice.friend.decrease',
  'notice.group',
  'notice.group.member-change',
  'notice.group.member-increase',
  'notice.group.invite',
  'notice.group.member-decrease',
  'notice.group.admin',
  'notice.group.name-change',
  'notice.group.avatar-change',
  'notice.group.metadata-change',
  'notice.group.marked-read',
  'notice.conversation.update',
  'notice.conversation.delete',
  'notice.message.recall',
  'notice.message.update',
  'notice.message.batch-update',
  'notice.message.delete',
  'notice.message.reaction',
  'notice.conversation.read-summary',
  'notice.message',
  'notice.im.command',
]);

const ACCOUNT_EVENTS = [
  'system.login.session',
  'system.login.qrcode',
  'system.login.qrcode.status',
  'system.login.sms',
  'system.login.voice',
  'system.login.accounts',
  'system.login.sms-required',
  'system.login.verification',
  'system.action.verification',
  'system.login.error',
  'system.handler.error',
  'system.online',
  'system.reconnecting',
  'system.offline',
  'message.private',
  'message.stranger',
  'message.group',
  'message',
  'message.raw',
  'request',
  'request.group',
  'request.group.join',
  'notice',
  'notice.conversation',
  'notice.conversation.marked-read',
  'notice.friend',
  'notice.friend.marked-read',
  'notice.friend.add-request',
  'notice.friend.increase',
  'notice.friend.decrease',
  'notice.group',
  'notice.group.member-change',
  'notice.group.member-increase',
  'notice.group.invite',
  'notice.group.member-decrease',
  'notice.group.admin',
  'notice.group.name-change',
  'notice.group.avatar-change',
  'notice.group.metadata-change',
  'notice.group.marked-read',
  'notice.conversation.update',
  'notice.conversation.delete',
  'notice.message.recall',
  'notice.message.update',
  'notice.message.batch-update',
  'notice.message.delete',
  'notice.message.reaction',
  'notice.conversation.read-summary',
  'notice.message',
  'notice.im.command',
] as const satisfies readonly (keyof AccountEventMap)[];

/**
 * 多账号入口。
 *
 * Client 管理账号集合和统一生命周期；每个 Account 独占底层
 * ApiConnection、Cookie、设备身份和消息连接。
 */
export class Client extends BaseClient<Account, AccountOptions> {
  private readonly store: AccountStore;

  private readonly defaults: ClientAccountDefaults;
  private readonly accountForwarders = new Map<
    Account,
    ReadonlyArray<readonly [keyof AccountEventMap, (data: unknown) => void]>
  >();

  constructor(options: ClientOptions = {}) {
    super();
    this.store = new AccountStore(options.dataDir ? { dataDir: options.dataDir } : {});
    this.defaults = {
      ...(options.skipVerify !== undefined ? { skipVerify: options.skipVerify } : {}),
      ...(options.localState !== undefined ? { localState: options.localState } : {}),
    };
    if (options.autoLoad ?? true) this.loadAccounts();
  }

  override on<K extends keyof ClientEventMap>(
    event: K,
    listener: (payload: ClientEventMap[K]) => void | Promise<void>,
  ): this;
  override on(event: string, listener: (...args: unknown[]) => void): this;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof ClientEventMap>(event: K, payload: ClientEventMap[K]): boolean;
  override emit(event: string, ...args: unknown[]): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  protected override instantiateAccount(
    options: AccountOptions,
  ): Account {
    return Account.create(this.createTransport(options), this.store, options);
  }

  protected override listStoredAccountIds(): readonly string[] {
    return this.store.listUids();
  }

  protected override resolveStoredAccountId(accountId: string): string | undefined {
    return this.store.resolvePlatformUid(accountId);
  }

  protected override accountRegistrationKey(options: AccountOptions): string | undefined {
    return options.accountId ?? (options.login && 'mobile' in options.login
      ? options.login.mobile
      : undefined);
  }

  protected override normalizeAccountOptions(
    options: AccountOptions,
    context: AccountContext,
  ): AccountOptions {
    return {
      ...this.defaults,
      ...options,
      ...(context.resolvedAccountId ? { accountId: context.resolvedAccountId } : {}),
    };
  }

  protected override onAccountAdded(account: Account): void {
    this.forwardEvents(account);
    super.emit('account.added', { account });
  }

  protected override onAccountRemoved(account: Account): void {
    for (const [event, listener] of this.accountForwarders.get(account) ?? []) {
      account.off(event, listener);
    }
    this.accountForwarders.delete(account);
    super.emit('account.removed', { account });
  }

  private createTransport(options: AccountOptions): ApiConnection {
    const savedUid = this.store.resolvePlatformUid(options.accountId);
    const saved = savedUid ? this.store.load(savedUid) : undefined;
    if (saved) {
      if (saved.deviceProfile.userAgent !== DESKTOP_LOGIN_USER_AGENT) {
        saved.deviceProfile.userAgent = DESKTOP_LOGIN_USER_AGENT;
        this.store.save(saved);
      }
      return new ApiConnection(this.store.toClientConfig(saved));
    }
    return new ApiConnection();
  }

  private forwardEvents(account: Account): void {
    const forwarders: Array<readonly [keyof AccountEventMap, (data: unknown) => void]> = [];
    for (const event of ACCOUNT_EVENTS) {
      const listener = (data: unknown): void => {
        if (event === 'system.online') {
          const online = data as AccountEventMap['system.online'];
          this.rememberAccountAlias(account, online.platformUid);
          this.promoteAccountIdentity(account);
        }
        if (PASSIVE_MESSAGE_EVENTS.has(event)) {
          super.emit(event, data as MessageEvent);
        } else {
          this.emitAccountEvent(
            event as Exclude<keyof AccountEventMap, PassiveAccountEventName>,
            account,
            data,
          );
        }
      };
      forwarders.push([event, listener]);
      account.on(event, listener);
    }
    this.accountForwarders.set(account, forwarders);
  }

  override [captureRejectionSymbol](error: unknown, event: string | symbol, payload?: unknown): void {
    const normalized = toError(error);
    if (event === 'system.handler.error') {
      logger.error(normalized, 'system.handler.error listener failed');
      return;
    }
    const account = payload instanceof Account
      ? payload
      : typeof payload === 'object' && payload !== null && 'account' in payload &&
          payload.account instanceof Account
        ? payload.account
        : undefined;
    if (!account) {
      logger.error(normalized, 'handler failed for %s', String(event));
      return;
    }
    super.emit('system.handler.error', { account, event, error: normalized });
  }

  private emitAccountEvent(
    event: Exclude<keyof AccountEventMap, PassiveAccountEventName>,
    account: Account,
    data: unknown,
  ): void {
    if (event === 'system.offline') {
      super.emit(event, { account });
      return;
    }
    if (event === 'system.login.error') {
      super.emit(event, { account, error: data as Error });
      return;
    }
    super.emit(event, { ...(data as object), account });
  }

}

/** oicq 风格入口；多账号仍由同一个 Client 统一管理。 */
export function createClient(options: ClientOptions = {}): Client {
  return new Client(options);
}
