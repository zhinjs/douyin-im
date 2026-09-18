import type { Group } from './group.js';
import type { GroupMemberData, UserFollowerStatus, UserFollowStatus } from '../../services/im/types.js';

export enum MemberRole {
  MEMBER = 0,
  OWNER = 1,
  ADMIN = 2,
  VISITOR = 3,
}

export class Member {
  readonly uid: string;
  readonly group: Group;
  private _secUid?: string;
  private _nickname?: string;
  private _avatar?: string;
  private _alias?: string;
  private _role: number;
  private _sortOrder?: string;
  private _blocked?: number;
  private _leftBlockTime?: string;
  private _ext: Readonly<Record<string, string>> = {};

  private constructor(data: GroupMemberData, group: Group) {
    this.uid = data.uid;
    this.group = group;
    this._role = data.role;
    this.update(data);
  }

  static bind(data: GroupMemberData, group: Group): Member {
    return new Member(data, group);
  }

  get secUid(): string | undefined {
    return this._secUid;
  }

  get followStatus(): UserFollowStatus | undefined { return this.group.account.getUserRelation(this.uid)?.followStatus; }
  /** 对方是否关注群所属账号；与群角色无关。 */
  get followerStatus(): UserFollowerStatus | undefined { return this.group.account.getUserRelation(this.uid)?.followerStatus; }

  /** 联网读取用户资料；不改群角色、群名片，也不创建私聊会话。 */
  async getProfile() {
    const profile = await this.group.account.readUserProfile(this.uid, this.secUid);
    this.update({ uid: this.uid, role: this.role, nickname: profile.nickname,
      ...(profile.avatarThumb ? { avatar: profile.avatarThumb } : {}) });
    return profile;
  }

  /** 使用群所属账号关注此成员，不创建额外私聊会话。 */
  async setFollowed(followed = true) {
    if (!this.secUid) throw new Error('群成员缺少 secUid，先刷新群成员资料');
    const options = { uid: this.uid, secUid: this.secUid, followed };
    return this.group.account.runVerifiedAction({ operation: followed ? 'follow' : 'unfollow', uid: this.uid },
      () => this.group.account.im.setUserFollowed(options), result => {
        if (result.statusCode === 0 && result.followStatus !== undefined) {
          this.group.account.updateUserRelation(this.uid, { followStatus: result.followStatus,
            ...([1, 2].includes(result.followStatus) ? { blocked: false } : {}) });
        }
      });
  }

  get nickname(): string | undefined {
    return this._nickname;
  }

  get avatar(): string | undefined {
    return this._avatar;
  }

  get alias(): string | undefined {
    return this._alias;
  }

  get role(): number {
    return this._role;
  }

  get sortOrder(): string | undefined {
    return this._sortOrder;
  }

  get blocked(): number | undefined {
    return this._blocked;
  }

  get leftBlockTime(): string | undefined {
    return this._leftBlockTime;
  }

  get ext(): Readonly<Record<string, string>> {
    return this._ext;
  }

  get displayName(): string {
    return this._alias || this._nickname || this.uid;
  }

  get isOwner(): boolean {
    return this._role === MemberRole.OWNER;
  }

  get isAdmin(): boolean {
    return this._role === MemberRole.ADMIN;
  }

  get roleName(): 'member' | 'owner' | 'admin' | 'visitor' | 'unknown' {
    switch (this._role) {
      case MemberRole.MEMBER: return 'member';
      case MemberRole.OWNER: return 'owner';
      case MemberRole.ADMIN: return 'admin';
      case MemberRole.VISITOR: return 'visitor';
      default: return 'unknown';
    }
  }

  async refresh(): Promise<this> {
    const members = await this.group.getMemberList(true);
    if (!members.has(this.uid)) throw new Error(`群成员不存在: ${this.uid}`);
    return this;
  }

  /** @internal 同一个 UID 始终复用实例，只刷新资料。 */
  update(data: GroupMemberData): void {
    this._role = data.role;
    if (data.secUid !== undefined) this._secUid = data.secUid;
    if (data.nickname !== undefined) this._nickname = data.nickname;
    if (data.avatar !== undefined) this._avatar = data.avatar;
    if (data.alias !== undefined) this._alias = data.alias;
    if (data.sortOrder !== undefined) this._sortOrder = data.sortOrder;
    if (data.blocked !== undefined) this._blocked = data.blocked;
    if (data.leftBlockTime !== undefined) this._leftBlockTime = data.leftBlockTime;
    if (data.ext !== undefined) this._ext = { ...data.ext };
  }
}
