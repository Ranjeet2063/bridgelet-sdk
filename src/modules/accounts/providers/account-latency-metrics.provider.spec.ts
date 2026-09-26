import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { Registry } from 'prom-client';
import { AccountLatencyMetricsProvider } from './account-latency-metrics.provider.js';

/**
 * Issue #676 — assert on the resulting Prometheus metric state, not just on
 * the provider's own accessors. In particular these tests pin the histogram's
 * bucket boundaries and counts, which a mock-based test could never catch.
 *
 * Each test gets a fresh `Registry` injected so assertions are independent of
 * each other and of any other suite touching the global default registry.
 */
describe('AccountLatencyMetricsProvider', () => {
  let provider: AccountLatencyMetricsProvider;
  let registry: Registry;

  const HISTOGRAM = 'account_creation_latency_ms';

  interface HistogramReading {
    count: number;
    sum: number;
    buckets: ReadonlyArray<{ le: string | number; count: number }>;
  }

  const histogram = (): HistogramReading =>
    registry.getSingleMetric(HISTOGRAM)!.get() as unknown as HistogramReading;

  /** Cumulative count of samples at or below the given bucket bound. */
  const bucketCount = (le: string | number): number => {
    const match = histogram().buckets.find((b) => b.le === le);
    if (!match) {
      throw new Error(
        `No Prometheus bucket with le=${le}; got ${histogram()
          .buckets.map((b) => b.le)
          .join(', ')}`,
      );
    }
    return match.count;
  };

  beforeEach(async () => {
    registry = new Registry();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: AccountLatencyMetricsProvider,
          useFactory: () => new AccountLatencyMetricsProvider(registry),
        },
      ],
    }).compile();
    provider = module.get<AccountLatencyMetricsProvider>(
      AccountLatencyMetricsProvider,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  // ── registration ────────────────────────────────────────────────────────────

  describe('Prometheus registration', () => {
    it('registers the latency histogram', () => {
      expect(registry.getSingleMetric(HISTOGRAM)).toBeDefined();
    });

    it('exposes exactly the documented bucket boundaries', () => {
      // A misconfigured boundary here would silently corrupt every percentile
      // and alert derived from the scraped series.
      const bounds = histogram().buckets.map((b) => b.le);
      expect(bounds).toEqual([
        50, 100, 250, 500, 1000, 2500, 5000, 10000, '+Inf',
      ]);
    });

    it('keeps the Prometheus buckets in sync with getBuckets()', () => {
      const inMemory = provider.getBuckets().map((b) => b.upperBoundMs);
      const prometheus = histogram()
        .buckets.filter((b) => b.le !== '+Inf')
        .map((b) => b.le as number);
      expect(prometheus).toEqual(inMemory);
    });

    it('reuses an already-registered metric instead of throwing', () => {
      expect(() => new AccountLatencyMetricsProvider(registry)).not.toThrow();
    });
  });

  // ── basic recording ─────────────────────────────────────────────────────────

  describe('record()', () => {
    it('increments getTotalCount()', () => {
      provider.record(200, true);
      provider.record(300, false);
      expect(provider.getTotalCount()).toBe(2);
    });

    it('counts only successful samples in getSuccessCount()', () => {
      provider.record(100, true);
      provider.record(200, false);
      provider.record(150, true);
      expect(provider.getSuccessCount()).toBe(2);
    });

    it('increments histogram buckets for samples within their bound', () => {
      provider.record(100, true); // ≤ 100ms bucket
      provider.record(300, true); // ≤ 500ms bucket (not ≤100)
      const buckets = provider.getBuckets();
      const b100 = buckets.find((b) => b.upperBoundMs === 100)!;
      const b500 = buckets.find((b) => b.upperBoundMs === 500)!;
      expect(b100.count).toBe(1);
      expect(b500.count).toBe(2); // cumulative
    });

    it('records every observation on the Prometheus histogram', () => {
      provider.record(120, true);
      provider.record(340, false);
      const h = histogram();
      expect(h.count).toBe(2);
      expect(h.sum).toBe(460);
    });
  });

  // ── Prometheus/in-memory agreement ──────────────────────────────────────────

  describe('histogram agrees with the in-memory buckets', () => {
    it.each([
      [10],
      [50],
      [51],
      [100],
      [250],
      [999],
      [1_000],
      [2_500],
      [5_000],
      [9_999],
      [10_000],
      [60_000],
    ])('a single %ims sample lands in the right Prometheus bucket', (ms) => {
      provider.record(ms, true);

      const inMemoryCount = provider
        .getBuckets()
        .filter((b) => ms <= b.upperBoundMs).length;
      const prometheusCount = histogram().buckets.filter(
        (b) => b.le !== '+Inf' && ms <= (b.le as number),
      ).length;

      expect(prometheusCount).toBe(inMemoryCount);
      // The sample is counted by every bucket at or above its magnitude.
      expect(bucketCount('+Inf')).toBe(1);
    });

    it('keeps counts cumulative across mixed magnitudes', () => {
      provider.record(40, true);
      provider.record(600, true);
      provider.record(3_000, true);

      expect(bucketCount(50)).toBe(1);
      expect(bucketCount(500)).toBe(1);
      expect(bucketCount(1_000)).toBe(2);
      expect(bucketCount(2_500)).toBe(2);
      expect(bucketCount(5_000)).toBe(3);
      expect(histogram().count).toBe(3);
    });

    it('renders the histogram in the Prometheus text exposition format', async () => {
      provider.record(100, true);
      provider.record(300, true);

      const text = await registry.metrics();
      expect(text).toContain('account_creation_latency_ms_bucket');
      expect(text).toContain('account_creation_latency_ms_count 2');
      expect(text).toContain('account_creation_latency_ms_sum 400');
    });
  });

  // ── percentiles ─────────────────────────────────────────────────────────────

  describe('percentile calculations', () => {
    it('returns 0 when no samples recorded', () => {
      expect(provider.getP99Ms()).toBe(0);
      expect(provider.getP95Ms()).toBe(0);
      expect(provider.getP50Ms()).toBe(0);
    });

    it('getP50Ms() returns median', () => {
      [100, 200, 300, 400, 500].forEach((d) => provider.record(d, true));
      expect(provider.getP50Ms()).toBe(300);
    });

    it('getP99Ms() returns near-max for many uniform samples', () => {
      Array.from({ length: 100 }, (_, i) => provider.record(i + 1, true));
      expect(provider.getP99Ms()).toBe(99);
    });

    it('getP95Ms() returns 95th percentile', () => {
      Array.from({ length: 100 }, (_, i) => provider.record(i + 1, true));
      expect(provider.getP95Ms()).toBe(95);
    });
  });

  // ── alert ───────────────────────────────────────────────────────────────────

  describe('p99 alert', () => {
    it('emits warn log when p99 exceeds 5000ms', () => {
      const warnSpy = jest
        .spyOn(provider['logger'], 'warn')
        .mockImplementation(() => {});

      // Drive p99 above threshold: many slow samples
      Array.from({ length: 100 }, () => provider.record(6_000, true));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ALERT'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('5000ms'));
    });

    it('does not emit warn when p99 is within threshold', () => {
      const warnSpy = jest
        .spyOn(provider['logger'], 'warn')
        .mockImplementation(() => {});

      provider.record(100, true);
      provider.record(200, true);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ── buckets ─────────────────────────────────────────────────────────────────

  describe('getBuckets()', () => {
    it('returns all default bucket boundaries', () => {
      const bounds = provider.getBuckets().map((b) => b.upperBoundMs);
      expect(bounds).toContain(50);
      expect(bounds).toContain(5_000);
      expect(bounds).toContain(10_000);
    });

    it('all counts are 0 before any recording', () => {
      const allZero = provider.getBuckets().every((b) => b.count === 0);
      expect(allZero).toBe(true);
    });
  });
});
