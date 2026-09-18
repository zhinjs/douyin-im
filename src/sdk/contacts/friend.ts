import type { Account } from '../account.js';
import { ChatContact } from './chat-contact.js';
import type { UserFollowerStatus, UserFollowStatus } from '../../services/im/types.js';

/**
 * oicq Friend — 私聊好友，已绑定 thread，可直接 sendMsg。
 *
 * `message.private` 事件通过 `event.friend` 访问。
 */
export class Friend extends ChatContact {
  readonly uid: string;
  private _nickname?: string;
  private _avatar?: string;
  private _secUid?: string;
  private _blocked?: boolean;
  private _remark?: string;
  private _signature?: string;
  private _closeFriend?: boolean;
  private conversationTask?: Promise<void>;
  protected override get logTarget(): string {
    return `[Private: ${this.remark || this.nickname || '未知用户'}(${this.uid})]`;
  }

  private constructor(
    uid: string,
    threadId: string,
    conversationShortId: string,
    account: Account,
    metadata: FriendMetadata,
  ) {
    super(uid, { threadId, conversationShortId, conversationType: 1, inboxType: 0 }, account);
    this.uid = uid;
    this.updateMetadata(metadata);
  }

  /** @internal Friend 始终绑定所属账号，动作复用账号当前连接。 */
  static override bind(
    uid: string,
    threadId: string,
    conversationShortId: string,
    account: Account,
    metadata: FriendMetadata = {},
  ): Friend {
    return new Friend(uid, threadId, conversationShortId, account, metadata);
  }

  get nickname(): string | undefined { return this._nickname; }
  get avatar(): string | undefined { return this._avatar; }
  get secUid(): string | undefined { return this._secUid; }
  get blocked(): boolean | undefined { return this.account.getUserRelation(this.uid)?.blocked ?? this._blocked; }
  get remark(): string | undefined { return this.account.getUserRelation(this.uid)?.remark ?? this._remark; }
  get signature(): string | undefined { return this._signature; }
  get closeFriend(): boolean | undefined { return this._closeFriend; }
  get followStatus(): UserFollowStatus | undefined { return this.account.getUserRelation(this.uid)?.followStatus; }
  /** 对方是否关注当前账号；未读取资料时为 undefined。 */
  get followerStatus(): UserFollowerStatus | undefined { return this.account.getUserRelation(this.uid)?.followerStatus; }

  /** 联网读取资料和关注关系，不创建私聊会话。 */
  async getProfile() {
    const profile = await this.account.readUserProfile(this.uid, this.secUid);
    this.updateMetadata({ nickname: profile.nickname, ...(profile.avatarThumb ? { avatar: profile.avatarThumb } : {}) });
    return profile;
  }

  /** 关注 / 取消关注；返回 4 表示私密账号申请待批准。 */
  async setFollowed(followed = true) {
    if (!this.secUid) throw new Error('好友缺少 secUid，先刷新好友资料');
    const options = { uid: this.uid, secUid: this.secUid, followed };
    return this.account.runVerifiedAction({ operation: followed ? 'follow' : 'unfollow', uid: this.uid },
      () => this.account.im.setUserFollowed(options), result => {
        if (result.statusCode === 0 && result.followStatus !== undefined) {
          this.account.updateUserRelation(this.uid, { followStatus: result.followStatus,
            ...([1, 2].includes(result.followStatus) ? { blocked: false } : {}) });
        }
      });
  }

  /** @internal 列表刷新时更新资料并保留 Friend 实例身份。 */
  updateMetadata(metadata: FriendMetadata): void {
    if (metadata.nickname !== undefined) this._nickname = metadata.nickname;
    if (metadata.avatar !== undefined) this._avatar = metadata.avatar;
    if (metadata.secUid !== undefined) this._secUid = metadata.secUid;
    if (metadata.blocked !== undefined) this._blocked = metadata.blocked;
    if (metadata.remark !== undefined) this._remark = metadata.remark;
    if (metadata.signature !== undefined) this._signature = metadata.signature;
    if (metadata.closeFriend !== undefined) this._closeFriend = metadata.closeFriend;
  }

  /** 拉黑或取消拉黑；返回操作响应，关系资料随后异步刷新，不删除好友或会话。 */
  async setBlocked(blocked = true) {
    if (!this.secUid) throw new Error('好友缺少 secUid，先刷新好友资料');
    const im = this.account.im;
    const result = await im.setUserBlocked({
      uid: this.uid,
      secUid: this.secUid,
      blocked,
    });
    // Desktop does not infer is_block/followStatus from this response. Its
    // resolved block request starts an independent profile refresh (also on a
    // business error), whose failure never retries the mutation.
    if (this.account.online && this.account.im === im) {
      void this.getProfile().catch(() => undefined);
    }
    return result;
  }

  /** 修改或清空好友备注；Desktop UI 限制最多 20 个字符。 */
  async setRemark(remark: string) {
    if (!this.secUid) throw new Error('好友缺少 secUid，先刷新好友资料');
    const im = this.account.im;
    const result = await im.setUserRemark({ uid: this.uid, secUid: this.secUid, remark });
    if (this.account.online && this.account.im === im && result.statusCode === 0 && result.remark !== undefined) {
      this.account.updateUserRelation(this.uid, { remark: result.remark });
    }
    return result;
  }

  /** @internal Account 在 native createConversation 成功后补全会话地址。 */
  bindConversation(threadId: string, conversationShortId: string): void {
    this.updateAddress({ threadId, conversationShortId, conversationType: 1, inboxType: 0 });
  }

  protected override async prepareAddress() {
    if (!this.conversationShortId) {
      this.conversationTask ??= this.account.ensureFriendConversation(this);
      try {
        await this.conversationTask;
      } finally {
        delete this.conversationTask;
      }
    }
    return this.resolveAddress();
  }
}

export interface FriendMetadata {
  nickname?: string;
  avatar?: string;
  secUid?: string;
  blocked?: boolean;
  remark?: string;
  signature?: string;
  closeFriend?: boolean;
}
