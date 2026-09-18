import {
  DesktopDTraitBootstrap,
  type DesktopDTraitBootstrapContext,
  type DesktopDTraitMonitor,
} from './desktop-dtrait-bootstrap.js';
import type { DesktopDTraitParametersContext } from './desktop-dtrait-parameters.js';
import {
  installDesktopDTraitBrowser,
  type DesktopDTraitBrowserDependencies,
  type DesktopDTraitBrowserInstallRealm,
} from './desktop-dtrait-browser-install.js';

export const DESKTOP_DTRAIT_LOCAL_CORE_VERSION = '1.0.31';
const acceptedVersions: ReadonlySet<unknown> = new Set([
  DESKTOP_DTRAIT_LOCAL_CORE_VERSION,
  ...[
    'lf-douyin-pc-web.douyinstatic.com',
    'lf-ucenter-web.yhgfb-cn-static.com',
  ].map(
    host =>
      `https://${host}/obj/passport-fe/ucenter_fe/@byted/uc-secure-dtrait-core/1.0.31/dist/index.umd.production.js`
  ),
]);
export type DesktopDTraitBrowserBootstrapRealm =
  DesktopDTraitBrowserInstallRealm &
    Pick<
      DesktopDTraitParametersContext,
      'document' | 'window' | 'localStorage'
    > & {
      readonly XMLHttpRequest: new () => unknown;
    };
export interface DesktopDTraitBrowserBootstrapOptions extends DesktopDTraitBrowserDependencies {
  monitor: DesktopDTraitMonitor;
  monitorInstances?: DesktopDTraitBootstrapContext['monitorInstances'];
}
const bootstraps = new WeakMap<object, DesktopDTraitBootstrap>();

/** Preinstalled local 1.0.31 core plus the original parameter/bootstrap lifecycle.
 * Loading a new version requires a separately verified implementation, never a silent downgrade or remote eval.
 */
export function createDesktopDTraitBrowserBootstrap(
  realm: DesktopDTraitBrowserBootstrapRealm,
  options: DesktopDTraitBrowserBootstrapOptions
) {
  const previous = bootstraps.get(realm.window);
  if (previous) return previous;
  const installation = installDesktopDTraitBrowser(realm, options);
  const target =
    realm.window as unknown as DesktopDTraitBootstrapContext['window'];
  const requireVersion = (version: unknown) => {
    if (!acceptedVersions.has(version)) {
      // Avoid echoing server-controlled URLs, query tokens or arbitrary objects.
      throw new Error(
        'Unsupported DTrait core version; local implementation requires verified 1.0.31'
      );
    }
    if (target.DTraitSDK !== installation.core) {
      throw new Error('DTrait browser core ownership changed');
    }
  };
  const bootstrap = new DesktopDTraitBootstrap({
    window: target,
    localCore: {
      async load(version) {
        requireVersion(version);
        return true;
      },
      resolve(params) {
        requireVersion(params['urlVersion']);
        return installation.core;
      },
    },
    parameters: {
      get window() {
        return realm.window;
      },
      get XMLHttpRequest() {
        // Native callbacks receive Event arguments; ln deliberately ignores them.
        return realm.XMLHttpRequest as DesktopDTraitParametersContext['XMLHttpRequest'];
      },
      get document() {
        return realm.document;
      },
      get localStorage() {
        return realm.localStorage;
      },
      get Date() {
        return realm.Date;
      },
      atob: value => realm.atob(value),
      btoa: value => realm.btoa(value),
      setTimeout: (callback, delay) => realm.setTimeout(callback, delay),
    },
    // Unused for a local core. Keeping this unreachable boundary explicit prevents
    // accidental remote script loads if bootstrap's implementation changes.
    document: {
      createElement() {
        throw new Error(
          'Remote DTrait script loading is disabled for the local core'
        );
      },
      getElementsByTagName() {
        throw new Error(
          'Remote DTrait script loading is disabled for the local core'
        );
      },
    },
    // Original tn/en/$r closures call their monitor owner; core invokes callbacks
    // with its own receiver. Do not pass host instance methods unbound.
    monitor: {
      init: (value, instances) => options.monitor.init(value, instances),
      setConfig: value => options.monitor.setConfig(value),
      setWebId: value => options.monitor.setWebId?.(value),
      sendSlardarEvent: value => options.monitor.sendSlardarEvent(value),
      sendSlardarLog: value => options.monitor.sendSlardarLog(value),
      sendTeaLog: (...args) => options.monitor.sendTeaLog(...args),
    },
    ...(options.monitorInstances === undefined
      ? {}
      : { monitorInstances: options.monitorInstances }),
    get performance() {
      return realm.performance;
    },
  });
  bootstraps.set(realm.window, bootstrap);
  return bootstrap;
}
