import type {
  SharedCommentStatus,
  SharedWorkAccess,
  SharedWorkDetail,
} from '../../services/im/shared-content.js';
import { resolveSharedWorkAccess } from '../../services/im/shared-content.js';
import type { Account } from '../account.js';

interface SharedWorkMetadata {
  readonly title?: string;
  readonly authorUid?: string;
  readonly authorSecUid?: string;
}

/** 绑定到当前账号和来源会话的作品卡片实例。 */
export class SharedWork {
  readonly account: Account;
  readonly id: string;
  readonly title: string;
  readonly authorUid: string;
  readonly authorSecUid: string;
  private detail?: SharedWorkDetail;

  private constructor(
    id: string,
    metadata: SharedWorkMetadata,
    private readonly fetchDetails: (workIds: readonly string[]) => Promise<SharedWorkDetail[]>,
    account: Account,
  ) {
    this.id = id;
    this.title = metadata.title ?? '';
    this.authorUid = metadata.authorUid ?? '';
    this.authorSecUid = metadata.authorSecUid ?? '';
    this.account = account;
  }

  /** @internal 由 MessageEvent 创建。 */
  static bind(
    id: string,
    metadata: SharedWorkMetadata,
    fetchDetails: (workIds: readonly string[]) => Promise<SharedWorkDetail[]>,
    account: Account,
  ): SharedWork {
    return new SharedWork(id, metadata, fetchDetails, account);
  }

  /** 获取聊天语境下的作品详情；默认复用本实例最近一次成功结果。 */
  async getDetail(refresh = false): Promise<SharedWorkDetail> {
    if (!this.id) throw new Error('SharedWork: no work id');
    if (!refresh && this.detail) return this.detail;
    const details = await this.fetchDetails([this.id]);
    const detail = details.find((item) => item.workId === this.id);
    if (!detail) throw new Error(`SharedWork: work ${this.id} was omitted by the server`);
    this.detail = detail;
    return detail;
  }

  /** 获取桌面端用于分享/下载判断的权限与媒体地址。 */
  async getAccess(refresh = false): Promise<SharedWorkAccess> {
    return resolveSharedWorkAccess(await this.getDetail(refresh));
  }
}

interface SharedCommentMetadata {
  readonly text?: string;
  readonly authorName?: string;
  readonly coverUrl?: string;
}

/** 绑定到当前账号和来源会话的评论分享卡片实例。 */
export class SharedComment {
  readonly account: Account;
  readonly id: string;
  readonly text: string;
  readonly authorName: string;
  readonly coverUrl: string;
  private status?: SharedCommentStatus;

  private constructor(
    id: string,
    metadata: SharedCommentMetadata,
    private readonly fetchStatuses: (
      commentIds: readonly string[],
    ) => Promise<SharedCommentStatus[]>,
    account: Account,
  ) {
    this.id = id;
    this.text = metadata.text ?? '';
    this.authorName = metadata.authorName ?? '';
    this.coverUrl = metadata.coverUrl ?? '';
    this.account = account;
  }

  /** @internal 由 MessageEvent 创建。 */
  static bind(
    id: string,
    metadata: SharedCommentMetadata,
    fetchStatuses: (commentIds: readonly string[]) => Promise<SharedCommentStatus[]>,
    account: Account,
  ): SharedComment {
    return new SharedComment(id, metadata, fetchStatuses, account);
  }

  /** 获取该评论卡片当前是否仍可展示。 */
  async getStatus(refresh = false): Promise<SharedCommentStatus> {
    if (!this.id) throw new Error('SharedComment: no comment id');
    if (!refresh && this.status) return this.status;
    const statuses = await this.fetchStatuses([this.id]);
    const status = statuses.find((item) => item.commentId === this.id);
    if (!status) throw new Error(`SharedComment: comment ${this.id} was omitted by the server`);
    this.status = status;
    return status;
  }
}
