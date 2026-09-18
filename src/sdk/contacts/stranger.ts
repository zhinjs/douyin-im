import type { Account } from '../account.js';
import { ChatContact } from './chat-contact.js';
import type { UserFollowerStatus, UserFollowStatus } from '../../services/im/types.js';

export interface StrangerMetadata {
  inboxType?: number;
  nickname?: string;
  avatar?: string;
  secUid?: string;
  blocked?: boolean;
  remark?: string;
}

/** 陌生人箱中的私聊会话。它可回复，但不会进入好友缓存 fl。 */
export class Stranger extends ChatContact {
  readonly uid: string;
  private _nickname?: string;
  private _avatar?: string;
  private _secUid?: string;
  private _blocked?: boolean;
  private _remark?: string;
  protected override get logTarget(): string {
    return `[Stranger: ${this.remark || this.nickname || '未知用户'}(${this.uid})]`;
  }

  private constructor(
    uid: string,
    threadId: string,
    conversationShortId: string,
    account: Account,
    metadata: StrangerMetadata,
  ) {
    super(uid, { threadId, conversationShortId, conversationType: 1, inboxType: metadata.inboxType ?? 1 }, account);
    this.uid = uid;
    this.updateMetadata(metadata);
  }

  /** @internal Stranger 只能由当前账号的陌生人列表绑定。 */
  static override bind(
    uid: string,
    threadId: string,
    conversationShortId: string,
    account: Account,
    metadata: StrangerMetadata = {},
  ): Stranger {
    return new Stranger(uid, threadId, conversationShortId, account, metadata);
  }

  get nickname(): string | undefined { return this._nickname; }
  get avatar(): string | undefined { return this._avatar; }
  get secUid(): string | undefined { return this._secUid; }
  get blocked(): boolean | undefined { return this.account.getUserRelation(this.uid)?.blocked ?? this._blocked; }
  get remark(): string | undefined { return this.account.getUserRelation(this.uid)?.remark ?? this._remark; }
  get followStatus(): UserFollowStatus | undefined { return this.account.getUserRelation(this.uid)?.followStatus; }
  /** 对方是否关注当前账号；未读取资料时为 undefined。 */
  get followerStatus(): UserFollowerStatus | undefined { return this.account.getUserRelation(this.uid)?.followerStatus; }

  /** 联网读取用户资料，不把陌生人自动移为好友。 */
  async getProfile() {
    const profile = await this.account.readUserProfile(this.uid, this.secUid);
    this.updateMetadata({ nickname: profile.nickname, ...(profile.avatarThumb ? { avatar: profile.avatarThumb } : {}) });
    return profile;
  }

  /** 关注 / 取消关注不等于将陌生人会话移入好友列表。 */
  async setFollowed(followed = true) {
    if (!this.secUid) throw new Error('陌生人缺少 secUid，先刷新陌生人资料');
    const options = { uid: this.uid, secUid: this.secUid, followed };
    return this.account.runVerifiedAction({ operation: followed ? 'follow' : 'unfollow', uid: this.uid },
      () => this.account.im.setUserFollowed(options), result => {
        if (result.statusCode === 0 && result.followStatus !== undefined) {
          this.account.updateUserRelation(this.uid, { followStatus: result.followStatus,
            ...([1, 2].includes(result.followStatus) ? { blocked: false } : {}) });
        }
      });
  }

  /** @internal 列表刷新时更新资料并保留 Stranger 实例身份。 */
  updateMetadata(metadata: StrangerMetadata): void {
    if (metadata.inboxType !== undefined) this.updateAddress({ ...this.address, inboxType: metadata.inboxType });
    if (metadata.nickname !== undefined) this._nickname = metadata.nickname;
    if (metadata.avatar !== undefined) this._avatar = metadata.avatar;
    if (metadata.secUid !== undefined) this._secUid = metadata.secUid;
    if (metadata.blocked !== undefined) this._blocked = metadata.blocked;
    if (metadata.remark !== undefined) this._remark = metadata.remark;
  }

  /** Native stranger inbox 不分页返回该会话消息；可同时清空陌生人未读数。 */
  getInboxMessages(resetUnreadCount = false) {
    return this.account.im.getStrangerMessages(
      this.resolveAddress().conversationShortId,
      resetUnreadCount,
    );
  }

  override markRead() {
    return this.account.im.markStrangerConversationRead(
      this.resolveAddress().conversationShortId,
    );
  }

  /** 拉黑或取消拉黑；返回操作响应，关系资料随后异步刷新，不删除陌生人会话。 */
  async setBlocked(blocked = true) {
    if (!this.secUid) throw new Error('陌生人缺少 secUid，先刷新陌生人资料');
    const im = this.account.im;
    const result = await im.setUserBlocked({
      uid: this.uid,
      secUid: this.secUid,
      blocked,
    });
    // Like Desktop, refresh confirmed profile state after any resolved block
    // response; do not wait, infer a follow change, or replay on refresh failure.
    if (this.account.online && this.account.im === im) {
      void this.getProfile().catch(() => undefined);
    }
    return result;
  }

  /** 修改用户备注；平台允许在尚未成为好友时从资料页设置。 */
  async setRemark(remark: string) {
    if (!this.secUid) throw new Error('陌生人缺少 secUid，先刷新陌生人资料');
    const im = this.account.im;
    const result = await im.setUserRemark({ uid: this.uid, secUid: this.secUid, remark });
    if (this.account.online && this.account.im === im && result.statusCode === 0 && result.remark !== undefined) {
      this.account.updateUserRelation(this.uid, { remark: result.remark });
    }
    return result;
  }

}
