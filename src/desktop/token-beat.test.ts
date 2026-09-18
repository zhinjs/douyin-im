import { PassportTokenBeat } from './token-beat.js';
import type { PassportApiResponse, PassportTokenBeatScene } from './types.js';

describe('Desktop activity-driven Session renewal', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function fixture() {
    const request = jest.fn<Promise<PassportApiResponse>, [PassportTokenBeatScene, AbortSignal]>()
      .mockResolvedValue({ message: 'success', data: {} });
    const expired = jest.fn();
    return { request, expired, beat: new PassportTokenBeat(request, expired) };
  }

  it('starts once with boot, pauses after an idle interval, and resumes with active', async () => {
    const { request, beat } = fixture();
    beat.start(); beat.start();
    expect(request.mock.calls.map(([scene]) => scene)).toEqual(['boot']);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(jest.getTimerCount()).toBe(0);
    beat.activity();
    expect(request.mock.calls.map(([scene]) => scene)).toEqual(['boot', 'active']);
    // The resume activity itself does not set the flag for the next interval.
    await jest.advanceTimersByTimeAsync(600_000);
    expect(jest.getTimerCount()).toBe(0);
    beat.stop();
  });

  it('polls only after activity, resets the flag, and shares a leading-only ten-second throttle', async () => {
    const { request, beat } = fixture(); beat.start();
    await jest.advanceTimersByTimeAsync(595_000); beat.activity();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(request.mock.calls.map(([scene]) => scene)).toEqual(['boot', 'polling']);
    beat.activity(); // suppressed by the previous interval's activity throttle
    await jest.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(2);
    beat.activity();
    await jest.advanceTimersByTimeAsync(10_000); beat.activity();
    await jest.advanceTimersByTimeAsync(590_000);
    expect(request.mock.calls.map(([scene]) => scene)).toEqual(['boot', 'polling', 'active', 'polling']);
    beat.stop(); expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    [{ message: 'error', data: { error_code: 401 } }, true],
    [{ message: 'success', data: { error_code: 401 } }, false],
    [{ message: 'error', data: { error_code: '401' } }, false],
    [{ message: 'error', data: { error_code: 8 } }, false],
    [{ message: 'error', error_code: 401, data: {} }, false],
  ] as const)('classifies business rejection strictly (%j)', async (response, shouldExpire) => {
    const { request, expired, beat } = fixture();
    request.mockResolvedValue(response as unknown as PassportApiResponse);
    beat.start(); await jest.advanceTimersByTimeAsync(0);
    expect(expired).toHaveBeenCalledTimes(shouldExpire ? 1 : 0);
    const signal = request.mock.calls[0]![1];
    expect(signal.aborted).toBe(shouldExpire);
    if (shouldExpire) { beat.activity(); expect(request).toHaveBeenCalledTimes(1); }
    beat.stop();
  });

  it.each([new Error('offline'), { status: 401 }, { error_code: 401 }])('does not reclassify transport exceptions as Passport responses (%j)', async error => {
    const { request, expired, beat } = fixture(); request.mockRejectedValue(error);
    beat.start(); await jest.advanceTimersByTimeAsync(0);
    expect(expired).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1); beat.stop();
  });

  it('allows overlapping source requests but expires the account only once', async () => {
    const { request, expired, beat } = fixture();
    const finish: ((response: PassportApiResponse) => void)[] = [];
    request.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
    beat.start(); beat.activity(); await jest.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(2);
    for (const resolve of finish) resolve({ message: 'error', data: { error_code: 401 } });
    await jest.advanceTimersByTimeAsync(0);
    expect(expired).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });

  it('isolates accounts and ignores stopped generations even after restarting the same instance', async () => {
    const first = fixture(), second = fixture();
    let finish!: (response: PassportApiResponse) => void;
    first.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    first.beat.start(); second.beat.start();
    const oldSignal = first.request.mock.calls[0]![1];
    first.beat.activity(); await jest.advanceTimersByTimeAsync(600_000);
    expect(first.request).toHaveBeenCalledTimes(2); expect(second.request).toHaveBeenCalledTimes(1);
    first.beat.stop(); first.beat.activity(); expect(first.request).toHaveBeenCalledTimes(2);
    first.beat.start(); finish({ message: 'error', data: { error_code: 401 } });
    await jest.advanceTimersByTimeAsync(0);
    expect(oldSignal.aborted).toBe(true); expect(first.expired).not.toHaveBeenCalled();
    expect(first.request.mock.calls[2]![1]).not.toBe(oldSignal);
    first.beat.stop(); second.beat.stop(); expect(jest.getTimerCount()).toBe(0);
  });
});
