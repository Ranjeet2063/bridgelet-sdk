import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Histogram } from 'prom-client';

export const EXPIRY_BUFFER_LEDGERS = 10;

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private server: StellarSdk.Horizon.Server;
  private sorobanServer: SorobanRpc.Server;
  private network: string;

  constructor(
    private configService: ConfigService,
    @InjectMetric('soroban_rpc_latency_seconds')
    private readonly sorobanRpcLatency: Histogram<string>,
  ) {
    const horizonUrl =
      this.configService.getOrThrow<string>('stellar.horizonUrl');
    const sorobanRpcUrl = this.configService.getOrThrow<string>(
      'stellar.sorobanRpcUrl',
    );
    this.network = this.configService.getOrThrow<string>('stellar.network');
    this.server = new StellarSdk.Horizon.Server(horizonUrl);
    this.sorobanServer = new SorobanRpc.Server(sorobanRpcUrl);

    this.logger.log(`Initialized Stellar service for ${this.network}`);
  }

  /**
   * Fetches the current ledger sequence number from Horizon.
   * Used to convert wall-clock expiry times to ledger-based expiry
   * required by EphemeralAccount.initialize() on-chain.
   *
   * Stellar closes a ledger approximately every 5 seconds.
   * Conversion: expiry_ledger = current_ledger + Math.ceil(expiresInSeconds / 5)
   */
  async getCurrentLedger(): Promise<number> {
    const ledgerPage = await this.server
      .ledgers()
      .order('desc')
      .limit(1)
      .call();

    const sequence = ledgerPage.records[0].sequence;
    this.logger.debug(`Current ledger sequence: ${sequence}`);
    return sequence;
  }

  /**
   * Converts a seconds-based expiry duration to a Stellar ledger sequence number.
   * Adds a small buffer (10 ledgers) to account for submission latency.
   */
  async toExpiryLedger(expiresInSeconds: number): Promise<number> {
    const currentLedger = await this.getCurrentLedger();
    return (
      currentLedger + Math.ceil(expiresInSeconds / 5) + EXPIRY_BUFFER_LEDGERS
    );
  }

  /**
   * Generates the ephemeral account keypair.
   *
   * ## Randomness source (audited, #654)
   *
   * This returns the actual secret key for an account that will hold funds, so
   * the entropy source matters. The full chain, verified against the installed
   * dependency tree, is:
   *
   *   StellarSdk.Keypair.random()                  @stellar/stellar-base
   *     -> ed25519.utils.randomPrivateKey()        @noble/curves/ed25519
   *       -> randomSecretKey(seed = randomBytes(32))
   *         -> randomBytes()                       @noble/hashes/utils
   *           -> crypto.getRandomValues()          Web Crypto CSPRNG
   *
   * `@noble/hashes` falls back to Node's `crypto.randomBytes()` on older
   * runtimes and otherwise **throws** (`'crypto.getRandomValues must be
   * defined'`). It never silently degrades to a weaker generator, so there is
   * no path here that yields predictable key material.
   *
   * No intermediate helper in this codebase substitutes its own RNG: this method
   * delegates straight to the SDK, and `Math.random()` appears nowhere in the
   * key-generation path. `stellar.service.spec.ts` asserts that, so a future
   * change that introduces one fails the suite rather than shipping quietly.
   *
   * If this ever needs to become deterministic for tests, inject a seed
   * explicitly rather than swapping the generator - `Keypair.fromRawEd25519Seed()`
   * is the supported way in.
   */
  generateKeypair(): StellarSdk.Keypair {
    return StellarSdk.Keypair.random();
  }

  /**
   * Creates a funded ephemeral Stellar account and initializes the
   * EphemeralAccount Soroban contract with expiry and recovery restrictions.
   *
   * The two operations are:
   * 1. Horizon: CreateAccount operation (funds the account with base reserve)
   * 2. Soroban: EphemeralAccount.initialize() (sets on-chain restrictions)
   *
   * If the contract initialization fails after the Horizon transaction succeeds,
   * an error is thrown so the caller (AccountsService) can avoid persisting
   * a record for an unrestricted account.
   *
   * ⚠️ MVP Note: True atomicity between Horizon and Soroban is not possible.
   * A failed initialize() after a successful createAccount() will leave an
   * unrestricted funded account on-chain. Issue #15 tracks the compensation strategy.
   */
  async createEphemeralAccount(params: {
    publicKey: string;
    amount: string;
    asset: string;
    expiresIn: number;
    recoveryAddress: string;
    contractId: string;
    sweepControllerContractId: string;
    fundingKeypairSecret?: string;
  }): Promise<string> {
    this.logger.log(`Creating ephemeral account: ${params.publicKey}`);

    const fundingSecret =
      params.fundingKeypairSecret ??
      this.configService.getOrThrow<string>('stellar.fundingSecret');
    const fundingKeypair = StellarSdk.Keypair.fromSecret(fundingSecret);

    // Step 1: Create account on Stellar classic (Horizon)
    const fundingAccount = await this.server.loadAccount(
      fundingKeypair.publicKey(),
    );

    const transaction = new StellarSdk.TransactionBuilder(fundingAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.createAccount({
          destination: params.publicKey,
          startingBalance: '2',
        }),
      )
      .setTimeout(30)
      .build();

    transaction.sign(fundingKeypair);
    const result = await this.server.submitTransaction(transaction);
    this.logger.log(`Horizon account created: ${result.hash}`);

    // Step 2: Initialize the Soroban contract with restrictions
    const expiryLedger = await this.toExpiryLedger(params.expiresIn);

    const contract = new StellarSdk.Contract(params.contractId);
    const sourceAccount = await this.sorobanServer.getAccount(
      fundingKeypair.publicKey(),
    );

    const initTransaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(
        contract.call(
          'initialize',
          StellarSdk.Address.fromString(fundingKeypair.publicKey()).toScVal(), // creator
          StellarSdk.xdr.ScVal.scvU32(expiryLedger), // expiry_ledger
          StellarSdk.Address.fromString(params.recoveryAddress).toScVal(), // recovery_address
          StellarSdk.Address.fromString(
            params.sweepControllerContractId,
          ).toScVal(), // authorized_controller
          StellarSdk.Address.fromString(fundingKeypair.publicKey()).toScVal(),
        ),
      )
      .setTimeout(30)
      .build();

    const preparedTx =
      await this.sorobanServer.prepareTransaction(initTransaction);
    preparedTx.sign(fundingKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let initResult: SorobanRpc.Api.SendTransactionResponse;
    try {
      initResult = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (initResult.status === 'ERROR') {
      this.logger.error(
        `Contract initialize() failed for ${params.publicKey}: ${JSON.stringify(initResult.errorResult)}`,
      );
      throw new Error(
        `Contract initialization failed: ${JSON.stringify(initResult.errorResult ?? 'unknown')}`,
      );
    }

    // Poll for confirmation
    await this.waitForTransaction(initResult.hash);

    this.logger.log(
      `Contract initialized for ${params.publicKey}, expiry ledger: ${expiryLedger}`,
    );
    return result.hash;
  }

  /**
   * Calls EphemeralAccount.record_payment() on the Soroban contract.
   *
   * Should be called when an inbound payment is detected on the ephemeral
   * account's Stellar address (via Horizon payment stream — see Issue #9).
   *
   * Contract error mapping:
   * - Error::InvalidAmount     → throws — payment amount must be positive
   * - Error::DuplicateAsset    → throws — that asset already recorded, not retryable
   * - Error::TooManyPayments   → throws — 10 asset limit reached, not retryable
   * - Error::NotInitialized    → throws — contract not initialized, system error
   */
  async recordPayment(params: {
    contractId: string;
    amount: bigint; // i128 in contract — use bigint to avoid precision loss
    assetAddress: string; // Stellar contract address of the asset
    signerSecret: string;
  }): Promise<void> {
    const signerKeypair = StellarSdk.Keypair.fromSecret(params.signerSecret);
    const contract = new StellarSdk.Contract(params.contractId);
    const sourceAccount = await this.sorobanServer.getAccount(
      signerKeypair.publicKey(),
    );

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(
        contract.call(
          'record_payment',
          StellarSdk.xdr.ScVal.scvI128(
            new StellarSdk.xdr.Int128Parts({
              hi: StellarSdk.xdr.Int64.fromString(
                (params.amount >> 64n).toString(),
              ),
              lo: StellarSdk.xdr.Uint64.fromString(
                (params.amount & 0xffffffffffffffffn).toString(),
              ),
            }),
          ),
          StellarSdk.Address.fromString(params.assetAddress).toScVal(),
        ),
      )
      .setTimeout(30)
      .build();

    const preparedTx = await this.sorobanServer.prepareTransaction(transaction);
    preparedTx.sign(signerKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let result: SorobanRpc.Api.SendTransactionResponse;
    try {
      result = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (result.status === 'ERROR') {
      this.logger.error(
        `record_payment failed for contract ${params.contractId}: ${JSON.stringify(result.errorResult)}`,
      );
      throw new Error(
        `record_payment failed: ${JSON.stringify(result.errorResult ?? 'unknown')}`,
      );
    }

    await this.waitForTransaction(result.hash);
    this.logger.log(
      `Payment recorded on contract ${params.contractId}, amount: ${params.amount}`,
    );
  }

  /**
   * Calls SweepController.execute_sweep() to transfer funds from an ephemeral
   * account to the recipient's permanent wallet.
   *
   * The SweepController internally calls EphemeralAccount.sweep() which
   * validates state and updates the account status on-chain.
   *
   * ⚠️ MVP Note: The contract updates state and emits events but does NOT yet
   * execute token transfers on-chain. Actual fund movement is not implemented
   * in bridgelet-core at this stage. See bridgelet-core known limitations.
   *
   * Contract error mapping:
   * - Error::AlreadySwept          → terminal, do not retry
   * - Error::AccountExpired        → terminal, trigger expiry flow instead
   * - Error::UnauthorizedDestination → destination doesn't match locked mode config
   * - Error::AuthorizationFailed   → signature invalid
   */
  async executeSweep(params: {
    sweepControllerContractId: string;
    ephemeralAccountContractId: string;
    destination: string;
    authSignature: Buffer; // 64 bytes
    signerSecret: string;
  }): Promise<void> {
    const signerKeypair = StellarSdk.Keypair.fromSecret(params.signerSecret);
    const contract = new StellarSdk.Contract(params.sweepControllerContractId);
    const sourceAccount = await this.sorobanServer.getAccount(
      signerKeypair.publicKey(),
    );

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(
        contract.call(
          'execute_sweep',
          StellarSdk.Address.fromString(
            params.ephemeralAccountContractId,
          ).toScVal(),
          StellarSdk.Address.fromString(params.destination).toScVal(),
          StellarSdk.xdr.ScVal.scvBytes(params.authSignature),
        ),
      )
      .setTimeout(30)
      .build();

    const preparedTx = await this.sorobanServer.prepareTransaction(transaction);
    preparedTx.sign(signerKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let result: SorobanRpc.Api.SendTransactionResponse;
    try {
      result = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (result.status === 'ERROR') {
      const errStr = JSON.stringify(result.errorResult);
      this.logger.error(
        `execute_sweep failed for ${params.ephemeralAccountContractId}: ${errStr}`,
      );

      // Surface terminal errors explicitly so callers don't retry
      if (errStr.includes('AlreadySwept')) throw new Error('ALREADY_SWEPT');
      if (errStr.includes('AccountExpired')) throw new Error('ACCOUNT_EXPIRED');

      throw new Error(`execute_sweep failed: ${errStr}`);
    }

    await this.waitForTransaction(result.hash);
    this.logger.log(
      `Sweep executed: ${params.ephemeralAccountContractId} → ${params.destination}`,
    );
  }

  /**
   * Calls EphemeralAccount.expire() to close an unclaimed account after its
   * expiry ledger has been reached, directing funds to the recovery address.
   *
   * Should be called by a scheduled job monitoring accounts whose expiresAt
   * timestamp has passed. The scheduler is tracked separately (not in scope here).
   *
   * ⚠️ MVP Note: Fund recovery to recovery_address depends on token transfer
   * implementation in the contract, which is not yet complete in bridgelet-core.
   *
   * Contract error mapping:
   * - Error::NotExpired     → non-fatal race condition, ledger not yet reached
   * - Error::InvalidStatus  → terminal, account already swept or expired
   * - Error::NotInitialized → system error, contract was never initialized
   */
  async expireAccount(params: {
    contractId: string;
    signerSecret: string;
  }): Promise<void> {
    // Guard: check ledger before calling to avoid unnecessary transactions
    const currentLedger = await this.getCurrentLedger();
    const accountInfo = await this.getAccountInfo(params.contractId);

    if (currentLedger < accountInfo.expiry_ledger) {
      this.logger.warn(
        `expireAccount called too early for ${params.contractId}. ` +
          `Current: ${currentLedger}, expiry: ${accountInfo.expiry_ledger}`,
      );
      return; // non-fatal, scheduler will retry
    }

    const signerKeypair = StellarSdk.Keypair.fromSecret(params.signerSecret);
    const contract = new StellarSdk.Contract(params.contractId);
    const sourceAccount = await this.sorobanServer.getAccount(
      signerKeypair.publicKey(),
    );

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(contract.call('expire'))
      .setTimeout(30)
      .build();

    const preparedTx = await this.sorobanServer.prepareTransaction(transaction);
    preparedTx.sign(signerKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let result: SorobanRpc.Api.SendTransactionResponse;
    try {
      result = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (result.status === 'ERROR') {
      const errStr = JSON.stringify(result.errorResult);
      if (errStr.includes('InvalidStatus')) {
        throw new Error('ACCOUNT_ALREADY_TERMINAL');
      }
      throw new Error(`expire() failed: ${errStr}`);
    }

    await this.waitForTransaction(result.hash);
    this.logger.log(`Account expired on-chain: ${params.contractId}`);
  }

  /**
   * Calls EphemeralAccount.get_info() and returns the full on-chain account state.
   * Used by the sweep and claims modules to verify account readiness before acting,
   * and internally by expireAccount() to check expiry ledger before submitting.
   */
  async getAccountInfo(contractId: string): Promise<{
    status: string;
    expiry_ledger: number;
    payment_received: boolean;
    payment_count: number;
    recovery_address: string;
  }> {
    const contract = new StellarSdk.Contract(contractId);

    // get_info is a read-only call — use simulateTransaction, no signing needed
    const dummyKeypair = StellarSdk.Keypair.random();
    const sourceAccount = new StellarSdk.Account(dummyKeypair.publicKey(), '0');

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(contract.call('get_info'))
      .setTimeout(30)
      .build();

    const endTimer = this.sorobanRpcLatency.startTimer();
    let simResult: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      simResult = await this.sorobanServer.simulateTransaction(transaction);
    } finally {
      endTimer();
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`get_info simulation failed: ${simResult.error}`);
    }

    // Parse the returned ScVal - shape mirrors AccountInfo struct in bridgelet-core
    const returnVal = simResult.result?.retval;
    if (!returnVal)
      throw new Error(`get_info returned no value for ${contractId}`);

    const mapEntries = returnVal.map();
    if (!mapEntries) {
      throw new Error(
        `get_info returned unexpected ScVal type for ${contractId}`,
      );
    }

    const fields = mapEntries.map((entry) => ({
      key: entry.key().sym().toString(),
      val: entry.val(),
    }));

    const get = (key: string) => fields.find((f) => f.key === key)?.val;

    const recoveryVal = get('recovery_address');
    if (!recoveryVal) {
      throw new Error(
        `get_info missing recovery_address field for ${contractId}`,
      );
    }

    return {
      status: get('status')?.u32()?.toString() ?? 'unknown',
      expiry_ledger: get('expiry_ledger')?.u32() ?? 0,
      payment_received: get('payment_received')?.b() ?? false,
      payment_count: get('payment_count')?.u32() ?? 0,
      recovery_address: StellarSdk.Address.fromScVal(recoveryVal).toString(),
    };
  }

  /**
   * Polls Soroban RPC until a transaction is confirmed or fails.
   * Used after sendTransaction() which is async by nature.
   */
  private async waitForTransaction(
    txHash: string,
    maxAttempts = 10,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const endTimer = this.sorobanRpcLatency.startTimer();
      let status: SorobanRpc.Api.GetTransactionResponse;
      try {
        status = await this.sorobanServer.getTransaction(txHash);
      } finally {
        endTimer();
      }

      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return;
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction ${txHash} failed on-chain`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      `Transaction ${txHash} not confirmed after ${maxAttempts} attempts`,
    );
  }

  private getNetworkPassphrase(): string {
    return this.network === 'mainnet'
      ? StellarSdk.Networks.PUBLIC
      : StellarSdk.Networks.TESTNET;
  }
}
