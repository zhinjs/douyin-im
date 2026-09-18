import type {
  DesktopDTraitAes,
  DesktopDTraitRsa,
  DesktopDTraitCryptoUtil,
} from './desktop-dtrait-crypto.js';
import {
  DesktopDTraitFeatures,
  type DesktopDTraitFeatureContext,
} from './desktop-dtrait-features.js';
import type { DesktopDTraitCore } from './desktop-dtrait-bootstrap.js';

export interface DesktopDTraitFeatureValues {
  bool?: Record<string, unknown> | null;
  num?: Record<string, unknown> | null;
  str?: Record<string, unknown> | null;
}

export interface DesktopDTraitRequestConfig {
  pathname: string;
  host?: string;
  headers?: Record<string, unknown> | string | null;
}
export interface DesktopDTraitRequestMeta {
  ucProxyParam?: Record<string, unknown>;
}
export interface DesktopDTraitRequestError {
  config: DesktopDTraitRequestConfig;
  err: unknown;
  instance?: DesktopDTraitRequestMeta;
  errType?: unknown;
}
export interface DesktopDTraitCoreMonitor {
  sendSlardarEvent?(value: Record<string, unknown>): unknown;
  sendTeaLog?(name: string, value: Record<string, unknown>): unknown;
  sendSlardarLog?(value: { content: string }): unknown;
}
export interface DesktopDTraitCoreRealmState {
  hookLogCount: number;
  collectionCount: number;
  collectionErrors: { name: string }[];
}
export interface DesktopDTraitRequestCoreContext {
  readonly Date: { now(): number };
  readonly performance: { now(): number };
  atob(value: string): string;
  readonly crypto: {
    aes?: Pick<DesktopDTraitAes, 'getAesKey' | 'encryptData'>;
    rsa?: Pick<DesktopDTraitRsa, 'encryptData'>;
    util?: Pick<DesktopDTraitCryptoUtil, 'uint8ArrayToHex'>;
  };
  readonly featureProtocol: Pick<
    DesktopDTraitFeatures,
    'getResult' | 'addBoolFeature' | 'addNumFeature' | 'addStringFeature'
  >;
  readonly monitor?: DesktopDTraitCoreMonitor;
  /** The account realm's actual collector. No empty default or external sourcePromise fallback. */
  collect(): Promise<DesktopDTraitFeatureValues>;
  /** Share only within one account's realm, matching the original module lexical state. */
  readonly realmState?: DesktopDTraitCoreRealmState;
  /** Bind the actual transport in its account browser realm; never a global Node patch. */
  installHooks(callbacks: {
    errorRequestConfig(input: DesktopDTraitRequestError): void;
    hookConfig(config: DesktopDTraitRequestConfig): { needProxy: boolean };
    processRequestConfig(
      config: DesktopDTraitRequestConfig,
      meta: DesktopDTraitRequestMeta
    ): Promise<DesktopDTraitRequestConfig>;
    processResponseConfig(
      response: {
        config: DesktopDTraitRequestConfig;
        headers?: Record<string, unknown> | string | null;
        httpCode?: number;
      },
      meta?: DesktopDTraitRequestMeta
    ): Promise<boolean>;
  }): void;
  onBackgroundError?(error: unknown): void;
}
const quietPaths = [
  '/passport/web/check_qrconnect/',
  '/passport/token/beat/web/',
  '/check_qrconnect/',
  '/passport/web/get_qrcode/',
  '/passport/ticket_guard/get_client_cert/',
  '/passport/web/challenge/',
  '/passport/general/login_guiding_strategy/',
  '/passport/token/beat/sso/web/',
];

export interface DesktopDTraitCoreContext extends Omit<
  DesktopDTraitRequestCoreContext,
  'featureProtocol' | 'monitor'
> {
  readonly featureContext: DesktopDTraitFeatureContext;
  setTimeout(callback: () => void, delay: number): unknown;
}

/** F87/F88 entrypoint. Create once per isolated account realm; return true is not collection/authentication readiness. */
export function createDesktopDTraitCore(
  context: DesktopDTraitCoreContext
): DesktopDTraitCore {
  let instance: DesktopDTraitRequestCore | null = null;
  const realmState: DesktopDTraitCoreRealmState = context.realmState ?? {
    hookLogCount: 0,
    collectionCount: 0,
    collectionErrors: [],
  };
  return {
    getInstance(params, options): true {
      // Source reads these unused options too, before checking the singleton.
      const {
        sourcePromise,
        dTraitPath = [],
        urlRewriteRules = [],
        getLocalSource,
        dTraitHost = [],
        containerSdkVersion = 'unknown',
        monitor,
        delayCollect,
      } = options;
      void sourcePromise;
      void getLocalSource;
      void containerSdkVersion;
      if (!instance) {
        instance = new DesktopDTraitRequestCore(
          {
            ...context,
            realmState,
            get featureProtocol() {
              return new DesktopDTraitFeatures(context.featureContext, {});
            },
          },
          Object.assign({}, params, { libraGroup: options['libraGroup'] })
        );
        if (delayCollect)
          context.setTimeout(
            () => instance?.setSource(),
            (delayCollect as number) * 1000
          );
        else instance.setSource();
      }
      if (monitor) instance.updateMonitor(monitor as DesktopDTraitCoreMonitor);
      instance.updateDTraitPath(dTraitPath as string[]);
      instance.updateDTraitHost(dTraitHost as string[]);
      instance.updateUrlRewriteRules(urlRewriteRules as unknown[]);
      return true;
    },
  };
}

/** One core per account realm. F24–85 request, collection and monitor state; transport/collector are explicit bindings. */
export class DesktopDTraitRequestCore {
  initPromise: Promise<unknown> = Promise.resolve(false);
  aesKey: string | undefined;
  centralRsaPub: string;
  centralVersion: unknown;
  centralRsaAesKey: string | undefined = '';
  edgeRsaPub: string;
  edgeVersion: unknown;
  edgeRsaAesKey = '';
  centralDTrait = '';
  edgeDTrait = '';
  dTraitToken = '';
  dTraitPathCache: Record<
    string,
    { time: number; val: Record<string, string> | null }
  > = {};
  dTraitHooksPath: string[] = [];
  dTraitHooksHost: string[] = [];
  dTraitUrlRewriteRules: unknown[] = [];
  collectStatus = false;
  readonly featureProtocol: DesktopDTraitRequestCoreContext['featureProtocol'];
  libraGroup: unknown;
  getLocalSource: () => Promise<unknown> = () => Promise.resolve({});
  private readonly realmState: DesktopDTraitCoreRealmState;
  private readonly cacheLogList = {
    slardarEvent: [] as Record<string, unknown>[],
    sendTeaLog: [] as { eventName: string; params: Record<string, unknown> }[],
    slardarLog: [] as { content: string }[],
  };
  private sendSlardarEventBase: DesktopDTraitCoreMonitor['sendSlardarEvent'] =
    undefined;
  private sendTeaLogBase: DesktopDTraitCoreMonitor['sendTeaLog'] = undefined;
  private sendSlardarLogBase: DesktopDTraitCoreMonitor['sendSlardarLog'] =
    undefined;
  constructor(
    private readonly context: DesktopDTraitRequestCoreContext,
    params: Record<string, unknown>
  ) {
    this.realmState = context.realmState ?? {
      hookLogCount: 0,
      collectionCount: 0,
      collectionErrors: [],
    };
    this.sendSlardarEvent({
      name: 'dtrait_monkey_patch_request',
      metrics: { duration: context.performance.now() },
      categories: {
        path_len: Array.isArray(this.dTraitHooksPath)
          ? this.dTraitHooksPath.length
          : 0,
      },
    });
    // Original hooks are installed before key creation; even invalid public-key encoding can leave hooks installed.
    context.installHooks({
      hookConfig: this.hookConfig,
      processRequestConfig: this.processRequestConfig,
      processResponseConfig: this.processResponseConfig,
      errorRequestConfig: this.errorRequestConfig,
    });
    const getKey = () => context.crypto.aes?.getAesKey();
    this.aesKey = context.crypto.util?.uint8ArrayToHex(getKey()!);
    this.centralRsaPub = context.atob(
      (params['centralRsaPub'] || '') as string
    );
    this.centralVersion = params['centralVersion'];
    this.edgeRsaPub = context.atob((params['edgeRsaPub'] || '') as string);
    this.edgeVersion = params['edgeVersion'];
    this.featureProtocol = context.featureProtocol;
    this.libraGroup = params['libraGroup'];
    this.observe(this.init());
    // Optional pre-supplied sink uses the same replay path as a later browser owner update.
    if (context.monitor) this.updateMonitor(context.monitor);
  }
  sendSlardarEvent = (value: Record<string, unknown>): unknown => {
    if (this.sendSlardarEventBase) return this.sendSlardarEventBase?.(value);
    this.cacheLogList.slardarEvent.push(value);
    return undefined;
  };
  sendTeaLog = (
    eventName: string,
    params: Record<string, unknown>
  ): unknown => {
    if (this.sendTeaLogBase) return this.sendTeaLogBase?.(eventName, params);
    this.cacheLogList.sendTeaLog.push({ eventName, params });
    return undefined;
  };
  sendSlardarLog = (value: { content: string }): unknown => {
    if (this.sendSlardarLogBase) return this.sendSlardarLogBase?.(value);
    this.cacheLogList.slardarLog.push(value);
    return undefined;
  };
  updateMonitor = (monitor: DesktopDTraitCoreMonitor): void => {
    // F77 replays each queue in order without clearing it, even on later monitor replacements.
    if (monitor.sendTeaLog) {
      this.sendTeaLogBase = monitor.sendTeaLog;
      this.cacheLogList.sendTeaLog.map(value => {
        if (value) this.sendTeaLog(value.eventName, value.params);
        return null;
      });
    }
    if (monitor.sendSlardarEvent) {
      this.sendSlardarEventBase = value => {
        monitor.sendSlardarEvent!(
          Object.assign({}, value, {
            categories: Object.assign(
              { realVersion: '1.0.31' },
              value?.['categories']
            ),
          })
        );
      };
      this.cacheLogList.slardarEvent.map(value => {
        if (value) this.sendSlardarEvent(value);
        return null;
      });
    }
    if (monitor.sendSlardarLog) {
      this.sendSlardarLogBase = monitor.sendSlardarLog;
      this.cacheLogList.slardarLog.map(value => {
        if (value) this.sendSlardarLog(value);
        return null;
      });
    }
  };
  /** Source g/b/m queue, deliberately retaining only diagnostic codes, not raw errors or feature values. */
  recordCollectionError = (name: string): void => {
    this.realmState.collectionErrors.push({ name });
  };
  getOnlineSourceWithLog = async (): Promise<DesktopDTraitFeatureValues> => {
    ++this.realmState.collectionCount;
    const start = this.context.Date.now();
    const source = await this.context.collect();
    try {
      // F26 statistics use num/bool/str; F39 update uses bool/num/str.
      const { num = {}, bool = {}, str = {} } = source;
      const numKeys = Object.keys(num!),
        boolKeys = Object.keys(bool!),
        strKeys = Object.keys(str!);
      const total = numKeys.length + boolKeys.length + strKeys.length;
      this.sendSlardarEvent({
        name: 'feature_collect',
        metrics: {
          duration: this.context.Date.now() - start,
          performance: this.context.performance.now(),
        },
        categories: {
          result: total ? 1 : 0,
          bool_total: boolKeys.length,
          str_total: strKeys.length,
          index: this.realmState.collectionCount,
          total,
          path_len: Array.isArray(this.dTraitHooksPath)
            ? this.dTraitHooksPath.length
            : 0,
        },
      });
      this.realmState.collectionErrors.map(error => {
        this.sendSlardarLog({
          content: '[ft err][' + error.name + ']:[redacted]',
        });
        this.sendSlardarEvent({
          name: 'feat_collect_error',
          categories: { type: error.name },
        });
        return null;
      });
      this.realmState.collectionErrors = [];
    } catch {
      // Statistics/sinks may fail; return the original source and leave unflushed errors queued.
    }
    return source;
  };
  setSource = (): void => {
    this.initPromise = Promise.all([
      this.getOnlineSourceWithLog().then(source => {
        this.updateFeature(source);
        this.collectStatus = true;
        return Promise.resolve(true);
      }),
    ]).then(() => {
      this.updateFeatureScheduled();
      return true;
    });
    this.observe(this.initPromise);
  };
  updateFeatureScheduled = (): void => {
    // F40 never calls its inner F41 or installs a timer. Its shared timer starts null and has no writer.
  };
  updateGetLocalSource = (source: () => Promise<unknown>): void => {
    this.getLocalSource = source;
  };
  getHooksConfig = () => ({
    dTraitHooksHost: this.dTraitHooksHost,
    dTraitHooksPath: this.dTraitHooksPath,
    dTraitUrlRewriteRules: this.dTraitUrlRewriteRules,
  });
  init = async (): Promise<true> => {
    const start = this.context.Date.now();
    this.centralRsaAesKey = await this.rsaEncrypt(
      this.centralRsaPub,
      this.aesKey!
    );
    this.sendSlardarEvent({
      name: 'dtrait_online_init',
      metrics: { duration: this.context.Date.now() - start },
      categories: {
        has_aes_key: this.aesKey ? 1 : 0,
        has_central_rsa_aes_key: this.centralRsaAesKey ? 1 : 0,
        crypto: this.context.crypto.util ? 1 : 0,
      },
    });
    await this.initPromise;
    this.observe(this.getDTrait());
    return Promise.resolve(true);
  };
  getDTrait = async (): Promise<true> => {
    const { centralString, edgeString } = this.featureProtocol.getResult();
    this.centralDTrait = centralString;
    this.edgeDTrait = edgeString;
    return Promise.resolve(true);
  };
  updateFeature = (source: DesktopDTraitFeatureValues): void => {
    // F39 reads all three groups before iterating, includes inherited enumerable keys, and never clears prior values/cache.
    const { bool, num, str } = source;
    for (const key in bool) this.featureProtocol.addBoolFeature(key, bool[key]);
    for (const key in num) this.featureProtocol.addNumFeature(key, num[key]);
    for (const key in str) this.featureProtocol.addStringFeature(key, str[key]);
    // Source does not return/await this Promise; observe rejection without turning it into a ready gate.
    this.observe(this.getDTrait());
  };
  rsaEncrypt = async (
    key: string,
    plaintext: string
  ): Promise<string | undefined> =>
    await this.context.crypto.rsa?.encryptData(key, plaintext);
  aesEncrypt = async (key: string, plaintext: string): Promise<string> => {
    const { cipherText, iv } = (await this.context.crypto.aes?.encryptData(
      key,
      plaintext
    ))!;
    void iv;
    return cipherText;
  };
  getCentralData = async ({ path }: { path: string }): Promise<string> => {
    let rewritten = path;
    await this.initPromise;
    if (!this.centralDTrait) await this.getDTrait();
    if (this.dTraitUrlRewriteRules && this.dTraitUrlRewriteRules.length > 0)
      this.dTraitUrlRewriteRules.forEach(rule => {
        if (
          Array.isArray(rule) &&
          rule.length > 1 &&
          rewritten.indexOf(rule[0]) === 0
        )
          rewritten = rule[1];
      });
    const text = JSON.stringify({
      dtrait: this.centralDTrait,
      timestamp: Math.floor(this.context.Date.now() / 1000),
      sdkVersion: '1.0.31',
      path: rewritten,
    });
    const cipher = await this.aesEncrypt(this.aesKey!, text);
    return this.centralVersion + '_' + this.centralRsaAesKey + '_' + cipher;
  };
  getEdgeData = async ({ path }: { path: string }): Promise<string> => {
    await this.initPromise;
    if (!this.edgeDTrait) await this.getDTrait();
    const text = JSON.stringify({
      dtrait: this.edgeDTrait,
      timestamp: Math.floor(this.context.Date.now() / 1000),
      path,
    });
    const cipher = this.aesEncrypt(this.aesKey!, text);
    this.observe(cipher);
    // F66 omits await. F70 computes this side but never sends it; preserve the source Promise string.
    return this.edgeVersion + '_' + this.edgeRsaAesKey + '_' + cipher;
  };
  getDTraitHeader = async (input: {
    path: string;
  }): Promise<Record<string, string> | null> => {
    const [central] = await Promise.all([
      this.getCentralData(input),
      this.getEdgeData(input),
    ]);
    return central ? { 'x-tt-session-dtrait': central } : null;
  };
  setDTraitToken = (token: string): void => {
    this.dTraitToken = token;
  };
  updateDTraitPath = (paths: string[]): void => {
    this.dTraitHooksPath = ([] as string[]).concat(this.dTraitHooksPath, paths);
  };
  updateDTraitHost = (hosts: string[]): void => {
    this.dTraitHooksHost = ([] as string[]).concat(this.dTraitHooksHost, hosts);
  };
  updateUrlRewriteRules = (rules: unknown[]): void => {
    this.dTraitUrlRewriteRules = ([] as unknown[]).concat(
      this.dTraitUrlRewriteRules,
      rules
    );
  };
  hookConfig = ({
    pathname,
    host,
  }: DesktopDTraitRequestConfig): { needProxy: boolean } => {
    if (this.realmState.hookLogCount < 3) {
      this.realmState.hookLogCount++;
      this.sendSlardarEvent({
        name: 'dtrait_request_hook',
        metrics: { count: 1, duration: this.context.performance.now() },
        categories: {
          pathname,
          path_len: Array.isArray(this.dTraitHooksPath)
            ? this.dTraitHooksPath.length
            : 0,
        },
      });
    }
    let needProxy = false;
    for (let i = 0; i < this.dTraitHooksHost.length; i++)
      if (host && host.indexOf(this.dTraitHooksHost[i]!) === 0) {
        needProxy = true;
        break;
      }
    for (let i = 0; i < this.dTraitHooksPath.length; i++)
      if (pathname.indexOf(this.dTraitHooksPath[i]!) === 0) {
        needProxy = true;
        break;
      }
    return { needProxy };
  };
  processRequestConfig = async (
    config: DesktopDTraitRequestConfig,
    meta: DesktopDTraitRequestMeta
  ): Promise<DesktopDTraitRequestConfig> => {
    const { pathname, host } = config,
      start = this.context.Date.now();
    let isCache = 0,
      headers: Record<string, string> | null = null;
    try {
      if (
        this.dTraitPathCache?.[pathname] &&
        start - this.dTraitPathCache?.[pathname]?.time < 600_000
      ) {
        headers = this.dTraitPathCache[pathname]!.val;
        isCache = 1;
      } else {
        headers = await this.getDTraitHeader({ path: pathname });
        if (this.collectStatus)
          this.dTraitPathCache[pathname] = { time: start, val: headers };
      }
      const duration = this.context.Date.now() - start,
        length = headers?.['x-tt-session-dtrait']!.length;
      if (!quietPaths.includes(pathname)) {
        this.sendSlardarEvent({
          name: 'dtrait_request',
          metrics: { duration },
          categories: {
            pathname,
            host,
            isCache,
            centralDTraitLen: length,
            result: headers ? 1 : 0,
          },
        });
        meta.ucProxyParam = Object.assign({}, meta?.ucProxyParam || {}, {
          startTime: this.context.Date.now(),
        });
      }
    } finally {
      // Source F35 finally returns even after generation/telemetry failure. No claim of successful signing.
      config.headers = Object.assign({}, config.headers || {}, headers || {});
      // eslint-disable-next-line no-unsafe-finally -- Exact source finally-return; explicit signing entry still rejects.
      return Promise.resolve(config);
    }
  };
  processResponseConfig = async (
    response: {
      config: DesktopDTraitRequestConfig;
      headers?: Record<string, unknown> | string | null;
      httpCode?: number;
    },
    meta?: DesktopDTraitRequestMeta
  ): Promise<boolean> => {
    const { config, httpCode } = response,
      { host, pathname } = config;
    if (!response?.headers || typeof response.headers === 'string') return true;
    const token = '' + (response.headers?.['x-tt-session-dtrait-token'] || ''),
      logid = '' + (response.headers?.['x-tt-logid'] || 'unknown');
    if (token) this.setDTraitToken(token);
    if (!quietPaths.includes(pathname))
      try {
        this.sendTeaLog('web_bd_ticket_dtrait_response', {
          duration: meta?.ucProxyParam?.['startTime']
            ? this.context.Date.now() -
              (meta.ucProxyParam['startTime'] as number)
            : 0,
          pathname,
          host,
          has_dTraitToken: token ? 1 : 0,
          logid,
          http_code: httpCode,
          performance_time: this.context.performance?.now(),
        });
        this.sendSlardarEvent({
          name: 'dtrait_response',
          metrics: {
            count: 1,
            duration: meta?.ucProxyParam?.['startTime']
              ? this.context.Date.now() -
                (meta.ucProxyParam['startTime'] as number)
              : 0,
          },
          categories: {
            pathname,
            path: pathname,
            host,
            has_dTraitToken: token ? 1 : 0,
            logId: logid,
            http_code: httpCode,
          },
        });
      } catch {
        /* Source response telemetry errors are ignored after token update. */
      }
    return true;
  };
  private observe(task: Promise<unknown>): void {
    void task.catch(error => {
      try {
        this.context.onBackgroundError?.(error);
      } catch {
        /* Detached observation only. */
      }
    });
  }
  errorRequestConfig = ({
    config,
    instance,
    errType,
  }: DesktopDTraitRequestError): void => {
    const { pathname, host } = config;
    try {
      this.sendSlardarEvent({
        name: 'dtrait_request_error',
        metrics: {
          count: 1,
          duration: instance?.ucProxyParam?.['startTime']
            ? this.context.Date.now() -
              (instance.ucProxyParam['startTime'] as number)
            : 0,
        },
        categories: { pathname, host, errType },
      });
      // Deliberate privacy boundary: F38 serializes err, which may include request credentials.
      this.sendSlardarLog({
        content: '[request error]: [redacted]',
      });
    } catch {
      /* F38 ignores telemetry errors; transport failure propagation belongs to the transport. */
    }
  };
}
