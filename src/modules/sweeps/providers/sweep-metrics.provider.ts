import { Injectable, Logger } from '@nestjs/common';
import { Gauge, Registry, register } from 'prom-client';

const LOW_SUCCESS_RATE_THRESHOLD = 0.95;

export interface SweepMetricsSnapshot {
  sweep_completed_total: number;
  sweep_failed_total: number;
  sweep_success_rate: number;
}

/**
 * SweepMetricsProvider
 *
 * Tracks sweep outcomes and keeps two parallel representations of the same
 * data (issue #676):
 *
 *  1. In-memory counters, read via the `get*`/`getSnapshot()` accessors. These
 *     drive the low-success-rate alert log and are what existing callers use.
 *  2. Prometheus `Gauge` objects registered on the default registry, so the
 *     values are actually exposed on `/metrics` and can be asserted against
 *     with `registry.getSingleMetric(name).get()`.
 *
 * Previously only (1) existed. Nothing outside this class' own unit tests ever
 * called `getSnapshot()`, so the numbers were computed but never scraped by
 * anything. The in-memory accessors are retained for alerting and backwards
 * compatibility, but they are no longer the only representation.
 */
@Injectable()
export class SweepMetricsProvider {
  private readonly logger = new Logger(SweepMetricsProvider.name);

  private sweepCompletedTotal = 0;
  private sweepFailedTotal = 0;

  private readonly completedGauge: Gauge;
  private readonly failedGauge: Gauge;
  private readonly successRateGauge: Gauge;

  constructor(private readonly registry: Registry = register) {
    this.completedGauge = this.getOrCreateGauge('sweep_completed_total', {
      help: 'Total number of completed sweeps',
    });
    this.failedGauge = this.getOrCreateGauge('sweep_failed_total', {
      help: 'Total number of failed sweeps',
    });
    this.successRateGauge = this.getOrCreateGauge('sweep_success_rate', {
      help: 'Ratio of completed to total sweeps (1 when none recorded)',
    });
  }

  /**
   * prom-client throws on duplicate metric registration, and this provider is
   * constructed both as a Nest singleton and directly in unit tests, both
   * against the same default registry. Reuse an existing metric when the name
   * is already taken rather than crashing.
   */
  private getOrCreateGauge(
    name: string,
    config: { help: string },
  ): Gauge {
    const existing = this.registry.getSingleMetric(name);
    if (existing) return existing as Gauge;
    return new Gauge({
      name,
      help: config.help,
      registers: [this.registry],
    });
  }

  recordCompleted(): void {
    this.sweepCompletedTotal++;
    this.syncGauges();
    this.checkSuccessRate();
  }

  recordFailed(): void {
    this.sweepFailedTotal++;
    this.syncGauges();
    this.checkSuccessRate();
  }

  getCompletedTotal(): number {
    return this.sweepCompletedTotal;
  }

  getFailedTotal(): number {
    return this.sweepFailedTotal;
  }

  getSuccessRate(): number {
    const total = this.sweepCompletedTotal + this.sweepFailedTotal;
    if (total === 0) return 1;
    return this.sweepCompletedTotal / total;
  }

  getSnapshot(): SweepMetricsSnapshot {
    return {
      sweep_completed_total: this.sweepCompletedTotal,
      sweep_failed_total: this.sweepFailedTotal,
      sweep_success_rate: this.getSuccessRate(),
    };
  }

  private syncGauges(): void {
    this.completedGauge.set(this.sweepCompletedTotal);
    this.failedGauge.set(this.sweepFailedTotal);
    this.successRateGauge.set(this.getSuccessRate());
  }

  private checkSuccessRate(): void {
    const total = this.sweepCompletedTotal + this.sweepFailedTotal;
    if (total === 0) return;
    const rate = this.getSuccessRate();
    if (rate < LOW_SUCCESS_RATE_THRESHOLD) {
      this.logger.warn(
        `ALERT: sweep_success_rate=${(rate * 100).toFixed(2)}% is below ` +
          `${LOW_SUCCESS_RATE_THRESHOLD * 100}% threshold ` +
          `(completed=${this.sweepCompletedTotal}, failed=${this.sweepFailedTotal})`,
      );
    }
  }
}
