import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { Registry } from 'prom-client';
import { SweepMetricsProvider } from './sweep-metrics.provider.js';

/**
 * Issue #676 — assert on the resulting Prometheus metric state, not just on
 * the provider's own accessors.
 *
 * Each test gets a fresh `Registry` injected into the provider so the
 * assertions are independent of one another and of any other suite that has
 * touched the global default registry.
 */
describe('SweepMetricsProvider', () => {
  let provider: SweepMetricsProvider;
  let registry: Registry;

  /** Reads a gauge's current value straight out of the registry. */
  const gaugeValue = (name: string): number =>
    registry.getSingleMetric(name)!.get() as unknown as number;

  beforeEach(async () => {
    registry = new Registry();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: SweepMetricsProvider, useFactory: () => new SweepMetricsProvider(registry) },
      ],
    }).compile();
    provider = module.get<SweepMetricsProvider>(SweepMetricsProvider);
  });

  afterEach(() => jest.restoreAllMocks());

  // ── registration ────────────────────────────────────────────────────────────

  describe('Prometheus registration', () => {
    it('registers all three metrics on the injected registry', () => {
      for (const name of [
        'sweep_completed_total',
        'sweep_failed_total',
        'sweep_success_rate',
      ]) {
        expect(registry.getSingleMetric(name)).toBeDefined();
      }
    });

    it('reports a success rate of 1 before anything is recorded', () => {
      expect(gaugeValue('sweep_success_rate')).toBe(1);
    });

    it('reuses an already-registered metric instead of throwing', () => {
      // A second provider against the same registry is what happens when both
      // the Nest singleton and a test construct one; prom-client would throw
      // on a duplicate name if getOrCreateGauge were not defensive.
      expect(() => new SweepMetricsProvider(registry)).not.toThrow();
    });
  });

  // ── counters ────────────────────────────────────────────────────────────────

  describe('sweep_completed_total', () => {
    it('starts at 0', () => {
      expect(provider.getCompletedTotal()).toBe(0);
    });

    it('increments on each recordCompleted() call', () => {
      provider.recordCompleted();
      provider.recordCompleted();
      expect(provider.getCompletedTotal()).toBe(2);
    });

    it('is reflected in the Prometheus gauge', () => {
      provider.recordCompleted();
      provider.recordCompleted();
      provider.recordCompleted();
      expect(gaugeValue('sweep_completed_total')).toBe(3);
    });

    it('is independent of recordFailed()', () => {
      provider.recordFailed();
      expect(provider.getCompletedTotal()).toBe(0);
      expect(gaugeValue('sweep_completed_total')).toBe(0);
    });
  });

  describe('sweep_failed_total', () => {
    it('starts at 0', () => {
      expect(provider.getFailedTotal()).toBe(0);
    });

    it('increments on each recordFailed() call', () => {
      provider.recordFailed();
      provider.recordFailed();
      provider.recordFailed();
      expect(provider.getFailedTotal()).toBe(3);
    });

    it('is reflected in the Prometheus gauge', () => {
      provider.recordFailed();
      expect(gaugeValue('sweep_failed_total')).toBe(1);
    });

    it('is independent of recordCompleted()', () => {
      provider.recordCompleted();
      expect(provider.getFailedTotal()).toBe(0);
      expect(gaugeValue('sweep_failed_total')).toBe(0);
    });
  });

  // ── success rate ────────────────────────────────────────────────────────────

  describe('getSuccessRate()', () => {
    it('returns 1 when no sweeps have been recorded', () => {
      expect(provider.getSuccessRate()).toBe(1);
    });

    it('returns 1 when all sweeps completed successfully', () => {
      provider.recordCompleted();
      provider.recordCompleted();
      expect(provider.getSuccessRate()).toBe(1);
    });

    it('returns 0 when all sweeps failed', () => {
      provider.recordFailed();
      expect(provider.getSuccessRate()).toBe(0);
    });

    it('calculates the correct ratio with mixed outcomes', () => {
      provider.recordCompleted(); // 1
      provider.recordCompleted(); // 2
      provider.recordCompleted(); // 3
      provider.recordFailed(); // 1 failure → 3/4 = 0.75
      expect(provider.getSuccessRate()).toBeCloseTo(0.75);
    });
  });

  // ── gauge/metric agreement ──────────────────────────────────────────────────

  describe('in-memory accessors agree with the registry', () => {
    it.each([
      { completed: 0, failed: 0 },
      { completed: 1, failed: 0 },
      { completed: 0, failed: 1 },
      { completed: 7, failed: 3 },
      { completed: 19, failed: 1 },
    ])(
      'completed=$completed failed=$failed is consistent across both views',
      ({ completed, failed }) => {
        for (let i = 0; i < completed; i++) provider.recordCompleted();
        for (let i = 0; i < failed; i++) provider.recordFailed();

        const snapshot = provider.getSnapshot();
        expect(snapshot).toEqual({
          sweep_completed_total: completed,
          sweep_failed_total: failed,
          sweep_success_rate: provider.getSuccessRate(),
        });

        expect(gaugeValue('sweep_completed_total')).toBe(completed);
        expect(gaugeValue('sweep_failed_total')).toBe(failed);
        expect(gaugeValue('sweep_success_rate')).toBeCloseTo(
          snapshot.sweep_success_rate,
        );
      },
    );

    it('renders the metrics in the Prometheus text exposition format', async () => {
      provider.recordCompleted();
      provider.recordCompleted();
      provider.recordFailed();

      const text = await registry.metrics();
      expect(text).toContain('sweep_completed_total 2');
      expect(text).toContain('sweep_failed_total 1');
      expect(text).toContain('sweep_success_rate 0.6666666666666666');
    });
  });

  // ── snapshot ────────────────────────────────────────────────────────────────

  describe('getSnapshot()', () => {
    it('returns all three SLI fields', () => {
      provider.recordCompleted();
      provider.recordFailed();
      const snap = provider.getSnapshot();
      expect(snap).toHaveProperty('sweep_completed_total', 1);
      expect(snap).toHaveProperty('sweep_failed_total', 1);
      expect(snap).toHaveProperty('sweep_success_rate', 0.5);
    });
  });

  // ── alert ───────────────────────────────────────────────────────────────────

  describe('success-rate alert', () => {
    it('emits a warn log when success rate drops below 95%', () => {
      const warnSpy = jest
        .spyOn(provider['logger'], 'warn')
        .mockImplementation(() => {});

      // 5 completed + 1 failed → 83.3% success rate (below 95%)
      for (let i = 0; i < 5; i++) provider.recordCompleted();
      provider.recordFailed();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ALERT'));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sweep_success_rate'),
      );
    });

    it('does not warn when success rate is at or above 95%', () => {
      const warnSpy = jest
        .spyOn(provider['logger'], 'warn')
        .mockImplementation(() => {});

      // 19 completed + 1 failed → 95% success rate
      for (let i = 0; i < 19; i++) provider.recordCompleted();
      provider.recordFailed();

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when all sweeps succeed', () => {
      const warnSpy = jest
        .spyOn(provider['logger'], 'warn')
        .mockImplementation(() => {});

      provider.recordCompleted();
      provider.recordCompleted();

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('alerts off the computed rate, not the raw counts', () => {
      const warnSpy = jest
        .spyOn(provider['logger'], 'warn')
        .mockImplementation(() => {});

      // 4 completed + 1 failed = exactly 80%, well under the 95% threshold,
      // even though the absolute failure count is tiny.
      for (let i = 0; i < 4; i++) provider.recordCompleted();
      provider.recordFailed();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sweep_success_rate=80.00%'),
      );
    });
  });
});
