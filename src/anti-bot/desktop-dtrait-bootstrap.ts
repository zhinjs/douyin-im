import {
  DesktopDTraitParameters,
  type DesktopDTraitParametersContext,
} from './desktop-dtrait-parameters.js';
import type { DesktopWebSecureDTraitOptions } from './desktop-web-secure-sdk.js';

export interface DesktopDTraitMonitor {
  init(
    value: Record<string, unknown>,
    instances: { slardarInstance?: unknown; teaInstance?: unknown }
  ): unknown;
  setConfig(value: Record<string, unknown>): unknown;
  setWebId?(value: string | undefined): void;
  sendSlardarEvent(value: Record<string, unknown>): unknown;
  sendSlardarLog(value: { content: string }): unknown;
  sendTeaLog(...args: unknown[]): unknown;
}
export interface DesktopDTraitCore {
  getInstance(
    params: Record<string, unknown>,
    options: Record<string, unknown>
  ): unknown;
}
export interface DesktopDTraitScript {
  type: string;
  src: string;
  readonly readyState?: string;
  onreadystatechange?: (() => void) | null;
  onload?: (() => void) | null;
  onerror?: ((error: unknown) => void) | null;
}
export interface DesktopDTraitBootstrapContext {
  /** Optional host-owned local core. Source CDN behavior is retained when absent. */
  readonly localCore?: {
    load(version: unknown, aid: number | string | undefined): Promise<boolean>;
    resolve(params: Record<string, unknown>): DesktopDTraitCore;
  };
  readonly parameters: DesktopDTraitParametersContext;
  readonly window: {
    DTraitSDK?: DesktopDTraitCore | { default: DesktopDTraitCore };
    readonly DTraitUcAesEncrypt?: unknown;
    readonly DTraitUcRsaEncrypt?: unknown;
    readonly DTraitUcCryptoJSUtil?: unknown;
  };
  readonly document: {
    createElement(tag: 'script'): DesktopDTraitScript;
    getElementsByTagName(
      tag: 'head'
    ): ArrayLike<{ appendChild(script: DesktopDTraitScript): unknown }>;
  };
  readonly monitor: DesktopDTraitMonitor;
  readonly monitorInstances?: {
    slardarInstance?: unknown;
    teaInstance?: unknown;
  };
  readonly performance?: { now?(): number };
}

/** Un/Ln and jn/dr/pr/vr. Explicit browser realm; calling start can load remote scripts.
 * Does not install module-level crypto globals or invent the external DTrait core.
 */
export class DesktopDTraitBootstrap {
  readonly parameters: DesktopDTraitParameters;
  private coreResult: unknown = false;
  private loaded = false;
  private loading: Promise<boolean> | undefined;
  private readonly builtin: Record<string, unknown> = {
    urlVersion: '1.0.31',
    centralRsaPub:
      'LS0tLS1CRUdJTiBSU0EgUFVCTElDIEtFWS0tLS0tCk1JSUJDZ0tDQVFFQTQrZHZ2WTd1TStvcGMrbkxHL0R1bVNlRm83YVZjSW0xTE8rbVVJcldwclJ6UDBhMUdwRVEKNHF0TzlNUmYvbHdFSXgzOCs0Qlo0WE9HemV2VnR1VXZmSU9VRTdBVHRRVzdGS0pmNVBuU0xDSTYvazB2bDFGQwpMVVNWbUVQNnFQSnJJalo0elhvcWkzeXVOWisxb2RiUkEvL0dIZ2NnU3l5eWFMcXp3amtwV0dYb3VNWW12WXNTCnBway9mdjJFV0FCc3RQTnhXYTRFT0JDYWRUVVBrWE5RNzZOQkVQOXh6ZkpTMjB3aUR2MW9TL3ZLdnJTVXBXY0oKbmF6a2tCdnFRYmJBcVZiUUZURi9EUGlrcHB1NlpUNmxHSVh2SktDcmVlRmlIQTJxSzZ0UzE4U1dWSFc5QVJ6MQorcGpCMWVxSUlZdG9oV3BUMkI0ME9DNE84dFZlQkFuYmlRSURBUUFCCi0tLS0tRU5EIFJTQSBQVUJMSUMgS0VZLS0tLS0=',
    centralVersion: 'd0',
    edgeRsaPub:
      'LS0tLS1CRUdJTiBSU0EgUFVCTElDIEtFWS0tLS0tCk1JSUJDZ0tDQVFFQXlFQkQ0MXQzcWpqL1NOaU5rT3BBbnNGdGZKZ0F5MGF5VTZCbEJ3RS9EZVZjNkdWV0xWUk4KWjdiMWRuRHVmQk5iUm1XQjlZeWVyYm1FOFFDM2lPOXp1NVFWd2x4SGV2ZEN0ZFFyeDZpQzF3QVRoaHFjdTNIYgprZ1dsazZ1Ylk5MXRvRFhNd0k2WGdmRUoyVEJsdHVSbklXRjR5RDVEaEc2c3lSSVNmNTRMWGY0WjgzbzlGcXNvCmlsNkV3cVZCbEU3dXlIY3dJOTA5WDg4Rlc3MXFLdmJMU040OGJlQ0EwbzFmZitqbmhRakNBTDZqbUR2dUhJeWEKUk1vYm1wRFVOLzQ3L3NHbDNzNDlFOEZFSEFXUmk5d1cyc2NZUDBJTkJXUlR5RlRHcG9GUGlqekJFUndnYzdrWQozVno3ZytSMXd2RkxUSEVITEtYUWFwTHpEMWR5Uk81YUt3SURBUUFCCi0tLS0tRU5EIFJTQSBQVUJMSUMgS0VZLS0tLS0K',
    edgeVersion: 'd0',
    dTraitVersion: '0',
  };
  constructor(private readonly context: DesktopDTraitBootstrapContext) {
    this.parameters = new DesktopDTraitParameters(context.parameters);
  }
  setWebId = (value: string | undefined): void => {
    this.context.monitor.setWebId?.(value);
  };

  start = async (options: DesktopWebSecureDTraitOptions): Promise<unknown> => {
    const {
      aid = 6383,
      consumerPathList = [],
      urlRewriteRules = [],
      consumerHostList = [],
      reportAppLog,
      webId,
      libraGroup = '',
      delayCollect = 0,
      useBuildIn = false,
    } = options;
    const { monitor, window } = this.context,
      now = () => this.context.parameters.Date.now();
    monitor.init(
      {
        appId: aid,
        commonParams: { dTraitVersion: '1.0.23' },
        webId,
        reportAppLog,
      },
      {
        slardarInstance: this.context.monitorInstances?.slardarInstance,
        teaInstance: this.context.monitorInstances?.teaInstance,
      }
    );
    let params: Record<string, unknown> = {
      centralVersion: '',
      dTraitVersion: '',
      edgeVersion: '',
      urlVersion: '',
      centralRsaPub: '',
      edgeRsaPub: '',
    };
    // Source awaits a separate async branch (_/S) before setConfig/getInstance.
    // Keep that boundary: concurrent starts emit both loader metrics before either core call.
    const initialize = async () => {
      if (useBuildIn) {
        const start = now();
        let cdnResult = 0;
        try {
          if (!window.DTraitSDK) await this.loadCore('1.0.31', options.aid);
          params = { ...this.builtin };
          cdnResult = 1;
        } catch {
          /* Source continues to final getInstance, including after loader failure. */
        }
        monitor.sendSlardarEvent({
          name: 'dtrait_sdk_init_local',
          metrics: {
            duration: now() - start,
            performance: this.context.performance?.now?.() || 0,
          },
          categories: { cdn_result: cdnResult, ...this.cryptoPresence() },
        });
      } else {
        const start = now();
        params = await this.parameters.get(aid).catch(error => {
          monitor.sendSlardarLog({
            content: `[getDTraitParamsWithCache error]: ${error}`,
          });
          return this.builtin;
        });
        const duration = now() - start;
        if (!this.coreResult) {
          let urlDuration = 0,
            cdnResult = 0;
          try {
            const begin = now();
            await this.loadCore(params['urlVersion'], options.aid);
            urlDuration = now() - begin;
            cdnResult = 1;
          } catch {
            /* Source still tries core. */
          }
          monitor.sendSlardarEvent({
            name: 'dtrait_sdk_init',
            metrics: {
              url_duration: urlDuration,
              int_duration: duration,
              performance: this.context.performance?.now?.() || 0,
            },
            categories: {
              dataFrom: params['dataFrom'],
              cdn_result: cdnResult,
              ...this.cryptoPresence(),
            },
          });
        }
      }
    };
    await initialize();
    monitor.setConfig({
      centralVersion: params?.['centralVersion'],
      dTraitVersion: params?.['dTraitVersion'],
      edgeVersion: params?.['edgeVersion'],
      urlVersion: params?.['urlVersion'],
      dTraitContainerSdkVersion: '1.0.23',
      useBuildIn: Number(useBuildIn || false),
    });
    const module = (
      this.context.localCore
        ? this.context.localCore.resolve(params)
        : window.DTraitSDK
    ) as DesktopDTraitCore & {
      default?: DesktopDTraitCore;
    };
    // Preserve assignment before Promise adoption: rejection does not clear the truthy Ln value.
    return (this.coreResult = (module.default || module).getInstance(params, {
      dTraitPath: consumerPathList,
      dTraitHost: consumerHostList,
      urlRewriteRules,
      containerSdkVersion: '1.0.23',
      libraGroup,
      delayCollect,
      monitor: {
        sendSlardarEvent: monitor.sendSlardarEvent,
        sendSlardarLog: monitor.sendSlardarLog,
        sendTeaLog: monitor.sendTeaLog,
      },
    }));
  };

  private cryptoPresence(): Record<string, number> {
    const window = this.context.window;
    return {
      aesEncrypt: window.DTraitUcAesEncrypt ? 1 : 0,
      rsaEncrypt: window.DTraitUcRsaEncrypt ? 1 : 0,
      cryptoJSUtil: window.DTraitUcCryptoJSUtil ? 1 : 0,
    };
  }

  private loadCore(
    version: unknown,
    aid: number | string | undefined
  ): Promise<boolean> {
    if (this.loaded) return Promise.resolve(true);
    if (!this.loading)
      this.loading = new Promise((resolve, reject) => {
        this.loadWithRetry(version, aid)
          .then(value => {
            if (value) this.loaded = true;
            resolve(value);
            this.loading = undefined;
          })
          .catch(error => {
            reject(error);
            this.loading = undefined;
          });
      });
    return this.loading;
  }

  private async loadWithRetry(
    version: unknown,
    aid: number | string | undefined
  ): Promise<boolean> {
    // Local resources have no CDN retry. Resolution is checked again before each
    // getInstance because source's successful-load memo is not version-keyed.
    if (this.context.localCore)
      return this.context.localCore.load(version, aid);
    // No coercion before startsWith; a truthy non-string fails just as in jn.
    const url =
      version && (version as string).startsWith('http')
        ? (version as string)
        : `${aid === 6383 ? 'https://lf-douyin-pc-web.douyinstatic.com' : 'https://lf-ucenter-web.yhgfb-cn-static.com'}/obj/passport-fe/ucenter_fe/@byted/uc-secure-dtrait-core/${version}/dist/index.umd.production.js`;
    try {
      for (let remaining = 5; ; remaining--) {
        try {
          await this.loadScript(url);
          return true;
        } catch (error) {
          if (!remaining) throw error;
        }
      }
    } catch (error) {
      this.context.monitor.sendSlardarLog({
        content: `[loadResource error]: ${error}`,
      });
      throw error;
    }
  }

  private loadScript(url: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const script = this.context.document.createElement('script');
      script.type = 'text/javascript';
      script.src = url;
      this.context.document
        .getElementsByTagName('head')[0]!
        .appendChild(script);
      if (script.readyState)
        script.onreadystatechange = () => {
          if (
            script.readyState === 'complete' ||
            script.readyState === 'loaded'
          ) {
            script.onreadystatechange = null;
            resolve(true);
          }
        };
      else {
        script.onload = () => resolve(true);
        script.onerror = reject;
      }
    });
  }
}
