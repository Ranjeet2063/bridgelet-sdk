import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service.js';
import { Account } from '../accounts/entities/account.entity.js';
import { AccountStatus } from '../accounts/enums/account-status.enum.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private expiryHandle: ReturnType<typeof setInterval> | null = null;
  private initializingHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectRepository(Account)
    private readonly accountsRepository: Repository<Account>,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly webhooksService: WebhooksService,
  ) {}

  onModuleInit(): void {
    const expiryIntervalMs = this.configService.getOrThrow<number>(
      'app.expiryCheckIntervalMs',
    );
    const initializingIntervalMs = this.configService.getOrThrow<number>(
      'app.initializingCleanupIntervalMs',
    );

    this.expiryHandle = setInterval(
      () => void this.runExpiryJob(),
      expiryIntervalMs,
    );
    this.initializingHandle = setInterval(
      () => void this.runInitializingCleanup(),
      initializingIntervalMs,
    );

    this.logger.log(`Expiry job started (interval: ${expiryIntervalMs}ms)`);
    this.logger.log(
      `INITIALIZING cleanup started (interval: ${initializingIntervalMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.expiryHandle !== null) {
      clearInterval(this.expiryHandle);
      this.expiryHandle = null;
    }
    if (this.initializingHandle !== null) {
      clearInterval(this.initializingHandle);
      this.initializingHandle = null;
    }
    this.logger.log('Scheduler jobs stopped');
  }

  /**
   * Expires all PENDING_PAYMENT and PENDING_CLAIM accounts whose expiresAt
   * has passed. Calls StellarService.expireAccount() then sets status to
   * EXPIRED and records expiredAt. Per-account failures are isolated.
   */
  async runExpiryJob(): Promise<void> {
    const now = new Date();

    let accounts: Account[];
    try {
      accounts = await this.accountsRepository.find({
        where: [
          { status: AccountStatus.PENDING_PAYMENT, expiresAt: LessThan(now) },
          { status: AccountStatus.PENDING_CLAIM, expiresAt: LessThan(now) },
        ],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Expiry job DB query failed: ${msg}`);
      return;
    }

    if (accounts.length === 0) return;

    this.logger.debug(
      `Expiry job: processing ${accounts.length} expired account(s)`,
    );

    await Promise.allSettled(
      accounts.map((account) => this.expireAccount(account)),
    );
  }

  private async expireAccount(account: Account): Promise<void> {
    const contractId = account.contractId;
    const signerSecret = this.configService.getOrThrow<string>(
      'stellar.fundingSecret',
    );

    if (!contractId) {
      this.logger.error(
        `expireAccount() skipped for account ${account.id}: contractId is null`,
      );
      return;
    }

    try {
      await this.stellarService.expireAccount({ contractId, signerSecret });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `expireAccount() failed for account ${account.id} (${account.publicKey}): ${msg}`,
      );
      return;
    }

    const expiredAt = new Date();
    await this.accountsRepository.update(account.id, {
      status: AccountStatus.EXPIRED,
      expiredAt,
    });
    this.logger.log(`Account ${account.id} status → EXPIRED`);

    await this.webhooksService.triggerEvent('account.expired', {
      accountId: account.id,
      publicKey: account.publicKey,
      expiredAt,
    });
  }

  /**
   * Marks accounts stuck in INITIALIZING status beyond the configured timeout
   * as FAILED. No contract call is made — the contract was never initialized
   * for these accounts.
   */
  async runInitializingCleanup(): Promise<void> {
    const timeoutMs = this.configService.getOrThrow<number>(
      'app.initializingTimeoutMs',
    );
    const cutoff = new Date(Date.now() - timeoutMs);

    let accounts: Account[];
    try {
      accounts = await this.accountsRepository.find({
        where: {
          status: AccountStatus.INITIALIZING,
          createdAt: LessThan(cutoff),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`INITIALIZING cleanup DB query failed: ${msg}`);
      return;
    }

    if (accounts.length === 0) return;

    this.logger.debug(
      `INITIALIZING cleanup: processing ${accounts.length} stale account(s)`,
    );

    await Promise.allSettled(
      accounts.map((account) => this.markInitializingFailed(account)),
    );
  }

  private async markInitializingFailed(account: Account): Promise<void> {
    try {
      // Explicit typed variable avoids TypeORM _QueryDeepPartialEntity inference on jsonb spread
      const metadata: Record<string, any> = {
        ...(account.metadata ?? {}),
        failureReason: 'initialization_timeout',
        detectedAt: new Date().toISOString(),
      };
      await this.accountsRepository.update(account.id, {
        status: AccountStatus.FAILED,
        metadata,
      });
      this.logger.warn(
        `Account ${account.id} status → FAILED (initialization_timeout)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to mark account ${account.id} as FAILED: ${msg}`,
      );
    }
  }
}
