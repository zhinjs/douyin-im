import {
  createDesktopDTraitBrowserCore,
  type DesktopDTraitBrowserRealm,
} from './desktop-dtrait-browser.js';
import {
  installDesktopDTraitCrypto,
  type DesktopDTraitCryptoContext,
} from './desktop-dtrait-crypto.js';
import type { DesktopDTraitTransportRealm } from './desktop-dtrait-transport.js';

export type DesktopDTraitBrowserInstallRealm = DesktopDTraitBrowserRealm &
  DesktopDTraitTransportRealm &
  Pick<DesktopDTraitCryptoContext, 'window' | 'crypto' | 'location'>;
export type DesktopDTraitBrowserDependencies = Pick<
  DesktopDTraitCryptoContext,
  'loadCryptoJS' | 'loadJSEncrypt' | 'onBackgroundError'
>;

const installed = new WeakMap<object, ReturnType<typeof assemble>>();

/** Explicit entry for an account-owned browser realm. Publishes crypto then the migrated core; does not start login or collect. */
export function installDesktopDTraitBrowser(
  realm: DesktopDTraitBrowserInstallRealm,
  dependencies: DesktopDTraitBrowserDependencies
) {
  const previous = installed.get(realm.window);
  if (previous) return previous;
  const target = realm.window as unknown as Record<string, unknown>;
  // Host ownership guard: do not overwrite another page/plugin's security SDK.
  if (target['DTraitSDK'])
    throw new Error('DTraitSDK already belongs to another browser owner');
  const result = assemble(realm, dependencies, target);
  target['DTraitSDK'] = result.core;
  installed.set(realm.window, result);
  return result;
}

function assemble(
  realm: DesktopDTraitBrowserInstallRealm,
  dependencies: DesktopDTraitBrowserDependencies,
  target: Record<string, unknown>
) {
  const crypto = installDesktopDTraitCrypto(
    {
      get window() {
        return realm.window;
      },
      get crypto() {
        return realm.crypto;
      },
      get location() {
        return realm.location;
      },
      get Math() {
        return realm.Math;
      },
      get TextEncoder() {
        return realm.TextEncoder as typeof TextEncoder;
      },
      atob: value => realm.atob(value),
      btoa: value => realm.btoa(value),
      loadCryptoJS: () => dependencies.loadCryptoJS(),
      loadJSEncrypt: () => dependencies.loadJSEncrypt(),
      onBackgroundError: error => dependencies.onBackgroundError?.(error),
    },
    target
  );
  const core = createDesktopDTraitBrowserCore(realm, {
    // The original core reads the published module globals, not a snapshot of methods.
    crypto: {
      get aes() {
        return target['DTraitUcAesEncrypt'] as typeof crypto.aes;
      },
      get rsa() {
        return target['DTraitUcRsaEncrypt'] as typeof crypto.rsa;
      },
      get util() {
        return target['DTraitUcCryptoJSUtil'] as typeof crypto.util;
      },
    },
    getCryptoUtil: () => target['DTraitUcCryptoJSUtil'] as typeof crypto.util,
    onBackgroundError: error => dependencies.onBackgroundError?.(error),
  });
  return { crypto, core };
}
