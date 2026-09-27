export interface IntervalJobRunnerOptions {
  intervalMs: number;
  task: () => Promise<void>;
  jitterMs?: number;
  onError?: (error: unknown) => void;
  random?: () => number;
}

/**
 * Runs an asynchronous job repeatedly without allowing executions to overlap.
 * Each next run is scheduled only after the previous one settles, and optional
 * jitter spreads workers that start at the same time across a small window.
 */
export class IntervalJobRunner {
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;

  constructor(private readonly options: IntervalJobRunnerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error('IntervalJobRunner intervalMs must be greater than zero');
    }
    if ((options.jitterMs ?? 0) < 0) {
      throw new Error('IntervalJobRunner jitterMs cannot be negative');
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    const jitterMs = this.options.jitterMs ?? 0;
    const random = this.options.random ?? Math.random;
    const delay = this.options.intervalMs + Math.floor(random() * jitterMs);
    this.timeoutHandle = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.timeoutHandle = null;
    if (this.stopped || this.running) return;

    this.running = true;
    try {
      await this.options.task();
    } catch (error: unknown) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }
}
