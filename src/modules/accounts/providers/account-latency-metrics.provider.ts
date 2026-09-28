import { Injectable, Logger } from '@nestjs/common';
import { Histogram, Registry, register } from 'prom-client';

interface HistogramBucket {
  upperBoundMs: number;
  count: number;
}

interface LatencySample {
  durationMs: number;
  success: boolean;
  recordedAt: Date;
}

const P99_ALERT_THRESHOLD_MS = 5_000;

const DEFAULT_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

/**
 * AccountLatencyMetricsProvider
 *
 * Records account-creation latency and keeps two parallel representations of
 * the same data (issue #676):
 *
 *  1. In-memory samples and cumulative buckets, read via `getBuckets()`,
 *     `getP99Ms()` and friends. These drive the p99 alert log.
 *  2. A Prometheus `Histogram` registered on the default registry, so the
 *     latency distribution is actually exposed on `/metrics` and can be
 *     asserted against with `registry.getSingleMetric(name).get()`.
 *
 * Previously only (1) existed, and nothing outside this class' own unit tests
 * ever called `getBuckets()` — the latency distribution was computed but never
 * scraped, so a misconfigured bucket boundary or a swapped success label would
 * have gone unnoticed in production.
 */
@Injectable()
export class AccountLatencyMetricsProvider {
  private readonly logger = new Logger(AccountLatencyMetricsProvider.name);
  private readonly samples: LatencySample[] = [];
  private readonly buckets: HistogramBucket[] = DEFAULT_BUCKETS_MS.map((b) => ({
    upperBoundMs: b,
    count: 0,
  }));
  private readonly latencyHistogram: Histogram;

  constructor(private readonly registry: Registry = register) {
    const existing = this.registry.getSingleMetric(
      'account_creation_latency_ms',
    );
    this.latencyHistogram =
      (existing as Histogram | undefined) ??
      new Histogram({
        name: 'account_creation_latency_ms',
        help: 'Account creation latency in milliseconds',
        // Must stay in sync with DEFAULT_BUCKETS_MS so the Prometheus view and
        // the in-memory view cannot disagree.
        buckets: DEFAULT_BUCKETS_MS,
        registers: [this.registry],
      });
  }

  record(durationMs: number, success: boolean): void {
    this.samples.push({ durationMs, success, recordedAt: new Date() });
    for (const bucket of this.buckets) {
      if (durationMs <= bucket.upperBoundMs) {
        bucket.count++;
      }
    }
    this.latencyHistogram.observe(durationMs);
    this.checkAlert(durationMs);
  }

  getP99Ms(): number {
    return this.percentile(99);
  }

  getP95Ms(): number {
    return this.percentile(95);
  }

  getP50Ms(): number {
    return this.percentile(50);
  }

  getTotalCount(): number {
    return this.samples.length;
  }

  getSuccessCount(): number {
    return this.samples.filter((s) => s.success).length;
  }

  getBuckets(): ReadonlyArray<{ upperBoundMs: number; count: number }> {
    return this.buckets;
  }

  private percentile(p: number): number {
    const sorted = [...this.samples]
      .map((s) => s.durationMs)
      .sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  private checkAlert(durationMs: number): void {
    const p99 = this.getP99Ms();
    if (p99 > P99_ALERT_THRESHOLD_MS) {
      this.logger.warn(
        `ALERT: account_creation_latency p99=${p99}ms exceeds threshold of ${P99_ALERT_THRESHOLD_MS}ms ` +
          `(latest sample: ${durationMs}ms, total_samples: ${this.samples.length})`,
      );
    }
  }
}
