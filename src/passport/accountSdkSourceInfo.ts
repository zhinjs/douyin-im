import { mixModeEncode } from './mixMode.js';

/** C321 module74321 a(): UTF-8 bytes excluding UTF-16 surrogates, XOR5, unpadded hex. */
export function encodeAccountSdkSourceInfo(plain: string): string {
  return mixModeEncode(plain);
}

export function encodeBrowserInfo(browserInfo: Record<string, unknown>): string {
  return encodeAccountSdkSourceInfo(JSON.stringify(browserInfo));
}
