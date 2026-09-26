import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity.js';
import type { SweepExecutionRequest } from '../interfaces/execute-sweep.interface.js';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';
import { StellarAddressValidator } from '../../../common/validators/stellar-address.validator.js';

@Injectable()
export class ValidationProvider {
  private readonly logger = new Logger(ValidationProvider.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  /**
   * Validate all sweep parameters before execution
   */
  public async validateSweepParameters(
    sweepExecutionRequest: SweepExecutionRequest,
  ): Promise<void> {
    this.logger.log(
      `Validating sweep parameters for account: ${sweepExecutionRequest.accountId}`,
    );

    // Validate destination address
    StellarAddressValidator.assertValid(
      sweepExecutionRequest.destinationAddress,
    );

    // Validate account exists, is in correct state, and has not been
    // soft-deleted (deletedAt: IsNull() is explicit here even though
    // TypeORM's @DeleteDateColumn already filters it, per issue #435).
    const account = await this.accountRepository.findOne({
      where: { id: sweepExecutionRequest.accountId, deletedAt: IsNull() },
    });

    if (!account) {
      throw new NotFoundException(
        `Account ${sweepExecutionRequest.accountId} not found`,
      );
    }

    // Validate ephemeral public key matches
    if (account.publicKey !== sweepExecutionRequest.ephemeralPublicKey) {
      throw new BadRequestException('Ephemeral public key mismatch');
    }

    // Check account status
    // Verify account has received payment
    if (account.status === AccountStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Account has not received payment yet');
    }

    if (account.status !== AccountStatus.PENDING_CLAIM) {
      throw new BadRequestException(
        `Account cannot be swept. Status: ${account.status}`,
      );
    }

    // Check account hasn't expired
    if (new Date() > account.expiresAt) {
      throw new BadRequestException('Account has expired');
    }

    // Validate amount is positive
    const amount = parseFloat(sweepExecutionRequest.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive number');
    }

    // Validate amount matches account balance
    if (sweepExecutionRequest.amount !== account.amount) {
      throw new BadRequestException(
        `Amount mismatch: expected ${account.amount}, got ${sweepExecutionRequest.amount}`,
      );
    }

    // Validate asset format
    if (!this.isValidAssetFormat(sweepExecutionRequest.asset)) {
      throw new BadRequestException('Invalid asset format');
    }

    // Validate asset matches
    if (sweepExecutionRequest.asset !== account.asset) {
      throw new BadRequestException(
        `Asset mismatch: expected ${account.asset}, got ${sweepExecutionRequest.asset}`,
      );
    }

    this.logger.log(
      `Validation passed for account: ${sweepExecutionRequest.accountId}`,
    );
  }

  /**
   * Check if account can be swept
   */
  public async canSweep(
    accountId: string,
    destinationAddress: string,
  ): Promise<boolean> {
    try {
      const account = await this.accountRepository.findOne({
        where: { id: accountId, deletedAt: IsNull() },
      });

      if (!account) return false;
      if (account.status !== AccountStatus.PENDING_CLAIM) return false;
      if (new Date() > account.expiresAt) return false;

      StellarAddressValidator.assertValid(destinationAddress);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get detailed sweep status
   */
  public async getSweepStatus(
    accountId: string,
  ): Promise<{ canSweep: boolean; reason?: string }> {
    const account = await this.accountRepository.findOne({
      where: { id: accountId, deletedAt: IsNull() },
    });

    if (!account) {
      return { canSweep: false, reason: 'Account not found' };
    }

    if (!account.publicKey) {
      return {
        canSweep: false,
        reason: 'No public key associated with account',
      };
    }

    if (account.status === AccountStatus.CLAIMED) {
      return { canSweep: false, reason: 'Already swept' };
    }

    if (account.status === AccountStatus.EXPIRED) {
      return { canSweep: false, reason: 'Account expired' };
    }

    if (account.status === AccountStatus.PENDING_PAYMENT) {
      return { canSweep: false, reason: 'Payment not received' };
    }

    if (new Date() > account.expiresAt) {
      return { canSweep: false, reason: 'Account expired' };
    }

    return { canSweep: true };
  }

  /**
   * Validate asset format (native, XLM, or CODE:ISSUER)
   */
  private isValidAssetFormat(asset: string): boolean {
    if (asset === 'native' || asset === 'XLM') {
      return true;
    }

    // Format: CODE:ISSUER
    const parts = asset.split(':');
    if (parts.length !== 2) {
      return false;
    }

    const [code, issuer] = parts;
    // Asset code: 1-12 alphanumeric characters
    if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) {
      return false;
    }

    // Issuer must be valid Stellar address
    return StellarAddressValidator.isValid(issuer);
  }
}
