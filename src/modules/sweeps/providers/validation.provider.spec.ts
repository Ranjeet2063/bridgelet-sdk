import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity.js';
import { ValidationProvider } from './validation.provider.js';
import { StrKey, Horizon, NotFoundError } from '@stellar/stellar-sdk';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';

const mockAccount = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 'acc-123',
    publicKey: 'GAB...',
    ephemeralSecret: 'S...',
    status: AccountStatus.PENDING_CLAIM,
    expiresAt: new Date(Date.now() + 86400000),
    amount: '100',
    asset: 'native',
    ...overrides,
  }) as Account;

describe('ValidationProvider', () => {
  let provider: ValidationProvider;
  let repo: Repository<Account>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationProvider,
        {
          provide: getRepositoryToken(Account),
          useClass: Repository,
        },
      ],
    }).compile();

    provider = module.get<ValidationProvider>(ValidationProvider);
    repo = module.get<Repository<Account>>(getRepositoryToken(Account));
    // Mock Stellar address validation to avoid relying on real keys in tests
    jest.spyOn(StrKey, 'isValidEd25519PublicKey').mockReturnValue(true);
  });

  describe('validateSweepParameters', () => {
    const validDto = {
      accountId: 'acc-123',
      ephemeralPublicKey: 'GABC123',
      ephemeralSecret: 'SABC123',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      amount: '100',
      asset: 'native',
    };

    it('should pass validation for valid parameters', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          publicKey: validDto.ephemeralPublicKey,
          amount: validDto.amount,
        }),
      );

      const realValidG =
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665O';

      const dto = { ...validDto, destinationAddress: realValidG };

      await expect(
        provider.validateSweepParameters(dto),
      ).resolves.not.toThrow();
    });

    it('should throw NotFoundException for non-existent account', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(null);

      const dto = {
        ...validDto,
        destinationAddress:
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J33665O',
      };

      await expect(provider.validateSweepParameters(dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for CLAIMED status', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          status: AccountStatus.CLAIMED,
          publicKey: validDto.ephemeralPublicKey,
        }),
      );
      const dto = {
        ...validDto,
        destinationAddress:
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      };

      await expect(provider.validateSweepParameters(dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for EXPIRED status (logic check)', async () => {
      const pastDate = new Date(Date.now() - 10000);
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          status: AccountStatus.PENDING_CLAIM,
          expiresAt: pastDate,
          publicKey: validDto.ephemeralPublicKey,
        }),
      );
      const dto = {
        ...validDto,
        destinationAddress:
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      };

      await expect(provider.validateSweepParameters(dto)).rejects.toThrow(
        'Account has expired',
      );
    });

    it('should throw BadRequestException for PENDING_PAYMENT status', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          status: AccountStatus.PENDING_PAYMENT,
          publicKey: validDto.ephemeralPublicKey,
        }),
      );
      const dto = {
        ...validDto,
        destinationAddress:
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      };

      await expect(provider.validateSweepParameters(dto)).rejects.toThrow(
        'Account has not received payment yet',
      );
    });

    it('should throw BadRequestException for amount mismatch', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          publicKey: validDto.ephemeralPublicKey,
          amount: '500',
        }),
      );
      const dto = {
        ...validDto,
        destinationAddress:
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      };

      await expect(provider.validateSweepParameters(dto)).rejects.toThrow(
        /Amount mismatch/,
      );
    });

    it('should throw BadRequestException for asset mismatch', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          publicKey: validDto.ephemeralPublicKey,
          amount: validDto.amount,
          asset: 'USDC:G...',
        }),
      );
      const dto = {
        ...validDto,
        destinationAddress:
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      };

      await expect(provider.validateSweepParameters(dto)).rejects.toThrow(
        /Asset mismatch/,
      );
    });
  });

  describe('canSweep', () => {
    it('should return true for valid sweep conditions', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(mockAccount());
      const result = await provider.canSweep(
        'acc-123',
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      );
      expect(result).toBe(true);
    });

    it('should return false for non-existent account', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(null);
      const result = await provider.canSweep(
        'acc-123',
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      );
      expect(result).toBe(false);
    });

    it('should return false for expired account', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          expiresAt: new Date(Date.now() - 1000),
        }),
      );
      const result = await provider.canSweep(
        'acc-123',
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      );
      expect(result).toBe(false);
    });

    it('should not throw errors and return false on exception', async () => {
      jest.spyOn(repo, 'findOne').mockRejectedValue(new Error('DB Error'));
      const result = await provider.canSweep(
        'acc-123',
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J336650',
      );
      expect(result).toBe(false);
    });
  });

  describe('getSweepStatus', () => {
    it('should return canSweep true for valid account', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(mockAccount());
      const result = await provider.getSweepStatus('acc-123');
      expect(result).toEqual({ canSweep: true });
    });

    it('should return "Account not found" for non-existent', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(null);
      const result = await provider.getSweepStatus('acc-123');
      expect(result.reason).toBe('Account not found');
    });

    it('should return "Already swept" for CLAIMED status', async () => {
      jest
        .spyOn(repo, 'findOne')
        .mockResolvedValue(mockAccount({ status: AccountStatus.CLAIMED }));
      const result = await provider.getSweepStatus('acc-123');
      expect(result.reason).toBe('Already swept');
    });

    it('returns "Account expired" for EXPIRED status', async () => {
      jest
        .spyOn(repo, 'findOne')
        .mockResolvedValue(mockAccount({ status: AccountStatus.EXPIRED }));
      const result = await provider.getSweepStatus('acc-123');
      expect(result.reason).toBe('Account expired');
    });

    it('returns "Payment not received" for PENDING_PAYMENT status', async () => {
      jest
        .spyOn(repo, 'findOne')
        .mockResolvedValue(
          mockAccount({ status: AccountStatus.PENDING_PAYMENT }),
        );
      const result = await provider.getSweepStatus('acc-123');
      expect(result.reason).toBe('Payment not received');
    });

    it('returns reason for account with no publicKey', async () => {
      jest
        .spyOn(repo, 'findOne')
        .mockResolvedValue(mockAccount({ publicKey: '' }));
      const result = await provider.getSweepStatus('acc-123');
      expect(result.canSweep).toBe(false);
    });
  });

  describe('validateSweepParameters — additional branches', () => {
    const base = {
      accountId: 'acc-123',
      ephemeralPublicKey: 'GAB...',
      ephemeralSecret: 'SABC123',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      amount: '100',
      asset: 'native',
    };

    it('throws when ephemeralPublicKey does not match account', async () => {
      jest
        .spyOn(repo, 'findOne')
        .mockResolvedValue(mockAccount({ publicKey: 'GDIFFERENT...' }));
      await expect(
        provider.validateSweepParameters({
          ...base,
          ephemeralPublicKey: 'GNOT_MATCHING',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when amount is zero', async () => {
      jest
        .spyOn(repo, 'findOne')
        .mockResolvedValue(mockAccount({ publicKey: base.ephemeralPublicKey }));
      await expect(
        provider.validateSweepParameters({ ...base, amount: '0' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when amount is NaN', async () => {
      jest
        .spyOn(repo, 'findOne')
        .mockResolvedValue(mockAccount({ publicKey: base.ephemeralPublicKey }));
      await expect(
        provider.validateSweepParameters({ ...base, amount: 'notanumber' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws for invalid asset format (not native and not CODE:ISSUER)', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          publicKey: base.ephemeralPublicKey,
          amount: '100',
          asset: 'BADFORMAT',
        }),
      );
      await expect(
        provider.validateSweepParameters({ ...base, asset: 'BADFORMAT' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('isValidAssetFormat — private method via validateSweepParameters', () => {
    const base = {
      accountId: 'acc-123',
      ephemeralPublicKey: 'GAB...',
      ephemeralSecret: 'SABC123',
      destinationAddress: 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337',
      amount: '100',
    };

    it('rejects asset with no colon (single-part)', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          publicKey: base.ephemeralPublicKey,
          amount: '100',
          asset: 'USDC',
        }),
      );
      await expect(
        provider.validateSweepParameters({ ...base, asset: 'USDC' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects asset code that is too long (>12 chars)', async () => {
      jest.spyOn(repo, 'findOne').mockResolvedValue(
        mockAccount({
          publicKey: base.ephemeralPublicKey,
          amount: '100',
          asset: 'TOOLONGCODE1X:GABC',
        }),
      );
      jest.spyOn(StrKey, 'isValidEd25519PublicKey').mockReturnValue(true);
      await expect(
        provider.validateSweepParameters({
          ...base,
          asset: 'TOOLONGCODE1X:GABC',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('assertDestinationExists', () => {
    const destination = 'GD5J6HLF5666X4AZLTFTXGKWDBSUXSWXP6P5F20O1337';

    it('should resolve when account exists on Horizon', async () => {
      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue({ id: destination }),
      } as unknown as Horizon.Server;

      await expect(
        provider.assertDestinationExists(destination, mockServer),
      ).resolves.toBeUndefined();
      expect(mockServer.loadAccount).toHaveBeenCalledWith(destination);
    });

    it('should throw BadRequestException with DESTINATION_NOT_FUNDED on NotFoundError', async () => {
      const notFoundErr = new NotFoundError('Not Found', { status: 404 });
      const mockServer = {
        loadAccount: jest.fn().mockRejectedValue(notFoundErr),
      } as unknown as Horizon.Server;

      let caughtError: unknown;
      try {
        await provider.assertDestinationExists(destination, mockServer);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(BadRequestException);
      const res = (caughtError as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
      expect(res.code).toBe('DESTINATION_NOT_FUNDED');
    });

    it('should throw BadRequestException with DESTINATION_NOT_FUNDED when error response status is 404', async () => {
      const err = { response: { status: 404 } };
      const mockServer = {
        loadAccount: jest.fn().mockRejectedValue(err),
      } as unknown as Horizon.Server;

      await expect(
        ValidationProvider.assertDestinationExists(destination, mockServer),
      ).rejects.toThrow(BadRequestException);
    });

    it('should rethrow network errors without producing DESTINATION_NOT_FUNDED', async () => {
      const networkError = new Error(
        'getaddrinfo ENOTFOUND horizon-testnet.stellar.org',
      );
      const mockServer = {
        loadAccount: jest.fn().mockRejectedValue(networkError),
      } as unknown as Horizon.Server;

      let caughtError: unknown;
      try {
        await provider.assertDestinationExists(destination, mockServer);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBe(networkError);
      expect(caughtError).not.toBeInstanceOf(BadRequestException);
    });
  });
});
