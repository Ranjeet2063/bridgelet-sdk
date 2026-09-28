import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { IsNull } from 'typeorm';
import { TokenVerificationProvider } from './token-verification.provider.js';
import { Account } from '../../accounts/entities/account.entity.js';
import jwt from 'jsonwebtoken';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';

// Mock jsonwebtoken to control verify output, but keep actual error classes
jest.mock('jsonwebtoken', () => {
  const actualJwt = jest.requireActual('jsonwebtoken');
  return {
    ...actualJwt,
    verify: jest.fn(),
  };
});

describe('TokenVerificationProvider', () => {
  let provider: TokenVerificationProvider;

  // Mock for TypeORM Account repository
  const mockAccountRepository = {
    findOne: jest.fn(),
  };

  // Mock for ConfigService (used to get JWT_SECRET)
  const mockConfigService = {
    get: jest.fn(),
    getOrThrow: jest.fn(),
  };

  beforeEach(async () => {
    // Set up the testing module with required providers and mocks
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenVerificationProvider,
        {
          provide: getRepositoryToken(Account),
          useValue: mockAccountRepository,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    provider = module.get<TokenVerificationProvider>(TokenVerificationProvider);
  });

  afterEach(() => {
    // Clear all mock interactions after each test
    jest.clearAllMocks();
  });

  describe('verifyClaimToken', () => {
    const validToken = 'valid.jwt.token';
    // This is the sha256 hash of 'valid.jwt.token'
    const tokenHash =
      'c8e4ea66ed0356bf3a8fccc0118eb9cd323bda7e64175ac2d6b38c351fce81a5';

    // A standard mock account representing a valid state
    const mockAccount = {
      id: 'account-id',
      publicKey: 'GTEST...',
      claimTokenHash: tokenHash,
      amount: '100.0000000',
      asset: 'native',
      status: AccountStatus.PENDING_CLAIM,
      expiresAt: new Date(Date.now() + 86400000), // 24 hours from now
    };

    // A standard mock decoded token payload
    const mockDecodedToken = {
      publicKey: 'GTEST...',
      type: 'claim',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    beforeEach(() => {
      // Setup default mock returns for the JWT secret and verification
      mockConfigService.getOrThrow.mockReturnValue('test-secret');
      (jwt.verify as jest.Mock).mockReturnValue(mockDecodedToken);
      // Spy on the logger to verify error logging
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    });

    it('should successfully verify valid token with eligible account', async () => {
      // Setup: Valid token + existing eligible account
      mockAccountRepository.findOne.mockResolvedValue(mockAccount);

      // Execute: Verify the token
      const result = await provider.verifyClaimToken(validToken);

      // Assert: Correct response and proper dependency calls
      expect(result).toEqual({
        valid: true,
        accountId: mockAccount.id,
        amount: mockAccount.amount,
        asset: mockAccount.asset,
        expiresAt: mockAccount.expiresAt,
      });
      expect(jwt.verify).toHaveBeenCalledWith(validToken, 'test-secret');
      expect(mockAccountRepository.findOne).toHaveBeenCalledWith({
        where: { claimTokenHash: expect.any(String), deletedAt: IsNull() },
      });
    });

    it('should return correct verification response with amount and expiry', async () => {
      // Setup: Valid token + existing eligible account
      mockAccountRepository.findOne.mockResolvedValue(mockAccount);

      // Execute: Verify the token
      const result = await provider.verifyClaimToken(validToken);

      // Assert: The response contains the expected fields and values
      expect(result.valid).toBe(true);
      expect(result.amount).toBe('100.0000000');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('should throw UnauthorizedException for expired JWT (TokenExpiredError)', async () => {
      // Setup: Mock JWT library throwing TokenExpiredError
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new jwt.TokenExpiredError('jwt expired', new Date());
      });

      // Execute & Assert: Should throw UnauthorizedException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith('Token has expired');
    });

    it('should throw UnauthorizedException for invalid JWT signature (JsonWebTokenError)', async () => {
      // Setup: Mock JWT library throwing JsonWebTokenError
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new jwt.JsonWebTokenError('invalid signature');
      });

      // Execute & Assert: Should throw UnauthorizedException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'Invalid token signature',
      );
    });

    it('should throw UnauthorizedException for token with wrong type', async () => {
      // Setup: Mock token payload with invalid 'type' field
      (jwt.verify as jest.Mock).mockReturnValue({
        ...mockDecodedToken,
        type: 'access',
      });

      // Execute & Assert: Should throw UnauthorizedException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'Invalid token type: access',
      );
    });

    it('should throw UnauthorizedException for non-existent account', async () => {
      // Setup: Token is valid, but account lookup returns null
      mockAccountRepository.findOne.mockResolvedValue(null);

      // Execute & Assert: Should throw UnauthorizedException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('Account not found for token hash:'),
      );
    });

    it('should throw ConflictException for already claimed account (AccountStatus.CLAIMED)', async () => {
      // Setup: Valid token, but account status is CLAIMED
      mockAccountRepository.findOne.mockResolvedValue({
        ...mockAccount,
        status: AccountStatus.CLAIMED,
      });

      // Execute & Assert: Should throw ConflictException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        ConflictException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        `Account ${mockAccount.id} has already been claimed`,
      );
    });

    it('should throw UnauthorizedException for expired account (AccountStatus.EXPIRED)', async () => {
      // Setup: Valid token, but account status is EXPIRED
      mockAccountRepository.findOne.mockResolvedValue({
        ...mockAccount,
        status: AccountStatus.EXPIRED,
      });

      // Execute & Assert: Should throw UnauthorizedException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        `Account ${mockAccount.id} has expired`,
      );
    });

    it('should throw BadRequestException for account without payment (AccountStatus.PENDING_PAYMENT)', async () => {
      // Setup: Valid token, but account status is PENDING_PAYMENT
      mockAccountRepository.findOne.mockResolvedValue({
        ...mockAccount,
        status: AccountStatus.PENDING_PAYMENT,
      });

      // Execute & Assert: Should throw BadRequestException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        BadRequestException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        `Account ${mockAccount.id} has not received payment`,
      );
    });

    it('should throw BadRequestException for failed account (AccountStatus.FAILED)', async () => {
      // Setup: Valid token, but account status is FAILED
      mockAccountRepository.findOne.mockResolvedValue({
        ...mockAccount,
        status: AccountStatus.FAILED,
      });

      // Execute & Assert: Should throw BadRequestException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        BadRequestException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        `Account ${mockAccount.id} is in failed state`,
      );
    });

    it('should throw BadRequestException for unknown account status', async () => {
      // Setup: Valid token, but account status is not recognized
      mockAccountRepository.findOne.mockResolvedValue({
        ...mockAccount,
        status: 'UNKNOWN_STATUS' as AccountStatus,
      });

      // Execute & Assert: Should throw BadRequestException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        BadRequestException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'Unknown account status: UNKNOWN_STATUS',
      );
    });

    it('should throw UnauthorizedException when current time exceeds account expiry', async () => {
      // Setup: Valid token, account status is ok, but global time is past account's expiresAt
      mockAccountRepository.findOne.mockResolvedValue({
        ...mockAccount,
        expiresAt: new Date(Date.now() - 1000), // Already expired
      });

      // Execute & Assert: Should throw UnauthorizedException
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Account ${mockAccount.id} has expired at`),
      );
    });

    it('should verify proper error logging for unexpected errors', async () => {
      // Setup: Throw a generic error from repository findOne
      const unexpectedError = new Error('Database connection failed');
      mockAccountRepository.findOne.mockRejectedValue(unexpectedError);

      // Execute: Try to verify the token
      await expect(provider.verifyClaimToken(validToken)).rejects.toThrow(
        unexpectedError,
      );

      // Assert: Verify that the error was properly logged
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Unexpected error during token verification',
        unexpectedError,
      );
    });
  });
});
