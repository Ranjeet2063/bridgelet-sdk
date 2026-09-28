import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { getToken } from '@willsoto/nestjs-prometheus';
import { AccountsService } from './accounts.service.js';
import { Account } from './entities/account.entity.js';
import { StellarService } from '../stellar/stellar.service.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { AccountStatus } from './enums/account-status.enum.js';
import { CreateAccountDto } from './dto/create-account.dto.js';
import { AccountLatencyMetricsProvider } from './providers/account-latency-metrics.provider.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';

const VALID_KEY = 'G' + 'A'.repeat(55);
const VALID_KEY2 = 'G' + 'B'.repeat(55);

const mockRepo = {
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockStellarService = {
  generateKeypair: jest.fn(),
  createEphemeralAccount: jest.fn(),
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-jwt-token'),
};

const mockConfigService = {
  getOrThrow: jest.fn((key: string) => {
    const cfg: Record<string, string> = {
      'stellar.encryptionKey': 'a'.repeat(64),
      'stellar.contracts.ephemeralAccount': 'CONTRACT123',
      'stellar.contracts.sweepController': 'CONTRACT456',
      'app.claimBaseUrl': 'https://claim.bridgelet.io',
    };
    const v = cfg[key];
    if (!v) throw new Error(`Config key not found: ${key}`);
    return v;
  }),
  get: jest.fn((key: string) => {
    if (key === 'app.claimTokenExpiry') return 2592000;
    return undefined;
  }),
};

const mockWebhooksService = {
  triggerEvent: jest.fn().mockResolvedValue(undefined),
};

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'uuid-1',
    publicKey: VALID_KEY,
    secretKeyEncrypted: 'enc',
    fundingSource: VALID_KEY2,
    amount: '100',
    asset: 'native',
    status: AccountStatus.PENDING_PAYMENT,
    claimTokenHash: 'hash',
    destinationAddress: null,
    expiresAt: new Date('2099-01-01'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    claimedAt: null,
    expiredAt: null,
    metadata: null,
    ...overrides,
  } as Account;
}

describe('AccountsService', () => {
  let service: AccountsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default keypair mock
    mockStellarService.generateKeypair.mockReturnValue({
      publicKey: () => VALID_KEY,
      secret: () => 'STEST',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: getRepositoryToken(Account), useValue: mockRepo },
        { provide: StellarService, useValue: mockStellarService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: WebhooksService, useValue: mockWebhooksService },
        AccountLatencyMetricsProvider,
        {
          provide: getToken('account_creation_total'),
          useValue: { inc: jest.fn() },
        },
        {
          provide: KmsKeyProvider,
          useValue: {
            getEncryptionKey: jest.fn().mockReturnValue('a'.repeat(64)),
          },
        },
      ],
    }).compile();

    service = module.get<AccountsService>(AccountsService);
  });

  // ─── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    const dto: CreateAccountDto = {
      fundingSource: VALID_KEY2,
      amount: '100',
      asset: 'native',
      expiresIn: 3600,
    };

    it('returns an AccountResponseDto with publicKey and txHash on success', async () => {
      const saved = makeAccount();
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockStellarService.createEphemeralAccount.mockResolvedValue('txhash-abc');

      const result = await service.create(dto);

      expect(result.publicKey).toBe(VALID_KEY);
      expect(result.txHash).toBe('txhash-abc');
      expect(result.status).toBe(AccountStatus.PENDING_PAYMENT);
    });

    it('passes expiresIn to createEphemeralAccount for ledger conversion', async () => {
      const saved = makeAccount();
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockStellarService.createEphemeralAccount.mockResolvedValue('txhash-abc');

      await service.create(dto);

      expect(mockStellarService.createEphemeralAccount).toHaveBeenCalledWith(
        expect.objectContaining({ expiresIn: 3600 }),
      );
    });

    it('triggers account.created webhook after success', async () => {
      const saved = makeAccount();
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockStellarService.createEphemeralAccount.mockResolvedValue('txhash-abc');

      await service.create(dto);

      expect(mockWebhooksService.triggerEvent).toHaveBeenCalledWith(
        'account.created',
        expect.objectContaining({ publicKey: VALID_KEY }),
      );
    });

    it('includes a claimUrl in the response', async () => {
      const saved = makeAccount();
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockStellarService.createEphemeralAccount.mockResolvedValue('txhash-abc');

      const result = await service.create(dto);

      expect(result.claimUrl).toContain('mock-jwt-token');
    });

    it('marks account as FAILED and re-throws when createEphemeralAccount fails', async () => {
      const saved = makeAccount({ status: AccountStatus.INITIALIZING });
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockStellarService.createEphemeralAccount.mockRejectedValue(
        new Error('Horizon error'),
      );

      await expect(service.create(dto)).rejects.toThrow('Horizon error');
      expect(saved.status).toBe(AccountStatus.FAILED);
      expect(mockRepo.save).toHaveBeenCalledTimes(2); // initial save + failed save
    });

    it('wraps non-Error exceptions thrown by createEphemeralAccount', async () => {
      const saved = makeAccount();
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockStellarService.createEphemeralAccount.mockRejectedValue(
        'raw string error',
      );

      await expect(service.create(dto)).rejects.toThrow('raw string error');
    });
  });

  // ─── findOne ─────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('returns an AccountResponseDto for an existing account', async () => {
      mockRepo.findOne.mockResolvedValue(makeAccount());

      const result = await service.findOne('uuid-1');

      expect(result.accountId).toBe('uuid-1');
      expect(result.publicKey).toBe(VALID_KEY);
    });

    it('throws NotFoundException when account does not exist', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns null claimUrl when claimTokenHash is absent', async () => {
      mockRepo.findOne.mockResolvedValue(makeAccount({ claimTokenHash: null }));

      const result = await service.findOne('uuid-1');

      expect(result.claimUrl).toBeNull();
    });

    it('returns a masked claimUrl when claimTokenHash is present', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeAccount({ claimTokenHash: 'abc' }),
      );

      const result = await service.findOne('uuid-1');

      expect(result.claimUrl).toContain('***');
    });
  });

  // ─── findAll ─────────────────────────────────────────────────────────────

  describe('findAll', () => {
    function makeQueryBuilder(accounts: Account[], total: number) {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([accounts, total]),
      };
      return qb;
    }

    it('returns accounts and total', async () => {
      const accounts = [makeAccount()];
      mockRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(accounts, 1),
      );
      const result = await service.findAll({ limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.accounts).toHaveLength(1);
    });
    it('excludes soft-deleted accounts by default', async () => {
      const qb = makeQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qb);
      await service.findAll({ limit: 50, offset: 0 });
      expect(qb.where).toHaveBeenCalledWith('account.deletedAt IS NULL');
    });
    it('applies status filter when provided', async () => {
      const qb = makeQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        status: AccountStatus.PENDING_PAYMENT,
        limit: 10,
        offset: 0,
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'account.status = :status',
        expect.objectContaining({ status: AccountStatus.PENDING_PAYMENT }),
      );
    });

    it('caps limit at 100', async () => {
      const qb = makeQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ limit: 999, offset: 0 });

      expect(qb.take).toHaveBeenCalledWith(100);
    });

    it('returns empty list when no accounts match', async () => {
      mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([], 0));

      const result = await service.findAll({ limit: 50, offset: 0 });

      expect(result.total).toBe(0);
      expect(result.accounts).toHaveLength(0);
    });
  });
});
