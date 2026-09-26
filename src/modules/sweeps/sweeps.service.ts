import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationProvider } from './providers/validation.provider.js';
import { ContractProvider } from './providers/contract.provider.js';
import { TransactionProvider } from './providers/transaction.provider.js';
import { StellarService } from '../stellar/stellar.service.js';
import type { SweepExecutionRequest } from './interfaces/execute-sweep.interface.js';
import type { SweepResult } from './interfaces/sweep-result.interface.js';
import { TransactionResult } from './interfaces/transaction-result.interface.js';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { SweepMetricsProvider } from './providers/sweep-metrics.provider.js';

@Injectable()
export class SweepsService {
  private readonly logger = new Logger(SweepsService.name);

  constructor(
    private readonly validationProvider: ValidationProvider,
    private readonly contractProvider: ContractProvider,
    private readonly transactionProvider: TransactionProvider,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    @InjectMetric('sweep_success_total')
    private readonly sweepSuccessCounter: Counter<string>,
    @InjectMetric('sweep_failure_total')
    private readonly sweepFailureCounter: Counter<string>,
    private readonly sweepMetrics: SweepMetricsProvider,
  ) {}

  /**
   * Execute sweep: authorize on-chain via SweepController contract, then
   * transfer funds via a classic Horizon payment.
   *
   * The authoritative description of the 4-step flow, including a sequence
   * diagram, lives in this module's README rather than here, so it does not
   * have to be reverse-engineered from code comments (#651):
   * {@link ../README.md | src/modules/sweeps/README.md} - see "Sweep Flow".
   *
   * The order of operations below is strict and intentional.
   *
   * ⚠️ If Step 3 succeeds but Step 4 fails, the contract will be in Swept
   * state but no funds will have moved. This is logged as a critical error
   * for manual recovery. Do not retry automatically. The README section
   * "Failure between steps 3 and 4" documents the recovery path.
   */
  public async executeSweep(
    sweepExecutionRequest: SweepExecutionRequest,
  ): Promise<SweepResult> {
    this.logger.log(
      `Executing sweep for account: ${sweepExecutionRequest.accountId}`,
    );

    // Step 1: Validate sweep parameters
    await this.validationProvider.validateSweepParameters(
      sweepExecutionRequest,
    );

    // Steps 2 & 3: Smart-contract authorization.
    // On a retry into PARTIAL_SWEEP the contract is already in Swept state
    // and re-invoking execute_sweep would revert on-chain. The orchestrator
    // (ClaimRedemptionProvider) signals this via skipContractAuth: true and
    // we synthesise the auth hash deterministically from the same inputs
    // for audit-trail purposes.
    let contractAuthHash: string;
    if (sweepExecutionRequest.skipContractAuth) {
      this.logger.log(
        `Skip-contract-auth retry for account ${sweepExecutionRequest.accountId}: ` +
          'contract already in Swept state from prior partial failure.',
      );
      contractAuthHash = this.contractProvider.generateAuthHash(
        sweepExecutionRequest.ephemeralPublicKey,
        sweepExecutionRequest.destinationAddress,
      );
    } else {
      // Step 2: Generate authorization signature for the contract call
      const authSignature = this.contractProvider.generateAuthSignature({
        ephemeralPublicKey: sweepExecutionRequest.ephemeralPublicKey,
        destinationAddress: sweepExecutionRequest.destinationAddress,
      });

      // Step 3: Submit execute_sweep() on the SweepController Soroban contract
      const sweepControllerContractId = this.configService.getOrThrow<string>(
        'stellar.contracts.sweepController',
      );
      const ephemeralAccountContractId = this.configService.getOrThrow<string>(
        'stellar.contracts.ephemeralAccount',
      );

      await this.stellarService.executeSweep({
        sweepControllerContractId,
        ephemeralAccountContractId,
        destination: sweepExecutionRequest.destinationAddress,
        authSignature,
        signerSecret: sweepExecutionRequest.ephemeralSecret,
      });

      this.logger.log(
        `Contract sweep authorized for account ${sweepExecutionRequest.accountId}`,
      );

      contractAuthHash = this.contractProvider.generateAuthHash(
        sweepExecutionRequest.ephemeralPublicKey,
        sweepExecutionRequest.destinationAddress,
      );
    }

    // Step 4: Execute the classic Horizon payment to move funds.
    // We catch errors here and return a structured partial result
    // (isPartial: true) instead of propagating them: the contract may
    // already be in Swept state by this point and a thrown exception
    // would force the orchestrator into a manual recovery flow.
    // Returning isPartial lets the caller transition the account to
    // PARTIAL_SWEEP and emit a sweep.partial webhook so a retry
    // redemption (or an operator) can pick up the work.
    let transactionResult: TransactionResult;
    try {
      transactionResult =
        await this.transactionProvider.executeSweepTransaction({
          ephemeralSecret: sweepExecutionRequest.ephemeralSecret,
          destinationAddress: sweepExecutionRequest.destinationAddress,
          amount: sweepExecutionRequest.amount,
          asset: sweepExecutionRequest.asset,
        });
      this.sweepSuccessCounter.inc();
    } catch (error) {
      this.sweepFailureCounter.inc();
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `PARTIAL sweep: contract authorized but Horizon payment failed for ` +
          `account ${sweepExecutionRequest.accountId}. Contract auth hash: ` +
          `${contractAuthHash}. Error: ${message}`,
        stack,
      );
      this.sweepMetrics.recordFailed();
      return {
        success: false,
        isPartial: true,
        contractAuthHash,
        amountSwept: sweepExecutionRequest.amount,
        destination: sweepExecutionRequest.destinationAddress,
        error: message,
      };
    }

    this.logger.log(`Sweep complete: txHash=${transactionResult.hash}`);
    this.sweepMetrics.recordCompleted();

    return {
      success: true,
      txHash: transactionResult.hash,
      contractAuthHash,
      amountSwept: sweepExecutionRequest.amount,
      destination: sweepExecutionRequest.destinationAddress,
      timestamp: transactionResult.timestamp,
    };
  }

  /**
   * Check if account can be swept (validation only, no execution)
   */
  public async canSweep(
    accountId: string,
    destinationAddress: string,
  ): Promise<boolean> {
    return this.validationProvider.canSweep(accountId, destinationAddress);
  }

  /**
   * Get sweep status for an account
   */
  public async getSweepStatus(accountId: string): Promise<{
    canSweep: boolean;
    reason?: string;
  }> {
    return this.validationProvider.getSweepStatus(accountId);
  }
}
