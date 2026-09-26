import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Account } from '../accounts/entities/account.entity.js';
import { AccountStatus } from '../accounts/enums/account-status.enum.js';
import { PaymentMonitorService } from './payment-monitor.service.js';
import { StellarService } from '../stellar/stellar.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAccount = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 'acc-uuid-1',
    publicKey: 'GPUBKEY1234',
    status: AccountStatus.PENDING_PAYMENT,
    secretKeyEncrypted: 'enc',
    fundingSource: 'GFUNDING',
    amount: '100',
    asset: 'USDC',
    claimTokenHash: null,
    destinationAddress: null,
    expiresAt: new Date(Date.now() + 86_400_000), // expires in 1 day
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date(),
    claimedAt: null,
    expiredAt: null,
    metadata: null,
    ...overrides,
  }) as Account;

const makePaymentRecord = (overrides: Partial<any> = {}) => ({
  type: 'payment',
  to: 'GPUBKEY1234',
  from: 'GSENDER',
  amount: '100.0000000',
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: 'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN',
  created_at: '2024-01-01T01:00:00Z', // after account createdAt
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock Horizon server
// ---------------------------------------------------------------------------

const mockCallFn = jest.fn<() => Promise<{ records: any[] }>>();
const mockPaymentsBuilder = {
  forAccount: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  call: mockCallFn,
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk',
  );
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        payments: () => mockPaymentsBuilder,
      })),
    },
    Asset: actual.Asset,
    Networks: actual.Networks,
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentMonitorService', () => {
  let service: PaymentMonitorService;
  let onModuleInitSpy: jest.SpiedFunction<
    PaymentMonitorService['onModuleInit']
  >;
  let stellarService: {
    recordPayment: jest.MockedFunction<StellarService['recordPayment']>;
  };
  let accountsRepo: {
    find: jest.MockedFunction<() => Promise<Account[]>>;
    update: jest.MockedFunction<() => Promise<any>>;
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    mockCallFn.mockReset();
    mockPaymentsBuilder.forAccount.mockClear();
    mockPaymentsBuilder.order.mockClear();
    mockPaymentsBuilder.limit.mockClear();

    accountsRepo = {
      find: jest.fn<() => Promise<Account[]>>().mockResolvedValue([]),
      update: jest.fn<() => Promise<any>>().mockResolvedValue({ affected: 1 }),
    };

    const stellarMock = {
      recordPayment: jest
        .fn<StellarService['recordPayment']>()
        .mockResolvedValue(undefined),
    };

    const configMock = {
      getOrThrow: jest.fn((key: string) => {
        const map: Record<string, string> = {
          'stellar.horizonUrl': 'https://horizon-testnet.stellar.org',
          'stellar.contracts.ephemeralAccount': 'CONTRACT123',
          'stellar.fundingSecret': 'SFUNDING_SECRET',
          'stellar.network': 'testnet',
          'app.paymentPollIntervalMs': '30000',
        };
        if (!(key in map)) throw new Error(`Config key not found: ${key}`);
        return map[key];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentMonitorService,
        { provide: getRepositoryToken(Account), useValue: accountsRepo },
        { provide: StellarService, useValue: stellarMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get(PaymentMonitorService);
    stellarService = module.get(StellarService);

    // Prevent the real interval from starting in tests
    onModuleInitSpy = jest
      .spyOn(service, 'onModuleInit')
      .mockImplementation(() => undefined);

    // Bypass real Stellar asset validation — not under test here
    jest
      .spyOn(service as any, 'resolveAssetAddress')
      .mockReturnValue('MOCK_ASSET_CONTRACT_ADDRESS');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('onModuleInit / onModuleDestroy', () => {
    it('starts a setInterval on init and clears it on destroy', () => {
      onModuleInitSpy.mockRestore();

      const intervalHandle = setInterval(() => undefined, 1_000);
      clearInterval(intervalHandle);

      const setIntervalSpy = jest
        .spyOn(global, 'setInterval')
        .mockReturnValue(intervalHandle);
      const clearIntervalSpy = jest
        .spyOn(global, 'clearInterval')
        .mockImplementation(() => undefined);

      service.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // pollAllAccounts — account filtering
  // -------------------------------------------------------------------------

  describe('pollAllAccounts()', () => {
    it('does not query Horizon when there are no PENDING_PAYMENT accounts', async () => {
      accountsRepo.find.mockResolvedValueOnce([]);
      await service.pollAllAccounts();
      expect(mockPaymentsBuilder.forAccount).not.toHaveBeenCalled();
    });

    it('skips expired accounts by querying only non-expired ones', async () => {
      // The repo query includes expiresAt filter; if none returned, Horizon is never called.
      // Simulate the DB returning zero results (expired accounts are already filtered by the WHERE clause)
      accountsRepo.find.mockResolvedValueOnce([]);
      await service.pollAllAccounts();
      expect(accountsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: AccountStatus.PENDING_PAYMENT,
          }),
        }),
      );
      expect(mockPaymentsBuilder.forAccount).not.toHaveBeenCalled();
    });

    it('polls each active account independently', async () => {
      const acc1 = makeAccount({ id: 'a1', publicKey: 'GPK1' });
      const acc2 = makeAccount({ id: 'a2', publicKey: 'GPK2' });
      accountsRepo.find.mockResolvedValueOnce([acc1, acc2]);
      mockCallFn.mockResolvedValue({ records: [] });

      await service.pollAllAccounts();

      expect(mockPaymentsBuilder.forAccount).toHaveBeenCalledWith('GPK1');
      expect(mockPaymentsBuilder.forAccount).toHaveBeenCalledWith('GPK2');
    });
  });

  // -------------------------------------------------------------------------
  // Payment detection
  // -------------------------------------------------------------------------

  describe('payment detected → status updated', () => {
    it('calls recordPayment() and updates status to PENDING_CLAIM when payment found', async () => {
      const account = makeAccount();
      mockCallFn.mockResolvedValueOnce({
        records: [makePaymentRecord()],
      });

      await service.findInboundPayment(account).then(async (payment) => {
        await service.processPayment(account, payment!);
      });

      expect(stellarService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: 'CONTRACT123',
          signerSecret: 'SFUNDING_SECRET',
          amount: expect.any(BigInt),
        }),
      );
      expect(accountsRepo.update).toHaveBeenCalledWith(
        { id: 'acc-uuid-1', status: AccountStatus.PENDING_PAYMENT },
        { status: AccountStatus.PENDING_CLAIM },
      );
    });

    it('filters out payments before account.createdAt', async () => {
      const account = makeAccount({
        createdAt: new Date('2024-06-01T00:00:00.000Z'),
      });
      mockCallFn.mockResolvedValueOnce({
        records: [
          makePaymentRecord({ created_at: '2024-05-31T23:59:59Z' }), // before createdAt
        ],
      });

      const result = await service.findInboundPayment(account);
      expect(result).toBeNull();
    });

    it('only handles payments addressed to this account', async () => {
      const account = makeAccount();
      mockCallFn.mockResolvedValueOnce({
        records: [makePaymentRecord({ to: 'GOTHER' })],
      });

      const result = await service.findInboundPayment(account);
      expect(result).toBeNull();
    });

    it('ignores non-payment operation types', async () => {
      const account = makeAccount();
      mockCallFn.mockResolvedValueOnce({
        records: [{ ...makePaymentRecord(), type: 'create_account' }],
      });

      const result = await service.findInboundPayment(account);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency — DuplicateAsset
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('treats DuplicateAsset as no-op (still updates DB) and does not throw', async () => {
      const account = makeAccount();
      const payment = makePaymentRecord();

      stellarService.recordPayment.mockRejectedValueOnce(
        new Error('DuplicateAsset'),
      );

      await expect(
        service.processPayment(account, payment),
      ).resolves.not.toThrow();

      // DB should still be updated to PENDING_CLAIM
      expect(accountsRepo.update).toHaveBeenCalledWith(
        { id: 'acc-uuid-1', status: AccountStatus.PENDING_PAYMENT },
        { status: AccountStatus.PENDING_CLAIM },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Per-account failure isolation
  // -------------------------------------------------------------------------

  describe('failure isolation', () => {
    it('continues polling other accounts when one Horizon call fails', async () => {
      const acc1 = makeAccount({ id: 'a1', publicKey: 'GPK1' });
      const acc2 = makeAccount({ id: 'a2', publicKey: 'GPK2' });
      accountsRepo.find.mockResolvedValueOnce([acc1, acc2]);

      // First account: Horizon throws
      mockCallFn
        .mockRejectedValueOnce(new Error('Horizon unavailable'))
        // Second account: no payment found
        .mockResolvedValueOnce({ records: [] });

      // Should not throw
      await expect(service.pollAllAccounts()).resolves.not.toThrow();

      // Both accounts were attempted
      expect(mockPaymentsBuilder.forAccount).toHaveBeenCalledWith('GPK1');
      expect(mockPaymentsBuilder.forAccount).toHaveBeenCalledWith('GPK2');
    });

    it('does not update DB when Horizon call fails for an account', async () => {
      const acc = makeAccount();
      accountsRepo.find.mockResolvedValueOnce([acc]);
      mockCallFn.mockRejectedValueOnce(new Error('Horizon unavailable'));

      await service.pollAllAccounts();

      expect(accountsRepo.update).not.toHaveBeenCalled();
    });

    it('does not call recordPayment() when no inbound payment is found', async () => {
      const acc = makeAccount();
      accountsRepo.find.mockResolvedValueOnce([acc]);
      mockCallFn.mockResolvedValueOnce({ records: [] });

      await service.pollAllAccounts();

      expect(stellarService.recordPayment).not.toHaveBeenCalled();
      expect(accountsRepo.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Amount conversion
  // -------------------------------------------------------------------------

  describe('amount parsing (via processPayment)', () => {
    it('converts "100.0000000" → 1_000_000_000n stroops', async () => {
      const account = makeAccount();
      const payment = makePaymentRecord({ amount: '100.0000000' });

      await service.processPayment(account, payment);

      expect(stellarService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1_000_000_000n }),
      );
    });

    it('converts "1.5000000" → 15_000_000n stroops', async () => {
      const account = makeAccount();
      const payment = makePaymentRecord({ amount: '1.5000000' });

      await service.processPayment(account, payment);

      expect(stellarService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 15_000_000n }),
      );
    });
  });
});
