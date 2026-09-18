import type { DesktopDTraitFeatureValues } from './desktop-dtrait-request-core.js';

export interface DesktopDTraitCollectionContext {
  readonly Date: { now(): number };
  setTimeout(callback: () => void, delay: number): unknown;
}
export interface DesktopDTraitCollectionOptions {
  cache: Record<string, unknown>;
  debug: boolean;
}
export type DesktopDTraitCollectionTask = (
  options: DesktopDTraitCollectionOptions
) => unknown;
export type DesktopDTraitCollectionResult =
  | { value: unknown; duration: number }
  | { error: unknown; duration: number };

/** zt: synchronous values, thenables and throws use the same callback; do not Promise.resolve before invoking. */
function invoke(
  task: () => unknown,
  complete: (success: boolean, value: unknown) => void
): void {
  try {
    const value = task();
    if (value && typeof (value as PromiseLike<unknown>).then === 'function')
      (value as PromiseLike<unknown>).then(
        result => complete(true, result),
        error => complete(false, error)
      );
    else complete(true, value);
  } catch (error) {
    complete(false, error);
  }
}
function observe<T>(task: Promise<T>): Promise<T> {
  void task.then(undefined, () => {});
  return task;
}

/** Yt yields after a work slice, including the last item. This is not a per-feature timeout. */
async function mapInSlices<T, R>(
  context: DesktopDTraitCollectionContext,
  items: T[],
  map: (value: T, index: number) => R,
  budget = 16
): Promise<R[]> {
  const results = Array<R>(items.length);
  let start = context.Date.now();
  for (let i = 0; i < items.length; i++) {
    results[i] = map(items[i]!, i);
    const now = context.Date.now();
    if (now >= start + budget) {
      start = now;
      await new Promise<void>(resolve =>
        context.setTimeout(() => resolve(), 0)
      );
    }
  }
  return results;
}

/** Zt: starts phase one immediately; returned runner waits then executes deferred phase two. */
export function prepareDesktopDTraitCollection(
  context: DesktopDTraitCollectionContext,
  tasks: Record<string, DesktopDTraitCollectionTask>,
  options: DesktopDTraitCollectionOptions,
  budget?: number
): () => Promise<Record<string, DesktopDTraitCollectionResult>> {
  const keys = Object.keys(tasks);
  const prepared = observe(
    mapInSlices(
      context,
      keys,
      key => {
        const task = tasks[key]!;
        const stage = observe(
          new Promise<
            () =>
              | DesktopDTraitCollectionResult
              | Promise<DesktopDTraitCollectionResult>
          >(resolve => {
            const start = context.Date.now();
            invoke(task.bind(null, options), (success, value) => {
              const duration = context.Date.now() - start;
              if (!success) return resolve(() => ({ error: value, duration }));
              if (typeof value !== 'function')
                return resolve(() => ({ value, duration }));
              resolve(
                () =>
                  new Promise<DesktopDTraitCollectionResult>(finish => {
                    const secondStart = context.Date.now();
                    invoke(value as () => unknown, (ok, result) => {
                      const total = duration + context.Date.now() - secondStart;
                      finish(
                        ok
                          ? { value: result, duration: total }
                          : { error: result, duration: total }
                      );
                    });
                  })
              );
            });
          })
        );
        return () => stage.then(run => run());
      },
      budget
    )
  );
  return async () => {
    const stages = await prepared;
    const running = await mapInSlices(
      context,
      stages,
      run => observe(run()),
      budget
    );
    const values = await Promise.all(running);
    const result: Record<string, DesktopDTraitCollectionResult> = {};
    for (let i = 0; i < keys.length; i++) result[keys[i]!] = values[i]!;
    return result;
  };
}

export interface DesktopDTraitCollectionPlugins {
  boolFeature: DesktopDTraitCollectionTask;
  strFeature: DesktopDTraitCollectionTask;
  canvas: DesktopDTraitCollectionTask;
  audio: DesktopDTraitCollectionTask;
  css: DesktopDTraitCollectionTask;
  domRect: DesktopDTraitCollectionTask;
  mediaTypes: DesktopDTraitCollectionTask;
  speech: DesktopDTraitCollectionTask;
  svgRect: DesktopDTraitCollectionTask;
  math: DesktopDTraitCollectionTask;
  webGL: DesktopDTraitCollectionTask;
  fonts: DesktopDTraitCollectionTask;
}

/** F127/F146/F150/F154 and F123/Qt. Requires actual plugins, never installs empty browser collectors. */
export class DesktopDTraitCollector {
  private readonly bool: Record<string, DesktopDTraitCollectionTask>;
  private readonly str: Record<string, DesktopDTraitCollectionTask>;
  constructor(
    private readonly context: DesktopDTraitCollectionContext,
    plugins: DesktopDTraitCollectionPlugins
  ) {
    this.str = {
      strFeature: plugins.strFeature,
      canvas: plugins.canvas,
      audio: plugins.audio,
      css: plugins.css,
      domRect: plugins.domRect,
      mediaTypes: plugins.mediaTypes,
      speech: plugins.speech,
      svgRect: plugins.svgRect,
      math: plugins.math,
      webGL: plugins.webGL,
      fonts: plugins.fonts,
    };
    this.bool = { boolFeature: plugins.boolFeature };
  }
  private async collectGroup(
    tasks: Record<string, DesktopDTraitCollectionTask>
  ): Promise<Record<string, unknown>> {
    const run = prepareDesktopDTraitCollection(this.context, tasks, {
      cache: {},
      debug: false,
    });
    const results = await run();
    let combined: Record<string, unknown> = {};
    for (const key of Object.keys(results)) {
      const result = results[key]!;
      // F147/F151 access .value even on errors: undefined contributes no properties.
      combined = Object.assign(
        Object.assign({}, combined),
        (result as { value?: unknown }).value
      );
    }
    return Object.assign({}, combined);
  }
  private async collectOnce(): Promise<DesktopDTraitFeatureValues> {
    const [bool, str] = await Promise.all([
      this.collectGroup(this.bool),
      this.collectGroup(this.str),
    ]);
    return { num: {}, bool, str };
  }
  async collect(): Promise<DesktopDTraitFeatureValues> {
    try {
      // Qt gets retry count 3 from F123: first attempt plus three immediate aggregate retries.
      return await new Promise<DesktopDTraitFeatureValues>(
        (resolve, reject) => {
          let retries = 3;
          const attempt = () => {
            void this.collectOnce()
              .then(resolve)
              .catch(error => {
                if (retries-- > 0) attempt();
                else reject(error);
              });
          };
          attempt();
        }
      );
    } catch {
      // Source fallback after aggregate exhaustion, not a readiness/success signal.
      return { bool: {}, num: {}, str: {} };
    }
  }
}
