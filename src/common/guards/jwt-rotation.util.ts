import type { JwtService } from '@nestjs/jwt';
import jwt from 'jsonwebtoken';

/**
 * Grace-window secret rotation for `JWT_SECRET` (issue #683).
 *
 * Claim tokens are signed with `app.jwtSecret` and can stay valid for up to
 * `CLAIM_TOKEN_EXPIRY` (default 30 days). Rotating `JWT_SECRET` therefore has
 * to be a two-step operation: publish the new secret, but keep accepting the
 * old one for a window at least as long as the longest-lived outstanding
 * claim token. Without that window, every unclaimed token in flight is
 * unredeemable and the funds behind it are stranded until the account expires
 * and is recovered.
 *
 * How the window is expressed:
 *   1. Set `JWT_SECRET` to the new value and `JWT_SECRET_PREVIOUS` to the old
 *      one. Deploy. New tokens are signed with the new secret; both verify.
 *   2. Leave it in place for at least `CLAIM_TOKEN_EXPIRY` after the switch so
 *      every token minted under the old secret has had time to be redeemed.
 *   3. Unset `JWT_SECRET_PREVIOUS` and deploy again.
 *
 * The fallback is strictly last-resort: a token that verifies under *neither*
 * secret still fails, and the original verification error is rethrown so the
 * caller sees the real reason rather than a misleading "no previous secret"
 * message.
 */

/** Reads the previous secret from the environment, if a window is open. */
export function previousJwtSecret(): string | undefined {
  const previous = process.env.JWT_SECRET_PREVIOUS;
  return previous && previous.length > 0 ? previous : undefined;
}

/**
 * Verifies a claim JWT against the current secret, falling back to the
 * previous secret while a rotation window is open.
 *
 * Uses the `jsonwebtoken` module directly (rather than Nest's `JwtService`)
 * because claim tokens are verified against `JWT_SECRET` in
 * `TokenVerificationProvider`, independent of the API-token `JwtService`
 * registered per module. The same current-then-previous semantics apply.
 *
 * @param token the raw JWT
 * @param currentSecret the active signing secret
 * @param previousSecret defaults to `JWT_SECRET_PREVIOUS`
 * @returns the decoded payload
 * @throws the error from the *current*-secret attempt, so callers can keep
 *   mapping `TokenExpiredError` / `JsonWebTokenError` to 401s unchanged
 */
export function verifyClaimTokenWithRotation<T = unknown>(
  token: string,
  currentSecret: string,
  previousSecret: string | undefined = previousJwtSecret(),
): T {
  try {
    return jwt.verify(token, currentSecret) as T;
  } catch (currentErr) {
    if (!previousSecret || previousSecret === currentSecret) {
      throw currentErr;
    }
    try {
      return jwt.verify(token, previousSecret) as T;
    } catch {
      // Neither secret accepted it. Surface the failure against the *current*
      // secret: that is the one the client should be fixing, and it preserves
      // the TokenExpiredError vs JsonWebTokenError distinction callers rely on.
      throw currentErr;
    }
  }
}

/**
 * Nest `JwtService` equivalent of {@link verifyClaimTokenWithRotation}, for
 * call sites that verify through the DI-registered service.
 */
export async function verifyWithRotation(
  jwtService: JwtService,
  token: string,
  previousSecret: string | undefined = previousJwtSecret(),
): Promise<unknown> {
  try {
    return await jwtService.verifyAsync(token);
  } catch (err) {
    if (!previousSecret) throw err;
    try {
      return await jwtService.verifyAsync(token, { secret: previousSecret });
    } catch {
      throw err;
    }
  }
}
