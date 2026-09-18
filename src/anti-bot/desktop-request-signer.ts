import { setDesktopProperty } from './desktop-property-write.js';
import { generateDesktopABogusWithRuntime } from './aBogus.js';
import { DesktopEnvironmentState, type DesktopEnvironmentContext } from './desktop-environment-mask.js';
import { DesktopBehaviorState } from './desktop-behavior.js';
import { buildDesktopFingerprint, type DesktopFingerprintContext } from './desktop-fingerprint.js';

export type DesktopSigningContext = DesktopEnvironmentContext & DesktopFingerprintContext & {
  readonly window: { readonly onwheelx?: { readonly _Ax?: unknown } };
  readonly navigator: {
    readonly userAgent: string;
    /** Must belong to this execution context; sign() writes its vendorSubs, as the source does. */
    readonly __proto__: { vendorSubs?: { ink: number } };
    readonly vendorSubs?: { readonly ink?: number };
  };
  readonly Date: { now(): number };
  readonly Math: { random(): number };
};

export interface DesktopSigningConfig {
  readonly aid: number;
  readonly pageId: number;
  readonly track: { readonly mode: number };
}

/**
 * One-context BDMS .7 request wrapper. Does not install hooks, listeners, report
 * timers or token storage. The caller supplies actual bindings and behavior input.
 */
export class DesktopRequestSigner {
  private readonly environment: DesktopEnvironmentState;

  constructor(
    private readonly context: DesktopSigningContext,
    private readonly config: DesktopSigningConfig,
    private readonly behavior: DesktopBehaviorState,
    environment?: DesktopEnvironmentState,
  ) {
    this.environment = environment ?? new DesktopEnvironmentState(context);
  }

  /** Query serialization and existing signature keys are owned by the specific request hook. */
  sign(query: string, body: unknown, contentType?: string): string {
    // RHS is evaluated before resolving navigator.__proto__ on the assignment's LHS.
    const vendorSubs = { ink: this.context.Date.now() - 1 };
    const prototype = this.context.navigator.__proto__;
    if (prototype == null) throw new TypeError('BDMS navigator prototype is missing');
    // The complete bundle is strict: rejected prototype writes throw.
    setDesktopProperty(Object(prototype), 'vendorSubs', vendorSubs, prototype);
    const environmentMask = this.environment.mask();
    const mode = this.config.track.mode;
    const behaviorMask = mode !== 0 ? 0 : this.behavior.mask();
    const normalizedBody = typeof body !== 'string' || (contentType && contentType.indexOf('multipart/form-data') != -1) ? '' : body;
    let userAgent = this.context.navigator.userAgent;
    if (userAgent.indexOf('baiduboxapp') >= 0) userAgent = userAgent.replace(/\s(EasyBrowser)?[Ww]ebCore=0x[a-z0-9]{9}$/, '');
    if (userAgent.indexOf('AlipayClient') >= 0) userAgent = userAgent.replace(/\sChannelId\(\d+\)/, '');
    return generateDesktopABogusWithRuntime({ query, body: normalizedBody, userAgent, environmentMask, behaviorMask }, {
      flag: () => this.readFlag(), now: () => this.context.Date.now(),
      ink: () => this.context.navigator.vendorSubs?.ink,
      pageId: () => this.config.pageId, aid: () => this.config.aid,
      fingerprint: () => buildDesktopFingerprint(this.context),
      random: () => this.context.Math.random(),
    });
  }

  private readFlag(): 3 | 11 | 12 {
    if (this.context.window.onwheelx && this.context.window.onwheelx._Ax) {
      return Object.getOwnPropertyDescriptor(this.context.window.onwheelx, '_Ax')?.writable === false ? 3 : 12;
    }
    return 11;
  }
}
