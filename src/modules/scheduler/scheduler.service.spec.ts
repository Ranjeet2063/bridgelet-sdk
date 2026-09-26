import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Account } from '../accounts/entities/account.entity.js';
import { AccountStatus } from '../accounts/enums/account-status.enum.js';
import { SchedulerService } from './scheduler.service.js';
import { StellarService } from '../stellar/stellar.service.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Replace the makeAccount helper:
const makeAccount = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 'acc-uuid-1',
    publicKey: 'GPUBKEY1234',
    contractId: 'CONTRACT123',
    status: AccountStatus.PENDING_PAYMENT,
    secretKeyEncrypted: 'enc',
    fundingSource: 'GFUNDING',
    amount: '100',
    asset: 'USDC',
    claimTokenHash: null,
    destinationAddress: null,
    expiresAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 3_600_000),
    updatedAt: new Date(),
    claimedAt: null,
    expiredAt: null,
    deletedAt: null,
    metadata: null,
    ...overrides,
  }) as Account;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchedulerService', () => {
  let service: SchedulerService;
  let stellarService: {
    expireAccount: jest.MockedFunction<StellarService['expireAccount']>;
  };
  let accountsRepo: {
    find: jest.MockedFunction<() => Promise<Account[]>>;
    update: jest.MockedFunction<() => Promise<any>>;
  };

  beforeEach(async () => {
    accountsRepo = {
      find: jest.fn<() => Promise<Account[]>>().mockResolvedValue([]),
      update: jest.fn<() => Promise<any>>().mockResolvedValue({ affected: 1 }),
    };

    const stellarMock = {
      expireAccount: jest
        .fn<StellarService['expireAccount']>()
        .mockResolvedValue(undefined),
    };

    const configMock = {
      getOrThrow: jest.fn((key: string) => {
        const map: Record<string, string> = {
          'stellar.fundingSecret': 'SFUNDING_SECRET',
          'app.expiryCheckIntervalMs': '300000',
          'app.initializingCleanupIntervalMs': '900000',
          'app.initializingTimeoutMs': '600000',
        };
        if (!(key in map)) throw new Error(`Config key not found: ${key}`);
        return map[key];
      }),
    };

    const webhooksMock = {
      triggerEvent: jest
        .fn<WebhooksService['triggerEvent']>()
        .mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: getRepositoryToken(Account), useValue: accountsRepo },
        { provide: StellarService, useValue: stellarMock },
        { provide: ConfigService, useValue: configMock },
        { provide: WebhooksService, useValue: webhooksMock },
      ],
    }).compile();

    service = module.get(SchedulerService);
    stellarService = module.get(StellarService);

    // Prevent real intervals from starting
    jest.spyOn(service, 'onModuleInit').mockImplementation(() => undefined);
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('onModuleInit / onModuleDestroy', () => {
    it('starts two setIntervals on init and clears both on destroy', () => {
      // Restore the beforeEach no-op spy so we hit the real implementation
      jest.restoreAllMocks();

      const handles = [111, 222];
      let callCount = 0;
      const setIntervalSpy = jest
        .spyOn(global, 'setInterval')
        .mockImplementation(() => handles[callCount++] as any);
      const clearIntervalSpy = jest
        .spyOn(global, 'clearInterval')
        .mockImplementation(() => undefined);

      service.onModuleInit();
      expect(setInterval).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      expect(clearInterval).toHaveBeenCalledWith(111);
      expect(clearInterval).toHaveBeenCalledWith(222);

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Expiry job — happy path
  // -------------------------------------------------------------------------

  describe('runExpiryJob()', () => {
    it('calls expireAccount() and updates status to EXPIRED for expired accounts', async () => {
      const account = makeAccount({ status: AccountStatus.PENDING_PAYMENT });
      accountsRepo.find.mockResolvedValueOnce([account]);

      await service.runExpiryJob();

      expect(stellarService.expireAccount).toHaveBeenCalledWith({
        contractId: 'CONTRACT123',
        signerSecret: 'SFUNDING_SECRET',
      });
      expect(accountsRepo.update).toHaveBeenCalledWith(account.id, {
        status: AccountStatus.EXPIRED,
        expiredAt: expect.any(Date),
      });
    });

    it('processes PENDING_CLAIM accounts too', async () => {
      const account = makeAccount({ status: AccountStatus.PENDING_CLAIM });
      accountsRepo.find.mockResolvedValueOnce([account]);

      await service.runExpiryJob();

      expect(stellarService.expireAccount).toHaveBeenCalledTimes(1);
      expect(accountsRepo.update).toHaveBeenCalledWith(account.id, {
        status: AccountStatus.EXPIRED,
        expiredAt: expect.any(Date),
      });
    });

    it('does nothing when no expired accounts are found', async () => {
      accountsRepo.find.mockResolvedValueOnce([]);

      await service.runExpiryJob();

      expect(stellarService.expireAccount).not.toHaveBeenCalled();
      expect(accountsRepo.update).not.toHaveBeenCalled();
    });

    it('queries only accounts with expiresAt in the past', async () => {
      await service.runExpiryJob();

      expect(accountsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.arrayContaining([
            expect.objectContaining({
              status: AccountStatus.PENDING_PAYMENT,
            }),
            expect.objectContaining({
              status: AccountStatus.PENDING_CLAIM,
            }),
          ]),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Expiry job — failure isolation
  // -------------------------------------------------------------------------

  describe('runExpiryJob() failure isolation', () => {
    it('continues processing other accounts when one expireAccount() call fails', async () => {
      const acc1 = makeAccount({ id: 'a1', publicKey: 'GPK1' });
      const acc2 = makeAccount({ id: 'a2', publicKey: 'GPK2' });
      accountsRepo.find.mockResolvedValueOnce([acc1, acc2]);

      stellarService.expireAccount
        .mockRejectedValueOnce(new Error('Soroban RPC unavailable'))
        .mockResolvedValueOnce(undefined);

      await expect(service.runExpiryJob()).resolves.not.toThrow();

      // Second account still processed
      expect(stellarService.expireAccount).toHaveBeenCalledTimes(2);
      // Only the successful one gets a DB update
      expect(accountsRepo.update).toHaveBeenCalledTimes(1);
      expect(accountsRepo.update).toHaveBeenCalledWith(
        'a2',
        expect.any(Object),
      );
    });

    it('does not throw when the DB query itself fails', async () => {
      accountsRepo.find.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(service.runExpiryJob()).resolves.not.toThrow();
      expect(stellarService.expireAccount).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // INITIALIZING cleanup — happy path
  // -------------------------------------------------------------------------

  describe('runInitializingCleanup()', () => {
    it('marks stale INITIALIZING accounts as FAILED with metadata', async () => {
      const account = makeAccount({
        status: AccountStatus.INITIALIZING,
        createdAt: new Date(Date.now() - 700_000), // older than default 10-min timeout
        metadata: { existingKey: 'value' },
      });
      accountsRepo.find.mockResolvedValueOnce([account]);

      await service.runInitializingCleanup();

      expect(accountsRepo.update).toHaveBeenCalledWith(account.id, {
        status: AccountStatus.FAILED,
        metadata: {
          existingKey: 'value',
          failureReason: 'initialization_timeout',
          detectedAt: expect.any(String),
        },
      });
    });

    it('does not call expireAccount() for INITIALIZING accounts', async () => {
      const account = makeAccount({ status: AccountStatus.INITIALIZING });
      accountsRepo.find.mockResolvedValueOnce([account]);

      await service.runInitializingCleanup();

      expect(stellarService.expireAccount).not.toHaveBeenCalled();
    });

    it('does nothing when no stale INITIALIZING accounts are found', async () => {
      accountsRepo.find.mockResolvedValueOnce([]);

      await service.runInitializingCleanup();

      expect(accountsRepo.update).not.toHaveBeenCalled();
    });

    it('queries only INITIALIZING accounts older than the cutoff', async () => {
      await service.runInitializingCleanup();

      expect(accountsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: AccountStatus.INITIALIZING,
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // INITIALIZING cleanup — failure isolation
  // -------------------------------------------------------------------------

  describe('runInitializingCleanup() failure isolation', () => {
    it('continues processing other accounts when one DB update fails', async () => {
      const acc1 = makeAccount({
        id: 'a1',
        status: AccountStatus.INITIALIZING,
      });
      const acc2 = makeAccount({
        id: 'a2',
        status: AccountStatus.INITIALIZING,
      });
      accountsRepo.find.mockResolvedValueOnce([acc1, acc2]);

      accountsRepo.update
        .mockRejectedValueOnce(new Error('DB write failed'))
        .mockResolvedValueOnce({ affected: 1 });

      await expect(service.runInitializingCleanup()).resolves.not.toThrow();

      expect(accountsRepo.update).toHaveBeenCalledTimes(2);
    });

    it('does not throw when the DB query itself fails', async () => {
      accountsRepo.find.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(service.runInitializingCleanup()).resolves.not.toThrow();
      expect(accountsRepo.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Preserves existing metadata
  // -------------------------------------------------------------------------

  describe('metadata handling', () => {
    it('merges failureReason into existing metadata without overwriting other keys', async () => {
      const account = makeAccount({
        status: AccountStatus.INITIALIZING,
        metadata: { source: 'api', userId: 'u1' },
      });
      accountsRepo.find.mockResolvedValueOnce([account]);

      await service.runInitializingCleanup();

      expect(accountsRepo.update).toHaveBeenCalledWith(
        account.id,
        expect.objectContaining({
          metadata: expect.objectContaining({
            source: 'api',
            userId: 'u1',
            failureReason: 'initialization_timeout',
          }),
        }),
      );
    });

    it('handles null metadata gracefully', async () => {
      const account = makeAccount({
        status: AccountStatus.INITIALIZING,
        // test null metadata handling; cast to satisfy TypeScript
        metadata: null as unknown as Record<string, any> | undefined,
      });
      accountsRepo.find.mockResolvedValueOnce([account]);

      await expect(service.runInitializingCleanup()).resolves.not.toThrow();

      expect(accountsRepo.update).toHaveBeenCalledWith(
        account.id,
        expect.objectContaining({
          metadata: expect.objectContaining({
            failureReason: 'initialization_timeout',
          }),
        }),
      );
    });
  });
});
