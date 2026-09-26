import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { ClaimsController } from './claims.controller.js';
import { ClaimsService } from './claims.service.js';

/**
 * Claim tokens are bearer secrets guarding on-chain fund movement, so
 * /claims/redeem carries its own tighter @Throttle limit (see
 * claims.controller.ts) rather than relying solely on the app-wide default
 * in app.module.ts. This exercises the REAL ThrottlerGuard (not overridden).
 *
 * The app-wide limit is deliberately set absurdly high (GLOBAL_LIMIT). If it
 * were left at 5 — the same value as the redeem override — this suite could
 * not tell whether the 429 came from the route-specific @Throttle or from the
 * global default, and it would keep passing even if someone deleted the
 * @Throttle decorator entirely. That is the regression this file exists to
 * catch.
 */

/** Route-specific limit declared by @Throttle on POST /claims/redeem. */
const REDEEM_LIMIT = 5;
/** Route-specific limit declared by @Throttle on POST /claims/verify. */
const VERIFY_LIMIT = 10;
/** App-wide default, set high so it can never be the limiting factor. */
const GLOBAL_LIMIT = 10_000;

describe('claim route rate limiting', () => {
  let app: INestApplication;
  let redeemClaim: jest.Mock;
  let verifyClaimToken: jest.Mock;

  beforeEach(async () => {
    redeemClaim = jest
      .fn()
      .mockRejectedValue(new Error('invalid token'));
    verifyClaimToken = jest
      .fn()
      .mockRejectedValue(new Error('invalid token'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ ttl: 60000, limit: GLOBAL_LIMIT }]),
      ],
      controllers: [ClaimsController],
      providers: [
        {
          provide: ClaimsService,
          useValue: { redeemClaim, verifyClaimToken },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Fires `n` attempts and returns every status code produced. */
  const attempt = async (path: string, n: number): Promise<number[]> => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await request(app.getHttpServer()).post(path).send({
        claimToken: 'bad-token',
        destinationAddress: 'GINVALID',
      });
      statuses.push(res.status);
    }
    return statuses;
  };

  describe('POST /claims/redeem', () => {
    it('allows exactly REDEEM_LIMIT attempts before throttling', async () => {
      const statuses = await attempt('/claims/redeem', REDEEM_LIMIT + 3);
      expect(statuses.slice(0, REDEEM_LIMIT).every((s) => s !== 429)).toBe(
        true,
      );
      expect(statuses.slice(REDEEM_LIMIT)).toEqual([429, 429, 429]);
    });

    it('throttles repeated INVALID redemption attempts', async () => {
      // The brute-force case: every attempt carries a bad token, and the
      // failures must still consume the budget. If rejections were free, an
      // attacker could probe unlimited tokens.
      await attempt('/claims/redeem', REDEEM_LIMIT + 1);
      expect(redeemClaim).toHaveBeenCalledTimes(REDEEM_LIMIT);
    });

    it('is throttled by the route limit, not the global default', async () => {
      const statuses = await attempt('/claims/redeem', REDEEM_LIMIT + 1);
      expect(statuses[REDEEM_LIMIT]).toBe(429);
      // Sanity: the global limit is far higher, so it cannot explain the 429.
      expect(GLOBAL_LIMIT).toBeGreaterThan(REDEEM_LIMIT * 100);
    });

    it('keeps throttling on every subsequent attempt', async () => {
      const statuses = await attempt('/claims/redeem', REDEEM_LIMIT + 6);
      expect(statuses.filter((s) => s === 429)).toHaveLength(6);
    });
  });

  describe('POST /claims/verify', () => {
    it('allows exactly VERIFY_LIMIT attempts before throttling', async () => {
      const statuses = await attempt('/claims/verify', VERIFY_LIMIT + 2);
      expect(statuses.slice(0, VERIFY_LIMIT).every((s) => s !== 429)).toBe(
        true,
      );
      expect(statuses.slice(VERIFY_LIMIT)).toEqual([429, 429]);
    });

    it('throttles repeated invalid token probes', async () => {
      await attempt('/claims/verify', VERIFY_LIMIT + 1);
      expect(verifyClaimToken).toHaveBeenCalledTimes(VERIFY_LIMIT);
    });
  });

  describe('limits are per-route, not shared', () => {
    it('exhausting verify does not throttle redeem', async () => {
      await attempt('/claims/verify', VERIFY_LIMIT + 2);
      const redeemStatuses = await attempt('/claims/redeem', REDEEM_LIMIT);
      expect(redeemStatuses.some((s) => s === 429)).toBe(false);
    });

    it('exhausting redeem does not throttle verify', async () => {
      await attempt('/claims/redeem', REDEEM_LIMIT + 2);
      const verifyStatuses = await attempt('/claims/verify', VERIFY_LIMIT);
      expect(verifyStatuses.some((s) => s === 429)).toBe(false);
    });
  });

  describe('GET /claims/:id', () => {
    it('is not throttled by the claim-route budgets', async () => {
      // The read path has no route-level override, so it is governed by the
      // global limit only. Burn the redeem budget, then confirm GET is fine.
      await attempt('/claims/redeem', REDEEM_LIMIT + 2);
      for (let i = 0; i < REDEEM_LIMIT + 5; i++) {
        const res = await request(app.getHttpServer()).get(
          '/claims/00000000-0000-4000-8000-000000000000',
        );
        expect(res.status).not.toBe(429);
      }
    });
  });
});
