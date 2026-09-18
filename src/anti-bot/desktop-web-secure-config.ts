/** Web SecureSDK configuration, separate from native REE ticket policy and BDMS. */
export interface DesktopWebSecureSceneConfig {
  aid?: number | string | undefined;
  scene?: string;
  certType?: string;
  signVersion?: unknown;
  signTimeout?: unknown;
  urlRewriteRules?: unknown;
  providerPathList?: string[];
  providerHostPathList?: string[];
  onlyProviderPathList?: string[];
  consumerPathList?: string[];
  consumerHostList?: string[];
  consumerHostPathList?: string[];
  excludeConsumerPathList?: string[];
  excludeReportPathList?: string[];
  [key: string]: unknown;
}

export interface DesktopWebSecureMatch {
  needProxy: boolean;
  onlyProxyResp?: boolean;
  providerConfig?: DesktopWebSecureSceneConfig | undefined;
  consumerConfig?: DesktopWebSecureSceneConfig | undefined;
  signType?: string | undefined;
  initType?: string | undefined;
  pathname?: string;
  hostname?: string | undefined;
  needReport?: boolean;
}

/** Pure policy state only; creating this does not install hooks, load TCC or generate keys. */
export class DesktopWebSecureConfiguration {
  aid: number | string | undefined;
  readonly config: Record<string, DesktopWebSecureSceneConfig[]> = {};

  setConfig(value: DesktopWebSecureSceneConfig): void {
    const { scene, aid } = value;
    this.aid = aid;
    const key = String(scene);
    const previous = this.config[key];
    if (previous && Array.isArray(previous)) previous.push(value);
    else this.config[key] = [value];
  }

  /** The caller passes getConfig's selected value, not the outer TCC HTTP envelope. */
  applyRemoteConfig(value: Record<string, unknown> | null | undefined): void {
    if (!value || !this.aid) return;
    const selected = value[this.aid];
    // Select once: a remote entry can change aid, but must not switch this traversal.
    if (selected && Array.isArray(selected)) selected.forEach(entry => this.setConfig(entry));
  }
}

/** C860 so(): ordered prefix matching. It is not a host authorization boundary. */
export function classifyDesktopWebSecureRequest(
  request: { url?: string } | null | undefined,
  config: Record<string, unknown> | null | undefined,
  pageHref: string,
  signType?: string,
  initType?: string,
): DesktopWebSecureMatch {
  try {
    if (!config) return { needProxy: false };
    const url = (request || {}).url;
    if (!url) return { needProxy: false };
    let hostname: string | undefined;
    let pathname: string;
    try {
      const parsed = new URL(url, pageHref);
      hostname = parsed.host;
      pathname = parsed.pathname;
    } catch { pathname = url; }
    if (['mcs.zijieapi.com', 'mon.zijieapi.com'].includes(hostname || '')) return { needProxy: false };
    let needProxy = false;
    let onlyProxyResp = false;
    let needReport = true;
    let providerConfig: DesktopWebSecureSceneConfig | undefined;
    let consumerConfig: DesktopWebSecureSceneConfig | undefined;
    Object.keys(config).forEach(scene => {
      const entries = config[scene];
      if (!Array.isArray(entries)) return;
      entries.forEach((entry: DesktopWebSecureSceneConfig) => {
        const {
          excludeConsumerPathList = [], providerPathList = [], providerHostPathList = [],
          onlyProviderPathList = [], consumerHostList = [], consumerPathList = [],
          consumerHostPathList = [], excludeReportPathList = [],
        } = entry || {};
        for (let i = 0; i < excludeReportPathList.length; i++) {
          if (pathname && pathname.indexOf(excludeReportPathList[i]!) === 0) needReport = false;
        }
        if (excludeConsumerPathList.length > 0 && !consumerConfig) {
          // Source uses onlyProvider's length here. It also retains prior config
          // selections and continues the remaining rules after an exclusion.
          for (let i = 0; i < onlyProviderPathList.length; i++) {
            if (pathname && pathname.indexOf(excludeConsumerPathList[i]!) === 0) {
              needProxy = false; onlyProxyResp = false; break;
            }
          }
        }
        if (onlyProviderPathList.length > 0 && !providerConfig) {
          for (let i = 0; i < onlyProviderPathList.length; i++) {
            if (pathname && pathname.indexOf(onlyProviderPathList[i]!) === 0) {
              needProxy = true; onlyProxyResp = true; providerConfig = entry; break;
            }
          }
        }
        if (providerHostPathList.length > 0 && !providerConfig) {
          for (let i = 0; i < providerHostPathList.length; i++) {
            if (hostname && `${hostname}${pathname}`.indexOf(providerHostPathList[i]!) === 0) {
              needProxy = true; onlyProxyResp = false; providerConfig = entry; break;
            }
          }
        }
        if (providerPathList.length > 0 && !providerConfig) {
          for (let i = 0; i < providerPathList.length; i++) {
            if (pathname && pathname.indexOf(providerPathList[i]!) === 0) {
              needProxy = true; onlyProxyResp = false; providerConfig = entry; break;
            }
          }
        }
        if (consumerHostPathList.length > 0 && !consumerConfig) {
          for (let i = 0; i < consumerHostPathList.length; i++) {
            if (hostname && `${hostname}${pathname}`.indexOf(consumerHostPathList[i]!) === 0) {
              needProxy = true; onlyProxyResp = false; consumerConfig = entry; break;
            }
          }
        }
        if (consumerHostList.length > 0 && !consumerConfig) {
          for (let i = 0; i < consumerHostList.length; i++) {
            if (hostname && hostname.indexOf(consumerHostList[i]!) === 0) {
              needProxy = true; onlyProxyResp = false; consumerConfig = entry; break;
            }
          }
        }
        if (consumerPathList.length > 0 && !consumerConfig) {
          for (let i = 0; i < consumerPathList.length; i++) {
            if (pathname && pathname.indexOf(consumerPathList[i]!) === 0) {
              needProxy = true; onlyProxyResp = false; consumerConfig = entry; break;
            }
          }
        }
      });
    });
    return { needProxy, onlyProxyResp, providerConfig, consumerConfig, signType, initType, pathname, hostname, needReport };
  } catch { return { needProxy: false }; }
}
