import { BaseEvent } from '../../base/event.js';
import type { ImActionResponse } from '../../services/im/types.js';
import type { Account } from '../account.js';
import type { Group } from '../contacts/group.js';
import type { GroupJoinRequest } from '../contacts/group-join-request.js';

/** A server-side decision that is still waiting for this account. */
export abstract class RequestEvent<
  Response extends ImActionResponse = ImActionResponse,
> extends BaseEvent<Account> {
  override readonly postType = 'request' as const;
  abstract override readonly type: string;
  abstract readonly isPending: boolean;
  private decision?: { approve: boolean; task: Promise<Response> };

  protected constructor(
    account: Account,
    raw: Readonly<Record<string, unknown>> = {},
    time?: number | string,
  ) {
    super(account, raw, time);
  }

  approve(): Promise<Response> {
    return this.decide(true);
  }

  reject(): Promise<Response> {
    return this.decide(false);
  }

  /** 子类只实现协议动作与成功后的业务状态更新。 */
  protected abstract executeDecision(approve: boolean): Promise<Response>;

  private decide(approve: boolean): Promise<Response> {
    if (this.decision) {
      return this.decision.approve === approve
        ? this.decision.task
        : Promise.reject(new Error('申请正在处理，不能同时执行相反的决策'));
    }
    if (!this.isPending) return Promise.reject(new Error('申请已处理'));
    // 先登记任务，再执行子类，防止同步调用与多个事件 handler 重复提交。
    const task = Promise.resolve().then(() => {
      if (!this.isPending) throw new Error('申请已处理');
      return this.executeDecision(approve);
    });
    this.decision = { approve, task };
    const clear = () => { delete this.decision; };
    void task.then(clear, clear);
    return task;
  }
}

export abstract class GroupRequestEvent<
  Response extends ImActionResponse = ImActionResponse,
> extends RequestEvent<Response> {
  abstract readonly group: Group;
}

export abstract class GroupJoinRequestEvent<
  Response extends ImActionResponse = ImActionResponse,
> extends GroupRequestEvent<Response> {
  override readonly type = 'group.join' as const;
  abstract readonly requestId: string;
  abstract readonly applicantUid: string;
}

export type AnyRequestEvent = GroupJoinRequest;
