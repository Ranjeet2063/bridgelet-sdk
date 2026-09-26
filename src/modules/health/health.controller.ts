import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Maximum milliseconds to wait for a pool connection before reporting the
 * pool as exhausted. Matches the connectionTimeoutMillis set in
 * database.config.ts (issue #516; previously misspelled there as
 * acquireTimeoutMillis, which pg-pool silently ignored) so the health
 * endpoint reliably detects pool exhaustion without introducing an
 * independent, stale timeout value. With that option now correctly named,
 * pg-pool itself also drops a queued request after this many ms instead of
 * leaving it queued indefinitely once this race gives up on it.
 */
const DB_HEALTH_TIMEOUT_MS = 3_000;

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'Health check – includes database pool status' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  @ApiResponse({ status: 503, description: 'Service is unhealthy' })
  async check() {
    const dbStatus = await this.checkDatabasePool();
    return {
      status: dbStatus.healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        stellar: 'ok',
        soroban: 'ok',
      },
    };
  }

  /**
   * Attempts to acquire a pool connection and run a trivial query within
   * DB_HEALTH_TIMEOUT_MS. Returns a structured status object that captures:
   *   - healthy:       whether the check succeeded
   *   - poolExhausted: true when the acquire timeout fired (all connections busy)
   *   - error:         human-readable reason when unhealthy
   */
  private async checkDatabasePool(): Promise<{
    healthy: boolean;
    poolExhausted: boolean;
    error?: string;
  }> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('pool_acquire_timeout')),
        DB_HEALTH_TIMEOUT_MS,
      ),
    );

    try {
      await Promise.race([this.dataSource.query('SELECT 1'), timeout]);
      return { healthy: true, poolExhausted: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const poolExhausted = message === 'pool_acquire_timeout';
      return {
        healthy: false,
        poolExhausted,
        error: poolExhausted
          ? 'Connection pool exhausted: all connections in use'
          : `Database unreachable: ${message}`,
      };
    }
  }
}
