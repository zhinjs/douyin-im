import type { Account } from '../account.js';
import { ChatContact } from './chat-contact.js';
import { Member, MemberRole } from './member.js';
import { Friend } from './friend.js';
import { GroupJoinRequest } from './group-join-request.js';
import type {
  GroupJoinRequestActionResponse,
  GroupJoinRequestData,
  GroupMemberListResponse,
  GroupMemberData,
  ImActionResponse,
  ParticipantActionResponse,
  SendMessageResponse,
} from '../../services/im/types.js';
import { GroupJoinRequestStatus } from '../../services/im/types.js';
import { ImProtoTransportError } from '../../services/im/transport.js';

export interface GroupMetadata {
  name?: string;
  description?: string;
  notice?: string;
  avatar?: string;
  ownerUid?: string;
  memberCount?: number;
  muted?: boolean;
  pinned?: boolean;
  favorite?: boolean;
  isParticipant?: boolean;
  inboxType?: number;
  members?: GroupMemberData[];
}

/** 群号就是 jumpbyte 协议中的纯数字 conversationId。 */
export class Group extends ChatContact {
  readonly groupId: string;
  private _name?: string;
  private _description?: string;
  private _notice?: string;
  private _avatar?: string;
  private _ownerUid?: string;
  private _memberCount?: number;
  private _muted?: boolean;
  private _pinned?: boolean;
  private _favorite?: boolean;
  private _isParticipant?: boolean;
  private readonly members: Map<string, Member>;
  private readonly joinRequests = new Map<string, GroupJoinRequest>();
  protected override get logTarget(): string {
    return `[Group: ${this.name || '未知群'}(${this.groupId})]`;
  }

  private constructor(groupId: string, shortId: string, account: Account, metadata: GroupMetadata) {
    super(
      groupId,
      {
        threadId: groupId,
        conversationShortId: shortId || groupId,
        conversationType: 2,
        inboxType: metadata.inboxType ?? 0,
      },
      account,
    );
    this.groupId = groupId;
    if (metadata.name) this._name = metadata.name;
    if (metadata.description) this._description = metadata.description;
    if (metadata.notice) this._notice = metadata.notice;
    if (metadata.avatar) this._avatar = metadata.avatar;
    if (metadata.ownerUid) this._ownerUid = metadata.ownerUid;
    if (metadata.memberCount !== undefined) this._memberCount = metadata.memberCount;
    if (metadata.muted !== undefined) this._muted = metadata.muted;
    if (metadata.pinned !== undefined) this._pinned = metadata.pinned;
    if (metadata.favorite !== undefined) this._favorite = metadata.favorite;
    if (metadata.isParticipant !== undefined) this._isParticipant = metadata.isParticipant;
    this.members = new Map(
      (metadata.members ?? []).map((member) => [member.uid, Member.bind(member, this)]),
    );
  }

  static override bind(groupId: string, shortId: string, account: Account, metadata: GroupMetadata = {}): Group {
    return new Group(groupId, shortId, account, metadata);
  }

  get name(): string | undefined {
    return this._name;
  }

  get description(): string | undefined {
    return this._description;
  }

  get notice(): string | undefined {
    return this._notice;
  }

  get avatar(): string | undefined {
    return this._avatar;
  }

  get ownerUid(): string | undefined {
    return this._ownerUid;
  }

  get memberCount(): number | undefined {
    return this._memberCount;
  }

  get muted(): boolean | undefined {
    return this._muted;
  }

  get pinned(): boolean | undefined {
    return this._pinned;
  }

  get favorite(): boolean | undefined {
    return this._favorite;
  }

  get isParticipant(): boolean | undefined {
    return this._isParticipant;
  }

  get memberList(): ReadonlyMap<string, Member> {
    return this.members;
  }

  /** @internal 将列表/推送中的较完整群资料合并进稳定实例。 */
  updateMetadata(metadata: GroupMetadata): void {
    if (metadata.name !== undefined) this._name = metadata.name;
    if (metadata.description !== undefined) this._description = metadata.description;
    if (metadata.notice !== undefined) this._notice = metadata.notice;
    if (metadata.avatar !== undefined) this._avatar = metadata.avatar;
    if (metadata.ownerUid !== undefined) this._ownerUid = metadata.ownerUid;
    if (metadata.memberCount !== undefined) this._memberCount = metadata.memberCount;
    if (metadata.muted !== undefined) this._muted = metadata.muted;
    if (metadata.pinned !== undefined) this._pinned = metadata.pinned;
    if (metadata.favorite !== undefined) this._favorite = metadata.favorite;
    if (metadata.isParticipant !== undefined) this._isParticipant = metadata.isParticipant;
    if (metadata.inboxType !== undefined && metadata.inboxType !== this.inboxType) {
      this.updateAddress({ ...this.address, inboxType: metadata.inboxType });
    }
    for (const member of metadata.members ?? []) this.ensureMember(member);
  }

  pickMember(uid: string): Member | undefined {
    return this.members.get(uid);
  }

  /** @internal 入站事件补入列表尚未包含的新成员。 */
  ensureMember(member: GroupMemberData, persist = true): Member {
    const existing = this.members.get(member.uid);
    if (existing) {
      existing.update(member);
      if (persist) this.account.upsertCachedGroupMembers(this.groupId, [member]);
      return existing;
    }
    const created = Member.bind(member, this);
    this.members.set(member.uid, created);
    if (persist) this.account.upsertCachedGroupMembers(this.groupId, [member]);
    return created;
  }

  /** @internal 离群通知先返回稳定 Member 实例，再从当前成员缓存中移除。 */
  detachMember(member: Omit<GroupMemberData, 'role'> & { role?: number }): Member {
    const detached = this.ensureMember({
      ...member,
      role: member.role ?? this.members.get(member.uid)?.role ?? MemberRole.MEMBER,
    }, false);
    this.members.delete(member.uid);
    this.account.removeCachedGroupMembers(this.groupId, [member.uid]);
    return detached;
  }

  /** @internal Update stable instances after Account commits native UID-only removal. */
  removeCachedMemberIds(uids: readonly string[]): void {
    for (const uid of uids) this.members.delete(uid);
  }

  /** 优先读取本地完整快照；force=true 时从 cmd605 强制刷新。 */
  async getMemberList(force = false): Promise<ReadonlyMap<string, Member>> {
    const cached = force ? undefined : this.account.cachedGroupMembers(this.groupId);
    if (cached) return this.replaceMemberInstances(cached);
    const result = await this.hydrateGroupMembers(
      await this.account.im.listConversationParticipants(this.resolveAddress()),
    );
    if (result.statusCode !== 0) {
      throw new Error(`查询群成员失败: status=${result.statusCode} ${result.statusMsg}`.trim());
    }
    this.account.replaceCachedGroupMembers(this.groupId, result.members);
    return this.replaceMemberInstances(result.members);
  }

  /** 主动邀请用户入群；这不是审核入群申请。 */
  async inviteMembers(uids: string[]): Promise<ParticipantActionResponse> {
    const connection = this.account.im;
    this.assertCurrentConnection(connection);
    const result = await connection.inviteConversationParticipants({
      ...this.resolveAddress(),
      uids,
    });
    this.assertCurrentConnection(connection);
    return result;
  }

  /** 显式向同账号好友发送群邀请卡；不直接加人，不审核申请，不批量自动降级。 */
  async sendInvite(friend: Friend): Promise<SendMessageResponse> {
    if (!(friend instanceof Friend) || friend.account !== this.account) throw new Error('群邀请卡只能发给当前账号的 Friend');
    const connection = this.account.im;
    this.assertCurrentConnection(connection);
    const conversation = this.account.cachedConversation(this.threadId);
    if (!conversation || conversation.conversationType !== 2) throw new Error('群邀请卡缺少本地群会话资料');
    const profile = this.account.profile ?? await this.account.getProfile();
    this.assertCurrentConnection(connection);
    const owner = conversation.ownerUid ? this.account.cachedFriend(conversation.ownerUid) : undefined;
    return friend.sendMsg({ type: 'group-invite', group: {
      groupId: conversation.conversationId,
      shortId: conversation.conversationShortId,
      inviterUid: profile.uid,
      inviterSecUid: profile.secUid,
      avatarUrl: conversation.coreExt?.['a:ab_avatar'] ?? '',
      ...(conversation.participantsCount !== undefined ? { memberCount: conversation.participantsCount } : {}),
      name: conversation.name,
      ownerName: owner ? owner.remark || owner.nickname || '' : null,
      ...(conversation.ownerUid !== undefined ? { ownerUid: conversation.ownerUid } : {}),
      ...(conversation.ownerSecUid !== undefined ? { ownerSecUid: conversation.ownerSecUid } : {}),
    } });
  }

  get joinRequestList(): ReadonlyMap<string, GroupJoinRequest> {
    return this.joinRequests;
  }

  pickJoinRequest(requestId: string): GroupJoinRequest | undefined {
    return this.joinRequests.get(requestId);
  }

  /** 拉取本群入群申请；申请对象使用 applyId 缓存并保持实例稳定。 */
  async getJoinRequests(): Promise<ReadonlyMap<string, GroupJoinRequest>> {
    const result = await this.account.getGroupJoinRequestData(this.resolveAddress());
    if (result.statusCode !== 0) {
      throw new Error(`查询入群申请失败: status=${result.statusCode} ${result.statusMsg}`.trim());
    }
    const next = new Map<string, GroupJoinRequest>();
    for (const data of result.requests) {
      if (data.groupShortId !== this.conversationShortId) continue;
      const request = this.ensureJoinRequest(data);
      next.set(request.requestId, request);
    }
    for (const requestId of this.joinRequests.keys()) {
      if (!next.has(requestId)) this.joinRequests.delete(requestId);
    }
    return this.joinRequests;
  }

  /** @internal 供绑定到当前账号和群的 GroupJoinRequest 调用。 */
  async reviewJoinRequest(
    request: GroupJoinRequest,
    status: GroupJoinRequestStatus.APPROVED | GroupJoinRequestStatus.REJECTED,
  ): Promise<GroupJoinRequestActionResponse> {
    if (request.group !== this || this.joinRequests.get(request.requestId) !== request) {
      throw new Error('入群申请不属于当前群');
    }
    const result = await this.account.im.reviewGroupJoinRequest({
      requestId: request.requestId,
      status,
    });
    if (result.statusCode === 0) {
      request.update(result.request ?? {
        requestId: request.requestId,
        applicantUid: request.applicantUid,
        groupShortId: this.conversationShortId,
        conversationType: 2,
        status,
      });
      // Approval is not proof of membership. Update members only from the member
      // list or an actual member-increase notice, like the direct invite path.
    }
    return result;
  }

  /** 请求级响应不证明成员已移除；成员缓存由通知或列表更新。 */
  async removeMembers(uids: string[]): Promise<ImActionResponse> {
    const connection = this.account.im;
    this.assertCurrentConnection(connection);
    const conversation = this.account.cachedConversation(this.threadId);
    if (!conversation) throw new Error(`本地会话不存在: ${this.threadId}`);
    if (conversation.conversationType !== 2) throw new Error(`移除成员要求群会话: ${this.threadId}`);
    const result = await connection.removeConversationParticipants({
      threadId: conversation.conversationId,
      conversationShortId: conversation.conversationShortId,
      conversationType: 2,
      inboxType: conversation.inboxType ?? 0,
      uids,
    });
    this.assertCurrentConnection(connection);
    return result;
  }

  /** @internal 协议申请推送与主动列表查询共用同一实例缓存。 */
  ensureJoinRequest(data: GroupJoinRequestData): GroupJoinRequest {
    const existing = this.joinRequests.get(data.requestId);
    if (existing) {
      existing.update(data);
      return existing;
    }
    const created = GroupJoinRequest.bind(data, this);
    this.joinRequests.set(data.requestId, created);
    return created;
  }

  async leave(): Promise<ImActionResponse> {
    const connection = this.account.im;
    this.assertCurrentConnection(connection);
    const conversation = this.account.cachedConversation(this.threadId);
    if (!conversation) throw new Error(`本地会话不存在: ${this.threadId}`);
    if (conversation.conversationType !== 2) throw new Error(`退群要求群会话: ${this.threadId}`);
    // Native captures indexV1 before either request, including retained soft-deleted message rows.
    const lastMessageIndex = this.account.getConversationDeletionBoundary(this.threadId);
    const address = { threadId: conversation.conversationId, conversationShortId: conversation.conversationShortId,
      conversationType: 2 as const, inboxType: conversation.inboxType ?? 0 };
    const result = await connection.leaveConversation(address);
    this.assertCurrentConnection(connection);
    if (result.statusCode !== 0) return result;
    try {
      const cleanup = await connection.deleteConversation({ ...address, lastMessageIndex });
      this.assertCurrentConnection(connection);
      if (cleanup.statusCode !== 0) {
        this.account.logger.warn('已退群，但远端会话清理失败: group=%s status=%s；不自动重试', this.groupId, cleanup.statusCode);
      }
    } catch (error) {
      this.assertCurrentConnection(connection);
      if (!(error instanceof ImProtoTransportError)) throw error;
      // Leave is confirmed. A rejected/lost cleanup response does not undo it or trigger another leave.
      this.account.logger.warn('已退群，但远端会话清理未确认: group=%s；不自动重试', this.groupId);
    }
    this.account.applyConversationLeave(this.threadId, lastMessageIndex);
    return result;
  }

  /** cmd605/cmd654 只给 secUid 时，以账号资料查询补齐昵称和头像。 */
  private async hydrateGroupMembers(response: GroupMemberListResponse): Promise<GroupMemberListResponse> {
    if (response.statusCode !== 0) return response;
    const profiles = await this.account.im.resolveUsers(
      response.members.flatMap((member) => member.secUid ? [member.secUid] : []),
    ).catch(() => []);
    const bySecUid = new Map(profiles.map((profile) => [profile.secUid, profile]));
    return {
      ...response,
      members: response.members.map((member) => {
        const profile = member.secUid ? bySecUid.get(member.secUid) : undefined;
        return profile ? {
          ...member,
          nickname: profile.nickname,
          ...(profile.avatarThumb ? { avatar: profile.avatarThumb } : {}),
        } : member;
      }),
    };
  }

  private replaceMemberInstances(members: readonly GroupMemberData[]): ReadonlyMap<string, Member> {
    const next = new Map<string, Member>();
    for (const data of members) {
      const member = this.ensureMember(data, false);
      next.set(member.uid, member);
    }
    for (const uid of this.members.keys()) {
      if (!next.has(uid)) this.members.delete(uid);
    }
    return this.members;
  }
}
