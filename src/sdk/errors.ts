import type { SendMessageResponse } from '../services/im/types.js';

/** 产品层发送未被服务端确认投递。 */
export class SendMessageError extends Error {
  readonly response: SendMessageResponse;
  readonly statusCode: number;
  readonly checkCode?: number;

  constructor(response: SendMessageResponse) {
    const check = response.checkCode == null ? '' : ` check=${response.checkCode}`;
    super(`消息发送失败: status=${response.statusCode}${check} ${response.statusMsg}`.trim());
    this.name = 'SendMessageError';
    this.response = response;
    this.statusCode = response.statusCode;
    if (response.checkCode != null) this.checkCode = response.checkCode;
  }
}

/**
 * 账号设置了 `loginPolicy: 'saved-session-only'`，但没有可恢复的已保存会话。
 * SDK 不会转入二维码、短信或密码登录；凭据保持原样。
 */
export class SavedSessionRequiredError extends Error {
  readonly code = 'saved_session_required';

  constructor() {
    super('需要可恢复的已保存会话；当前登录策略不允许交互式登录');
    this.name = 'SavedSessionRequiredError';
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
