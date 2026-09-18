import {
  DesktopWebSecureSdk,
  type DesktopWebSecureSdkContext,
  type DesktopWebSecureTelemetry,
} from './desktop-web-secure-sdk.js';
import { DesktopWebSecureSystemCrypto } from './desktop-web-secure-crypto.js';
import {
  DesktopWebSecureTcc,
  type DesktopWebSecureTccContext,
} from './desktop-web-secure-tcc.js';
import {
  DesktopWebSecureServerCertificates,
  type DesktopWebSecureServerCertificateContext,
} from './desktop-web-secure-server-certificate.js';
import {
  DesktopWebSecureIndexedStorageHost,
  type DesktopWebIdbFactory,
} from './desktop-web-secure-indexed-storage.js';
import type { DesktopWebStorageArea } from './desktop-web-secure-local-storage.js';
import type { DesktopStorageIframeContext } from './desktop-web-secure-iframe.js';
import type { DesktopWebSecureStoreContext } from './desktop-web-secure-store.js';
import type { DesktopWebSecureTransportContext } from './desktop-web-secure-transport.js';
import type { DesktopWebSecureSocketContext } from './desktop-web-secure-socket.js';
import {
  createDesktopDTraitBrowserBootstrap,
  type DesktopDTraitBrowserBootstrapOptions,
  type DesktopDTraitBrowserBootstrapRealm,
} from './desktop-dtrait-browser-bootstrap.js';

export type DesktopWebSecureBrowserRealm =
  DesktopDTraitBrowserBootstrapRealm & {
    readonly window: DesktopWebSecureTransportContext['window'] &
      DesktopWebSecureSocketContext['window'] &
      DesktopStorageIframeContext['window'] &
      DesktopWebSecureTccContext['window'];
    readonly document: DesktopStorageIframeContext['document'] &
      DesktopWebSecureSdkContext['document'] & {
        cookie: string;
      };
    readonly location: {
      href: string;
      origin: string;
      hostname: string;
      search: string;
    };
    readonly navigator: DesktopStorageIframeContext['navigator'];
    readonly Date: { new (): { getTime(): number }; now(): number };
    readonly localStorage: DesktopWebStorageArea;
    readonly Request: DesktopWebSecureTransportContext['Request'];
    readonly Headers: DesktopWebSecureTransportContext['Headers'];
    readonly URL: typeof URL;
    readonly crypto: NonNullable<DesktopDTraitBrowserBootstrapRealm['crypto']>;
    readonly indexedDB?: unknown;
    readonly webkitIndexedDB?: unknown;
    readonly mozIndexedDB?: unknown;
    readonly OIndexedDB?: unknown;
    addEventListener(type: 'message', listener: (event: unknown) => void): void;
    removeEventListener(
      type: 'message',
      listener: (event: unknown) => void
    ): void;
  };
export interface DesktopWebSecureBrowserOptions extends DesktopDTraitBrowserBootstrapOptions {
  telemetry?: DesktopWebSecureTelemetry;
  containerVersion?: string;
  containerType?: string;
}
const owners = new WeakMap<object, DesktopWebSecureSdk>();

export interface DesktopLoginWebSecureConfig {
  aid?: number | string | undefined;
  device_id?: string | undefined;
}

/** LOGIN Pi.initSecureSDK, not the normal/lite Passport hp plugin.
 * Loading/configuration is deferred; neither return nor SDK.start completion is
 * a login/keys/Session readiness barrier. Source starts this for every panel.
 */
export function startDesktopLoginWebSecure(
  realm: DesktopWebSecureBrowserRealm,
  options: DesktopWebSecureBrowserOptions,
  config: DesktopLoginWebSecureConfig
): void {
  const observe = (pending: Promise<unknown>): void => {
    void pending.catch(error => {
      // Additive detached-error observation. Never retry or manufacture readiness.
      try {
        options.onBackgroundError?.(error);
      } catch {
        /* Observation only. */
      }
    });
  };
  observe(
    Promise.resolve()
      .then(() =>
        createDesktopWebSecureBrowser(realm, {
          ...options,
          containerType: options.containerType ?? 'sdk',
          containerVersion: options.containerVersion ?? '3.2.5',
        })
      )
      .then(sdk => {
        // Read the live panel configuration after loading, as the source callback does.
        sdk.setConfig({ aid: config.aid, scene: 'login', certType: 'header' });
        sdk.setWebId(config.device_id || '');
        observe(sdk.start());
        // No hp defaults, namespace, agid, path list or startDTrait in this entry.
      })
  );
}

/** Owns actual browser storage/iframe, certificate, TCC, crypto and both transports.
 * Construction installs WebSecure hooks; start/Passport init remains explicit.
 * Use in the same isolated browser realm as this module, never a shared Node-global shim.
 */
export function createDesktopWebSecureBrowser(
  realm: DesktopWebSecureBrowserRealm,
  options: DesktopWebSecureBrowserOptions
): DesktopWebSecureSdk {
  const target = realm.window as typeof realm.window & {
    securitySDK?: unknown;
  };
  const previous = owners.get(realm.window);
  if (previous) {
    if (target.securitySDK !== previous)
      throw new Error('securitySDK browser ownership changed');
    return previous;
  }
  // YV publishes the module's captured instance here. Unlike source's unchecked
  // truthy reuse, an account-owned host must never adopt a foreign SDK's keys.
  if (target.securitySDK)
    throw new Error('securitySDK already belongs to another browser owner');
  const background = (error: unknown) => options.onBackgroundError?.(error);
  const dtrait = createDesktopDTraitBrowserBootstrap(realm, options);
  const certificates = new DesktopWebSecureServerCertificates({
    get window() {
      return realm.window;
    },
    get XMLHttpRequest() {
      return realm.XMLHttpRequest as DesktopWebSecureServerCertificateContext['XMLHttpRequest'];
    },
    get localStorage() {
      return realm.localStorage;
    },
    get Date() {
      return realm.Date;
    },
    setTimeout: (callback, delay) => realm.setTimeout(callback, delay),
  });
  const tcc = new DesktopWebSecureTcc({
    get window() {
      return realm.window;
    },
    get XMLHttpRequest() {
      return realm.XMLHttpRequest as DesktopWebSecureTccContext['XMLHttpRequest'];
    },
    get Date() {
      return realm.Date;
    },
  });
  const indexed = new DesktopWebSecureIndexedStorageHost({
    origin: realm.location.origin,
    readIndexedDB() {
      // Ct reads identifiers in order inside a catch. Preserve missing-identifier
      // failure rather than silently skipping to a vendor alias.
      const global = (
        name: 'indexedDB' | 'webkitIndexedDB' | 'mozIndexedDB' | 'OIndexedDB'
      ) => {
        if (!(name in realm))
          throw new ReferenceError(`${name} is not defined`);
        return realm[name];
      };
      return (global('indexedDB') ||
        (realm.window as { indexedDB?: unknown }).indexedDB ||
        global('webkitIndexedDB') ||
        global('mozIndexedDB') ||
        global('OIndexedDB')) as DesktopWebIdbFactory | undefined;
    },
    setTimeout: (callback, delay) => realm.setTimeout(callback, delay),
    clearTimeout: timer => realm.clearTimeout(timer),
    onBackgroundError: background,
  });
  const iframe: DesktopStorageIframeContext = {
    origin: realm.location.origin,
    get document() {
      return realm.document;
    },
    get navigator() {
      return realm.navigator;
    },
    get window() {
      return realm.window;
    },
    get performance() {
      return realm.performance;
    },
    get Date() {
      return realm.Date;
    },
    get Math() {
      return realm.Math;
    },
    readLocalStorage: key => realm.localStorage.getItem(key),
    setTimeout: (callback, delay) => realm.setTimeout(callback, delay),
    clearTimeout: timer => realm.clearTimeout(timer),
    // No event/WindowProxy copies or wrapper identities: source/origin checks and
    // removeEventListener must see the actual same event and callback objects.
    addMessageListener: listener =>
      realm.addEventListener('message', listener as (event: unknown) => void),
    removeMessageListener: listener =>
      realm.removeEventListener(
        'message',
        listener as (event: unknown) => void
      ),
  };
  const sdk = new DesktopWebSecureSdk(
    {
      keys: {
        crypto: new DesktopWebSecureSystemCrypto(realm.crypto.subtle),
        certificates,
        get Date() {
          return realm.Date;
        },
        get performance() {
          return realm.performance;
        },
        onBackgroundError: background,
      },
      get document() {
        return realm.document;
      },
      browser: iframe,
      transport: {
        get window() {
          return realm.window;
        },
        get XMLHttpRequest() {
          return realm.XMLHttpRequest;
        },
        get location() {
          return realm.location;
        },
        get URL() {
          return realm.URL;
        },
        get Request() {
          return realm.Request;
        },
        get Headers() {
          return realm.Headers;
        },
        onBackgroundError: background,
      },
      storage: {
        iframe,
        store: {
          get window() {
            return realm.window;
          },
          get hostname() {
            return realm.location.hostname;
          },
          readCookie: () => realm.document.cookie,
          queryIframes: () =>
            realm.document.querySelectorAll('iframe') as ReturnType<
              DesktopWebSecureStoreContext['queryIframes']
            >,
          writeLocalStorage: (key, value) =>
            realm.localStorage.setItem(key, value),
          createLocalStorage: config =>
            indexed.createLocalStorage(
              () => realm.localStorage,
              config?.dbStorage
            ),
          onBackgroundError: background,
        },
        cache: {
          get Math() {
            return realm.Math;
          },
          onBackgroundError: background,
        },
      },
      tcc,
      dtrait,
      ...(options.telemetry === undefined
        ? {}
        : { telemetry: options.telemetry }),
      onBackgroundError: background,
    },
    {
      ...(options.containerVersion === undefined
        ? {}
        : { containerVersion: options.containerVersion }),
      ...(options.containerType === undefined
        ? {}
        : { containerType: options.containerType }),
    }
  );
  owners.set(realm.window, sdk);
  target.securitySDK = sdk;
  return sdk;
}
