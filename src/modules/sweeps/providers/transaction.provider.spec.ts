import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException, Logger } from '@nestjs/common';
import { BASE_FEE, Networks } from '@stellar/stellar-sdk';
import { TransactionProvider } from './transaction.provider.js';

// Define proper types for our mocks
interface MockKeypair {
  publicKey: () => string;
  secret: () => string;
}

interface MockAsset {
  isNative: () => boolean;
  getCode?: () => string;
  getIssuer?: () => string;
}

interface MockAccount {
  id: string;
  sequence: string;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;
  subentry_count?: number;
  offers?: Array<{ id: string }>;
}

interface MockTransactionResult {
  hash: string;
  ledger: number;
  successful: boolean;
}

interface MockTransaction {
  sign: jest.Mock;
}

interface MockTransactionBuilder {
  loadAccount?: jest.Mock;
  submitTransaction?: jest.Mock;
  addOperation?: jest.Mock;
  setTimeout?: jest.Mock;
  build?: jest.Mock;
}

interface MockOperation {
  type: string;
  [key: string]: unknown;
}

interface MockHorizonError extends Error {
  response?: {
    data?: {
      extras?: {
        result_codes?: {
          transaction?: string;
          operations?: string[];
        };
      };
    };
  };
}

interface TransactionProviderWithPrivates {
  parseAsset(assetString: string): MockAsset;
}

const mockSubmitTransaction = jest.fn<
  Promise<MockTransactionResult>,
  [unknown]
>();
const mockLoadAccount = jest.fn<Promise<MockAccount>, [string]>();
const mockTransactionSign = jest.fn<void, [MockKeypair]>();
const mockTransactionBuild = jest.fn<MockTransaction, []>(() => ({
  sign: mockTransactionSign,
}));
const mockTransactionSetTimeout = jest
  .fn<MockTransactionBuilder, [number]>()
  .mockReturnThis();
const mockTransactionAddOperation = jest
  .fn<MockTransactionBuilder, [MockOperation]>()
  .mockReturnThis();
const mockTransactionBuilder = jest
  .fn<
    MockTransactionBuilder,
    [MockAccount, { fee: string; networkPassphrase: string }]
  >()
  .mockImplementation(
    (): MockTransactionBuilder => ({
      addOperation: mockTransactionAddOperation,
      setTimeout: mockTransactionSetTimeout,
      build: mockTransactionBuild,
    }),
  );
const mockPaymentOperation = jest.fn<
  MockOperation,
  [{ destination: string; asset: MockAsset; amount: string }]
>((params) => ({
  type: 'payment',
  ...params,
}));
const mockAccountMergeOperation = jest.fn<
  MockOperation,
  [{ destination: string }]
>((params) => ({
  type: 'accountMerge',
  ...params,
}));

const mockKeypair: MockKeypair = {
  publicKey: jest
    .fn()
    .mockReturnValue(
      'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
    ),
  secret: jest.fn().mockReturnValue('S_SECRET'),
};

const mockKeypairFromSecret = jest
  .fn<MockKeypair, [string]>()
  .mockReturnValue(mockKeypair);
const mockAssetNative: MockAsset = {
  isNative: jest.fn().mockReturnValue(true),
};
const mockAssetConstructor = jest
  .fn<MockAsset, [string, string]>()
  .mockImplementation((code, issuer) => {
    if (!code || !issuer) {
      throw new Error('Asset code and issuer are required');
    }
    if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) {
      throw new Error('Invalid asset code');
    }
    if (!/^G[A-Z2-7]{55}$/.test(issuer)) {
      throw new Error('Invalid asset issuer');
    }
    return {
      isNative: () => false,
      getCode: () => code,
      getIssuer: () => issuer,
    };
  });

// Add native property to constructor
(
  mockAssetConstructor as typeof mockAssetConstructor & { native: jest.Mock }
).native = jest.fn<MockAsset, []>().mockReturnValue(mockAssetNative);

function getMockKeypairFromSecret(...args: [string]): MockKeypair {
  return mockKeypairFromSecret(...args);
}

function getMockTransactionBuilder(
  ...args: [MockAccount, { fee: string; networkPassphrase: string }]
): MockTransactionBuilder {
  return mockTransactionBuilder(...args);
}

function getMockPaymentOperation(
  ...args: [{ destination: string; asset: MockAsset; amount: string }]
): MockOperation {
  return mockPaymentOperation(...args);
}

function getMockAccountMergeOperation(
  ...args: [{ destination: string }]
): MockOperation {
  return mockAccountMergeOperation(...args);
}

function getMockAsset(...args: [string, string]): MockAsset {
  return mockAssetConstructor(...args);
}

getMockAsset.native = (): MockAsset =>
  (
    mockAssetConstructor as typeof mockAssetConstructor & { native: jest.Mock }
  ).native();

jest.mock('@stellar/stellar-sdk', () => {
  return {
    Horizon: {
      Server: jest.fn().mockImplementation(
        (): MockTransactionBuilder => ({
          loadAccount: mockLoadAccount,
          submitTransaction: mockSubmitTransaction,
        }),
      ),
    },
    Keypair: {
      fromSecret: getMockKeypairFromSecret,
    },
    TransactionBuilder: getMockTransactionBuilder,
    Operation: {
      payment: getMockPaymentOperation,
      accountMerge: getMockAccountMergeOperation,
    },
    Asset: getMockAsset,
    BASE_FEE: 100,
    Networks: {
      PUBLIC: 'Public Global Stellar Network ; September 2015',
      TESTNET: 'Test SDF Network ; September 2015',
    },
  };
});

describe('TransactionProvider', () => {
  let provider: TransactionProvider;
  let loggerErrorSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;

  const createProvider = async (
    network = 'testnet',
  ): Promise<TransactionProvider> => {
    const module = await Test.createTestingModule({
      providers: [
        TransactionProvider,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              const config: Record<string, string> = {
                'stellar.horizonUrl': 'https://horizon-testnet.stellar.org',
                'stellar.network': network,
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    return module.get(TransactionProvider);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockKeypairFromSecret.mockReturnValue(mockKeypair);
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    provider = await createProvider();
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  describe('executeSweepTransaction', () => {
    const params = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      amount: '100',
      asset: 'native',
    };

    it('should execute payment transaction successfully with correct build flow', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-123',
        ledger: 100,
        successful: true,
      });

      const result = await provider.executeSweepTransaction(params);

      expect(mockKeypairFromSecret).toHaveBeenCalledWith('S_VALID_SECRET');
      expect(mockLoadAccount).toHaveBeenCalledWith(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
      );
      expect(mockPaymentOperation).toHaveBeenCalledWith({
        destination: params.destinationAddress,
        asset: mockAssetNative,
        amount: params.amount,
      });
      expect(mockTransactionBuilder).toHaveBeenCalledWith(
        { id: 'acc-123', sequence: '1', balances: [] },
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        },
      );
      expect(mockTransactionAddOperation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payment' }),
      );
      expect(mockTransactionSetTimeout).toHaveBeenCalledWith(30);
      expect(mockTransactionBuild).toHaveBeenCalled();
      expect(mockTransactionSign).toHaveBeenCalledWith(mockKeypair);
      expect(mockSubmitTransaction).toHaveBeenCalled();
      expect(result.hash).toBe('tx-hash-123');
      expect(result.successful).toBe(true);

      const addOrder = mockTransactionAddOperation.mock.invocationCallOrder[0];
      const timeoutOrder =
        mockTransactionSetTimeout.mock.invocationCallOrder[0];
      const buildOrder = mockTransactionBuild.mock.invocationCallOrder[0];
      const signOrder = mockTransactionSign.mock.invocationCallOrder[0];
      expect(addOrder).toBeLessThan(timeoutOrder);
      expect(timeoutOrder).toBeLessThan(buildOrder);
      expect(buildOrder).toBeLessThan(signOrder);
    });

    it('should select PUBLIC network passphrase for mainnet', async () => {
      provider = await createProvider('mainnet');
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-456',
        ledger: 200,
        successful: true,
      });

      await provider.executeSweepTransaction(params);

      expect(mockTransactionBuilder).toHaveBeenCalledWith(
        { id: 'acc-123', sequence: '1', balances: [] },
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.PUBLIC,
        },
      );
    });

    it('should default to TESTNET network passphrase for invalid network config', async () => {
      provider = await createProvider('invalid');
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-789',
        ledger: 201,
        successful: true,
      });

      await provider.executeSweepTransaction(params);

      expect(mockTransactionBuilder).toHaveBeenCalledWith(
        { id: 'acc-123', sequence: '1', balances: [] },
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        },
      );
    });

    it('should throw InternalServerErrorException for account not found (loadAccount fail)', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Resource Missing'));

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException for invalid ephemeral secret', async () => {
      mockKeypairFromSecret.mockImplementationOnce(() => {
        throw new Error('invalid secret');
      });

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should log Horizon extras and wrap submission errors', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('tx_insufficient_balance');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_insufficient_balance',
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        'Sweep transaction failed: tx_insufficient_balance',
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Transaction extras: {"result_codes":{"transaction":"tx_insufficient_balance"}}',
      );
    });

    it('should throw InternalServerErrorException for submission errors without extras', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockRejectedValue(new Error('Transaction Failed'));

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException for insufficient balance', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('tx_insufficient_balance');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_insufficient_balance',
              operations: ['op_underfunded'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException for insufficient fee balance', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('tx_insufficient_fee');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_insufficient_fee',
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException when destination account does not exist', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('op_no_destination');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_no_destination'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException for network timeout', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException for duplicate transaction submission', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('tx_bad_seq');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq',
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException for sequence number conflict', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('tx_bad_seq');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq',
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        'Sweep transaction failed: tx_bad_seq',
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Transaction extras: {"result_codes":{"transaction":"tx_bad_seq"}}',
      );
    });

    it('should handle malformed Horizon response without extras', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('Unknown error');
      error.response = {
        data: {},
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle network disconnection gracefully', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Network Error'));

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('executeSweepTransaction - Source Account Edge Cases', () => {
    const params = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      amount: '100',
      asset: 'native',
    };

    it('should handle account with existing trustlines', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [
          { asset_type: 'native', balance: '100.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer:
              'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            balance: '50.0000000',
          },
        ],
        subentry_count: 1,
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-trustline',
        ledger: 100,
        successful: true,
      });

      const result = await provider.executeSweepTransaction(params);
      expect(result.successful).toBe(true);
    });

    it('should handle account with open DEX offers', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
        subentry_count: 2,
        offers: [{ id: 'offer-1' }, { id: 'offer-2' }],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-offers',
        ledger: 101,
        successful: true,
      });

      const result = await provider.executeSweepTransaction(params);
      expect(result.successful).toBe(true);
    });

    it('should handle newly created account (sequence 0)', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-new',
        sequence: '0',
        balances: [{ asset_type: 'native', balance: '2.0000000' }],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-new',
        ledger: 102,
        successful: true,
      });

      const result = await provider.executeSweepTransaction(params);
      expect(result.successful).toBe(true);
    });
  });

  describe('executeSweepTransaction - Payment Operation Details', () => {
    it('should create payment with issued asset', async () => {
      const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const customAssetParams = {
        ephemeralSecret: 'S_VALID_SECRET',
        destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
        amount: '50.5000000',
        asset: `USDC:${issuer}`,
      };

      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-usdc',
        ledger: 103,
        successful: true,
      });

      await provider.executeSweepTransaction(customAssetParams);

      expect(mockPaymentOperation).toHaveBeenCalledWith({
        destination: customAssetParams.destinationAddress,
        asset: expect.objectContaining({
          isNative: expect.any(Function),
          getCode: expect.any(Function),
          getIssuer: expect.any(Function),
        }),
        amount: customAssetParams.amount,
      });
    });

    it('should preserve amount precision in payment operation', async () => {
      const preciseParams = {
        ephemeralSecret: 'S_VALID_SECRET',
        destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
        amount: '123.4567890',
        asset: 'native',
      };

      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-precise',
        ledger: 104,
        successful: true,
      });

      await provider.executeSweepTransaction(preciseParams);

      expect(mockPaymentOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: '123.4567890',
        }),
      );
    });
  });

  describe('executeSweepTransaction - Transaction Hash Validation', () => {
    const params = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      amount: '100',
      asset: 'native',
    };

    it('should return valid 64-character hex hash', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const validHash = 'a'.repeat(64);
      mockSubmitTransaction.mockResolvedValue({
        hash: validHash,
        ledger: 105,
        successful: true,
      });

      const result = await provider.executeSweepTransaction(params);

      expect(result.hash).toMatch(/^[a-f0-9]{64}$/i);
      expect(result.hash.length).toBe(64);
    });

    it('should return unique hash for different transactions', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction
        .mockResolvedValueOnce({
          hash: 'a'.repeat(64),
          ledger: 106,
          successful: true,
        })
        .mockResolvedValueOnce({
          hash: 'b'.repeat(64),
          ledger: 107,
          successful: true,
        });

      const result1 = await provider.executeSweepTransaction(params);
      const result2 = await provider.executeSweepTransaction(params);

      expect(result1.hash).not.toBe(result2.hash);
    });

    it('should include ledger number in result', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash',
        ledger: 12345,
        successful: true,
      });

      const result = await provider.executeSweepTransaction(params);

      expect(result.ledger).toBe(12345);
      expect(typeof result.ledger).toBe('number');
    });

    it('should include timestamp in result', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash',
        ledger: 108,
        successful: true,
      });

      const beforeTime = new Date();
      const result = await provider.executeSweepTransaction(params);
      const afterTime = new Date();

      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(
        beforeTime.getTime(),
      );
      expect(result.timestamp.getTime()).toBeLessThanOrEqual(
        afterTime.getTime() + 1000,
      );
    });
  });

  describe('executeSweepTransaction - Configuration Edge Cases', () => {
    it('should throw error when Horizon URL is invalid', async () => {
      const invalidProvider = await Test.createTestingModule({
        providers: [
          TransactionProvider,
          {
            provide: ConfigService,
            useValue: {
              getOrThrow: jest.fn((key: string) => {
                if (key === 'stellar.horizonUrl') return 'invalid-url';
                if (key === 'stellar.network') return 'testnet';
                return '';
              }),
            },
          },
        ],
      }).compile();

      const testProvider = invalidProvider.get(TransactionProvider);
      mockLoadAccount.mockRejectedValue(new Error('Invalid URL'));

      await expect(
        testProvider.executeSweepTransaction({
          ephemeralSecret: 'S_SECRET',
          destinationAddress: 'GDEST',
          amount: '100',
          asset: 'native',
        }),
      ).rejects.toThrow();
    });
  });

  describe('executeSweepTransaction - Transaction Timeout Scenarios', () => {
    const params = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      amount: '100',
      asset: 'native',
    };

    it('should verify 30 second timeout is set', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-timeout',
        ledger: 109,
        successful: true,
      });

      await provider.executeSweepTransaction(params);

      expect(mockTransactionSetTimeout).toHaveBeenCalledWith(30);
      expect(mockTransactionSetTimeout).toHaveBeenCalledTimes(1);
    });

    it('should throw error on Horizon timeout', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw error on network request timeout', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockRejectedValue(
        new Error('Request timeout after 30s'),
      );

      await expect(provider.executeSweepTransaction(params)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('executeSweepTransaction - Fee Validation', () => {
    const params = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      amount: '100',
      asset: 'native',
    };

    it('should use BASE_FEE for transaction fee', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-fee',
        ledger: 110,
        successful: true,
      });

      await provider.executeSweepTransaction(params);

      expect(mockTransactionBuilder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fee: BASE_FEE,
        }),
      );
      expect(BASE_FEE).toBe(100);
    });
  });

  describe('mergeAccount', () => {
    const params = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
    };

    it('should execute merge transaction successfully and sign', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'merge-hash-123',
        ledger: 101,
        successful: true,
      });

      const result = await provider.mergeAccount(params);

      expect(mockTransactionBuilder).toHaveBeenCalledWith(
        { id: 'acc-123', sequence: '1', balances: [] },
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        },
      );
      expect(mockAccountMergeOperation).toHaveBeenCalledWith({
        destination: params.destinationAddress,
      });
      expect(mockTransactionAddOperation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'accountMerge' }),
      );
      expect(mockTransactionSetTimeout).toHaveBeenCalledWith(30);
      expect(mockTransactionSign).toHaveBeenCalledWith(mockKeypair);
      expect(result.hash).toBe('merge-hash-123');
      expect(result.successful).toBe(true);
    });

    it('should re-throw error if merge fails and log warning', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockRejectedValue(new Error('Merge Failed'));

      await expect(provider.mergeAccount(params)).rejects.toThrow(
        'Merge Failed',
      );
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'Account merge failed (non-critical): Merge Failed',
      );
    });

    it('should throw error when account has active trustlines', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('op_has_sub_entries');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_has_sub_entries'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.mergeAccount(params)).rejects.toThrow(
        'op_has_sub_entries',
      );
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Account merge failed (non-critical)'),
      );
    });

    it('should throw error when account has open offers on DEX', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('op_has_sub_entries');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_has_sub_entries'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.mergeAccount(params)).rejects.toThrow();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it('should throw error when merging account to itself', async () => {
      const selfMergeParams = {
        ephemeralSecret: 'S_VALID_SECRET',
        destinationAddress:
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
      };
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error: MockHorizonError = new Error('op_malformed');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_malformed'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.mergeAccount(selfMergeParams)).rejects.toThrow(
        'op_malformed',
      );
    });

    it('should successfully merge account and reclaim base reserve', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '2.5000000' }],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'merge-hash-reclaim',
        ledger: 105,
        successful: true,
      });

      const result = await provider.mergeAccount(params);

      expect(result.successful).toBe(true);
      expect(result.hash).toBe('merge-hash-reclaim');
      expect(mockAccountMergeOperation).toHaveBeenCalledWith({
        destination: params.destinationAddress,
      });
    });

    it('should handle merge with account having subentries', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
        subentry_count: 2,
      });
      const error: MockHorizonError = new Error('op_has_sub_entries');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_has_sub_entries'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.mergeAccount(params)).rejects.toThrow();
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('non-critical'),
      );
    });

    it('should re-throw and log when merge fails after successful sweep', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      const error = new Error('Unexpected merge failure');
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.mergeAccount(params)).rejects.toThrow(
        'Unexpected merge failure',
      );
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'Account merge failed (non-critical): Unexpected merge failure',
      );
    });
  });

  describe('mergeAccount - Edge Cases', () => {
    const params = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
    };

    it('should handle merge with account having pending operations', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '5',
        balances: [],
      });
      const error: MockHorizonError = new Error('op_has_sub_entries');
      error.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_has_sub_entries'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(error);

      await expect(provider.mergeAccount(params)).rejects.toThrow();
    });

    it('should handle network partition during merge', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockRejectedValue(new Error('ECONNRESET'));

      await expect(provider.mergeAccount(params)).rejects.toThrow('ECONNRESET');
    });
  });

  describe('parseAsset', () => {
    const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    it('should parse "native" to Native asset', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset('native');
      expect(result.isNative()).toBe(true);
    });

    it('should parse "XLM" to Native asset', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset('XLM');
      expect(result.isNative()).toBe(true);
    });

    it('should parse 1-character asset code', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`A:${issuer}`);
      expect(result.getCode?.()).toBe('A');
      expect(result.getIssuer?.()).toBe(issuer);
    });

    it('should parse 4-character asset code', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`USDC:${issuer}`);
      expect(result.getCode?.()).toBe('USDC');
      expect(result.getIssuer?.()).toBe(issuer);
    });

    it('should parse 12-character asset code', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`ABCDEFGHIJKL:${issuer}`);
      expect(result.getCode?.()).toBe('ABCDEFGHIJKL');
      expect(result.getIssuer?.()).toBe(issuer);
    });

    it('should preserve case sensitivity for asset codes', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`uSdC:${issuer}`);
      expect(result.getCode?.()).toBe('uSdC');
    });

    it('should throw error for invalid format without colon', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          'invalid',
        ),
      ).toThrow('Invalid asset format: invalid');
    });

    it('should throw error for extra colons', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          'USDC:ISSUER:EXTRA',
        ),
      ).toThrow('Invalid asset format: USDC:ISSUER:EXTRA');
    });

    it('should throw error for missing issuer', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          'USDC:',
        ),
      ).toThrow('Asset code and issuer are required');
    });

    it('should throw error for invalid issuer format', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          'USDC:BADISSUER',
        ),
      ).toThrow('Invalid asset issuer');
    });

    it('should throw error for invalid asset code characters', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          `US*D:${issuer}`,
        ),
      ).toThrow('Invalid asset code');
    });

    it('should handle alphanumeric asset codes', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`USD123:${issuer}`);
      expect(result.getCode?.()).toBe('USD123');
      expect(result.getIssuer?.()).toBe(issuer);
    });

    it('should throw error for asset code exceeding 12 characters', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          `ABCDEFGHIJKLM:${issuer}`,
        ),
      ).toThrow('Invalid asset code');
    });

    it('should throw error for empty asset code', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          `:${issuer}`,
        ),
      ).toThrow('Asset code and issuer are required');
    });

    it('should throw error for asset with spaces', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          `US DC:${issuer}`,
        ),
      ).toThrow('Invalid asset code');
    });
  });

  describe('parseAsset - Additional Edge Cases', () => {
    const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    it('should handle asset code with numbers', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`USD123:${issuer}`);
      expect(result.getCode?.()).toBe('USD123');
    });

    it('should throw error for lowercase asset code characters', () => {
      // This tests current behavior - asset codes are case-sensitive
      // but Stellar typically uses uppercase
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`usdc:${issuer}`);
      expect(result.getCode?.()).toBe('usdc');
    });

    it('should handle maximum valid asset code length', () => {
      const maxCode = 'A'.repeat(12);
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`${maxCode}:${issuer}`);
      expect(result.getCode?.()).toBe(maxCode);
      expect(result.getCode?.().length).toBe(12);
    });

    it('should handle minimum valid asset code length', () => {
      const result = (
        provider as unknown as TransactionProviderWithPrivates
      ).parseAsset(`A:${issuer}`);
      expect(result.getCode?.()).toBe('A');
      expect(result.getCode?.().length).toBe(1);
    });

    it('should throw error for whitespace in asset string', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          `US DC:${issuer}`,
        ),
      ).toThrow();
    });

    it('should throw error for leading whitespace', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          ` USDC:${issuer}`,
        ),
      ).toThrow();
    });

    it('should throw error for trailing whitespace', () => {
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          `USDC:${issuer} `,
        ),
      ).toThrow();
    });

    it('should validate issuer checksum via Stellar SDK', () => {
      // Asset constructor validates issuer format
      expect(() =>
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA6!',
        ),
      ).toThrow();
    });
  });

  describe('getAccountBalance', () => {
    const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    it('should return native balance when asset is native', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          { asset_type: 'native', balance: '123.4567890' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuer,
            balance: '10.0000000',
          },
        ],
        id: 'acc-123',
        sequence: '1',
      });

      await expect(
        provider.getAccountBalance(
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
          'native',
        ),
      ).resolves.toBe('123.4567890');
    });

    it('should return issued asset balance when trustline exists', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          { asset_type: 'native', balance: '1.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuer,
            balance: '5.1234567',
          },
        ],
        id: 'acc-123',
        sequence: '1',
      });

      await expect(
        provider.getAccountBalance(
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
          `USDC:${issuer}`,
        ),
      ).resolves.toBe('5.1234567');
    });

    it('should return zero when requested asset trustline does not exist', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          { asset_type: 'native', balance: '1.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDT',
            asset_issuer: issuer,
            balance: '9.0000000',
          },
        ],
        id: 'acc-123',
        sequence: '1',
      });

      await expect(
        provider.getAccountBalance(
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
          `USDC:${issuer}`,
        ),
      ).resolves.toBe('0');
    });

    it('should return zero when balance is missing', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [],
        id: 'acc-123',
        sequence: '1',
      });

      await expect(
        provider.getAccountBalance(
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
          'native',
        ),
      ).resolves.toBe('0');
    });

    it('should propagate errors when account load fails', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Account not found'));

      await expect(
        provider.getAccountBalance(
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
          'native',
        ),
      ).rejects.toThrow('Account not found');
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Failed to get account balance: Account not found',
      );
    });

    it('should handle account with multiple issued assets', async () => {
      const issuer2 =
        'GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH';
      mockLoadAccount.mockResolvedValue({
        balances: [
          { asset_type: 'native', balance: '50.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuer,
            balance: '100.5000000',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDT',
            asset_issuer: issuer2,
            balance: '200.7500000',
          },
        ],
        id: 'acc-123',
        sequence: '1',
      });

      const usdcBalance = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        `USDC:${issuer}`,
      );
      const usdtBalance = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        `USDT:${issuer2}`,
      );

      expect(usdcBalance).toBe('100.5000000');
      expect(usdtBalance).toBe('200.7500000');
    });

    it('should preserve 7 decimal places precision', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '0.0000001' }],
        id: 'acc-123',
        sequence: '1',
      });

      const balance = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        'native',
      );

      expect(balance).toBe('0.0000001');
    });

    it('should handle XLM alias for native asset balance', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '999.9999999' }],
        id: 'acc-123',
        sequence: '1',
      });

      const balance = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        'XLM',
      );

      expect(balance).toBe('999.9999999');
    });
  });

  describe('getAccountBalance - Additional Edge Cases', () => {
    const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    it('should handle very large balances', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '922337203685.4775807' }],
        id: 'acc-123',
        sequence: '1',
      });

      const balance = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        'native',
      );

      expect(balance).toBe('922337203685.4775807');
    });

    it('should handle account with zero native balance', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '0.0000000' }],
        id: 'acc-123',
        sequence: '1',
      });

      const balance = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        'native',
      );

      expect(balance).toBe('0.0000000');
    });

    it('should handle concurrent balance checks', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '100.0000000' }],
        id: 'acc-123',
        sequence: '1',
      });

      const results = await Promise.all([
        provider.getAccountBalance(
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
          'native',
        ),
        provider.getAccountBalance(
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
          'native',
        ),
      ]);

      expect(results[0]).toBe('100.0000000');
      expect(results[1]).toBe('100.0000000');
    });

    it('should handle network timeout during balance check', async () => {
      mockLoadAccount.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(
        provider.getAccountBalance(
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
          'native',
        ),
      ).rejects.toThrow('ETIMEDOUT');
    });

    it('should match asset code and issuer exactly', async () => {
      const issuer2 =
        'GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH';
      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuer,
            balance: '50.0000000',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuer2,
            balance: '75.0000000',
          },
        ],
        id: 'acc-123',
        sequence: '1',
      });

      const balance1 = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        `USDC:${issuer}`,
      );
      const balance2 = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        `USDC:${issuer2}`,
      );

      expect(balance1).toBe('50.0000000');
      expect(balance2).toBe('75.0000000');
    });

    it('should return string type for balance (not number)', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '100.0000000' }],
        id: 'acc-123',
        sequence: '1',
      });

      const balance = await provider.getAccountBalance(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665ON',
        'native',
      );

      expect(typeof balance).toBe('string');
    });
  });

  describe('Integration - Full Transaction Flow', () => {
    it('should complete full sweep transaction from start to finish', async () => {
      const params = {
        ephemeralSecret: 'S_VALID_SECRET',
        destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
        amount: '100.5000000',
        asset: 'native',
      };

      mockLoadAccount.mockResolvedValue({
        id: 'acc-integration',
        sequence: '12345',
        balances: [{ asset_type: 'native', balance: '100.5000000' }],
      });
      mockSubmitTransaction.mockResolvedValue({
        hash: 'integration-tx-hash',
        ledger: 999,
        successful: true,
      });

      const result = await provider.executeSweepTransaction(params);

      // Verify complete flow
      expect(mockKeypairFromSecret).toHaveBeenCalledWith(
        params.ephemeralSecret,
      );
      expect(mockLoadAccount).toHaveBeenCalled();
      expect(mockPaymentOperation).toHaveBeenCalled();
      expect(mockTransactionBuilder).toHaveBeenCalled();
      expect(mockTransactionSign).toHaveBeenCalled();
      expect(mockSubmitTransaction).toHaveBeenCalled();
      expect(result.successful).toBe(true);
      expect(result.hash).toBe('integration-tx-hash');
    });

    it('should handle full sweep + merge workflow', async () => {
      const sweepParams = {
        ephemeralSecret: 'S_VALID_SECRET',
        destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
        amount: '100.0000000',
        asset: 'native',
      };
      const mergeParams = {
        ephemeralSecret: 'S_VALID_SECRET',
        destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      };

      mockLoadAccount.mockResolvedValue({
        id: 'acc-workflow',
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '100.0000000' }],
      });
      mockSubmitTransaction
        .mockResolvedValueOnce({
          hash: 'sweep-hash',
          ledger: 1000,
          successful: true,
        })
        .mockResolvedValueOnce({
          hash: 'merge-hash',
          ledger: 1001,
          successful: true,
        });

      const sweepResult = await provider.executeSweepTransaction(sweepParams);
      const mergeResult = await provider.mergeAccount(mergeParams);

      expect(sweepResult.successful).toBe(true);
      expect(mergeResult.successful).toBe(true);
      expect(mockPaymentOperation).toHaveBeenCalled();
      expect(mockAccountMergeOperation).toHaveBeenCalled();
    });
  });

  describe('Error Message Quality', () => {
    it('should include original error message in wrapped exception', async () => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
      mockSubmitTransaction.mockRejectedValue(
        new Error('Specific Horizon error'),
      );

      try {
        await provider.executeSweepTransaction({
          ephemeralSecret: 'S_SECRET',
          destinationAddress: 'GDEST',
          amount: '100',
          asset: 'native',
        });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InternalServerErrorException);
        const err = error as Error;
        expect(err.message).toContain('Specific Horizon error');
      }
    });

    it('should provide helpful error for invalid asset format', () => {
      try {
        (provider as unknown as TransactionProviderWithPrivates).parseAsset(
          'INVALID_FORMAT',
        );
        fail('Should have thrown');
      } catch (error) {
        const err = error as Error;
        expect(err.message).toContain('Invalid asset format');
        expect(err.message).toContain('INVALID_FORMAT');
      }
    });
  });
  /**
   * #649: fee-bump audit fields on TransactionResult.
   */
  describe('fee-bump audit fields', () => {
    const params = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress:
        'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
      asset: 'native',
      amount: '100',
    };

    beforeEach(() => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
    });

    it('should report feeBump false for an ordinary submission', async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-plain',
        ledger: 100,
        successful: true,
      });

      const result = await provider.executeSweepTransaction(params);

      // Positively false, not merely absent - the field is what an audit
      // trail reads to know the hash needs no reconciliation.
      expect(result.feeBump).toBe(false);
      expect(result.innerTransactionHash).toBeUndefined();
    });

    it('should report feeBump and the inner hash for a fee-bumped submission', async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: 'tx-hash-outer',
        ledger: 101,
        successful: true,
        fee_bump_transaction: { hash: 'tx-hash-outer' },
        inner_transaction: { hash: 'tx-hash-inner' },
      });

      const result = await provider.executeSweepTransaction(params);

      expect(result.feeBump).toBe(true);
      // hash is the outer envelope; the inner hash is what was originally
      // signed and is what reconciles against the first submission.
      expect(result.hash).toBe('tx-hash-outer');
      expect(result.innerTransactionHash).toBe('tx-hash-inner');
    });

    it('should report the fee-bump fields on mergeAccount results too', async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: 'merge-hash-outer',
        ledger: 102,
        successful: true,
        fee_bump_transaction: { hash: 'merge-hash-outer' },
        inner_transaction: { hash: 'merge-hash-inner' },
      });

      const result = await provider.mergeAccount({
        ephemeralSecret: 'S_VALID_SECRET',
        destinationAddress:
          'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
      });

      expect(result.feeBump).toBe(true);
      expect(result.innerTransactionHash).toBe('merge-hash-inner');
    });
  });
  /**
   * #647: the account-merge path must honour the same Horizon ledger contract
   * as the payment path. It previously returned result.ledger unconverted.
   */
  describe('mergeAccount - ledger coercion', () => {
    const mergeParams = {
      ephemeralSecret: 'S_VALID_SECRET',
      destinationAddress:
        'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
    };

    beforeEach(() => {
      mockLoadAccount.mockResolvedValue({
        id: 'acc-123',
        sequence: '1',
        balances: [],
      });
    });

    it('should coerce a string ledger to a number', async () => {
      // Horizon can return ledger as a string even though the SDK types it as
      // a number - see transaction-result.interface.ts.
      mockSubmitTransaction.mockResolvedValue({
        hash: 'merge-hash',
        ledger: '104',
        successful: true,
      });

      const result = await provider.mergeAccount(mergeParams);

      expect(result.ledger).toBe(104);
      expect(typeof result.ledger).toBe('number');
    });

    it('should reject a non-numeric ledger instead of returning NaN', async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: 'merge-hash',
        ledger: 'not-a-ledger',
        successful: true,
      });

      await expect(provider.mergeAccount(mergeParams)).rejects.toThrow(
        'Invalid ledger value: not-a-ledger',
      );
    });

    it('should match the payment path for the same ledger value', async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: 'hash',
        ledger: '105',
        successful: true,
      });

      const merged = await provider.mergeAccount(mergeParams);
      const paid = await provider.executeSweepTransaction({
        ...mergeParams,
        asset: 'native',
        amount: '100',
      });

      expect(merged.ledger).toBe(paid.ledger);
    });
  });
});
