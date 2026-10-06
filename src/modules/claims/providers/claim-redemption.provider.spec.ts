import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ClaimRedemptionProvider } from './claim-redemption.provider.js';
import { TokenVerificationProvider } from './token-verification.provider.js';
import { Claim } from '../entities/claim.entity.js';
import { Account } from '../../accounts/entities/account.entity.js';
import { SweepsService } from '../../sweeps/sweeps.service.js';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';
import { ConfigService } from '@nestjs/config';
import { SecretEncryptionUtil } from '../../../common/crypto/secret-encryption.util.js';
import { WebhooksService } from '../../webhooks/webhooks.service.js';
import { ClaimAuditProvider } from './claim-audit.provider.js';
import { KmsKeyProvider } from '../../../common/crypto/kms-key.provider.js';

describe('ClaimRedemptionProvider', () => {
  let provider: ClaimRedemptionProvider;

  const mockClaimsRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  const mockAccountsRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  const mockTokenVerificationProvider = {
    verifyClaimToken: jest.fn(),
  };

  const mockSweepsService = {
    executeSweep: jest.fn(),
  };

  const mockWebhooksService = {
    triggerEvent: jest.fn(),
  };

  const VALID_DESTINATION =
    'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN';
  const VALID_TOKEN = 'valid.jwt.token';

  const mockAccount: Partial<Account> = {
    id: 'account-uuid-1234',
    publicKey: 'GPUBKEY47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLL',
    secretKeyEncrypted: Buffer.from('test-secret').toString('base64'),
    claimTokenHash: 'mock-token-hash',
    amount: '100.0000000',
    asset: 'native',
    status: AccountStatus.PENDING_CLAIM,
    expiresAt: new Date(Date.now() + 86_400_000),
    metadata: { userId: 'user-123' },
    destinationAddress: '',
    // #812: the redemption must hand the sweeper this account's own instance.
    contractId: 'CREDEMPTIONACCOUNT123456789ABCDEFGHIJKLMNOP',
    claimedAt: null,
  };

  const mockSweepResult = {
    txHash: 'a'.repeat(64),
    success: true,
  };

  const mockClaim: Partial<Claim> = {
    id: 'claim-uuid-5678',
    accountId: mockAccount.id,
    destinationAddress: VALID_DESTINATION,
    sweepTxHash: mockSweepResult.txHash,
    amountSwept: mockAccount.amount,
    asset: mockAccount.asset,
    claimedAt: new Date('2026-02-19T10:00:00.000Z'),
  };

  /** Creates a mock EntityManager whose QueryBuilder returns the given account */
  function makeManager(lockedAccount: Partial<Account> | null) {
    const qb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(lockedAccount),
    };
    return {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
      create: jest.fn().mockImplementation((_Entity, data) => ({ ...data })),
      qb,
    };
  }

  /**
   * Builds a DataSource mock that:
   *  - 1st call: acquires lock and sets CLAIMING (returns account in CLAIMING state)
   *  - 2nd call: finalises CLAIMED and saves claim record (returns mockClaim)
   */
  function makeHappyPathDataSource() {
    const claimingAccount = { ...mockAccount, status: AccountStatus.CLAIMING };
    const mgr1 = makeManager({ ...mockAccount });
    const mgr2 = makeManager(null); // not used for lock in 2nd txn

    return {
      transaction: jest
        .fn()
        .mockImplementationOnce(
          async (cb: (m: unknown) => Promise<unknown>) => {
            mgr1.save.mockResolvedValue(claimingAccount);
            return cb(mgr1);
          },
        )
        .mockImplementationOnce(
          async (cb: (m: unknown) => Promise<unknown>) => {
            // save is called twice: once for account update, once for new claim
            mgr2.save
              .mockResolvedValueOnce(undefined) // save(account)
              .mockResolvedValueOnce({ ...mockClaim }); // save(newClaim)
            mgr2.create.mockReturnValue({ ...mockClaim });
            return cb(mgr2);
          },
        ),
      _mgr1: mgr1,
    };
  }

  async function buildModule(dataSourceValue: object) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimRedemptionProvider,
        { provide: getRepositoryToken(Claim), useValue: mockClaimsRepository },
        {
          provide: getRepositoryToken(Account),
          useValue: mockAccountsRepository,
        },
        { provide: getDataSourceToken(), useValue: dataSourceValue },
        {
          provide: TokenVerificationProvider,
          useValue: mockTokenVerificationProvider,
        },
        { provide: SweepsService, useValue: mockSweepsService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('mock-value'),
            getOrThrow: jest.fn().mockReturnValue('a'.repeat(64)),
          },
        },
        { provide: WebhooksService, useValue: mockWebhooksService },
        {
          provide: ClaimAuditProvider,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: KmsKeyProvider,
          useValue: {
            getEncryptionKey: jest.fn().mockReturnValue('a'.repeat(64)),
          },
        },
      ],
    }).compile();

    jest.spyOn(SecretEncryptionUtil, 'decrypt').mockReturnValue('test-secret');
    return module.get<ClaimRedemptionProvider>(ClaimRedemptionProvider);
  }

  beforeEach(async () => {
    // Reset mutable values on the shared mockAccount so a previous test's
    // `locked.status = AccountStatus.CLAIMING` mutation does not leak into
    // subsequent tests (the shared reference is locked, then mutated by
    // redeemClaim's transaction body).
    mockAccount.status = AccountStatus.PENDING_CLAIM;
    mockAccount.destinationAddress = '';
    mockAccount.claimedAt = null;

    const ds = makeHappyPathDataSource();
    provider = await buildModule(ds);

    mockTokenVerificationProvider.verifyClaimToken.mockResolvedValue({
      valid: true,
    });
    mockAccountsRepository.findOne.mockResolvedValue({ ...mockAccount });
    mockAccountsRepository.update.mockResolvedValue(undefined);
    mockSweepsService.executeSweep.mockResolvedValue(mockSweepResult);
    mockClaimsRepository.findOne.mockResolvedValue({ ...mockClaim });
    mockWebhooksService.triggerEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateAccountStatus', () => {
    it('throws BadRequestException with setup message for INITIALIZING status', async () => {
      mockTokenVerificationProvider.verifyClaimToken.mockRejectedValue(
        new BadRequestException('This account is still being set up'),
      );

      await expect(
        provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow('still being set up');
    });
  });

  describe('redeemClaim - successful redemption', () => {
    it('should successfully redeem claim and execute sweep', async () => {
      const result = await provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      expect(result).toEqual({
        success: true,
        txHash: mockSweepResult.txHash,
        amountSwept: mockAccount.amount,
        asset: mockAccount.asset,
        destination: VALID_DESTINATION,
        sweptAt: expect.any(Date),
      });
    });

    it('should acquire SELECT FOR UPDATE lock before setting status to CLAIMING', async () => {
      // Rebuild with a spy-able dataSource so we can inspect the qb inside the callback
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);
      await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);
      expect(ds._mgr1.qb.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('should call SweepsService.executeSweep with correct parameters', async () => {
      await provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      expect(mockSweepsService.executeSweep).toHaveBeenCalledWith({
        accountId: mockAccount.id,
        ephemeralPublicKey: mockAccount.publicKey,
        ephemeralSecret: 'test-secret',
        destinationAddress: VALID_DESTINATION,
        amount: mockAccount.amount,
        asset: mockAccount.asset,
        // #812: the account's own EphemeralAccount instance.
        contractId: mockAccount.contractId,
        // Fresh PENDING_CLAIM attempt -> contract auth must run.
        skipContractAuth: false,
      });
    });

    it('should use two DB transactions: one to acquire CLAIMING, one to finalise CLAIMED', async () => {
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);
      await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);
      expect(ds.transaction).toHaveBeenCalledTimes(2);
    });

    it('fires sweep.completed exactly once (issue #632)', async () => {
      await provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      const completedCalls = mockWebhooksService.triggerEvent.mock.calls.filter(
        ([event]) => event === 'sweep.completed',
      );
      expect(completedCalls).toHaveLength(1);
      expect(mockWebhooksService.triggerEvent).not.toHaveBeenCalledWith(
        'sweep.failed',
        expect.anything(),
      );
    });
  });

  // Issue #641 (re-verified against #702): sweep.completed/sweep.failed must
  // each fire exactly once, and never both, for a single redemption. The two
  // triggers sit in mutually-exclusive branches (success vs. catch), and the
  // isPartial branch returns before either can run, so at most one of
  // sweep.completed/sweep.failed/sweep.partial fires per redemption attempt.
  describe('redeemClaim - webhook exactly-once guarantees (issue #641)', () => {
    it('fires sweep.completed exactly once and never sweep.failed on success', async () => {
      await provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      const completedCalls = mockWebhooksService.triggerEvent.mock.calls.filter(
        ([event]) => event === 'sweep.completed',
      );
      const failedCalls = mockWebhooksService.triggerEvent.mock.calls.filter(
        ([event]) => event === 'sweep.failed',
      );
      expect(completedCalls).toHaveLength(1);
      expect(failedCalls).toHaveLength(0);
    });

    it('fires sweep.failed exactly once and never sweep.completed when the sweep throws', async () => {
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);
      mockSweepsService.executeSweep.mockRejectedValue(new Error('boom'));

      await expect(
        p.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow('boom');

      const completedCalls = mockWebhooksService.triggerEvent.mock.calls.filter(
        ([event]) => event === 'sweep.completed',
      );
      const failedCalls = mockWebhooksService.triggerEvent.mock.calls.filter(
        ([event]) => event === 'sweep.failed',
      );
      expect(failedCalls).toHaveLength(1);
      expect(completedCalls).toHaveLength(0);
    });
  });

  describe('redeemClaim - idempotency for already-claimed accounts', () => {
    it('should return idempotent response when SELECT FOR UPDATE finds CLAIMED account', async () => {
      const claimedAccount = { ...mockAccount, status: AccountStatus.CLAIMED };
      const ds = {
        transaction: jest
          .fn()
          .mockImplementationOnce(
            async (cb: (m: unknown) => Promise<unknown>) =>
              cb(makeManager(claimedAccount)),
          ),
      };
      const p = await buildModule(ds);
      mockClaimsRepository.findOne.mockResolvedValue({ ...mockClaim });

      const result = await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      expect(result).toEqual({
        success: true,
        txHash: mockClaim.sweepTxHash,
        amountSwept: mockClaim.amountSwept,
        asset: mockClaim.asset,
        destination: mockClaim.destinationAddress,
        sweptAt: mockClaim.claimedAt,
        message: 'Claim was already redeemed',
      });
    });

    it('should handle ConflictException from token verification and return existing claim data', async () => {
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);

      mockTokenVerificationProvider.verifyClaimToken.mockRejectedValue(
        new ConflictException('Claim has already been redeemed'),
      );
      mockAccountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        status: AccountStatus.CLAIMED,
      });
      mockClaimsRepository.findOne.mockResolvedValue({
        ...mockClaim,
        sweepTxHash: 'conflict-tx-hash',
      });

      const result = await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);
      expect(result.message).toBe('Claim was already redeemed');
    });

    it('should throw ConflictException when account is in CLAIMING state (concurrent request)', async () => {
      const claimingAccount = {
        ...mockAccount,
        status: AccountStatus.CLAIMING,
      };
      const ds = {
        transaction: jest
          .fn()
          .mockImplementationOnce(
            async (cb: (m: unknown) => Promise<unknown>) =>
              cb(makeManager(claimingAccount)),
          ),
      };
      const p = await buildModule(ds);

      await expect(
        p.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('redeemClaim - Stellar address validation', () => {
    it('should throw BadRequestException for an address with invalid format', async () => {
      await expect(
        provider.redeemClaim(VALID_TOKEN, 'invalid-address'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for an address not starting with G', async () => {
      await expect(
        provider.redeemClaim(
          VALID_TOKEN,
          'SABCD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for an address shorter than 56 characters', async () => {
      await expect(provider.redeemClaim(VALID_TOKEN, 'GSHORT')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for an address longer than 56 characters', async () => {
      await expect(
        provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION + 'EXTRA'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('redeemClaim - sweep failure and rollback', () => {
    it('should rollback account status to PENDING_CLAIM when sweep fails', async () => {
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);
      mockSweepsService.executeSweep.mockRejectedValue(
        new Error('Stellar network error'),
      );

      await expect(
        p.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow();

      expect(mockAccountsRepository.update).toHaveBeenCalledWith(
        mockAccount.id,
        expect.objectContaining({ status: AccountStatus.PENDING_CLAIM }),
      );
    });

    it('should re-throw the original sweep error after rolling back account status', async () => {
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);
      mockSweepsService.executeSweep.mockRejectedValue(
        new Error('Stellar network error'),
      );

      await expect(
        p.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow('Stellar network error');
    });

    it('fires the sweep.failed webhook exactly once (issue #632)', async () => {
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);
      mockSweepsService.executeSweep.mockRejectedValue(
        new Error('Stellar network error'),
      );

      await expect(
        p.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow();

      const failedCalls = mockWebhooksService.triggerEvent.mock.calls.filter(
        ([event]) => event === 'sweep.failed',
      );
      expect(failedCalls).toHaveLength(1);
    });
  });

  describe('redeemClaim - propagates TokenVerification errors (issue #167)', () => {
    it('rethrows BadRequestException when token is expired', async () => {
      mockTokenVerificationProvider.verifyClaimToken.mockRejectedValue(
        new BadRequestException('Token has expired'),
      );

      await expect(
        provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow(BadRequestException);
    });

    it('rethrows BadRequestException when token does not match the requested account', async () => {
      mockTokenVerificationProvider.verifyClaimToken.mockRejectedValue(
        new BadRequestException('Token does not match the requested account'),
      );

      await expect(
        provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow(BadRequestException);
    });

    it('rethrows BadRequestException for malformed JWT', async () => {
      mockTokenVerificationProvider.verifyClaimToken.mockRejectedValue(
        new BadRequestException('jwt malformed'),
      );

      await expect(
        provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================================================
  // Partial-sweep path (issue #169): when SweepsService.executeSweep returns
  // isPartial=true the orchestrator transitions the account to PARTIAL_SWEEP,
  // records an audit entry with outcome='partial', fires a sweep.partial
  // webhook, and returns a structured non-error response so callers can
  // retry with the same token (the second attempt passes skipContractAuth
  // because the contract is already in Swept state).
  // ========================================================================
  describe('redeemClaim - partial sweep path', () => {
    it('accepts PARTIAL_SWEEP entry and passes skipContractAuth=true to executeSweep', async () => {
      const partialAccount = {
        ...mockAccount,
        status: AccountStatus.PARTIAL_SWEEP,
      };
      const ds = {
        transaction: jest
          .fn()
          .mockImplementationOnce(
            async (cb: (m: unknown) => Promise<unknown>) =>
              cb(makeManager(partialAccount)),
          ),
      };
      const p = await buildModule(ds);
      // Return a partial result so redeemClaim never enters the success
      // path (which would need a 2nd transaction we have not mocked).
      mockSweepsService.executeSweep.mockResolvedValueOnce({
        success: false,
        isPartial: true,
        contractAuthHash: 'partial-auth-hash',
        amountSwept: mockAccount.amount,
        destination: VALID_DESTINATION,
        error: 'Horizon offline',
      });

      await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      expect(mockSweepsService.executeSweep).toHaveBeenCalledWith(
        expect.objectContaining({ skipContractAuth: true }),
      );
    });

    it('passes skipContractAuth=false for a fresh PENDING_CLAIM attempt', async () => {
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);
      mockSweepsService.executeSweep.mockResolvedValueOnce(mockSweepResult);

      await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      expect(mockSweepsService.executeSweep).toHaveBeenCalledWith(
        expect.objectContaining({ skipContractAuth: false }),
      );
    });

    it('returns success:false, isPartial:true and transitions account to PARTIAL_SWEEP when sweeper signals partial', async () => {
      const ds = {
        transaction: jest
          .fn()
          .mockImplementationOnce(
            async (cb: (m: unknown) => Promise<unknown>) =>
              cb(makeManager(mockAccount)),
          ),
      };
      const p = await buildModule(ds);
      const partialResult = {
        success: false,
        isPartial: true,
        contractAuthHash: 'partial-auth-hash',
        amountSwept: '100.0000000',
        destination: VALID_DESTINATION,
        error: 'Horizon offline',
      };
      mockSweepsService.executeSweep.mockResolvedValueOnce(partialResult);

      const result = await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      expect(result.success).toBe(false);
      expect(result.isPartial).toBe(true);
      expect(result.contractAuthHash).toBe('partial-auth-hash');
      expect(result.error).toBe('Horizon offline');
      expect((result as { message?: string }).message).toMatch(
        /partial|Retry/i,
      );

      // The account must be reverted to PARTIAL_SWEEP, not PENDING_CLAIM.
      expect(mockAccountsRepository.update).toHaveBeenCalledWith(
        mockAccount.id,
        expect.objectContaining({
          status: AccountStatus.PARTIAL_SWEEP,
          destinationAddress: '',
        }),
      );
    });

    it('emits a sweep.partial webhook with the auth hash and error on partial outcome', async () => {
      const ds = {
        transaction: jest
          .fn()
          .mockImplementationOnce(
            async (cb: (m: unknown) => Promise<unknown>) =>
              cb(makeManager(mockAccount)),
          ),
      };
      const p = await buildModule(ds);
      const partialResult = {
        success: false,
        isPartial: true,
        contractAuthHash: 'partial-auth-hash',
        amountSwept: '100.0000000',
        destination: VALID_DESTINATION,
        error: 'Horizon offline',
      };
      mockSweepsService.executeSweep.mockResolvedValueOnce(partialResult);

      await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      expect(mockWebhooksService.triggerEvent).toHaveBeenCalledWith(
        'sweep.partial',
        expect.objectContaining({
          accountId: mockAccount.id,
          error: 'Horizon offline',
          contractAuthHash: 'partial-auth-hash',
        }),
      );
    });

    it('fires sweep.partial exactly once and never the terminal events (issue #693)', async () => {
      // The partial path is the third outcome, and the one most likely to
      // double-fire: the provider returns from inside the try block, so a
      // refactor that moved the trigger could plausibly also reach the catch.
      // Assert the count, not just the presence.
      const ds = {
        transaction: jest
          .fn()
          .mockImplementationOnce(
            async (cb: (m: unknown) => Promise<unknown>) =>
              cb(makeManager(mockAccount)),
          ),
      };
      const p = await buildModule(ds);
      mockSweepsService.executeSweep.mockResolvedValueOnce({
        success: false,
        isPartial: true,
        contractAuthHash: 'partial-auth-hash',
        amountSwept: '100.0000000',
        destination: VALID_DESTINATION,
        error: 'Horizon offline',
      });

      await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      const eventsFor = (name: string) =>
        mockWebhooksService.triggerEvent.mock.calls.filter(
          ([event]) => event === name,
        );

      expect(eventsFor('sweep.partial')).toHaveLength(1);
      expect(eventsFor('sweep.completed')).toHaveLength(0);
      expect(eventsFor('sweep.failed')).toHaveLength(0);
      // Only one webhook of any kind fired for this redemption attempt.
      expect(mockWebhooksService.triggerEvent).toHaveBeenCalledTimes(1);
    });

    it('fires sweep.partial exactly once when retrying a PARTIAL_SWEEP account', async () => {
      // Retry path: entered as PARTIAL_SWEEP, partial again. Still one event.
      const ds = {
        transaction: jest
          .fn()
          .mockImplementationOnce(
            async (cb: (m: unknown) => Promise<unknown>) =>
              cb(
                makeManager({
                  ...mockAccount,
                  status: AccountStatus.PARTIAL_SWEEP,
                }),
              ),
          ),
      };
      const p = await buildModule(ds);
      mockSweepsService.executeSweep.mockResolvedValueOnce({
        success: false,
        isPartial: true,
        contractAuthHash: 'partial-auth-hash-2',
        amountSwept: '100.0000000',
        destination: VALID_DESTINATION,
        error: 'Horizon still offline',
      });

      await p.redeemClaim(VALID_TOKEN, VALID_DESTINATION);

      const partialCalls = mockWebhooksService.triggerEvent.mock.calls.filter(
        ([event]) => event === 'sweep.partial',
      );
      expect(partialCalls).toHaveLength(1);
      expect(mockWebhooksService.triggerEvent).toHaveBeenCalledTimes(1);
    });

    it('on sweep failure (throw) leaves the account in PARTIAL_SWEEP if it entered as PARTIAL_SWEEP', async () => {
      const partialAccount = {
        ...mockAccount,
        status: AccountStatus.PARTIAL_SWEEP,
      };
      const ds = {
        transaction: jest
          .fn()
          .mockImplementationOnce(
            async (cb: (m: unknown) => Promise<unknown>) =>
              cb(makeManager(partialAccount)),
          ),
      };
      const p = await buildModule(ds);
      // Sweeper throws (NOT a structured isPartial).
      mockSweepsService.executeSweep.mockRejectedValueOnce(
        new Error('Contract invoke failed inside skip path'),
      );

      await expect(
        p.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow('Contract invoke failed');

      // The revert path must preserve the PARTIAL_SWEEP invariant.
      expect(mockAccountsRepository.update).toHaveBeenCalledWith(
        mockAccount.id,
        expect.objectContaining({ status: AccountStatus.PARTIAL_SWEEP }),
      );
    });

    it('on sweep failure (throw) reverts a fresh PENDING_CLAIM attempt back to PENDING_CLAIM', async () => {
      const ds = makeHappyPathDataSource();
      const p = await buildModule(ds);
      mockSweepsService.executeSweep.mockRejectedValueOnce(
        new Error('Network blip'),
      );

      await expect(
        p.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
      ).rejects.toThrow('Network blip');

      expect(mockAccountsRepository.update).toHaveBeenCalledWith(
        mockAccount.id,
        expect.objectContaining({ status: AccountStatus.PENDING_CLAIM }),
      );
    });
  });
});
