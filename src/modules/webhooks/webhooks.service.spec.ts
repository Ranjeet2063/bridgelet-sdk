import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, Logger } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';
import { Webhook } from './entities/webhook.entity.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'test-secret-key';
const WEBHOOK_URL = 'https://example.com/hook';

const makeWebhook = (overrides: Partial<Webhook> = {}): Webhook => ({
  id: 'webhook-uuid-1',
  url: WEBHOOK_URL,
  secret: WEBHOOK_SECRET,
  events: ['sweep.completed', 'account.created'],
  isActive: true,
  description: null,
  lastTriggeredAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

function expectedSignature(body: string, secret: string | null): string {
  return crypto
    .createHmac('sha256', secret ?? '')
    .update(body)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhooksService', () => {
  let service: WebhooksService;
  let loggerErrorSpy: jest.SpyInstance;

  const mockQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };

  const mockWebhookRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue(mockQb),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        {
          provide: getRepositoryToken(Webhook),
          useValue: mockWebhookRepository,
        },
        {
          // WebhooksService encrypts secrets at rest (issue #688). This stub
          // is an identity function so the pre-existing assertions below
          // (which compare signatures against the plaintext secret) keep
          // holding; webhooks.secret.spec.ts covers the real AES-GCM path.
          provide: KmsKeyProvider,
          useValue: {
            getEncryptionKey: () => 'f'.repeat(64),
            encrypt: (plain: string) => plain,
            decrypt: (ct: string) => ct,
          },
        },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);

    // Spy on the logger so we can assert on error/warn calls
    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe('create()', () => {
    it('persists webhook and returns response DTO without the secret', async () => {
      const webhook = makeWebhook();
      mockWebhookRepository.create.mockReturnValue(webhook);
      mockWebhookRepository.save.mockResolvedValue(webhook);

      const result = await service.create({
        url: WEBHOOK_URL,
        events: ['sweep.completed'],
        secret: WEBHOOK_SECRET,
      });

      expect(mockWebhookRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ url: WEBHOOK_URL, isActive: true }),
      );
      expect(result).toMatchObject({
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        isActive: true,
      });
      // Secret must never appear in the response DTO
      expect(result).not.toHaveProperty('secret');
    });
  });

  // -------------------------------------------------------------------------
  // findAll
  // -------------------------------------------------------------------------

  describe('findAll()', () => {
    it('returns only active webhooks as response DTOs, paginated', async () => {
      const webhook = makeWebhook();
      mockQb.getManyAndCount.mockResolvedValue([[webhook], 1]);

      const result = await service.findAll(50, 0);

      expect(mockQb.where).toHaveBeenCalledWith(
        'webhook.isActive = :isActive',
        { isActive: true },
      );
      expect(mockQb.skip).toHaveBeenCalledWith(0);
      expect(mockQb.take).toHaveBeenCalledWith(50);
      expect(result.total).toBe(1);
      expect(result.webhooks[0]).toMatchObject({
        id: webhook.id,
        url: webhook.url,
      });
    });

    it('caps limit at 100', async () => {
      await service.findAll(500, 0);
      expect(mockQb.take).toHaveBeenCalledWith(100);
    });

    it('orders deterministically so pagination is stable (issue #694)', async () => {
      // Without an explicit ORDER BY, PostgreSQL may return matching rows in
      // any order, so a row can appear on two consecutive pages or on neither.
      await service.findAll(50, 0);
      expect(mockQb.orderBy).toHaveBeenCalledWith('webhook.createdAt', 'ASC');
      // id breaks ties for rows sharing a createdAt.
      expect(mockQb.addOrderBy).toHaveBeenCalledWith('webhook.id', 'ASC');
    });

    it('rejects a non-integer limit with a 400 (issue #694)', async () => {
      // Without normalisation this reached TypeORM as NaN and surfaced as a
      // 500 from the query builder.
      await expect(service.findAll('abc', 0)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('rejects a non-integer offset with a 400 (issue #694)', async () => {
      await expect(service.findAll(50, 'nope')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('clamps a negative offset to 0 rather than erroring', async () => {
      await service.findAll(50, -10);
      expect(mockQb.skip).toHaveBeenCalledWith(0);
    });
  });

  describe('update()', () => {
    it('updates an existing webhook', async () => {
      const webhook = makeWebhook();

      mockWebhookRepository.findOne.mockResolvedValue(webhook);

      mockWebhookRepository.save.mockResolvedValue({
        ...webhook,
        url: 'https://updated.example.com/hook',
        events: ['account.created'],
        description: 'Updated webhook',
      });

      const result = await service.update(webhook.id, {
        url: 'https://updated.example.com/hook',
        events: ['account.created'],
        description: 'Updated webhook',
      });

      expect(mockWebhookRepository.findOne).toHaveBeenCalledWith({
        where: { id: webhook.id },
      });

      expect(mockWebhookRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://updated.example.com/hook',
          events: ['account.created'],
          description: 'Updated webhook',
        }),
      );

      expect(result).toMatchObject({
        id: webhook.id,
        url: 'https://updated.example.com/hook',
        events: ['account.created'],
        description: 'Updated webhook',
      });
    });

    it('throws NotFoundException when the webhook does not exist', async () => {
      mockWebhookRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update('missing-id', {
          url: 'https://example.com',
        }),
      ).rejects.toThrow('Webhook with ID missing-id not found');
    });
  });

  describe('remove()', () => {
    it('deactivates an existing webhook', async () => {
      const webhook = makeWebhook();

      mockWebhookRepository.findOne.mockResolvedValue(webhook);
      mockWebhookRepository.save.mockResolvedValue({
        ...webhook,
        isActive: false,
      });

      await service.remove(webhook.id);

      expect(mockWebhookRepository.findOne).toHaveBeenCalledWith({
        where: { id: webhook.id },
      });

      expect(mockWebhookRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: webhook.id,
          isActive: false,
        }),
      );

      expect(webhook.isActive).toBe(false);
    });

    it('throws NotFoundException when the webhook does not exist', async () => {
      mockWebhookRepository.findOne.mockResolvedValue(null);

      await expect(service.remove('missing-id')).rejects.toThrow(
        'Webhook with ID missing-id not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // triggerEvent — successful delivery
  // -------------------------------------------------------------------------

  describe('triggerEvent() — successful delivery', () => {
    it('delivers event payload to registered webhook via HTTP POST', async () => {
      const webhook = makeWebhook({ events: ['sweep.completed'] });
      mockQb.getMany.mockResolvedValue([webhook]);

      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, status: 200 } as Response);

      await service.triggerEvent('sweep.completed', {
        accountId: 'acc-123',
        amount: '100',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        WEBHOOK_URL,
        expect.objectContaining({ method: 'POST' }),
      );
      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    it('includes Content-Type and X-Bridgelet-Event headers', async () => {
      const webhook = makeWebhook({ events: ['account.created'] });
      mockQb.getMany.mockResolvedValue([webhook]);

      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, status: 200 } as Response);

      await service.triggerEvent('account.created', { accountId: 'acc-456' });

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string> },
      ];
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.headers['X-Bridgelet-Event']).toBe('account.created');
    });

    it('does not throw when no webhooks are subscribed to the event', async () => {
      mockQb.getMany.mockResolvedValue([]);

      await expect(
        service.triggerEvent('sweep.completed', { accountId: 'acc-789' }),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // triggerEvent — HMAC signature
  // -------------------------------------------------------------------------

  describe('triggerEvent() — HMAC signature', () => {
    it('includes X-Bridgelet-Signature header with correct sha256 HMAC', async () => {
      const webhook = makeWebhook({ secret: WEBHOOK_SECRET });
      mockQb.getMany.mockResolvedValue([webhook]);

      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, status: 200 } as Response);

      const payload = { accountId: 'acc-sig-test', amount: '50' };
      await service.triggerEvent('sweep.completed', payload);

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string>; body: string },
      ];

      const sentBody = init.body;
      const expected = `sha256=${expectedSignature(sentBody, WEBHOOK_SECRET)}`;
      expect(init.headers['X-Bridgelet-Signature']).toBe(expected);
    });

    it('includes X-Bridgelet-Signature even when webhook has no secret (uses empty key)', async () => {
      const webhook = makeWebhook({ secret: null });
      mockQb.getMany.mockResolvedValue([webhook]);

      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, status: 200 } as Response);

      await service.triggerEvent('account.expired', { accountId: 'acc-nosec' });

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string>; body: string },
      ];

      expect(init.headers['X-Bridgelet-Signature']).toMatch(
        /^sha256=[a-f0-9]{64}$/,
      );
      const expected = `sha256=${expectedSignature(init.body, null)}`;
      expect(init.headers['X-Bridgelet-Signature']).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // triggerEvent — failed delivery
  // -------------------------------------------------------------------------

  describe('triggerEvent() — failed delivery', () => {
    it('does not throw when the destination returns a non-2xx status', async () => {
      const webhook = makeWebhook();
      mockQb.getMany.mockResolvedValue([webhook]);

      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: false, status: 500 } as Response);

      await expect(
        service.triggerEvent('sweep.completed', { accountId: 'acc-fail' }),
      ).resolves.not.toThrow();
    });

    it('logs event type, accountId, url, and HTTP status on non-2xx response', async () => {
      const webhook = makeWebhook();
      mockQb.getMany.mockResolvedValue([webhook]);

      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: false, status: 503 } as Response);

      await service.triggerEvent('sweep.failed', { accountId: 'acc-log-test' });

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('sweep.failed'),
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('acc-log-test'),
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(WEBHOOK_URL),
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('503'),
      );
    });

    it('does not throw when fetch itself rejects (network error)', async () => {
      const webhook = makeWebhook();
      mockQb.getMany.mockResolvedValue([webhook]);

      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.triggerEvent('sweep.completed', { accountId: 'acc-net-err' }),
      ).resolves.not.toThrow();
    });

    it('logs event type and accountId on network error', async () => {
      const webhook = makeWebhook();
      mockQb.getMany.mockResolvedValue([webhook]);

      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      await service.triggerEvent('account.created', {
        accountId: 'acc-net-log',
      });

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('account.created'),
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('acc-net-log'),
      );
    });

    it('isolates per-webhook failures and still delivers to other webhooks', async () => {
      const hook1 = makeWebhook({ id: 'h1', url: 'https://hook1.example.com' });
      const hook2 = makeWebhook({ id: 'h2', url: 'https://hook2.example.com' });
      mockQb.getMany.mockResolvedValue([hook1, hook2]);

      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error('hook1 down'))
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await expect(
        service.triggerEvent('sweep.completed', { accountId: 'acc-iso' }),
      ).resolves.not.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not throw when the DB query for webhooks fails', async () => {
      mockQb.getMany.mockRejectedValue(new Error('DB gone'));

      await expect(
        service.triggerEvent('sweep.completed', { accountId: 'acc-db-err' }),
      ).resolves.not.toThrow();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('sweep.completed'),
      );
    });
  });
});
