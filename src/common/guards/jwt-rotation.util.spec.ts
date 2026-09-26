import jwt from 'jsonwebtoken';
import { TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';
import {
  verifyClaimTokenWithRotation,
  previousJwtSecret,
  verifyWithRotation,
} from './jwt-rotation.util.js';

const CURRENT = 'current-secret-value';
const PREVIOUS = 'previous-secret-value';

const sign = (secret: string, expiresIn: string | number = '1h') =>
  jwt.sign({ publicKey: 'GABC', type: 'claim' }, secret, { expiresIn });

describe('JWT secret rotation grace window (issue #683)', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe('previousJwtSecret', () => {
    it('is undefined when unset', () => {
      delete process.env.JWT_SECRET_PREVIOUS;
      expect(previousJwtSecret()).toBeUndefined();
    });

    it('is undefined when set to an empty string', () => {
      // An empty env var must not be treated as a real secret, or every
      // verification would silently do a second attempt with "".
      process.env.JWT_SECRET_PREVIOUS = '';
      expect(previousJwtSecret()).toBeUndefined();
    });

    it('returns the value when set', () => {
      process.env.JWT_SECRET_PREVIOUS = PREVIOUS;
      expect(previousJwtSecret()).toBe(PREVIOUS);
    });
  });

  describe('verifyClaimTokenWithRotation', () => {
    it('verifies a token signed with the current secret', () => {
      const payload = verifyClaimTokenWithRotation(sign(CURRENT), CURRENT);
      expect(payload).toEqual(
        expect.objectContaining({ type: 'claim', publicKey: 'GABC' }),
      );
    });

    it('verifies a token signed with the PREVIOUS secret during the window', () => {
      // The whole point: a claim token minted before the rotation must still
      // be redeemable, or the funds behind it are stranded.
      const payload = verifyClaimTokenWithRotation(
        sign(PREVIOUS),
        CURRENT,
        PREVIOUS,
      );
      expect(payload).toEqual(expect.objectContaining({ type: 'claim' }));
    });

    it('defaults the previous secret to JWT_SECRET_PREVIOUS', () => {
      process.env.JWT_SECRET_PREVIOUS = PREVIOUS;
      expect(previousJwtSecret()).toBe(PREVIOUS);
      expect(
        verifyClaimTokenWithRotation(sign(PREVIOUS), CURRENT),
      ).toEqual(expect.objectContaining({ type: 'claim' }));
    });

    it('rejects a token signed with an unrelated secret', () => {
      expect(() =>
        verifyClaimTokenWithRotation(
          sign('some-other-secret'),
          CURRENT,
          PREVIOUS,
        ),
      ).toThrow(JsonWebTokenError);
    });

    it('rejects a previous-secret token once the window is closed', () => {
      // Closing the window must actually close it.
      expect(() =>
        verifyClaimTokenWithRotation(sign(PREVIOUS), CURRENT, undefined),
      ).toThrow(JsonWebTokenError);
    });

    it('does not retry when the previous secret equals the current one', () => {
      expect(() =>
        verifyClaimTokenWithRotation(sign('nope'), CURRENT, CURRENT),
      ).toThrow(JsonWebTokenError);
    });

    it('preserves TokenExpiredError so callers can map it to a 401', () => {
      // Expiry is a distinct, expected outcome and must not be reported as a
      // signature failure just because a rotation window is open.
      const expired = jwt.sign(
        { publicKey: 'GABC', type: 'claim' },
        PREVIOUS,
        { expiresIn: -60 },
      );
      let thrown: unknown;
      try {
        verifyClaimTokenWithRotation(expired, CURRENT, PREVIOUS);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(TokenExpiredError);
    });

    it('surfaces the current-secret error when neither secret verifies', () => {
      // Callers distinguish expiry from a bad signature, so the rethrown
      // error must be the one from the *current* secret attempt.
      const badSignature = jwt.sign(
        { publicKey: 'GABC', type: 'claim' },
        'unrelated',
        { expiresIn: -60 },
      );
      let thrown: unknown;
      try {
        verifyClaimTokenWithRotation(badSignature, CURRENT, PREVIOUS);
      } catch (err) {
        thrown = err;
      }
      // Expired under both, so the first attempt's error is what surfaces.
      expect(thrown).toBeInstanceOf(TokenExpiredError);
    });

    it('rejects a structurally invalid token', () => {
      expect(() =>
        verifyClaimTokenWithRotation('not-a-jwt', CURRENT, PREVIOUS),
      ).toThrow(JsonWebTokenError);
    });

    it('does not accept a previous-secret token that has also expired', () => {
      const expired = jwt.sign(
        { publicKey: 'GABC', type: 'claim' },
        PREVIOUS,
        { expiresIn: -60 },
      );
      expect(() =>
        verifyClaimTokenWithRotation(expired, CURRENT, PREVIOUS),
      ).toThrow(TokenExpiredError);
    });
  });

  describe('verifyWithRotation (JwtService form)', () => {
    const makeService = () => {
      const verifyAsync = jest
        .fn()
        .mockResolvedValue({ type: 'api' });
      return { verifyAsync } as unknown as Parameters<
        typeof verifyWithRotation
      >[0] & { verifyAsync: jest.Mock };
    };

    it('verifies against the service default secret first', async () => {
      const service = makeService();
      await verifyWithRotation(service, 'tok', PREVIOUS);
      expect(service.verifyAsync).toHaveBeenCalledWith('tok');
    });

    it('falls back to the previous secret', async () => {
      const service = makeService();
      service.verifyAsync
        .mockRejectedValueOnce(new JsonWebTokenError('bad'))
        .mockResolvedValueOnce({ type: 'api' });
      await expect(
        verifyWithRotation(service, 'tok', PREVIOUS),
      ).resolves.toEqual({ type: 'api' });
      expect(service.verifyAsync).toHaveBeenNthCalledWith(2, 'tok', {
        secret: PREVIOUS,
      });
    });

    it('rethrows the original error when neither secret works', async () => {
      const service = makeService();
      const original = new JsonWebTokenError('bad');
      service.verifyAsync.mockRejectedValue(original);
      await expect(
        verifyWithRotation(service, 'tok', PREVIOUS),
      ).rejects.toBe(original);
    });

    it('does not retry when no previous secret is configured', async () => {
      const service = makeService();
      const original = new JsonWebTokenError('bad');
      service.verifyAsync.mockRejectedValue(original);
      await expect(
        verifyWithRotation(service, 'tok', undefined),
      ).rejects.toBe(original);
      expect(service.verifyAsync).toHaveBeenCalledTimes(1);
    });
  });
});
