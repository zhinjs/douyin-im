import protobuf from 'protobufjs';
import { desktopCookieProtoOptions } from './desktop.js';
import { mapProtoConversationListItem } from './mappers.js';
import { GroupJoinRequestStatus } from './types.js';
import { signedMessageIndex } from './conversation-delete.js';
import type { ImProtoTransport } from './transport.js';
import type {
  BatchMarkReadResponse,
  ConversationActionOptions,
  ConversationInfoListResponse,
  CreateGroupOptions,
  CreateConversationResponse,
  DeleteMessageOptions,
  DeleteConversationOptions,
  GroupParticipantActionOptions,
  GroupJoinRequestActionResponse,
  GroupJoinRequestData,
  GroupJoinRequestListOptions,
  GroupJoinRequestListResponse,
  GroupJoinRequestUnreadResponse,
  GroupMemberData,
  GroupMemberListResponse,
  ImActionResponse,
  MarkConversationReadOptions,
  ModifyMessageReactionOptions,
  ParticipantActionResponse,
  ParticipantIdentity,
  EnterConversationOptions,
  SetConversationSettingsOptions,
  ReviewGroupJoinRequestOptions,
} from './types.js';

const LONG = protobuf.util.Long as unknown as { fromString(value: string): unknown };

interface ActionBody {
  status?: number;
  extraInfo?: string;
  checkCode?: number | string;
  checkMessage?: string;
}

function actionResponse(
  decoded: Record<string, unknown>,
  bodyKey?: string,
): ImActionResponse {
  const envelopeStatus = Number(decoded['statusCode'] ?? 0);
  const payload = decoded['body'] as Record<string, unknown> | undefined;
  const body = (bodyKey ? payload?.[bodyKey] : undefined) as ActionBody | undefined;
  if (envelopeStatus === 0 && bodyKey && !body) {
    return {
      statusCode: -3,
      statusMsg: `IM response missing ${bodyKey}`,
    };
  }
  const actionStatus = Number(body?.status ?? 0);
  const checkMessage = String(body?.checkMessage ?? '');
  const checkDetail = parseCheckMessage(checkMessage);
  const checkCode = checkDetail.code ?? Number(body?.checkCode ?? 0);
  const statusCode = envelopeStatus || checkCode || actionStatus;
  const statusMsg = [
    checkDetail.message,
    checkDetail.parsed ? '' : checkMessage,
    body?.extraInfo,
    decoded['errorDesc'],
  ]
    .map((value) => String(value ?? ''))
    .find(Boolean) ?? '';
  return {
    statusCode,
    statusMsg,
    ...(checkCode ? { checkCode } : {}),
  };
}

function parseCheckMessage(value: string): { parsed: boolean; code?: number; message?: string } {
  if (!value.trim()) return { parsed: false };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const rawCode = parsed['status_code'] ?? parsed['statusCode'];
    const code = rawCode === undefined ? undefined : Number(rawCode);
    const message = [
      parsed['status_msg'],
      parsed['statusMsg'],
      parsed['tips'],
      parsed['toast'],
      parsed['message'],
    ].map((item) => String(item ?? '')).find(Boolean);
    return {
      parsed: true,
      ...(code !== undefined && Number.isFinite(code) ? { code } : {}),
      ...(message ? { message } : {}),
    };
  } catch {
    return { parsed: false };
  }
}

function pureInvitation(inviterUid: string): Record<string, string> {
  if (!/^\d+$/.test(inviterUid)) {
    throw new Error('inviteParticipants requires the current numeric IM uid');
  }
  return {
    invitation:
      `{"invitee":{"source_app_id":339757},"invitor":{"im_user_id":${inviterUid}},"source_type":6}`,
    ticket: '',
  };
}

function joinRequestData(value: Record<string, unknown> | undefined): GroupJoinRequestData | undefined {
  if (!value) return undefined;
  const requestId = String(value['applyId'] ?? '');
  const applicantUid = String(value['userId'] ?? '');
  const groupShortId = String(value['convShortId'] ?? '');
  if (!requestId || !applicantUid || !groupShortId) return undefined;
  const applicantSecUid = String(value['secUid'] ?? '');
  const reason = String(value['applyReason'] ?? '');
  const inviterUid = String(value['inviteUserId'] ?? '');
  const inviterSecUid = String(value['secInviteUid'] ?? '');
  const createdAt = String(value['createTime'] ?? '');
  const modifiedAt = String(value['modifyTime'] ?? '');
  const moderatorUid = String(value['modifyUser'] ?? '');
  const ext = value['ext'];
  return {
    requestId,
    applicantUid,
    groupShortId,
    conversationType: Number(value['conversationType'] ?? 2),
    status: Number(value['applyStatus'] ?? GroupJoinRequestStatus.PENDING) as GroupJoinRequestStatus,
    ...(applicantSecUid ? { applicantSecUid } : {}),
    ...(reason ? { reason } : {}),
    ...(inviterUid && inviterUid !== '0' ? { inviterUid } : {}),
    ...(inviterSecUid ? { inviterSecUid } : {}),
    ...(createdAt && createdAt !== '0' ? { createdAt } : {}),
    ...(modifiedAt && modifiedAt !== '0' ? { modifiedAt } : {}),
    ...(moderatorUid && moderatorUid !== '0' ? { moderatorUid } : {}),
    ...(ext && typeof ext === 'object' ? { ext: ext as Record<string, string> } : {}),
  };
}

function groupMemberData(value: Record<string, unknown> | undefined): GroupMemberData | undefined {
  if (!value) return undefined;
  const uid = String(value['userId'] ?? value['uid'] ?? '');
  if (!uid || uid === '0') return undefined;
  const secUid = String(value['secUid'] ?? '');
  const alias = String(value['alias'] ?? '');
  const sortOrder = String(value['sortOrder'] ?? '');
  const leftBlockTime = String(value['leftBlockTime'] ?? '');
  const ext = value['ext'];
  return {
    uid,
    role: Number(value['role'] ?? 0),
    ...(secUid ? { secUid } : {}),
    ...(alias ? { alias } : {}),
    ...(sortOrder ? { sortOrder } : {}),
    ...(value['blocked'] !== undefined ? { blocked: Number(value['blocked']) } : {}),
    ...(leftBlockTime ? { leftBlockTime } : {}),
    ...(ext && typeof ext === 'object' ? { ext: ext as Record<string, string> } : {}),
  };
}

/** Desktop Cookie 会话动作。底层 cmd、Long 编码和响应差异不泄漏到 SDK 对象。 */
export class ImConversationActions {
  constructor(
    private readonly transport: ImProtoTransport,
    private readonly deviceId: string,
    private readonly resolveSelfUid: () => string = () => '',
  ) {}

  async createConversation(
    participantUids: string[],
    conversationType: 1 | 2,
    options: CreateGroupOptions = {},
  ): Promise<CreateConversationResponse> {
    if (participantUids.length < 2) {
      throw new Error('createConversation requires at least two participants');
    }
    const participants = [...new Set(participantUids)];
    if (participants.some((uid) => !/^\d+$/.test(uid))) {
      throw new Error('conversation participant uid must be numeric');
    }
    const decoded = await this.transport.sendCookieProto(
      609,
      0,
      '/v2/conversation/create',
      {
        createConversationV2Body: {
          conversationType,
          participants: participants.map((uid) => LONG.fromString(uid)),
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.avatarUrl !== undefined ? { avatarUrl: options.avatarUrl } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          bizExt: {
            create: JSON.stringify({ source_app_id: 339757, source_type: 6 }),
            ...(conversationType === 2 ? { group_create_type: '0' } : {}),
          },
        },
      },
      this.cookieOptions(),
    );
    const result = actionResponse(decoded, 'createConversationV2Body');
    const payload = decoded['body'] as Record<string, unknown> | undefined;
    const body = payload?.['createConversationV2Body'] as {
      conversation?: Record<string, unknown>;
    } | undefined;
    return {
      ...result,
      ...(body?.conversation
        ? { conversation: mapProtoConversationListItem(body.conversation) }
        : {}),
    };
  }

  markRead(options: MarkConversationReadOptions): Promise<ImActionResponse> {
    const readBadgeCount = options.readBadgeCount ?? 1;
    if (!Number.isSafeInteger(readBadgeCount) || readBadgeCount < 0) {
      throw new Error('readBadgeCount must be a non-negative safe integer');
    }
    return this.send(
      2002,
      // Native rawMarkConversationRead uses outer cmd 2002 with body oneof tag 604,
      // and always dispatches through inbox 1 regardless of discovery inbox.
      1,
      '/v1/conversation/mark_read',
      'markConversationReadBody',
      {
        ...this.address(options),
        readMessageIndex: LONG.fromString(options.indexInConversation ?? '0'),
        readMessageIndexV2: LONG.fromString(options.indexInConversationV2 ?? '0'),
        readBadgeCount,
        serverMessageId: LONG.fromString(options.serverMessageId),
      },
    );
  }

  async markReadBatch(options: MarkConversationReadOptions[]): Promise<BatchMarkReadResponse> {
    if (options.length === 0) throw new Error('markReadBatch requires at least one message');
    const results = await Promise.all(options.map(async (item) => ({
      item,
      result: await this.markRead(item),
    })));
    const firstFailure = results.find(({ result }) => result.statusCode !== 0)?.result;
    return {
      statusCode: firstFailure?.statusCode ?? 0,
      statusMsg: firstFailure?.statusMsg ?? '',
      ...(firstFailure?.checkCode !== undefined ? { checkCode: firstFailure.checkCode } : {}),
      failed: results.filter(({ result }) => result.statusCode !== 0).map(({ item }) => item),
    };
  }

  async getConversationInfos(
    options: ConversationActionOptions[],
  ): Promise<ConversationInfoListResponse> {
    if (options.length === 0) throw new Error('getConversationInfos requires at least one conversation');
    const results = await Promise.all(options.map(async (item) => {
      // rawGetConversationInfo@0x17c908: short ID and type have positive-only
      // presence, unlike the mandatory address used by other conversation cmds.
      const shortId = BigInt.asIntN(64, BigInt(item.conversationShortId));
      const decoded = await this.transport.sendCookieProto(
        608,
        item.inboxType ?? 0,
        '/v2/conversation/get_info',
        { getConversationInfoV2Body: {
          conversationId: item.threadId,
          ...(shortId > 0n ? { conversationShortId: LONG.fromString(String(shortId)) } : {}),
          ...(item.conversationType > 0 ? { conversationType: item.conversationType } : {}),
        } },
        this.cookieOptions(),
      );
      const result = actionResponse(decoded);
      // refreshAsync's receive-pool callback accepts outer 0 OR 200. Keep this
      // command-specific: other action methods do not share that success rule.
      if (result.statusCode === 200) result.statusCode = 0;
      const payload = decoded['body'] as Record<string, unknown> | undefined;
      const body = payload?.['getConversationInfoV2Body'] as {
        conversationInfo?: Record<string, unknown>;
      } | undefined;
      return {
        result: result.statusCode === 0 && !body
          ? { statusCode: -3, statusMsg: 'IM response missing getConversationInfoV2Body' }
          : result,
        conversation: result.statusCode === 0 ? body?.conversationInfo : undefined,
      };
    }));
    const firstFailure = results.find(({ result }) => result.statusCode !== 0)?.result;
    return {
      statusCode: firstFailure?.statusCode ?? 0,
      statusMsg: firstFailure?.statusMsg ?? '',
      ...(firstFailure?.checkCode !== undefined ? { checkCode: firstFailure.checkCode } : {}),
      conversations: results
        .flatMap(({ conversation }) => conversation ? [mapProtoConversationListItem(conversation)] : [])
        .filter((item) => item.conversationId),
    };
  }

  deleteMessage(options: DeleteMessageOptions): Promise<ImActionResponse> {
    return this.send(
      701,
      options.inboxType ?? 0,
      '/v1/message/delete',
      'deleteMessageBody',
      {
        ...this.address(options),
        messageId: LONG.fromString(options.serverMessageId),
      },
    );
  }

  deleteConversation(options: DeleteConversationOptions): Promise<ImActionResponse> {
    const index = signedMessageIndex(options.lastMessageIndex);
    return this.send(
      603,
      options.inboxType ?? 0,
      '/v1/conversation/delete',
      'deleteConversationBody',
      { ...this.address(options), lastMessageIndex: LONG.fromString(String(index)) },
    );
  }

  enterConversation(options: EnterConversationOptions): Promise<ImActionResponse> {
    return this.send(
      410,
      options.inboxType ?? 0,
      '/v1/client/user_action',
      'sendUserActionBody',
      {
        ...this.address(options),
        actionType: 1,
        extra: {},
      },
    );
  }

  modifyReaction(options: ModifyMessageReactionOptions): Promise<ImActionResponse> {
    const emoji = options.emoji.trim();
    if (!emoji) throw new Error('reaction emoji cannot be empty');
    if (!/^\d+$/.test(options.serverMessageId)) throw new Error('server message id must be numeric');
    if (!/^\d+$/.test(options.operatorUid)) throw new Error('reaction operator uid must be numeric');
    return this.send(
      705,
      options.inboxType ?? 0,
      '/v1/message/set_property',
      'modifyMessagePropertyBody',
      {
        propertyList: {
          ...this.address(options),
          serverMessageId: LONG.fromString(options.serverMessageId),
          clientMessageId: '',
          modifyPropertyContent: [{
            operation: options.enabled ? 0 : 1,
            key: `se:${emoji}`,
            value: '',
            idempotentId: options.operatorUid,
          }],
        },
        ticket: '',
      },
      'modifyMessagePropertyBody',
    ).then((result) => result.statusCode === 1
      ? { statusCode: 0, statusMsg: result.statusMsg || 'reaction already applied' }
      : result);
  }

  async setSettings(options: SetConversationSettingsOptions): Promise<ImActionResponse> {
    // Native rawSetConversationMute/StickOnTop sets only the requested optional
    // field. Omitted fields remain unchanged; no cmd920 preflight is performed.
    return this.send(
      921,
      options.inboxType ?? 0,
      '/v1/conversation/set_setting_info',
      'setConversationSettingInfoBody',
      {
        ...this.address(options),
        ...(options.mute !== undefined ? { setMute: options.mute } : {}),
        ...(options.pinned !== undefined ? { setStickOnTop: options.pinned } : {}),
      },
      'setConversationSettingInfoBody',
    );
  }

  removeParticipants(options: GroupParticipantActionOptions): Promise<ImActionResponse> {
    this.validateParticipantUids(options.uids);
    // Desktop's cmd651 consumer checks only the envelope, not the invitation result body.
    return this.send(651, options.inboxType ?? 0, '/v1/conversation/remove_participants',
      'conversationRemoveParticipantsBody', {
        ...this.address(options),
        participants: options.uids.map((uid) => LONG.fromString(uid)),
      });
  }

  leave(options: ConversationActionOptions): Promise<ImActionResponse> {
    return this.send(
      652,
      options.inboxType ?? 0,
      '/v1/conversation/leave',
      'leaveConversationBody',
      this.address(options),
    );
  }

  async listParticipants(options: ConversationActionOptions): Promise<GroupMemberListResponse> {
    const members: GroupMemberData[] = [];
    let cursor = '0';
    const seenCursors = new Set<string>();
    for (;;) {
      if (seenCursors.has(cursor)) {
        return { statusCode: -1, statusMsg: 'participant cursor did not advance', members };
      }
      seenCursors.add(cursor);
      const decoded = await this.transport.sendCookieProto(
        605,
        options.inboxType ?? 0,
        '/v1/conversation/participants_list',
        {
          conversationParticipantsBody: {
            ...this.address(options),
            cursor: LONG.fromString(cursor),
            limit: 100,
          },
        },
        this.cookieOptions(),
      );
      const result = actionResponse(decoded, 'conversationParticipantsBody');
      if (result.statusCode !== 0) return { ...result, members };
      const payload = decoded['body'] as Record<string, unknown> | undefined;
      const body = payload?.['conversationParticipantsBody'] as {
        participantsPage?: {
          participants?: Array<Record<string, unknown>>;
          hasMore?: boolean;
          cursor?: string | number | { toString(): string };
        };
      } | undefined;
      if (!body) {
        return {
          statusCode: -3,
          statusMsg: 'IM response missing conversationParticipantsBody',
          members,
        };
      }
      const participantPage = body?.participantsPage;
      for (const participant of participantPage?.participants ?? []) {
        const member = groupMemberData(participant);
        if (member) members.push(member);
      }
      if (!participantPage?.hasMore) return { ...result, members };
      const nextCursor = String(participantPage.cursor ?? '');
      if (!nextCursor) {
        return { statusCode: -1, statusMsg: 'participant cursor did not advance', members };
      }
      cursor = nextCursor;
    }
  }

  async listJoinRequests(options: GroupJoinRequestListOptions = {}): Promise<GroupJoinRequestListResponse> {
    const requests: GroupJoinRequestData[] = [];
    let cursor = '0';
    const seenCursors = new Set<string>();
    for (;;) {
      if (seenCursors.has(cursor)) {
        return { statusCode: -1, statusMsg: 'join-request cursor did not advance', requests };
      }
      seenCursors.add(cursor);
      const decoded = await this.transport.sendCookieProto(
        2027,
        1,
        '/v1/conversation/get_audit_list',
        {
          getConversationAuditListBody: {
            cursor: LONG.fromString(cursor),
            limit: 100,
          },
        },
        this.cookieOptions(),
      );
      const result = actionResponse(decoded);
      if (result.statusCode !== 0) return { ...result, requests };
      const payload = decoded['body'] as Record<string, unknown> | undefined;
      const body = payload?.['getConversationAuditListBody'] as {
        applyInfoList?: Array<Record<string, unknown>>;
        nextCursor?: string | number | { toString(): string };
        hasMore?: boolean;
      } | undefined;
      if (!body) {
        return {
          statusCode: -3,
          statusMsg: 'IM response missing getConversationAuditListBody',
          requests,
        };
      }
      for (const raw of body?.applyInfoList ?? []) {
        const request = joinRequestData(raw);
        if (request && (!options.conversationShortId || request.groupShortId === options.conversationShortId)) {
          requests.push(request);
        }
      }
      if (!body?.hasMore) return { ...result, requests };
      const nextCursor = String(body.nextCursor ?? '');
      if (!nextCursor) {
        return { statusCode: -1, statusMsg: 'join-request cursor did not advance', requests };
      }
      cursor = nextCursor;
    }
  }

  async getJoinRequestUnread(): Promise<GroupJoinRequestUnreadResponse> {
    const decoded = await this.transport.sendCookieProto(
      2028, 1, '/v1/conversation/get_audit_unread',
      { getConversationAuditUnreadBody: {} }, this.cookieOptions(),
    );
    const result = actionResponse(decoded, 'getConversationAuditUnreadBody');
    if (result.statusCode !== 0) return result;
    const payload = decoded['body'] as Record<string, unknown>;
    const body = payload['getConversationAuditUnreadBody'] as Record<string, unknown>;
    const rawCount = body['unreadCount'] ?? '0';
    const unreadCount = String(rawCount);
    if (!/^\d+$/.test(unreadCount) ||
        (typeof rawCount === 'number' && !Number.isSafeInteger(rawCount)) ||
        BigInt(unreadCount) > 9223372036854775807n) {
      return { statusCode: -3, statusMsg: 'IM response invalid audit unread count' };
    }
    const lastRequest = joinRequestData(body['lastApplyInfo'] as Record<string, unknown> | undefined);
    return { ...result, unreadCount, ...(lastRequest ? { lastRequest } : {}) };
  }

  async clearJoinRequestUnread(): Promise<ImActionResponse> {
    // Desktop 1.2.1 native URL map intentionally uses this SAME path for cmd2029.
    // Its bridge sends an empty body: this is not a per-group operation.
    const decoded = await this.transport.sendCookieProto(
      2029, 1, '/v1/conversation/get_audit_unread',
      { clearConversationAuditUnreadBody: {} }, this.cookieOptions(),
    );
    return actionResponse(decoded, 'clearConversationAuditUnreadBody');
  }

  async reviewJoinRequest(options: ReviewGroupJoinRequestOptions): Promise<GroupJoinRequestActionResponse> {
    if (!/^\d+$/.test(options.requestId)) throw new Error('join request id must be numeric');
    if (
      options.status !== GroupJoinRequestStatus.APPROVED &&
      options.status !== GroupJoinRequestStatus.REJECTED
    ) {
      throw new Error('join request status must be APPROVED or REJECTED');
    }
    const decoded = await this.transport.sendCookieProto(
      2025,
      1,
      '/v1/conversation/ack_apply',
      {
        ackConversationApplyBody: {
          applyId: LONG.fromString(options.requestId),
          applyStatus: options.status,
          bizExt: {},
        },
      },
      this.cookieOptions(),
    );
    const result = actionResponse(decoded, 'ackConversationApplyBody');
    const payload = decoded['body'] as Record<string, unknown> | undefined;
    const body = payload?.['ackConversationApplyBody'] as {
      applyInfo?: Record<string, unknown>;
    } | undefined;
    const request = joinRequestData(body?.applyInfo);
    return { ...result, ...(request ? { request } : {}) };
  }

  async inviteParticipants(options: GroupParticipantActionOptions): Promise<ParticipantActionResponse> {
    this.validateParticipantUids(options.uids);
    const request = {
      ...this.address(options),
      participants: options.uids.map((uid) => LONG.fromString(uid)),
      bizExt: pureInvitation(this.resolveSelfUid()),
    };
    const bodyKey = 'conversationAddParticipantsBody';
    const decoded = await this.transport.sendCookieProto(
      650,
      1,
      '/v1/conversation/add_participants',
      { [bodyKey]: request },
      this.cookieOptions(),
    );
    // GroupMemberManager accepts 0/200 and copies the body, unlike cmd651's consumer.
    const envelopeStatus = Number(decoded['statusCode'] ?? 0);
    if (envelopeStatus !== 0 && envelopeStatus !== 200) {
      return { ...actionResponse(decoded), succeededUids: [], failedUids: [] };
    }
    const result = actionResponse({ ...decoded, statusCode: 0 }, bodyKey);
    const payload = decoded['body'] as Record<string, unknown> | undefined;
    const body = payload?.[bodyKey] as ActionBody & {
      successParticipants?: Array<string | number>;
      failedParticipants?: Array<string | number>;
      secSuccessParticipants?: Array<{ uid?: string | number; secUid?: string }>;
      secFailedParticipants?: Array<{ uid?: string | number; secUid?: string }>;
    } | undefined;
    if (!body) return { ...result, succeededUids: [], failedUids: [] };
    const identity = (participant: { uid?: string | number; secUid?: string }): ParticipantIdentity => ({
      ...(participant.uid !== undefined ? { uid: String(participant.uid) } : {}),
      ...(participant.secUid !== undefined ? { secUid: participant.secUid } : {}),
    });
    const details = {
      successParticipants: (body.successParticipants ?? []).map(String),
      failedParticipants: (body.failedParticipants ?? []).map(String),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.extraInfo !== undefined ? { extraInfo: body.extraInfo } : {}),
      ...(body.checkCode !== undefined ? { checkCode: String(body.checkCode) } : {}),
      ...(body.checkMessage !== undefined ? { checkMessage: body.checkMessage } : {}),
      secSuccessParticipants: (body.secSuccessParticipants ?? []).map(identity),
      secFailedParticipants: (body.secFailedParticipants ?? []).map(identity),
    };
    return {
      ...result,
      succeededUids: [...details.successParticipants, ...details.secSuccessParticipants.flatMap(item => item.uid === undefined ? [] : [item.uid])],
      failedUids: [...details.failedParticipants, ...details.secFailedParticipants.flatMap(item => item.uid === undefined ? [] : [item.uid])],
      details,
    };
  }

  private async send(
    cmd: number,
    inboxType: number,
    endpoint: string,
    requestKey: string,
    request: Record<string, unknown>,
    responseKey?: string,
  ): Promise<ImActionResponse> {
    const decoded = await this.transport.sendCookieProto(
      cmd,
      inboxType,
      endpoint,
      { [requestKey]: request },
      this.cookieOptions(),
    );
    return actionResponse(decoded, responseKey);
  }

  private address(options: ConversationActionOptions): Record<string, unknown> {
    return {
      conversationId: options.threadId,
      conversationShortId: LONG.fromString(options.conversationShortId),
      conversationType: options.conversationType,
    };
  }

  private validateParticipantUids(uids: string[]): void {
    if (uids.length === 0) throw new Error('participants cannot be empty');
    if (uids.some((uid) => !/^\d+$/.test(uid))) throw new Error('participant uid must be numeric');
  }

  private cookieOptions() {
    if (!this.deviceId) throw new Error('Cookie IM action requires deviceId');
    return desktopCookieProtoOptions(this.deviceId);
  }
}
