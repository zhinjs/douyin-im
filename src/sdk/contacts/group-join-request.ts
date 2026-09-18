import type {
  GroupJoinRequestActionResponse,
  GroupJoinRequestData,
} from '../../services/im/types.js';
import { GroupJoinRequestStatus } from '../../services/im/types.js';
import { GroupJoinRequestEvent } from '../events/request.js';
import type { Group } from './group.js';

/** 群入群申请。申请人尚未入群，因此它不是 Member。 */
export class GroupJoinRequest extends GroupJoinRequestEvent<GroupJoinRequestActionResponse> {
  readonly requestId: string;
  readonly group: Group;
  private data: GroupJoinRequestData;

  private constructor(data: GroupJoinRequestData, group: Group) {
    super(
      group.account,
      data as unknown as Readonly<Record<string, unknown>>,
      data.createdAt,
    );
    this.requestId = data.requestId;
    this.group = group;
    this.data = { ...data };
  }

  static override bind(data: GroupJoinRequestData, group: Group): GroupJoinRequest {
    return new GroupJoinRequest(data, group);
  }

  get applicantUid(): string {
    return this.data.applicantUid;
  }

  get applicantSecUid(): string | undefined {
    return this.data.applicantSecUid;
  }

  get applicantNickname(): string | undefined {
    return this.data.applicantNickname;
  }

  get applicantAvatar(): string | undefined {
    return this.data.applicantAvatar;
  }

  get displayName(): string {
    return this.data.applicantNickname || this.data.applicantUid;
  }

  get status(): GroupJoinRequestStatus {
    return this.data.status;
  }

  get reason(): string | undefined {
    return this.data.reason;
  }

  get inviterUid(): string | undefined {
    return this.data.inviterUid;
  }

  get createdAt(): string | undefined {
    return this.data.createdAt;
  }

  get ext(): Readonly<Record<string, string>> {
    return this.data.ext ?? {};
  }

  get isPending(): boolean {
    return this.data.status === GroupJoinRequestStatus.PENDING;
  }

  /** @internal 同一 applyId 保持实例稳定。 */
  update(data: GroupJoinRequestData): void {
    if (data.requestId !== this.requestId) throw new Error('cannot change join request id');
    this.data = { ...this.data, ...data };
  }

  protected override executeDecision(approve: boolean): Promise<GroupJoinRequestActionResponse> {
    const status = approve ? GroupJoinRequestStatus.APPROVED : GroupJoinRequestStatus.REJECTED;
    return this.group.reviewJoinRequest(this, status);
  }
}
