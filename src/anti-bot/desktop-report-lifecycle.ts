import { type DesktopReportSender } from './desktop-report.js';

export interface DesktopReportLifecycleContext {
  readonly performance: { now(): number };
  readonly Date: { now(): number };
  readonly document: { addEventListener(type: string, listener: () => void): void };
  setTimeout(callback: () => void, delay: number): unknown;
  setInterval(callback: () => void, delay: number): unknown;
  requestAnimationFrame(callback: (time: number) => void): unknown;
}

/** Already-normalized shared BDMS config; start() does not implement bdms.init(). */
export interface DesktopReportScheduleConfig {
  readonly dump: boolean;
  readonly ddrt: number;
  readonly track: { readonly mode: number; readonly delay: number };
}

export interface DesktopBehaviorReportSources {
  readonly move: { data(): unknown };
  readonly click: { data(): unknown };
  readonly clickEnd: { data(): unknown };
  readonly keyboard: { data(): unknown };
  readonly windowState: { data(): unknown };
  readonly gyro: { data(): unknown };
  readonly focus: { data(): unknown };
  screen(): unknown;
}

/**
 * BDMS .7 report scheduling and behavior envelope. Sources must be the real
 * context's collectors: no empty queue defaults, fabricated events or device data.
 * start() registers host resources; their lifetime is owned by the supplied host.
 */
export class DesktopReportLifecycle {
  private deviceStarted = false;
  private behaviorStarted = false;
  private visibilityStarted = false;
  private behaviorReported = false;
  private lastBehaviorTime: number;

  constructor(
    private readonly context: DesktopReportLifecycleContext,
    private readonly config: DesktopReportScheduleConfig,
    private readonly sources: DesktopBehaviorReportSources,
    private readonly sender: Pick<DesktopReportSender, 'send'>,
    private readonly deviceReport: () => void,
    private readonly startCollection: () => void,
  ) {
    this.lastBehaviorTime = context.performance.now();
  }

  /** Repeated calls install each kind at most once; existing delays are not rescheduled. */
  start(): void {
    if (this.config.dump && !this.visibilityStarted) {
      this.visibilityStarted = true;
      this.context.document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    // Re-read mode at each branch: the original does not snapshot the config.
    if (this.config.track.mode === 1) return;
    if (this.config.track.mode === 2) { this.startDevice(); return; }
    if (this.config.track.mode === 0) {
      this.startDevice();
      if (!this.behaviorStarted) {
        this.behaviorStarted = true;
        Reflect.apply(this.startCollection, null, []);
        Reflect.apply(this.context.setInterval, null, [this.reportBehavior, this.config.track.delay * 1000]);
      }
    }
  }

  /** Used by the behavior interval and matching business requests, independent of init mode. */
  readonly reportBehavior = (): void => {
    const now = this.context.performance.now();
    if (now - this.lastBehaviorTime >= 3000 || !this.behaviorReported) {
      this.behaviorReported = true;
      this.lastBehaviorTime = now;
      const report = this.collectBehavior();
      Reflect.apply(this.context.requestAnimationFrame, null, [() => this.sender.send(report)]);
    }
  };

  private readonly onVisibilityChange = (): void => {
    // Original handler does not inspect document.visibilityState.
    if (!this.behaviorReported) {
      this.behaviorReported = true;
      this.sender.send(this.collectBehavior(), true);
    }
  };

  private startDevice(): void {
    if (!this.deviceStarted) {
      this.deviceStarted = true;
      Reflect.apply(this.context.setTimeout, null, [this.deviceReport, this.config.ddrt * 1000]);
    }
  }

  private collectBehavior() {
    return {
      wID: { msgType: 2, privacyMode: 0, timestamp: this.context.Date.now() + '' },
      behavior: {
        beMove: this.sources.move.data(), beClick: this.sources.click.data(),
        beClickEnd: this.sources.clickEnd.data(), beKeyboard: this.sources.keyboard.data(),
        windowState: this.sources.windowState.data(), gyro: this.sources.gyro.data(),
        focus: this.sources.focus.data(), screen: Reflect.apply(this.sources.screen, null, []),
      },
    };
  }
}
