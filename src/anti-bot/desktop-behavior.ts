import { type DesktopBehaviorReportSources } from './desktop-report-lifecycle.js';

export interface DesktopBehaviorPoint {
  readonly x: number;
  readonly y: number;
  /** Date.now() at event handling, not event.timeStamp or performance.now(). */
  readonly ts: number;
}

export interface DesktopOrientationPoint extends DesktopBehaviorPoint { readonly z: number }
export interface DesktopVisibilityPoint { readonly v: 1 | 2; readonly ts: number }
export interface DesktopHoverPoint {
  /** Already encodeURI(innerText.slice(0, 15)); target validation belongs to the DOM adapter. */
  readonly target: string;
  readonly mode: 0 | 1;
  readonly ts: number;
}

export interface DesktopBehaviorSnapshot {
  readonly moves: readonly DesktopBehaviorPoint[];
  readonly clickStarts: readonly DesktopBehaviorPoint[];
  readonly keydowns: readonly { readonly ts: number }[];
  readonly clickEnds: readonly DesktopBehaviorPoint[];
  readonly windowStates: readonly DesktopVisibilityPoint[];
  readonly orientations: readonly DesktopOrientationPoint[];
  readonly focus: readonly DesktopHoverPoint[];
}

/**
 * BDMS 1.0.1.7 seven-queue behavior and q-state for one execution context. Input events and frames must
 * come from that context (or a labeled fixture); this class creates no activity,
 * timers or network traffic. Registration mode/DOM input conversion belong to
 * the caller. Reports and q read the same queues without consuming them.
 */
export class DesktopBehaviorState {
  private readonly moves: DesktopBehaviorPoint[] = [];
  private readonly clickStarts: DesktopBehaviorPoint[] = [];
  private readonly keydowns: { ts: number }[] = [];
  private readonly clickEnds: DesktopBehaviorPoint[] = [];
  private readonly windowStates: DesktopVisibilityPoint[] = [];
  private readonly orientations: DesktopOrientationPoint[] = [];
  private readonly focus: DesktopHoverPoint[] = [];
  private frameCount = 0;
  private interval = 16;

  constructor(private readonly startPerformanceTime: number) {}

  get sampleIntervalMs(): number { return this.interval; }

  /** RAF time sample or lazy performance.now reader (only invoked on frame 60); never RAF's timestamp argument. */
  recordFrame(performanceTime: number | (() => number)): void {
    if (this.frameCount >= 60) return;
    this.frameCount++;
    if (this.frameCount === 60) {
      const time = typeof performanceTime === 'function' ? performanceTime() : performanceTime;
      this.interval = (time - this.startPerformanceTime) / 60;
    }
  }

  protected get frameSamplingComplete(): boolean { return this.frameCount >= 60; }

  /** Mouse point or first remaining touch, normalized by the input adapter. */
  recordMove(point: DesktopBehaviorPoint | undefined): void {
    this.recordPoint(this.moves, point, 400);
  }

  recordClickStart(point: DesktopBehaviorPoint | undefined): void {
    this.recordPoint(this.clickStarts, point, 100);
  }

  recordClickEnd(point: DesktopBehaviorPoint | undefined): void {
    this.recordPoint(this.clickEnds, point, 200);
  }

  recordVisibility(visibilityState: string, ts: number): void {
    this.recordVisibilitySample(() => visibilityState, () => ts);
  }

  protected recordVisibilitySample(readVisibility: () => string, now: () => number): void {
    const previous = this.windowStates.at(-1);
    const v = readVisibility() === 'visible' ? 1 : 2;
    const ts = now();
    if (previous?.v === v) return;
    this.push(this.windowStates, { v, ts }, 50);
  }

  /** Mouseover/out normalization is supplied by the context's DOM adapter. */
  recordHover(point: DesktopHoverPoint | undefined): void {
    if (!point) return;
    if (point.mode === 1) { this.push(this.focus, { ...point }, 50); return; }
    const previous = this.focus.at(-1);
    if (!previous) return;
    if (point.ts - previous.ts >= 350) this.push(this.focus, { ...point }, 50);
    else this.focus.shift(); // Original ring pop removes the oldest, not the most recent hover.
  }

  /** x/y/z correspond to beta/gamma/alpha. Use this context's shared random source. */
  recordOrientation(point: DesktopOrientationPoint, random: () => number): void {
    this.recordOrientationSample(point.x, point.y, point.z, () => point.ts, random);
  }

  protected recordOrientationSample(x: number | null | undefined, y: number | null | undefined, z: number | null | undefined, now: () => number, random: () => number): void {
    if (!x || !y || !z) return;
    const previous = this.orientations.at(-1);
    const point = { x, y, z, ts: now() };
    const interval = random() * 90000 + 60000;
    if (previous && point.ts - previous.ts < interval) return;
    this.push(this.orientations, { x: point.x, y: point.y, z: point.z, ts: point.ts }, 50);
  }

  recordKeydown(ts: number): void {
    this.recordKeySample(() => ts);
  }

  protected recordKeySample(now: () => number): void {
    const previous = this.keydowns.at(-1);
    const ts = now();
    if (previous?.ts === ts) return;
    this.push(this.keydowns, { ts }, 100);
  }

  /** Reading or changing mode does not clear queues or stop input collection. */
  mask(trackMode = 0): number {
    if (trackMode !== 0) return 0;
    let result = this.clickStarts.length ? 0 : 4;
    if (!this.moves.length) result |= 2;
    else if (this.moves.length > 1) {
      let sum = 0;
      for (let index = 1; index < this.moves.length; index++) {
        const previous = this.moves[index - 1]!, point = this.moves[index]!;
        sum += Math.sqrt((point.x - previous.x) ** 2 + (point.y - previous.y) ** 2) / (point.ts - previous.ts);
      }
      if (sum / (this.moves.length - 1) > 18) result |= 16;
    }
    if (!this.keydowns.length) result |= 8;
    else if (this.keydowns.length >= 6) {
      let sum = 0;
      for (let index = 1; index < this.keydowns.length; index++) {
        sum += 1 / (this.keydowns[index]!.ts - this.keydowns[index - 1]!.ts);
      }
      if (sum / (this.keydowns.length - 1) > 0.2) result |= 32;
    }
    return result;
  }

  getSnapshot(): DesktopBehaviorSnapshot {
    return {
      moves: this.moves.map(point => ({ ...point })),
      clickStarts: this.clickStarts.map(point => ({ ...point })),
      keydowns: this.keydowns.map(point => ({ ...point })),
      clickEnds: this.clickEnds.map(point => ({ ...point })),
      windowStates: this.windowStates.map(point => ({ ...point })),
      orientations: this.orientations.map(point => ({ ...point })),
      focus: this.focus.map(point => ({ ...point })),
    };
  }

  /** Live report views of these same queues; each data() is a non-consuming value snapshot. */
  createReportSources(screen: () => unknown): DesktopBehaviorReportSources {
    const view = <T extends object>(queue: T[]) => ({ data: () => queue.map(point => ({ ...point })) });
    return {
      move: view(this.moves), click: view(this.clickStarts), clickEnd: view(this.clickEnds),
      keyboard: view(this.keydowns), windowState: view(this.windowStates), gyro: view(this.orientations),
      focus: view(this.focus), screen,
    };
  }

  private recordPoint(queue: DesktopBehaviorPoint[], point: DesktopBehaviorPoint | undefined, capacity: number): void {
    if (!point) return;
    const previous = queue.at(-1);
    if (previous && (point.ts - previous.ts <= this.interval || (point.x === previous.x && point.y === previous.y))) return;
    this.push(queue, { x: point.x, y: point.y, ts: point.ts }, capacity);
  }

  private push<T>(queue: T[], value: T, capacity: number): void {
    if (queue.length === capacity) queue.shift();
    queue.push(value);
  }
}
