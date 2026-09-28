import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerGuard } from '@nestjs/throttler';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { Webhook } from './entities/webhook.entity.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';

/**
 * Integration coverage for the full CRUD path against a repository that
 * actually implements the behaviour TypeORM provides (issue #692).
 *
 * The previous version of this file backed the service with a fake whose
 * query builder ignored `.skip()` and `.take()` entirely, so it passed
 * regardless of whether the service paginated. It also had no `update()` and
 * no `findOne()` filtering, so nothing verified that:
 *
 *   - `limit`/`offset` actually select the right window,
 *   - `total` reflects the unpaginated active count,
 *   - `isActive` toggling takes effect on the stored row,
 *   - a secret rotation persists,
 *   - an unknown id 404s on both update and delete.
 *
 * FakeRepository below implements ordering, skip/take, the `getManyAndCount`
 * split, and `update()`.
 */

const URL_A = 'https://api.example.com/hooks-a';
const URL_B = 'https://api.example.com/hooks-b';
const SECRET = 'an-adequately-long-secret';

class FakeRepository {
  private rows = new Map<string, Webhook>();
  private nextId = 1;

  /** Mirrors the ORDER BY createdAt, id used by WebhooksService.findAll(). */
  private sorted(): Webhook[] {
    return [...this.rows.values()].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  }

  create(data: Partial<Webhook>): Webhook {
    return {
      id: `wh-${this.nextId++}`,
      isActive: true,
      events: [],
      description: null,
      lastTriggeredAt: null,
      ...data,
      createdAt: data.createdAt ?? new Date(1700000000000 + this.nextId * 1000),
      updatedAt: new Date(),
    } as Webhook;
  }

  async save(webhook: Webhook): Promise<Webhook> {
    this.rows.set(webhook.id, webhook);
    return webhook;
  }

  async findOne({ where }: { where: { id: string } }): Promise<Webhook | null> {
    return this.rows.get(where.id) ?? null;
  }

  async update(
    id: string,
    patch: Partial<Webhook>,
  ): Promise<{ affected: number }> {
    const existing = this.rows.get(id);
    if (!existing) return { affected: 0 };
    this.rows.set(id, { ...existing, ...patch });
    return { affected: 1 };
  }

  createQueryBuilder() {
    const state = {
      where: '',
      params: {} as Record<string, unknown>,
      skips: 0,
      takes: 0,
    };

    const run = () => {
      let matched = this.sorted();
      if (state.where.includes('isActive')) {
        matched = matched.filter(
          (w) => w.isActive === state.params['isActive'],
        );
      }
      // TypeORM's getManyAndCount() counts before skip/take are applied.
      const total = matched.length;
      const paged = matched.slice(state.skips, state.skips + state.takes);
      return { paged, total };
    };

    const builder = {
      where(clause: string, params?: Record<string, unknown>) {
        state.where = clause;
        state.params = params ?? {};
        return builder;
      },
      andWhere() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      addOrderBy() {
        return builder;
      },
      skip(n: number) {
        state.skips = n;
        return builder;
      },
      take(n: number) {
        state.takes = n;
        return builder;
      },
      async getMany() {
        return run().paged;
      },
      async getManyAndCount() {
        const { paged, total } = run();
        return [paged, total];
      },
    };
    return builder;
  }

  // ── test helpers ───────────────────────────────────────────────────────────

  size(): number {
    return this.rows.size;
  }
  get(id: string): Webhook | undefined {
    return this.rows.get(id);
  }
  /** Seeds `n` active subscriptions with distinct, ordered createdAt values. */
  seed(n: number, isActive = true): Webhook[] {
    const created: Webhook[] = [];
    for (let i = 0; i < n; i++) {
      const webhook = this.create({
        isActive,
        url: URL_A,
        events: ['a'],
        createdAt: new Date(1700000000000 + i * 1000),
      });
      this.rows.set(webhook.id, webhook);
      created.push(webhook);
    }
    return created;
  }
}

describe('WebhooksController integration (real service + repository)', () => {
  let controller: WebhooksController;
  let repo: FakeRepository;

  beforeEach(async () => {
    repo = new FakeRepository();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        { provide: getRepositoryToken(Webhook), useValue: repo },
        {
          // WebhooksService encrypts secrets at rest (issue #688); an identity
          // stub keeps this spec focused on controller/service/repository
          // wiring. webhooks.secret.spec.ts covers the real cipher.
          provide: KmsKeyProvider,
          useValue: {
            getEncryptionKey: () => 'f'.repeat(64),
            encrypt: (plain: string) => plain,
            decrypt: (ct: string) => ct,
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(WebhooksController);
  });

  const ids = async (limit?: string, offset?: string) =>
    (await controller.findAll(limit, offset)).webhooks.map((w) => w.id);

  describe('create -> list -> update -> delete', () => {
    it('walks the full lifecycle', async () => {
      const created = await controller.create({
        url: URL_A,
        events: ['account.created'],
      });
      expect(await ids()).toContain(created.id);

      const updated = await controller.update(created.id, {
        description: 'x',
      });
      expect(updated.description).toBe('x');
      expect(repo.get(created.id)?.description).toBe('x');

      await controller.remove(created.id);
      expect(await ids()).not.toContain(created.id);
    });

    it('persists a created row with the supplied fields', async () => {
      const created = await controller.create({
        url: URL_B,
        events: ['sweep.completed', 'sweep.failed'],
        secret: SECRET,
        description: 'lifecycle',
      });
      const stored = repo.get(created.id)!;
      expect(stored.url).toBe(URL_B);
      expect(stored.events).toEqual(['sweep.completed', 'sweep.failed']);
      expect(stored.isActive).toBe(true);
      expect(stored.description).toBe('lifecycle');
    });

    it('defaults isActive to true and stores a null secret when omitted', async () => {
      const created = await controller.create({
        url: URL_A,
        events: ['account.created'],
      });
      expect(repo.get(created.id)!.isActive).toBe(true);
      expect(repo.get(created.id)!.secret).toBeNull();
    });
  });

  describe('pagination (issue #694)', () => {
    it('applies limit and offset to the returned window', async () => {
      const seeded = repo.seed(5);
      expect(seeded).toHaveLength(5);

      const firstPage = await controller.findAll('2', '0');
      expect(firstPage.webhooks.map((w) => w.id)).toEqual([
        seeded[0].id,
        seeded[1].id,
      ]);
      expect(firstPage.total).toBe(5);
    });

    it('returns non-overlapping, gapless pages', async () => {
      const seeded = repo.seed(5);
      const page1 = (await controller.findAll('2', '0')).webhooks.map(
        (w) => w.id,
      );
      const page2 = (await controller.findAll('2', '2')).webhooks.map(
        (w) => w.id,
      );
      const page3 = (await controller.findAll('2', '4')).webhooks.map(
        (w) => w.id,
      );

      expect([...page1, ...page2, ...page3]).toEqual(seeded.map((w) => w.id));
      // The core guarantee: nothing duplicated, nothing skipped.
      expect(new Set([...page1, ...page2, ...page3]).size).toBe(5);
    });

    it('returns an empty page past the end but keeps the real total', async () => {
      repo.seed(3);
      const res = await controller.findAll('10', '100');
      expect(res.webhooks).toHaveLength(0);
      expect(res.total).toBe(3);
    });

    it('is deterministic across repeated identical requests', async () => {
      repo.seed(6);
      const a = await ids('3', '3');
      const b = await ids('3', '3');
      expect(a).toEqual(b);
      expect(a).toHaveLength(3);
    });

    it('clamps an over-large limit to the maximum page size', async () => {
      repo.seed(3);
      const res = await controller.findAll('100000', '0');
      expect(res.webhooks.length).toBeLessThanOrEqual(100);
      expect(res.webhooks).toHaveLength(3);
    });

    it('defaults to a full first page when limit/offset are omitted', async () => {
      repo.seed(3);
      const res = await controller.findAll();
      expect(res.webhooks).toHaveLength(3);
      expect(res.total).toBe(3);
    });

    it.each([
      ['non-numeric limit', 'abc', '0'],
      ['decimal limit', '1.5', '0'],
      ['empty limit', '', '0'],
      ['non-numeric offset', '10', 'xyz'],
      ['decimal offset', '10', '2.5'],
    ])(
      'rejects a %s with 400 instead of failing in the query',
      async (_label, limit, offset) => {
        await expect(controller.findAll(limit, offset)).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it('clamps a negative offset to zero rather than erroring', async () => {
      repo.seed(2);
      const res = await controller.findAll('10', '-5');
      expect(res.webhooks).toHaveLength(2);
    });

    it('excludes inactive subscriptions from the listing and the total', async () => {
      const a = await controller.create({ url: URL_A, events: ['x'] });
      const b = await controller.create({ url: URL_B, events: ['x'] });
      await controller.update(b.id, { isActive: false });

      const res = await controller.findAll();
      expect(res.webhooks.map((w) => w.id)).toEqual([a.id]);
      expect(res.total).toBe(1);
    });
  });

  describe('update (issue #690)', () => {
    let id: string;
    beforeEach(async () => {
      id = (
        await controller.create({ url: URL_A, events: ['account.created'] })
      ).id;
    });

    it('pauses and resumes delivery via isActive', async () => {
      const paused = await controller.update(id, { isActive: false });
      expect(paused.isActive).toBe(false);
      expect(repo.get(id)!.isActive).toBe(false);

      const resumed = await controller.update(id, { isActive: true });
      expect(resumed.isActive).toBe(true);
      expect(repo.get(id)!.isActive).toBe(true);
    });

    it('rotates the secret and persists it', async () => {
      const rotated = 'a-different-secret-value-x';
      await controller.update(id, { secret: rotated });
      expect(repo.get(id)!.secret).toBe(rotated);
    });

    it('leaves omitted fields untouched', async () => {
      await controller.update(id, { secret: SECRET });
      const after = await controller.update(id, { description: 'only desc' });
      expect(after.description).toBe('only desc');
      expect(after.url).toBe(URL_A);
      expect(repo.get(id)!.secret).toBe(SECRET);
    });

    it('never returns the secret in any response', async () => {
      const created = await controller.create({
        url: URL_A,
        events: ['x'],
        secret: SECRET,
      });
      const updated = await controller.update(id, { description: 'd' });
      const listed = await controller.findAll();
      for (const dto of [created, updated, ...listed.webhooks]) {
        expect(dto).not.toHaveProperty('secret');
        expect(JSON.stringify(dto)).not.toContain(SECRET);
      }
    });

    it('404s for an unknown id', async () => {
      await expect(
        controller.update('does-not-exist', { description: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete (issue #691)', () => {
    it('is a soft delete: the row survives with isActive false', async () => {
      const id = (await controller.create({ url: URL_A, events: ['x'] })).id;

      await controller.remove(id);

      // Row still present — nothing was cascaded away.
      expect(repo.get(id)).toBeDefined();
      expect(repo.get(id)!.isActive).toBe(false);
      expect(repo.size()).toBe(1);
    });

    it('removes the subscription from the active listing', async () => {
      const id = (await controller.create({ url: URL_A, events: ['x'] })).id;
      await controller.remove(id);
      expect(await ids()).not.toContain(id);
      expect((await controller.findAll()).total).toBe(0);
    });

    it('is idempotent in effect — deleting twice leaves the same state', async () => {
      const id = (await controller.create({ url: URL_A, events: ['x'] })).id;
      await controller.remove(id);
      await controller.remove(id);
      expect(repo.get(id)!.isActive).toBe(false);
    });

    it('can be undone by re-activating via update', async () => {
      const id = (await controller.create({ url: URL_A, events: ['x'] })).id;
      await controller.remove(id);
      await controller.update(id, { isActive: true });
      expect(await ids()).toContain(id);
    });

    it('does not affect other subscriptions', async () => {
      const keep = (await controller.create({ url: URL_A, events: ['x'] })).id;
      const drop = (await controller.create({ url: URL_B, events: ['x'] })).id;
      await controller.remove(drop);
      expect(await ids()).toEqual([keep]);
    });

    it('404s for an unknown id', async () => {
      await expect(controller.remove('does-not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
