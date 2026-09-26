import * as nodeCrypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger, NotFoundException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';
import { Webhook } from './entities/webhook.entity.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';
import { SecretEncryptionUtil } from '../../common/crypto/secret-encryption.util.js';

/**
 * Webhook secret handling: encryption at rest, write-only exposure, and
 * delivery signing (issues #688 / #689 / #690).
 */

const PLAINTEXT_SECRET = 'a-sufficiently-long-secret';
const KEY = 'f'.repeat(64);
const URL = 'https://receiver.example.com/hook';

/** A KmsKeyProvider stub that performs real AES-GCM, so the assertions on the
 *  stored column are meaningful rather than a tautology. */
function makeKmsStub(overrides: Partial<KmsKeyProvider> = {}) {
  return {
    getEncryptionKey: () => KEY,
    encrypt: (plain: string) => SecretEncryptionUtil.encrypt(plain, KEY),
    decrypt: (ct: string) => SecretEncryptionUtil.decrypt(ct, KEY),
    ...overrides,
  } as unknown as KmsKeyProvider;
}

const makeWebhook = (overrides: Partial<Webhook> = {}): Webhook =>
  ({
    id: 'wh-1',
    url: URL,
    secret: SecretEncryptionUtil.encrypt(PLAINTEXT_SECRET, KEY),
    events: ['sweep.completed'],
    isActive: true,
    description: null,
    lastTriggeredAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as Webhook;

describe('WebhooksService — secret handling', () => {
  let service: WebhooksService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getMany: jest.Mock;
    getManyAndCount: jest.Mock;
  };

  const build = async (kms: KmsKeyProvider = makeKmsStub()) => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    repo = {
      create: jest.fn((d: Partial<Webhook>) => ({ id: 'wh-new', ...d })),
      save: jest.fn(async (w: Webhook) => w),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: getRepositoryToken(Webhook), useValue: repo },
        { provide: KmsKeyProvider, useValue: kms },
      ],
    }).compile();

    service = module.get(WebhooksService);
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  // ── #688: encryption at rest ────────────────────────────────────────────────

  describe('create()', () => {
    it('stores the secret encrypted, not as plaintext', async () => {
      await build();
      const dto = {
        url: URL,
        events: ['sweep.completed'],
        secret: PLAINTEXT_SECRET,
      };
      await service.create(dto);

      const persisted = repo.create.mock.calls[0]![0] as Partial<Webhook>;
      expect(persisted.secret).not.toBe(PLAINTEXT_SECRET);
      expect(persisted.secret).toMatch(/^aes256gcm:v1:/);
      expect(SecretEncryptionUtil.decrypt(persisted.secret!, KEY)).toBe(
        PLAINTEXT_SECRET,
      );
    });

    it('stores null when no secret is supplied', async () => {
      await build();
      await service.create({ url: URL, events: ['sweep.completed'] });
      expect(
        (repo.create.mock.calls[0]![0] as Partial<Webhook>).secret,
      ).toBeNull();
    });

    it('never returns the secret in the response DTO', async () => {
      await build();
      const res = await service.create({
        url: URL,
        events: ['sweep.completed'],
        secret: PLAINTEXT_SECRET,
      });
      expect(res).not.toHaveProperty('secret');
      expect(JSON.stringify(res)).not.toContain(PLAINTEXT_SECRET);
    });

    it('does not leak the plaintext secret through the response', async () => {
      await build();
      repo.create.mockImplementation((d: Partial<Webhook>) => ({
        id: 'wh-new',
        ...d,
        secret: PLAINTEXT_SECRET, // worst case: entity hands back plaintext
      }));
      const res = await service.create({
        url: URL,
        events: ['sweep.completed'],
        secret: PLAINTEXT_SECRET,
      });
      expect(JSON.stringify(res)).not.toContain(PLAINTEXT_SECRET);
    });
  });

  describe('update()', () => {
    it('re-encrypts a rotated secret rather than storing it raw', async () => {
      await build();
      const webhook = makeWebhook();
      repo.findOne.mockResolvedValue(webhook);
      const rotated = 'another-32-char-secret-value-here';

      await service.update('wh-1', { secret: rotated });

      expect(webhook.secret).not.toBe(rotated);
      expect(SecretEncryptionUtil.decrypt(webhook.secret!, KEY)).toBe(rotated);
    });

    it('leaves the stored secret untouched when not rotating', async () => {
      await build();
      const webhook = makeWebhook();
      repo.findOne.mockResolvedValue(webhook);
      const before = webhook.secret;

      await service.update('wh-1', { description: 'new description' });

      expect(webhook.secret).toBe(before);
    });

    it('never returns the secret in the response DTO', async () => {
      await build();
      repo.findOne.mockResolvedValue(makeWebhook());
      const res = await service.update('wh-1', { description: 'x' });
      expect(res).not.toHaveProperty('secret');
      expect(JSON.stringify(res)).not.toContain(PLAINTEXT_SECRET);
    });
  });

  // ── #689: signing uses the decrypted secret ─────────────────────────────────

  describe('triggerEvent()', () => {
    let fetchSpy: jest.SpyInstance;

    const captureDelivery = async () => {
      const webhook = makeWebhook();
      qb.getMany.mockResolvedValue([webhook]);
      await service.triggerEvent('sweep.completed', { accountId: 'a1' });
      const call = fetchSpy.mock.calls[0];
      if (!call) throw new Error('no delivery was attempted');
      const init = call[1] as RequestInit;
      return {
        body: init.body as string,
        headers: init.headers as Record<string, string>,
      };
    };

    beforeEach(async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, status: 200 } as Response);
      await build();
    });

    it('signs with the decrypted plaintext secret', async () => {
      const { body, headers } = await captureDelivery();
      const expected = nodeCrypto
        .createHmac('sha256', PLAINTEXT_SECRET)
        .update(body)
        .digest('hex');
      // If this passes, the ciphertext column was correctly decrypted before
      // signing — the end-to-end proof that encryption at rest is lossless.
      expect(headers['X-Bridgelet-Signature']).toBe(`sha256=${expected}`);
    });

    it('produces the same signature the docs tell integrators to compute', async () => {
      const { body, headers } = await captureDelivery();
      const header = headers['X-Bridgelet-Signature']!;
      expect(header.startsWith('sha256=')).toBe(true);
      const digest = header.slice('sha256='.length);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      // Documented verification snippet, reproduced.
      const recomputed = nodeCrypto
        .createHmac('sha256', PLAINTEXT_SECRET)
        .update(body)
        .digest('hex');
      expect(digest).toBe(recomputed);
    });

    it('signs with an empty key when no secret is configured', async () => {
      qb.getMany.mockResolvedValue([makeWebhook({ secret: null })]);
      await service.triggerEvent('sweep.completed', { accountId: 'a1' });
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;
      expect(headers['X-Bridgelet-Signature']).toBe(
        `sha256=${nodeCrypto.createHmac('sha256', '').update(body).digest('hex')}`,
      );
    });

    it('supports a legacy row whose secret was stored as plaintext', async () => {
      // Pre-encryption rows must keep working: the stored value is not a
      // recognised ciphertext format, so it is used as-is.
      qb.getMany.mockResolvedValue([makeWebhook({ secret: PLAINTEXT_SECRET })]);
      await service.triggerEvent('sweep.completed', { accountId: 'a1' });
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;
      expect(headers['X-Bridgelet-Signature']).toBe(
        `sha256=${nodeCrypto
          .createHmac('sha256', PLAINTEXT_SECRET)
          .update(body)
          .digest('hex')}`,
      );
    });

    it('skips delivery rather than signing with an undecryptable secret', async () => {
      // Wrong key: decrypt throws. Sending a bogus signature would either be
      // rejected by the receiver or, worse, be indistinguishable from forgery.
      const brokenKms = makeKmsStub({
        decrypt: () => {
          throw new Error('bad key');
        },
      } as Partial<KmsKeyProvider>);
      qb.getMany.mockResolvedValue([
        makeWebhook({ secret: SecretEncryptionUtil.encrypt('x', KEY) }),
      ]);
      await build(brokenKms);

      await service.triggerEvent('sweep.completed', { accountId: 'a1' });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('could not be decrypted'),
      );
    });

    it('still updates lastTriggeredAt bookkeeping on success', async () => {
      await captureDelivery();
      expect(repo.update).toHaveBeenCalledWith('wh-1', {
        lastTriggeredAt: expect.any(Date),
      });
    });
  });

  // ── #690: update() honours isActive and secret ─────────────────────────────

  describe('update() — isActive and secret (issue #690)', () => {
    beforeEach(async () => {
      await build();
    });

    it('pauses delivery via isActive: false', async () => {
      const webhook = makeWebhook();
      repo.findOne.mockResolvedValue(webhook);
      const res = await service.update('wh-1', { isActive: false });
      expect(webhook.isActive).toBe(false);
      expect(res.isActive).toBe(false);
    });

    it('resumes delivery via isActive: true', async () => {
      const webhook = makeWebhook({ isActive: false });
      repo.findOne.mockResolvedValue(webhook);
      const res = await service.update('wh-1', { isActive: true });
      expect(webhook.isActive).toBe(true);
      expect(res.isActive).toBe(true);
    });

    it('does not change isActive when the field is omitted', async () => {
      const webhook = makeWebhook({ isActive: false });
      repo.findOne.mockResolvedValue(webhook);
      const res = await service.update('wh-1', { description: 'x' });
      expect(webhook.isActive).toBe(false);
      expect(res.isActive).toBe(false);
    });

    it('rotates the secret without disturbing other fields', async () => {
      const webhook = makeWebhook();
      repo.findOne.mockResolvedValue(webhook);
      const rotated = 'yet-another-secret-value-32ch';

      const res = await service.update('wh-1', {
        secret: rotated,
        description: 'rotated',
      });

      expect(SecretEncryptionUtil.decrypt(webhook.secret!, KEY)).toBe(rotated);
      expect(res.description).toBe('rotated');
      expect(res.url).toBe(URL);
    });

    it('still 404s for an unknown webhook', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.update('missing', { isActive: false }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
