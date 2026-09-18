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

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
