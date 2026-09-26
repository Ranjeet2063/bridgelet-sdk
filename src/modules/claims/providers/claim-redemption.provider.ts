import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { IsNull, Repository, DataSource, EntityManager } from 'typeorm';
import * as crypto from 'crypto';
import { Claim } from '../entities/claim.entity.js';
import { Account } from '../../accounts/entities/account.entity.js';
import { ClaimRedemptionResponseDto } from '../dto/claim-redemption-response.dto.js';
import { SweepsService } from '../../sweeps/sweeps.service.js';
import { TokenVerificationProvider } from './token-verification.provider.js';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';
import { SecretEncryptionUtil } from '../../../common/crypto/secret-encryption.util.js';
import { KmsKeyProvider } from '../../../common/crypto/kms-key.provider.js';
import { ConfigService } from '@nestjs/config';
import { TransactionHashValidator } from '../../../common/validators/transaction-hash.validator.js';
import { StellarAddressValidator } from '../../../common/validators/stellar-address.validator.js';
import { WebhooksService } from '../../webhooks/webhooks.service.js';
import { ClaimAuditProvider } from './claim-audit.provider.js';

@Injectable()
export class ClaimRedemptionProvider {
  private readonly logger = new Logger(ClaimRedemptionProvider.name);

  constructor(
    @InjectRepository(Claim)
    private claimsRepository: Repository<Claim>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectDataSource()
    private dataSource: DataSource,
    private tokenVerificationProvider: TokenVerificationProvider,
    private sweepsService: SweepsService,
    private configService: ConfigService,
    private webhooksService: WebhooksService,
    private claimAuditProvider: ClaimAuditProvider,
    private kmsKeyProvider: KmsKeyProvider,
  ) {}

  async redeemClaim(
    token: string,
    destinationAddress: string,
    ip?: string | null,
  ): Promise<ClaimRedemptionResponseDto> {
    this.logger.log(`Redeeming claim for destination: ${destinationAddress}`);

    const tokenHash = this.hashToken(token);

    try {
      await this.tokenVerificationProvider.verifyClaimToken(token);
    } catch (error) {
      if (error instanceof ConflictException) {
        const claimedAccount = await this.accountsRepository.findOne({
          where: { claimTokenHash: tokenHash, deletedAt: IsNull() },
        });
        if (claimedAccount) {
          const existingClaim = await this.claimsRepository.findOne({
            where: { accountId: claimedAccount.id },
          });
          if (existingClaim) {
            return {
              success: true,
              txHash: existingClaim.sweepTxHash,
              amountSwept: existingClaim.amountSwept,
              asset: existingClaim.asset,
              destination: existingClaim.destinationAddress,
              sweptAt: existingClaim.claimedAt,
              message: 'Claim was already redeemed',
            };
          }
        }
      }
      throw error;
    }

    StellarAddressValidator.assertValid(destinationAddress);

    // Atomically acquire the claim slot using SELECT FOR UPDATE.
    // This prevents concurrent requests from both passing the status check.
    const { locked: account, wasPartialOnEntry } =
      await this.dataSource.transaction(async (manager: EntityManager) => {
        const locked = await manager
          .createQueryBuilder(Account, 'account')
          .setLock('pessimistic_write')
          .where('account.claimTokenHash = :tokenHash', { tokenHash })
          .andWhere('account.deletedAt IS NULL')
          .getOne();

        if (!locked) {
          throw new BadRequestException('Invalid or expired claim token');
        }

        // Defence in depth on account expiry (issue #687). The scheduler is
        // what normally moves an account to EXPIRED, so there is a window
        // between `expiresAt` passing and the status flipping. Verifying the
        // token up front catches the common case, but this locked read is a
        // separate query and must not rely on that check having happened.
        // Without it, a claim arriving in that window would attempt a sweep
        // of an account the contract has already expired.
        if (new Date() > locked.expiresAt) {
          this.logger.warn(
            `Refusing redemption for account ${locked.id}: expired at ${locked.expiresAt.toISOString()}`,
          );
          throw new UnauthorizedException(
            'Claim token has expired: the account expired before it was claimed',
          );
        }

        if (locked.status === AccountStatus.CLAIMED) {
          return { locked, wasPartialOnEntry: false };
        }

        if (locked.status === AccountStatus.CLAIMING) {
          throw new ConflictException('Claim is already being processed');
        }

        // Allow PENDING_CLAIM (fresh attempt) and PARTIAL_SWEEP (retry of a
        // contract-was-Swept-but-payment-failed prior attempt). Any other
        // status is rejected.
        if (
          locked.status !== AccountStatus.PENDING_CLAIM &&
          locked.status !== AccountStatus.PARTIAL_SWEEP
        ) {
          throw new BadRequestException(
            `Account cannot be redeemed. Status: ${locked.status}`,
          );
        }

        const wasPartial = locked.status === AccountStatus.PARTIAL_SWEEP;
        locked.status = AccountStatus.CLAIMING;
        locked.destinationAddress = destinationAddress;
        await manager.save(locked);
        return { locked, wasPartialOnEntry: wasPartial };
      });

    // Idempotent response for already-claimed account
    if (account.status === AccountStatus.CLAIMED) {
      this.logger.log(`Claim already redeemed for account: ${account.id}`);
      const existingClaim = await this.claimsRepository.findOne({
        where: { accountId: account.id },
      });
      if (!existingClaim) {
        throw new BadRequestException(
          'Claim record not found for already redeemed account',
        );
      }
      return {
        success: true,
        txHash: existingClaim.sweepTxHash,
        amountSwept: existingClaim.amountSwept,
        asset: existingClaim.asset,
        destination: existingClaim.destinationAddress,
        sweptAt: existingClaim.claimedAt,
        message: 'Claim was already redeemed',
      };
    }

    try {
      const sweepResult = await this.sweepsService.executeSweep({
        accountId: account.id,
        ephemeralPublicKey: account.publicKey,
        ephemeralSecret: SecretEncryptionUtil.decrypt(
          account.secretKeyEncrypted,
          this.kmsKeyProvider.getEncryptionKey(),
        ),
        destinationAddress,
        amount: account.amount,
        asset: account.asset,
        // PARTIAL_SWEEP retry: contract is already in Swept state from the
        // prior partial failure, so re-invoking execute_sweep would revert.
        // Skip steps 2-3 and only re-submit the Horizon payment.
        skipContractAuth: wasPartialOnEntry,
      });

      // PARTIAL SWEEP path: contract authorized but Horizon payment failed.
      // Mark the account so a future redemption attempt can retry the payment
      // (with skipContractAuth=true). Surface this as a non-error response
      // (status=200, success=false, isPartial=true) so callers can decide.
      if (sweepResult.isPartial) {
        await this.accountsRepository.update(account.id, {
          status: AccountStatus.PARTIAL_SWEEP,
          destinationAddress: '',
        });

        await this.claimAuditProvider.record({
          accountId: account.id,
          destination: destinationAddress,
          ip,
          outcome: 'partial',
          failureReason: sweepResult.error ?? 'unknown',
        });

        await this.webhooksService.triggerEvent('sweep.partial', {
          accountId: account.id,
          amount: account.amount,
          asset: account.asset,
          destination: destinationAddress,
          error: sweepResult.error,
          contractAuthHash: sweepResult.contractAuthHash,
        });

        return {
          success: false,
          isPartial: true,
          contractAuthHash: sweepResult.contractAuthHash,
          amountSwept: account.amount,
          asset: account.asset,
          destination: destinationAddress,
          error: sweepResult.error,
          message:
            'Sweep partially completed: contract authorized but Horizon payment failed. Retry with the same token.',
        };
      }

      TransactionHashValidator.assertValid(sweepResult.txHash as string);

      // Atomically record the claim and mark account as CLAIMED
      const claim = await this.dataSource.transaction(
        async (manager: EntityManager) => {
          account.status = AccountStatus.CLAIMED;
          account.claimedAt = new Date();
          await manager.save(account);

          const newClaim = manager.create(Claim, {
            accountId: account.id,
            destinationAddress,
            sweepTxHash: sweepResult.txHash as string,
            amountSwept: account.amount,
            asset: account.asset,
            claimedAt: account.claimedAt,
          });
          return manager.save(newClaim);
        },
      );

      this.logger.log(`Claim redeemed successfully: ${claim.id}`);

      await this.claimAuditProvider.record({
        accountId: account.id,
        destination: destinationAddress,
        ip,
        outcome: 'success',
      });

      await this.webhooksService.triggerEvent('sweep.completed', {
        accountId: account.id,
        amount: account.amount,
        asset: account.asset,
        destination: destinationAddress,
        txHash: sweepResult.txHash,
        sweptAt: claim.claimedAt,
        metadata: account.metadata,
      });

      return {
        success: true,
        txHash: sweepResult.txHash,
        amountSwept: account.amount,
        asset: account.asset,
        destination: destinationAddress,
        sweptAt: claim.claimedAt,
      };
    } catch (error) {
      // Revert from CLAIMING. On a retry that began in PARTIAL_SWEEP we
      // preserve the contract-is-Swept invariant by leaving the account
      // in PARTIAL_SWEEP — the contract is already authorized, so
      // settling-back to PENDING_CLAIM would invalidate that. Otherwise
      // revert to PENDING_CLAIM so the user can retry.
      const revertStatus = wasPartialOnEntry
        ? AccountStatus.PARTIAL_SWEEP
        : AccountStatus.PENDING_CLAIM;
      await this.accountsRepository.update(account.id, {
        status: revertStatus,
        destinationAddress: '',
      });

      const typedError = error as Error;
      this.logger.error(
        `Claim redemption failed: ${typedError.message}`,
        typedError.stack,
      );

      await this.claimAuditProvider.record({
        accountId: account.id,
        destination: destinationAddress,
        ip,
        outcome: 'failure',
        failureReason: typedError.message,
      });

      await this.webhooksService.triggerEvent('sweep.failed', {
        accountId: account.id,
        amount: account.amount,
        asset: account.asset,
        destination: destinationAddress,
        error: typedError.message,
        timestamp: new Date(),
      });

      throw error;
    }
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
