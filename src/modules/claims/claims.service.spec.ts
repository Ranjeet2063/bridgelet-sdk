import { Test, TestingModule } from '@nestjs/testing';
import { ClaimsService } from './claims.service.js';
import { ClaimLookupProvider } from './providers/claim-lookup.provider.js';
import { TokenVerificationProvider } from './providers/token-verification.provider.js';
import { ClaimRedemptionProvider } from './providers/claim-redemption.provider.js';
import { ClaimDetailsDto } from './dto/claim-details.dto.js';
import { ClaimVerificationResponseDto } from './dto/claim-verification-response.dto.js';
import { ClaimRedemptionResponseDto } from './dto/claim-redemption-response.dto.js';
import { getToken } from '@willsoto/nestjs-prometheus';

/**
 * Integration Tests for ClaimsService
 *
 * These tests verify that the ClaimsService properly delegates to its providers
 * and acts as a simple passthrough layer without modifying responses.
 *
 * The tests focus on:
 * - Proper delegation to the correct provider
 * - Correct parameter passing
 * - Unmodified response returns
 *
 * Note: Provider-specific logic is tested in their respective unit test files:
 * - ClaimLookupProvider: claim-lookup.provider.spec.ts
 * - TokenVerificationProvider: token-verification.provider.spec.ts
 * - ClaimRedemptionProvider: claim-redemption.provider.spec.ts
 */
describe('ClaimsService Integration Tests', () => {
  let service: ClaimsService;
  let claimLookupProvider: jest.Mocked<ClaimLookupProvider>;
  let tokenVerificationProvider: jest.Mocked<TokenVerificationProvider>;
  let claimRedemptionProvider: jest.Mocked<ClaimRedemptionProvider>;

  // Mock data for integration tests
  const mockClaimId = 'claim-id-123';
  const mockToken = 'valid.jwt.token';
  const mockDestinationAddress =
    'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN';

  const mockClaimDetails: ClaimDetailsDto = {
    id: mockClaimId,
    accountId: 'account-id-456',
    destinationAddress: mockDestinationAddress,
    amountSwept: '100.0000000',
    asset: 'native',
    sweepTxHash: 'tx-hash-789',
    claimedAt: new Date('2026-01-14T17:49:20.265Z'),
  };

  const mockVerificationResponse: ClaimVerificationResponseDto = {
    valid: true,
    accountId: 'account-id-456',
    amount: '100.0000000',
    asset: 'native',
    expiresAt: new Date('2026-01-15T17:49:20.265Z'),
  };

  const mockRedemptionResponse: ClaimRedemptionResponseDto = {
    success: true,
    txHash: 'sweep-tx-hash-abc',
    amountSwept: '100.0000000',
    asset: 'native',
    destination: mockDestinationAddress,
    sweptAt: new Date('2026-01-14T17:49:20.265Z'),
  };

  beforeEach(async () => {
    // Create mock providers with jest mock functions
    claimLookupProvider = {
      findClaimById: jest.fn(),
    } as any;

    tokenVerificationProvider = {
      verifyClaimToken: jest.fn(),
    } as any;

    claimRedemptionProvider = {
      redeemClaim: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimsService,
        {
          provide: ClaimLookupProvider,
          useValue: claimLookupProvider,
        },
        {
          provide: TokenVerificationProvider,
          useValue: tokenVerificationProvider,
        },
        {
          provide: ClaimRedemptionProvider,
          useValue: claimRedemptionProvider,
        },
        {
          provide: getToken('claim_redemption_total'),
          useValue: { inc: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<ClaimsService>(ClaimsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Service Delegation - ClaimLookupProvider', () => {
    it('should delegate findClaimById to ClaimLookupProvider', async () => {
      // Arrange: Setup mock to return claim details
      claimLookupProvider.findClaimById.mockResolvedValue(mockClaimDetails);

      // Act: Call the service method
      const result = await service.findClaimById(mockClaimId);

      // Assert: Verify delegation and response
      expect(claimLookupProvider.findClaimById).toHaveBeenCalledWith(
        mockClaimId,
      );
      expect(claimLookupProvider.findClaimById).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockClaimDetails);
    });

    it('should pass parameters correctly to ClaimLookupProvider', async () => {
      // Arrange: Setup mock
      claimLookupProvider.findClaimById.mockResolvedValue(mockClaimDetails);

      // Act: Call with specific parameter
      await service.findClaimById('specific-claim-id');

      // Assert: Verify exact parameter was passed
      expect(claimLookupProvider.findClaimById).toHaveBeenCalledWith(
        'specific-claim-id',
      );
    });

    it('should return ClaimLookupProvider response unchanged', async () => {
      // Arrange: Setup mock with specific response
      claimLookupProvider.findClaimById.mockResolvedValue(mockClaimDetails);

      // Act: Call the service
      const result = await service.findClaimById(mockClaimId);

      // Assert: Verify response is exactly the same (no modification)
      expect(result).toBe(mockClaimDetails);
      expect(result).toEqual(mockClaimDetails);
    });

    it('should propagate ClaimLookupProvider errors unchanged', async () => {
      // Arrange: Setup mock to throw error
      const error = new Error('Claim not found');
      claimLookupProvider.findClaimById.mockRejectedValue(error);

      // Act & Assert: Verify error is propagated
      await expect(service.findClaimById(mockClaimId)).rejects.toThrow(
        'Claim not found',
      );
    });
  });

  describe('Service Delegation - TokenVerificationProvider', () => {
    it('should delegate verifyClaimToken to TokenVerificationProvider', async () => {
      // Arrange: Setup mock to return verification response
      tokenVerificationProvider.verifyClaimToken.mockResolvedValue(
        mockVerificationResponse,
      );

      // Act: Call the service method
      const result = await service.verifyClaimToken(mockToken);

      // Assert: Verify delegation and response
      expect(tokenVerificationProvider.verifyClaimToken).toHaveBeenCalledWith(
        mockToken,
      );
      expect(tokenVerificationProvider.verifyClaimToken).toHaveBeenCalledTimes(
        1,
      );
      expect(result).toEqual(mockVerificationResponse);
    });

    it('should pass parameters correctly to TokenVerificationProvider', async () => {
      // Arrange: Setup mock
      tokenVerificationProvider.verifyClaimToken.mockResolvedValue(
        mockVerificationResponse,
      );

      // Act: Call with specific token
      await service.verifyClaimToken('specific-jwt-token');

      // Assert: Verify exact parameter was passed
      expect(tokenVerificationProvider.verifyClaimToken).toHaveBeenCalledWith(
        'specific-jwt-token',
      );
    });

    it('should return TokenVerificationProvider response unchanged', async () => {
      // Arrange: Setup mock with specific response
      tokenVerificationProvider.verifyClaimToken.mockResolvedValue(
        mockVerificationResponse,
      );

      // Act: Call the service
      const result = await service.verifyClaimToken(mockToken);

      // Assert: Verify response is exactly the same (no modification)
      expect(result).toBe(mockVerificationResponse);
      expect(result).toEqual(mockVerificationResponse);
    });

    it('should propagate TokenVerificationProvider errors unchanged', async () => {
      // Arrange: Setup mock to throw error
      const error = new Error('Invalid token');
      tokenVerificationProvider.verifyClaimToken.mockRejectedValue(error);

      // Act & Assert: Verify error is propagated
      await expect(service.verifyClaimToken(mockToken)).rejects.toThrow(
        'Invalid token',
      );
    });
  });

  describe('Service Delegation - ClaimRedemptionProvider', () => {
    it('should delegate redeemClaim to ClaimRedemptionProvider', async () => {
      // Arrange: Setup mock to return redemption response
      claimRedemptionProvider.redeemClaim.mockResolvedValue(
        mockRedemptionResponse,
      );

      // Act: Call the service method
      const result = await service.redeemClaim(
        mockToken,
        mockDestinationAddress,
      );

      // Assert: Verify delegation and response
      expect(claimRedemptionProvider.redeemClaim).toHaveBeenCalledWith(
        mockToken,
        mockDestinationAddress,
      );
      expect(claimRedemptionProvider.redeemClaim).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockRedemptionResponse);
    });

    it('should pass parameters correctly to ClaimRedemptionProvider', async () => {
      // Arrange: Setup mock
      claimRedemptionProvider.redeemClaim.mockResolvedValue(
        mockRedemptionResponse,
      );

      // Act: Call with specific parameters
      await service.redeemClaim('specific-token', 'specific-destination');

      // Assert: Verify exact parameters were passed
      expect(claimRedemptionProvider.redeemClaim).toHaveBeenCalledWith(
        'specific-token',
        'specific-destination',
      );
    });

    it('should return ClaimRedemptionProvider response unchanged', async () => {
      // Arrange: Setup mock with specific response
      claimRedemptionProvider.redeemClaim.mockResolvedValue(
        mockRedemptionResponse,
      );

      // Act: Call the service
      const result = await service.redeemClaim(
        mockToken,
        mockDestinationAddress,
      );

      // Assert: Verify response is exactly the same (no modification)
      expect(result).toBe(mockRedemptionResponse);
      expect(result).toEqual(mockRedemptionResponse);
    });

    it('should propagate ClaimRedemptionProvider errors unchanged', async () => {
      // Arrange: Setup mock to throw error
      const error = new Error('Sweep failed');
      claimRedemptionProvider.redeemClaim.mockRejectedValue(error);

      // Act & Assert: Verify error is propagated
      await expect(
        service.redeemClaim(mockToken, mockDestinationAddress),
      ).rejects.toThrow('Sweep failed');
    });

    // Verified for #707 (duplicate of the already-resolved #646, fixed in PR #772).
    it('passes concurrent redemption attempts for the same token straight through without deduping them itself', async () => {
      // ClaimsService is a passthrough (see file header): it must not hide a
      // double-redemption race by silently coalescing calls. Guarding the
      // actual claim-state transition is ClaimRedemptionProvider's job
      // (claim-redemption.provider.spec.ts); here we only assert the service
      // forwards both concurrent calls and surfaces whatever the provider
      // decides (one success, one rejection) unchanged.
      claimRedemptionProvider.redeemClaim
        .mockResolvedValueOnce(mockRedemptionResponse)
        .mockRejectedValueOnce(new Error('Claim already redeemed'));

      const [first, second] = await Promise.allSettled([
        service.redeemClaim(mockToken, mockDestinationAddress),
        service.redeemClaim(mockToken, mockDestinationAddress),
      ]);

      expect(claimRedemptionProvider.redeemClaim).toHaveBeenCalledTimes(2);
      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('rejected');
    });
  });

  describe('Service Integration - Combined Operations', () => {
    it('should handle multiple provider calls in sequence', async () => {
      // Arrange: Setup mocks for all providers
      tokenVerificationProvider.verifyClaimToken.mockResolvedValue(
        mockVerificationResponse,
      );
      claimRedemptionProvider.redeemClaim.mockResolvedValue(
        mockRedemptionResponse,
      );
      claimLookupProvider.findClaimById.mockResolvedValue(mockClaimDetails);

      // Act: Call multiple service methods
      const verificationResult = await service.verifyClaimToken(mockToken);
      const redemptionResult = await service.redeemClaim(
        mockToken,
        mockDestinationAddress,
      );
      const claimResult = await service.findClaimById(mockClaimId);

      // Assert: Verify all providers were called correctly
      expect(tokenVerificationProvider.verifyClaimToken).toHaveBeenCalledWith(
        mockToken,
      );
      expect(claimRedemptionProvider.redeemClaim).toHaveBeenCalledWith(
        mockToken,
        mockDestinationAddress,
      );
      expect(claimLookupProvider.findClaimById).toHaveBeenCalledWith(
        mockClaimId,
      );

      // Verify responses are unchanged
      expect(verificationResult).toEqual(mockVerificationResponse);
      expect(redemptionResult).toEqual(mockRedemptionResponse);
      expect(claimResult).toEqual(mockClaimDetails);
    });

    it('should maintain service isolation between provider calls', async () => {
      // Arrange: Setup mocks with different responses
      tokenVerificationProvider.verifyClaimToken.mockResolvedValue({
        ...mockVerificationResponse,
        accountId: 'account-1',
      });
      claimRedemptionProvider.redeemClaim.mockResolvedValue({
        ...mockRedemptionResponse,
        txHash: 'tx-1',
      });
      claimLookupProvider.findClaimById.mockResolvedValue({
        ...mockClaimDetails,
        id: 'claim-1',
      });

      // Act: Call methods with different parameters
      const result1 = await service.verifyClaimToken('token-1');
      const result2 = await service.redeemClaim('token-2', 'dest-2');
      const result3 = await service.findClaimById('claim-3');

      // Assert: Verify each call is independent and correct
      expect(tokenVerificationProvider.verifyClaimToken).toHaveBeenCalledWith(
        'token-1',
      );
      expect(claimRedemptionProvider.redeemClaim).toHaveBeenCalledWith(
        'token-2',
        'dest-2',
      );
      expect(claimLookupProvider.findClaimById).toHaveBeenCalledWith('claim-3');

      expect(result1.accountId).toBe('account-1');
      expect(result2.txHash).toBe('tx-1');
      expect(result3.id).toBe('claim-1');
    });
  });

  describe('Service Instantiation', () => {
    it('should be properly instantiated with all dependencies', () => {
      // Assert: Service should be defined and have all providers injected
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(ClaimsService);
    });

    it('should have all required methods available', () => {
      // Assert: All public methods should be available
      expect(typeof service.findClaimById).toBe('function');
      expect(typeof service.verifyClaimToken).toBe('function');
      expect(typeof service.redeemClaim).toBe('function');
    });
  });
});
