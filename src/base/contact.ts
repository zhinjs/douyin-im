import type { BaseAccount } from './account.js';

/** 协议层定位一条会话所需的稳定地址。 */
export interface ConversationAddress {
  readonly threadId: string;
  readonly conversationShortId: string;
  readonly conversationType: 1 | 2;
  readonly inboxType: number;
}

/** 账号绑定的协议联系人基类，只保存身份和会话地址。 */
export abstract class Contact<A extends BaseAccount = BaseAccount> {
  readonly account: A;
  readonly id: string;
  private _address: Readonly<ConversationAddress>;

  protected constructor(account: A, id: string, address: ConversationAddress) {
    this.account = account;
    this.id = id;
    this._address = Object.freeze({ ...address });
  }

  get address(): Readonly<ConversationAddress> { return this._address; }

  get threadId(): string {
    return this.address.threadId;
  }

  get conversationShortId(): string {
    return this.address.conversationShortId;
  }

  get conversationType(): 1 | 2 {
    return this.address.conversationType;
  }

  get inboxType(): number {
    return this.address.inboxType;
  }

  /** 允许上层在调用前补全短会话 ID，同时保持公开 address 不可变。 */
  protected resolveAddress(): Readonly<ConversationAddress> {
    return this.address;
  }

  /** 仅供上层在平台首次创建/补全会话后替换协议地址。 */
  protected updateAddress(address: ConversationAddress): void {
    this._address = Object.freeze({ ...address });
  }
}
