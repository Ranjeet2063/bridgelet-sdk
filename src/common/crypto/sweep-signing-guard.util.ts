/**
 * SweepSigningGuard
 *
 * ## Why this exists (#457)
 *
 * Issue #457 required that "the existing development/test-only guard is
 * preserved as defense-in-depth". **No such guard existed.** Before this file,
 * `stellar.sweepSigningKeySeed` was only ever read in
 * `src/config/stellar.config.ts` and consumed in
 * `ContractProvider.generateAuthSignature()` with no environment check
 * anywhere: not in the config factory, not in the provider, not in
 * `SweepsService`, not in the module wiring. Any deployment — production
 * included — would happily sign with whatever seed was in the environment,
 * including a copy-pasted development seed.
 *
 * So the guard is added here rather than "preserved".
 *
 * ## What it actually protects against
 *
 * A development/test signing seed being used in a production configuration.
 * A dev seed is, by construction, committed to `.env.example`, pasted into
 * chat, and shared between developers — the signature it produces proves
 * nothing about *who* authorised a sweep, because the key is public. On a
 * real deployment that is the difference between "only the SweepController's
 * registered `authorized_signer` may authorise a sweep" and "anyone with the
 * repository".
 *
 * This is defense-in-depth, not the primary control. The primary control is
 * on-chain: `SweepController` checks the signature against the
 * `authorized_signer` public key registered in its own storage. This guard
 * exists to stop a *misconfiguration* (dev seed in prod) from reaching that
 * check in the first place, and to fail loudly and early rather than
 * producing signatures that a real deployment would silently accept.
 *
 * ## Deliberate scope limits
 *
 * This guard is intentionally narrow:
 *
 * - It checks the environment *at signing time*, not at bootstrap. Adding it
 *   to module initialisation would make the process unbootable in production
 *   even in deployments that never sweep, which is a far larger blast radius
 *   than the bug it prevents.
 * - It refuses only when the environment is one that must not sign at all
 *   (`production`). `development`, `test`, and an *unset* `NODE_ENV` are all
 *   allowed, so local dev, Jest, and any environment that has not been
 *   explicit about its mode keep working. Refusing on unset would break
 *   every existing `.env` that omits `NODE_ENV` and buys nothing — an unset
 *   environment is not a production deployment.
 *
 * It is not a substitute for `stellar.network === 'mainnet'` checks; it keys
 * off the deployment mode, which is the thing an operator actually sets
 * correctly.
 */

/** Environments in which signing must be refused outright. */
const SIGNING_FORBIDDEN_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'production',
]);

export class SweepSigningGuard {
  /**
   * Throw if the current configuration must not sign sweep authorizations.
   *
   * @param nodeEnv - `process.env.NODE_ENV`, or `undefined` when unset.
   *                 Passed in rather than read from the environment directly
   *                 so the decision is a pure function of its input and can
   *                 be unit-tested in both directions.
   * @throws Error when `nodeEnv` is a production environment.
   */
  static assertSigningAllowed(nodeEnv: string | undefined): void {
    if (SweepSigningGuard.isSigningForbidden(nodeEnv)) {
      throw new Error(
        'Refusing to sign sweep authorizations: NODE_ENV is "production", ' +
          'which must not use a development/test SWEEP_SIGNING_KEY_SEED. ' +
          'Configure a dedicated production signing key whose public key is ' +
          'registered as the SweepController authorized_signer, or unset ' +
          'NODE_ENV only for a genuinely non-production deployment. ' +
          'See issue #457.',
      );
    }
  }

  /**
   * Whether signing is forbidden for the given environment. `undefined` and
   * the empty string are treated as "not production".
   */
  static isSigningForbidden(nodeEnv: string | undefined): boolean {
    if (nodeEnv === undefined) return false;
    return SIGNING_FORBIDDEN_ENVIRONMENTS.has(nodeEnv.trim().toLowerCase());
  }
}
