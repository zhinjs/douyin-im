export { ApiConnection, type ApiConnectionOptions } from './api-connection.js';
export { PassportRequestError } from './passport-error.js';
export {
  DESKTOP_APP_VERSION,
  DESKTOP_LOGIN_USER_AGENT,
  QR_DEFAULT_BODY,
} from './constants.js';
export {
  encodeFormBody,
  randomBizTraceId,
  signPassportQuery,
  resumePassportQuery,
  type SignPassportExtras,
  type SignedPassportQuery,
} from './passport-query.js';
export type {
  CheckQrconnectData,
  CheckQrconnectResponse,
  GetQrcodeData,
  GetQrcodeResponse,
  QrCodeInfo,
  QrConnectStatus,
  QrUserData,
  PassportSubAccount,
} from './types.js';
