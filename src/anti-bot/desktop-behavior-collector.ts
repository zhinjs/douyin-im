import { DesktopBehaviorState, type DesktopBehaviorPoint, type DesktopHoverPoint } from './desktop-behavior.js';

interface MouseInput { readonly clientX: number; readonly clientY: number }
interface TouchInput { readonly touches?: { item(index: number): MouseInput | null } | null }
interface HoverElement { readonly nodeName: string; readonly innerText: string }
interface OrientationInput { readonly beta?: number | null; readonly gamma?: number | null; readonly alpha?: number | null }

export interface DesktopBehaviorInputContext {
  readonly performance: { now(): number };
  readonly Date: { now(): number };
  readonly Math: { random(): number };
  readonly HTMLElement: abstract new (...args: never[]) => HoverElement;
  readonly encodeURI: typeof encodeURI;
  readonly document: {
    readonly visibilityState: string;
    addEventListener(type: string, listener: (event: unknown) => void): void;
  };
  readonly window: {
    readonly self: unknown;
    readonly top: unknown;
    requestAnimationFrame(callback: (time: number) => void): unknown;
    addEventListener(type: string, listener: (event: unknown) => void): void;
  };
}

/**
 * Same seven-queue state with the source's DOM input adapter. Construction starts
 * frame measurement; startCollection() installs D's listeners, without its own once
 * guard (DesktopReportLifecycle owns that guard). No synthetic activity or network.
 */
export class DesktopBehaviorCollector extends DesktopBehaviorState {
  constructor(private readonly context: DesktopBehaviorInputContext) {
    super(context.performance.now());
    this.queueFrame();
  }

  readonly startCollection = (): void => {
    this.context.document.addEventListener('mousemove', event => this.recordMove(this.mousePoint(event)));
    this.context.document.addEventListener('touchmove', event => this.recordMove(this.touchPoint(event)));
    this.context.document.addEventListener('mousedown', event => this.recordClickStart(this.mousePoint(event)));
    this.context.document.addEventListener('touchstart', event => this.recordClickStart(this.touchPoint(event)));
    this.context.document.addEventListener('mouseup', event => this.recordClickEnd(this.mousePoint(event)));
    this.context.document.addEventListener('touchend', event => this.recordClickEnd(this.touchPoint(event)));
    this.context.document.addEventListener('keydown', () => this.recordKeySample(() => this.context.Date.now()));
    this.context.document.addEventListener('mouseover', event => this.recordHover(this.hoverPoint(event, 1)));
    this.context.document.addEventListener('mouseout', event => this.recordHover(this.hoverPoint(event, 0)));
    if (this.context.window.self === this.context.window.top) {
      this.context.window.addEventListener('deviceorientation', event => {
        const input = event as OrientationInput;
        const x = input.beta, y = input.gamma, z = input.alpha;
        this.recordOrientationSample(x, y, z, () => this.context.Date.now(), () => this.context.Math.random());
      });
    }
    this.context.document.addEventListener('visibilitychange', () => this.recordVisibilitySample(
      () => this.context.document.visibilityState, () => this.context.Date.now(),
    ));
  };

  private queueFrame(): void {
    this.context.window.requestAnimationFrame(() => {
      this.recordFrame(() => this.context.performance.now());
      if (!this.frameSamplingComplete) this.queueFrame();
    });
  }

  private mousePoint(event: unknown): DesktopBehaviorPoint {
    const input = event as MouseInput;
    return { x: input.clientX, y: input.clientY, ts: this.context.Date.now() };
  }

  private touchPoint(event: unknown): DesktopBehaviorPoint | undefined {
    const point = (event as TouchInput).touches?.item(0);
    if (point) return this.mousePoint(point);
    return undefined;
  }

  private hoverPoint(event: unknown, mode: 0 | 1): DesktopHoverPoint | undefined {
    const target = (event as { target: unknown }).target;
    if (!(target instanceof this.context.HTMLElement)) return undefined;
    const nodeName = target.nodeName;
    if (nodeName == 'BODY' || nodeName == 'HTML') return undefined;
    let text = '';
    try { text = Reflect.apply(this.context.encodeURI, null, [target.innerText.slice(0, 15)]); } catch { /* Original only catches text/encoding errors. */ }
    if (text) return { target: text, mode, ts: this.context.Date.now() };
    return undefined;
  }
}
