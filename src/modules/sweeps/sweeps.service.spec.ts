import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { SweepsService } from './sweeps.service.js';
import { ValidationProvider } from './providers/validation.provider.js';
import { ContractProvider } from './providers/contract.provider.js';
import { TransactionProvider } from './providers/transaction.provider.js';
import { StellarService } from '../stellar/stellar.service.js';
import { ConfigService } from '@nestjs/config';
import { getToken } from '@willsoto/nestjs-prometheus';
import { SweepMetricsProvider } from './providers/sweep-metrics.provider.js';
import { Registry, register } from 'prom-client';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_AUTH_SIGNATURE = Buffer.alloc(64, 1);
const MOCK_TX_HASH = 'abc123txhash';
const MOCK_CONTRACT_AUTH_HASH = 'deadbeef'.repeat(8); // 64-char hex

const validRequest = {
  accountId: 'test-account-id',
  ephemeralPublicKey:
    'GEPH47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ephemeralSecret: 'SEPH47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  destinationAddress:
    'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN',
  amount: '100.0000000',
  asset: 'native',
};

const mockTxResult = {
  hash: MOCK_TX_HASH,
  ledger: 12345,
  successful: true,
  timestamp: new Date('2024-01-01T12:00:00Z'),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SweepsService', () => {
  let service: SweepsService;
  type SweepStatusResult = Awaited<
    ReturnType<ValidationProvider['getSweepStatus']>
  >;

  let validationProvider: {
    validateSweepParameters: jest.Mock<() => Promise<any>>;
    canSweep: jest.Mock<() => Promise<any>>;
    getSweepStatus: jest.Mock<() => Promise<any>>;
  };
  let contractProvider: {
    generateAuthSignature: jest.Mock<() => any>;
    generateAuthHash: jest.Mock<() => any>;
  };
  let transactionProvider: {
    executeSweepTransaction: jest.Mock<() => Promise<any>>;
  };
  let stellarService: { executeSweep: jest.Mock<() => Promise<any>> };

  beforeEach(async () => {
    validationProvider = {
      validateSweepParameters: jest.fn<any>().mockResolvedValue(undefined),
      canSweep: jest.fn<any>().mockResolvedValue(true),
      getSweepStatus: jest.fn<any>().mockResolvedValue({ canSweep: true }),
    };

    contractProvider = {
      generateAuthSignature: jest
        .fn<any>()
        .mockReturnValue(MOCK_AUTH_SIGNATURE),
      generateAuthHash: jest.fn<any>().mockReturnValue(MOCK_CONTRACT_AUTH_HASH),
    };

    transactionProvider = {
      executeSweepTransaction: jest.fn<any>().mockResolvedValue(mockTxResult),
    };

    stellarService = {
      executeSweep: jest.fn<any>().mockResolvedValue(undefined),
    };

    const configMock = {
      getOrThrow: jest.fn((key: string) => {
        const map: Record<string, string> = {
          'stellar.contracts.sweepController': 'SWEEP_CTRL_CONTRACT_ID',
          'stellar.contracts.ephemeralAccount': 'EPHEMERAL_CONTRACT_ID',
        };
        if (!(key in map)) throw new Error(`Config key not found: ${key}`);
        return map[key];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SweepsService,
        SweepMetricsProvider,
        { provide: ValidationProvider, useValue: validationProvider },
        { provide: ContractProvider, useValue: contractProvider },
        { provide: TransactionProvider, useValue: transactionProvider },
        { provide: StellarService, useValue: stellarService },
        { provide: ConfigService, useValue: configMock },
        {
          provide: getToken('sweep_success_total'),
          useValue: { inc: jest.fn() },
        },
        {
          provide: getToken('sweep_failure_total'),
          useValue: { inc: jest.fn() },
        },
        {
          provide: Registry,
          useValue: register,
        },
      ],
    }).compile();

    service = module.get<SweepsService>(SweepsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path — full flow
  // -------------------------------------------------------------------------

  describe('executeSweep — happy path', () => {
    it('calls validation first', async () => {
      await service.executeSweep(validRequest);
      expect(validationProvider.validateSweepParameters).toHaveBeenCalledWith(
        validRequest,
      );
    });

    it('generates auth signature via ContractProvider', async () => {
      await service.executeSweep(validRequest);
      expect(contractProvider.generateAuthSignature).toHaveBeenCalledWith({
        ephemeralPublicKey: validRequest.ephemeralPublicKey,
        destinationAddress: validRequest.destinationAddress,
      });
    });

    it('submits the contract call via StellarService.executeSweep()', async () => {
      await service.executeSweep(validRequest);
      expect(stellarService.executeSweep).toHaveBeenCalledWith({
        sweepControllerContractId: 'SWEEP_CTRL_CONTRACT_ID',
        ephemeralAccountContractId: 'EPHEMERAL_CONTRACT_ID',
        destination: validRequest.destinationAddress,
        authSignature: MOCK_AUTH_SIGNATURE,
        signerSecret: validRequest.ephemeralSecret,
      });
    });

    it('executes the Horizon payment via TransactionProvider', async () => {
      await service.executeSweep(validRequest);
      expect(transactionProvider.executeSweepTransaction).toHaveBeenCalledWith({
        ephemeralSecret: validRequest.ephemeralSecret,
        destinationAddress: validRequest.destinationAddress,
        amount: validRequest.amount,
        asset: validRequest.asset,
      });
    });

    it('calls validation before the contract call', async () => {
      const order: string[] = [];
      validationProvider.validateSweepParameters.mockImplementation(() => {
        order.push('validate');
        return Promise.resolve();
      });
      stellarService.executeSweep.mockImplementation(() => {
        order.push('contract');
        return Promise.resolve();
      });

      await service.executeSweep(validRequest);

      expect(order.indexOf('validate')).toBeLessThan(order.indexOf('contract'));
    });

    it('calls the contract before the Horizon payment', async () => {
      const order: string[] = [];
      stellarService.executeSweep.mockImplementation(() => {
        order.push('contract');
        return Promise.resolve();
      });
      transactionProvider.executeSweepTransaction.mockImplementation(() => {
        order.push('payment');
        return Promise.resolve(mockTxResult as any);
      });

      await service.executeSweep(validRequest);

      expect(order.indexOf('contract')).toBeLessThan(order.indexOf('payment'));
    });

    it('returns the real txHash from the Horizon payment', async () => {
      const result = await service.executeSweep(validRequest);
      expect(result.txHash).toBe(MOCK_TX_HASH);
    });

    it('returns success: true and correct fields', async () => {
      const result = await service.executeSweep(validRequest);
      expect(result).toEqual({
        success: true,
        txHash: MOCK_TX_HASH,
        contractAuthHash: MOCK_CONTRACT_AUTH_HASH,
        amountSwept: validRequest.amount,
        destination: validRequest.destinationAddress,
        timestamp: mockTxResult.timestamp,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe('executeSweep — error propagation', () => {
    it('propagates validation errors and does not proceed', async () => {
      validationProvider.validateSweepParameters.mockRejectedValue(
        new Error('Validation failed'),
      );

      await expect(service.executeSweep(validRequest)).rejects.toThrow(
        'Validation failed',
      );
      expect(stellarService.executeSweep).not.toHaveBeenCalled();
      expect(
        transactionProvider.executeSweepTransaction,
      ).not.toHaveBeenCalled();
    });

    it('propagates StellarService.executeSweep() errors and does not call Horizon payment', async () => {
      stellarService.executeSweep.mockRejectedValue(new Error('ALREADY_SWEPT'));

      await expect(service.executeSweep(validRequest)).rejects.toThrow(
        'ALREADY_SWEPT',
      );
      expect(
        transactionProvider.executeSweepTransaction,
      ).not.toHaveBeenCalled();
    });

    // Regression: prior behaviour propagated Horizon payment errors.
    // Since #169, sweeper for the contract-authorized-but-payment-failed
    // path no longer throws — it returns a structured isPartial result so
    // the orchestrator can transition the account into PARTIAL_SWEEP and
    // emit a sweep.partial webhook. The new contract is asserted by the
    // dedicated `isPartial` test below; we deliberately omit the old
    // `propagates TransactionProvider errors` test here.

    it('returns isPartial: true (does NOT throw) when Horizon payment fails after contract authorization', async () => {
      const horizonError = new Error('Horizon payment failed');
      transactionProvider.executeSweepTransaction.mockRejectedValue(
        horizonError,
      );

      // Spy on the service's private logger
      const loggerErrorSpy = jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => {});

      // The sweeper no longer throws — it returns a structured partial
      // result so the orchestrator can transition the account to PARTIAL_SWEEP
      // and emit a sweep.partial webhook.
      const result = await service.executeSweep(validRequest);

      expect(result.success).toBe(false);
      expect(result.isPartial).toBe(true);
      expect(result.error).toBe('Horizon payment failed');
      expect(result.contractAuthHash).toBe(MOCK_CONTRACT_AUTH_HASH);
      expect(result.amountSwept).toBe(validRequest.amount);
      expect(result.destination).toBe(validRequest.destinationAddress);
      expect(result.txHash).toBeUndefined();
      expect(result.timestamp).toBeUndefined();

      // The log line is now PARTIAL (not CRITICAL) to distinguish recoverable
      // vs fatal in monitoring.
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('PARTIAL sweep'),
        horizonError.stack,
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(validRequest.accountId),
        horizonError.stack,
      );
    });

    it('skips contract auth + execute_sweep when skipContractAuth=true; only runs Horizon payment', async () => {
      await service.executeSweep({
        ...validRequest,
        skipContractAuth: true,
      });

      expect(contractProvider.generateAuthSignature).not.toHaveBeenCalled();
      expect(stellarService.executeSweep).not.toHaveBeenCalled();
      // The Horizon payment still runs to retry the failed payment.
      expect(transactionProvider.executeSweepTransaction).toHaveBeenCalledWith({
        ephemeralSecret: validRequest.ephemeralSecret,
        destinationAddress: validRequest.destinationAddress,
        amount: validRequest.amount,
        asset: validRequest.asset,
      });
    });

    it('returns a success result with txHash when skipContractAuth=true and the Horizon payment succeeds', async () => {
      const result = await service.executeSweep({
        ...validRequest,
        skipContractAuth: true,
      });

      expect(result.isPartial).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.contractAuthHash).toBe(MOCK_CONTRACT_AUTH_HASH);
    });

    it('returns isPartial: true when skipContractAuth=true but the Horizon payment still fails', async () => {
      transactionProvider.executeSweepTransaction.mockRejectedValue(
        new Error('Horizon offline'),
      );

      const result = await service.executeSweep({
        ...validRequest,
        skipContractAuth: true,
      });

      expect(result.isPartial).toBe(true);
      expect(result.error).toBe('Horizon offline');
      // Skipped contract side did NOT happen.
      expect(contractProvider.generateAuthSignature).not.toHaveBeenCalled();
      expect(stellarService.executeSweep).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // canSweep / getSweepStatus — delegates unchanged
  // -------------------------------------------------------------------------

  describe('canSweep', () => {
    it('delegates to ValidationProvider', async () => {
      validationProvider.canSweep.mockResolvedValue(true);
      const result = await service.canSweep('account-id', 'GDEST...');
      expect(validationProvider.canSweep).toHaveBeenCalledWith(
        'account-id',
        'GDEST...',
      );
      expect(result).toBe(true);
    });
  });

  describe('getSweepStatus', () => {
    it('delegates to ValidationProvider', async () => {
      const sweepStatus: SweepStatusResult = {
        canSweep: false,
        reason: 'expired',
      };
      validationProvider.getSweepStatus.mockResolvedValue(sweepStatus);
      const result = await service.getSweepStatus('account-id');
      expect(validationProvider.getSweepStatus).toHaveBeenCalledWith(
        'account-id',
      );
      expect(result).toEqual({ canSweep: false, reason: 'expired' });
    });
  });
});
