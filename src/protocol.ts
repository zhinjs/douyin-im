/**
 * 底层协议与调试入口。
 *
 * 产品代码应从 `douyin-im` 使用 Client/Account；协议逆向、抓包验证和
 * 自定义适配器才从 `douyin-im/protocol` 导入这些实现。
 */
export * from './anti-bot/index.js';
export * from './services/im/cards.js';
export * from './desktop/index.js';
export * from './passport/index.js';
export * from './store/index.js';
export * from './services/index.js';
// Building blocks for a custom Cookie protobuf transport (AccountOptions.imTransport)
// and for observing Frontier frames on Account.frontierConnection.
export { encodeRequest, decodeRequestRaw, decodeResponseRaw } from './services/im/codec.js';
export type { EncodeRequestOptions } from './services/im/codec.js';
export { ImProtoTransport, ImProtoTransportError, desktopBodyDigest } from './services/im/transport.js';
export type {
  CookieProtoOptions,
  ImCookieTransport,
  ImProtoTransportClient,
  ImTransportContext,
  ImTransportFactory,
} from './services/im/transport.js';
export { DESKTOP_IM_PROFILE, desktopCookieProtoOptions, desktopImQuery } from './services/im/desktop.js';
export { pushFromResponse } from './services/im/ws-client.js';
export { CookieJar } from './http/cookie-jar.js';
export type { HttpResponse } from './http/types.js';
export { DouyinResponseError, parseJsonResponse } from './http/response.js';
export type { ResponseFailureKind } from './http/response.js';
