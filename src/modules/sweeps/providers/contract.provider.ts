import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Contract,
  rpc,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Address,
  xdr,
  hash,
} from '@stellar/stellar-sdk';
import type { AuthorizeSweepParams } from '../interfaces/authorize-sweep-params.interface.js';
import type { ContractAuthResult } from '../interfaces/contract-auth-result.interface.js';
import { SweepSignerUtil } from '../../../common/crypto/sweep-signer.util.js';

/**
 * Reported by {@link ContractProvider.getContractInfo} when the deployed
 * contract's version is not configured. Preferred over a hardcoded semver,
 * which silently drifts from the deployed WASM once the contract is
 * redeployed (#648).
 */
export const UNKNOWN_CONTRACT_VERSION = 'unknown';

@Injectable()
export class ContractProvider {
  private readonly logger = new Logger(ContractProvider.name);
  private readonly contractId: string;
  private readonly contractVersion: string;
  private readonly sorobanRpcUrl: string;
  private readonly networkPassphrase: string;

  /**
   * #650: built once per provider, not once per sweep. This provider is
   * registered with Nest's default (singleton) scope, so a single connection
   * is shared process-wide - matching TransactionProvider, which has always
   * built its Horizon server in the constructor.
   */
  private readonly server: rpc.Server;

  constructor(private readonly configService: ConfigService) {
    this.contractId = this.configService.getOrThrow<string>(
      'stellar.contracts.ephemeralAccount',
    );
    this.sorobanRpcUrl = this.configService.getOrThrow<string>(
      'stellar.sorobanRpcUrl',
    );

    // #648: sourced from config, not a literal, so the reported version
    // tracks the contract that is actually deployed. `get` (not
    // `getOrThrow`) because an unset version is reported as 'unknown'
    // rather than preventing the service from starting.
    this.contractVersion =
      this.configService.get<string>(
        'stellar.contracts.ephemeralAccountVersion',
      ) ?? UNKNOWN_CONTRACT_VERSION;

    const network = this.configService.getOrThrow<string>('stellar.network');
    this.networkPassphrase =
      network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    this.server = new rpc.Server(this.sorobanRpcUrl);

    this.logger.log(
      `Initialized ContractProvider with contract: ${this.contractId}`,
    );
  }

  /**
   * Authorize sweep via smart contract
   * Calls the contract's sweep() function to validate authorization
   */
  public async authorizeSweep(
    params: AuthorizeSweepParams,
  ): Promise<ContractAuthResult> {
    this.logger.log(
      `Authorizing sweep for account: ${params.ephemeralPublicKey}`,
    );

    try {
      // Reuse the shared Soroban RPC connection built in the constructor (#650)
      const server = this.server;

      // Create contract instance
      const contract = new Contract(this.contractId);

      // Prepare destination address parameter
      const destination = Address.fromString(params.destinationAddress);

      // Generate authorization signature
      // In production, this would be signed by an authorized key
      // For MVP, we create a dummy signature
      const authSignature = this.generateAuthSignature(params);

      // Build contract invocation transaction
      const account = await server.getAccount(params.ephemeralPublicKey);

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'sweep',
            destination.toScVal(),
            xdr.ScVal.scvBytes(authSignature),
          ),
        )
        .setTimeout(30)
        .build();

      // Simulate contract call first
      const simulated = await server.simulateTransaction(transaction);

      if (rpc.Api.isSimulationError(simulated)) {
        throw new Error(`Contract simulation failed: ${simulated.error}`);
      }

      // For MVP, we don't actually submit this transaction
      // The sweep will be handled by direct Stellar payment
      // In production, this would be submitted to enforce on-chain authorization

      this.logger.log('Contract authorization successful');

      // Generate cryptographically secure authorization hash
      const timestamp = Date.now();
      const authHash = this.generateAuthHash(
        params.ephemeralPublicKey,
        params.destinationAddress,
        timestamp,
      );

      return {
        authorized: true,
        hash: authHash,
        timestamp: new Date(timestamp),
      };
    } catch (error) {
      const typedError = error as Error;
      this.logger.error(
        `Contract execution failed: ${typedError.message}`,
        typedError.stack,
      );
      throw new InternalServerErrorException(
        `Contract execution failed: ${typedError.message}`,
      );
    }
  }

  public generateAuthSignature(params: AuthorizeSweepParams): Buffer {
    const signingKeySeed = this.configService.getOrThrow<string>(
      'stellar.sweepSigningKeySeed',
    );
    const sweepControllerContractId = this.configService.getOrThrow<string>(
      'stellar.contracts.sweepController',
    );

    // Fetch the current nonce from the SweepController contract before signing.
    // The nonce must match what the contract will read during verification.
    // This call is synchronous here for interface compatibility; the caller
    // (SweepsService) should ensure the nonce is current before invoking.
    const nonce = params.nonce ?? 0n;

    return SweepSignerUtil.sign(
      params.destinationAddress,
      nonce,
      sweepControllerContractId,
      signingKeySeed,
    );
  }

  /**
   * Check contract status and version.
   *
   * `version` comes from `stellar.contracts.ephemeralAccountVersion`
   * (`EPHEMERAL_ACCOUNT_CONTRACT_VERSION`) and is
   * {@link UNKNOWN_CONTRACT_VERSION} when that is not configured. It is
   * deliberately not a hardcoded literal: this value is safe to surface on
   * an admin/health endpoint, so it must never claim a version the deployed
   * contract does not have (#648).
   *
   * Verified for #709 (duplicate of the already-resolved #648, fixed in PR #781).
   */
  public getContractInfo(): {
    contractId: string;
    version: string;
  } {
    return {
      contractId: this.contractId,
      version: this.contractVersion,
    };
  }
  /**
   * Generate cryptographically secure authorization hash
   * Uses Stellar SDK's SHA-256 hash function for security
   *
   * @param ephemeralKey - The ephemeral account public key
   * @param destination - The destination address for the sweep
   * @param timestamp - Optional timestamp for replay protection (defaults to current time)
   * @returns 64-character hex string of the SHA-256 hash
   */
  public generateAuthHash(
    ephemeralKey: string,
    destination: string,
    timestamp?: number,
  ): string {
    const ts = timestamp ?? Date.now();
    const message = `${ephemeralKey}:${destination}:${ts}`;
    const hashBuffer = hash(Buffer.from(message));
    return hashBuffer.toString('hex');
  }
}
