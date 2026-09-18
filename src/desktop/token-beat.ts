import type { PassportApiResponse, PassportTokenBeatScene } from './types.js';

/** Desktop xh activity scheduler; one instance belongs to one account lifecycle. */
export class PassportTokenBeat {
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private throttle?: ReturnType<typeof setTimeout>;
  private operated = false;

  constructor(
    private readonly request: (scene: PassportTokenBeatScene, signal: AbortSignal) => Promise<PassportApiResponse>,
    private readonly onExpired: () => void,
  ) {}

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    this.startBeating('boot');
  }

  /** Explicit host activity, equivalent to the renderer's shared leading throttle. */
  activity(): void {
    if (!this.controller || this.throttle) return;
    this.throttle = setTimeout(() => { delete this.throttle; }, 10_000);
    this.throttle.unref?.();
    if (this.timer) this.operated = true;
    else this.startBeating('active');
  }

  /** Terminal account teardown, unlike Desktop's idle pause which keeps its listeners. */
  stop(): void {
    const controller = this.controller;
    delete this.controller;
    this.pause();
    clearTimeout(this.throttle); delete this.throttle;
    controller?.abort(new Error('Session 续期已停止'));
  }

  private pause(): void {
    clearInterval(this.timer); delete this.timer;
    this.operated = false;
  }

  private startBeating(scene: PassportTokenBeatScene): void {
    if (this.timer || !this.controller) return;
    this.timer = setInterval(() => {
      if (!this.operated) { this.pause(); return; }
      this.operated = false;
      void this.beat('polling');
    }, 600_000);
    this.timer.unref?.();
    void this.beat(scene);
  }

  private async beat(scene: PassportTokenBeatScene): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    let response: PassportApiResponse;
    try { response = await this.request(scene, controller.signal); }
    catch { return; } // Transport errors are not a numeric Passport business 401.
    if (this.controller !== controller || controller.signal.aborted) return;
    if (response.message !== 'success' && response.data?.error_code === 401) {
      this.stop();
      this.onExpired();
    }
  }
}
