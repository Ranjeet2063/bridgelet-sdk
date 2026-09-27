import { IntervalJobRunner } from './interval-job-runner.js';

describe('IntervalJobRunner', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts once, applies jitter, and repeats after the task settles', async () => {
    const task = jest.fn().mockResolvedValue(undefined);
    const runner = new IntervalJobRunner({
      intervalMs: 1_000,
      jitterMs: 200,
      random: () => 0.5,
      task,
    });
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    runner.start();
    runner.start();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1_100);

    await jest.advanceTimersByTimeAsync(1_100);
    expect(task).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a slow asynchronous task', async () => {
    let resolveTask!: () => void;
    const task = jest.fn(
      () => new Promise<void>((resolve) => (resolveTask = resolve)),
    );
    const runner = new IntervalJobRunner({ intervalMs: 100, task });

    runner.start();
    await jest.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(1);

    resolveTask();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('reports failures and continues scheduling', async () => {
    const error = new Error('job failed');
    const onError = jest.fn();
    const task = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const runner = new IntervalJobRunner({ intervalMs: 100, task, onError });

    runner.start();
    await jest.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(error);

    await jest.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('cancels the pending run when stopped', () => {
    const task = jest.fn().mockResolvedValue(undefined);
    const runner = new IntervalJobRunner({ intervalMs: 100, task });

    runner.start();
    runner.stop();
    jest.advanceTimersByTime(100);

    expect(task).not.toHaveBeenCalled();
  });
});
