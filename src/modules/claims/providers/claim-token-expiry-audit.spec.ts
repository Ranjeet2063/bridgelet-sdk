import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { TokenVerificationProvider } from './token-verification.provider.js';
import { ClaimRedemptionProvider } from './claim-redemption.provider.js';
import { Claim } from '../entities/claim.entity.js';
import { Account } from '../../accounts/entities/account.entity.js';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';
import { SweepsService } from '../../sweeps/sweeps.service.js';
import { WebhooksService } from '../../webhooks/webhooks.service.js';
import { ClaimAuditProvider } from './claim-audit.provider.js';
import { KmsKeyProvider } from '../../../common/crypto/kms-key.provider.js';

const VALID_DESTINATION =
  'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN';

jest.mock('jsonwebtoken', () => ({
  ...jest.requireActual('jsonwebtoken'),
  verify: jest.fn(),
}));

// Audit for issue: "CLAIM_TOKEN_EXPIRY default of 30 days vs ephemeral-account
// expiry". Conclusion: the two are already independent by design —
// TokenVerificationProvider.verifyClaimToken() checks `account.expiresAt`
// explicitly and does NOT trust the JWT's own (longer-lived) `exp` claim as
// proof the underlying account is still claimable. This test pins that down
// so it can't regress silently.
describe('Claim token expiry vs. account expiry (audit)', () => {
  let provider: TokenVerificationProvider;
  const mockAccountRepository = { findOne: jest.fn() };
  const mockConfigService = { getOrThrow: jest.fn().mockReturnValue('secret') };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenVerificationProvider,
        {
          provide: getRepositoryToken(Account),
          useValue: mockAccountRepository,
        },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();
    provider = module.get(TokenVerificationProvider);
    jest.clearAllMocks();
    mockConfigService.getOrThrow.mockReturnValue('secret');
  });

  it('rejects a JWT that has not yet hit its own exp once the account has already expired', async () => {
    // exp is 29 days out (well within the 30-day CLAIM_TOKEN_EXPIRY default),
    // so jwt.verify() would happily accept it on its own.
    (jwt.verify as jest.Mock).mockReturnValue({
      publicKey: 'GTEST...',
      type: 'claim',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 29 * 86400,
    });
    mockAccountRepository.findOne.mockResolvedValue({
      id: 'acct-1',
      status: AccountStatus.PENDING_CLAIM,
      expiresAt: new Date(Date.now() - 1000), // account itself expired 1s ago
    });

    await expect(provider.verifyClaimToken('t')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // The case above only covers verification. The redemption path
  // (ClaimRedemptionProvider.redeemClaim) re-reads the account to acquire the
  // claim slot and must not sweep funds for an account that has already
  // expired, relying on a downstream 404 to stop it.
  describe('redemption path', () => {
    let redemptionProvider: ClaimRedemptionProvider;
    let executeSweep: jest.Mock;
    /** When set, the claim-slot query returns this row instead of null. */
    let expiredAccount: Record<string, unknown> | null = null;

    beforeEach(async () => {
      executeSweep = jest.fn().mockResolvedValue({ txHash: 'a'.repeat(64) });
      expiredAccount = null;
      const tokenVerification = {
        verifyClaimToken: jest.fn().mockResolvedValue({ valid: true }),
      };
      const accountsRepository = {
        findOne: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const claimsRepository = {
        findOne: jest.fn().mockResolvedValue(null),
      };
      const dataSource = {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            createQueryBuilder: () => ({
              setLock: () => ({
                where: () => ({
                  andWhere: () => ({
                    getOne: () => Promise.resolve(expiredAccount),
                  }),
                }),
              }),
            }),
            save: jest.fn(),
            create: jest.fn(),
          }),
        ),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ClaimRedemptionProvider,
          { provide: getRepositoryToken(Claim), useValue: claimsRepository },
          {
            provide: getRepositoryToken(Account),
            useValue: accountsRepository,
          },
          { provide: DataSource, useValue: dataSource },
          { provide: TokenVerificationProvider, useValue: tokenVerification },
          { provide: SweepsService, useValue: { executeSweep } },
          {
            provide: ConfigService,
            useValue: { getOrThrow: () => 'secret', get: () => undefined },
          },
          {
            provide: WebhooksService,
            useValue: { triggerEvent: jest.fn() },
          },
          {
            provide: ClaimAuditProvider,
            useValue: { record: jest.fn() },
          },
          {
            provide: KmsKeyProvider,
            useValue: { getEncryptionKey: () => 'f'.repeat(64) },
          },
        ],
      }).compile();
      redemptionProvider = module.get(ClaimRedemptionProvider);
    });

    it('does not sweep when the claim-slot lookup cannot find a live account', async () => {
      // The pessimistic-lock lookup filters `deletedAt IS NULL` and returns
      // null for an expired/unknown account, so redeemClaim must bail out
      // with an explicit BadRequest rather than fall through to the sweep and
      // rely on a downstream 404.
      await expect(
        redemptionProvider.redeemClaim('tok', VALID_DESTINATION),
      ).rejects.toThrow(BadRequestException);

      expect(executeSweep).not.toHaveBeenCalled();
    });

    it('rejects an expired account with an explicit message and no sweep', async () => {
      // Feed the slot query a row that is present but already past its
      // expiresAt. The redemption path must reject on the expiry itself
      // rather than attempting a sweep of a dead account.
      expiredAccount = {
        id: 'acct-1',
        status: AccountStatus.PENDING_CLAIM,
        expiresAt: new Date(Date.now() - 1000),
        secretKeyEncrypted: 'aes256gcm:v1:aa:bb:cc',
        amount: '100.0000000',
        asset: 'native',
        metadata: null,
        publicKey: 'GTEST...',
      };

      await expect(
        redemptionProvider.redeemClaim('tok', VALID_DESTINATION),
      ).rejects.toThrow(UnauthorizedException);

      expect(executeSweep).not.toHaveBeenCalled();
    });

    it('rejects a wrong-format destination before touching the account', async () => {
      // Guard ordering: address validation must precede any sweep attempt.
      await expect(
        redemptionProvider.redeemClaim('tok', 'not-a-stellar-address'),
      ).rejects.toThrow(BadRequestException);
      expect(executeSweep).not.toHaveBeenCalled();
    });
  });
});
