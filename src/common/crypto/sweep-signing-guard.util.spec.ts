import { SweepSigningGuard } from './sweep-signing-guard.util.js';

/**
 * #457 — acceptance criterion 3: "the existing development/test-only guard is
 * preserved as defense-in-depth even after real signing lands".
 *
 * These tests exist in both directions on purpose: the guard must block a
 * production configuration (the security property) *and* must not interfere
 * with local dev or the test suite (the reason the check is narrow). A guard
 * that only ever fails is not a guard, it is an outage.
 */
describe('SweepSigningGuard.isSigningForbidden', () => {
  it.each([
    'production',
    'PRODUCTION',
    '  Production  ',
    // Whitespace/casing must not be a way to slip past the guard — an operator
    // must not be able to defeat it with a stray space in a YAML value.
    'Production ',
  ])('forbids signing when NODE_ENV is %p', (nodeEnv) => {
    expect(SweepSigningGuard.isSigningForbidden(nodeEnv)).toBe(true);
  });

  it.each([
    'development',
    'dev',
    'test',
    'staging',
    'ci',
    // Prefix/substring matches are NOT production: refusing these would be
    // surprising and would break legitimate environments.
    'prod',
    'preproduction',
    'productionish',
  ])('allows signing when NODE_ENV is %p', (nodeEnv) => {
    expect(SweepSigningGuard.isSigningForbidden(nodeEnv)).toBe(false);
  });

  it('allows signing when NODE_ENV is unset', () => {
    expect(SweepSigningGuard.isSigningForbidden(undefined)).toBe(false);
  });

  it('allows signing when NODE_ENV is an empty string', () => {
    expect(SweepSigningGuard.isSigningForbidden('')).toBe(false);
  });
});

describe('SweepSigningGuard.assertSigningAllowed', () => {
  it('throws in a production configuration', () => {
    expect(() => SweepSigningGuard.assertSigningAllowed('production')).toThrow(
      /Refusing to sign sweep authorizations/,
    );
  });

  it('names NODE_ENV and the offending variable so the operator can act', () => {
    expect(() => SweepSigningGuard.assertSigningAllowed('production')).toThrow(
      /NODE_ENV is "production"/,
    );
    expect(() => SweepSigningGuard.assertSigningAllowed('production')).toThrow(
      /SWEEP_SIGNING_KEY_SEED/,
    );
  });

  it('cites the issue so the next maintainer can find the rationale', () => {
    expect(() => SweepSigningGuard.assertSigningAllowed('production')).toThrow(
      /#457/,
    );
  });

  it.each(['development', 'test', 'staging', undefined, ''])(
    'does not throw for %p',
    (nodeEnv) => {
      expect(() =>
        SweepSigningGuard.assertSigningAllowed(nodeEnv),
      ).not.toThrow();
    },
  );

  it('is consistent with isSigningForbidden', () => {
    for (const env of ['production', 'development', 'test', undefined]) {
      const threw = (() => {
        try {
          SweepSigningGuard.assertSigningAllowed(env);
          return false;
        } catch {
          return true;
        }
      })();
      expect(threw).toBe(SweepSigningGuard.isSigningForbidden(env));
    }
  });
});
