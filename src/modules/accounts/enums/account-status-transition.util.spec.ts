import { ConflictException, HttpStatus } from '@nestjs/common';
import { AccountStatus } from './account-status.enum.js';
import {
  ACCOUNT_STATUS_TRANSITIONS,
  TERMINAL_ACCOUNT_STATUSES,
  assertValidAccountStatusTransition,
  isTerminalAccountStatus,
  isValidAccountStatusTransition,
} from './account-status-transition.util.js';

const ALL_STATUSES = Object.values(AccountStatus);

/**
 * Every legal edge in the table, asserted individually so a future edit to the
 * table cannot silently drop one without a test failing here. Hoisted to module
 * scope so both `isValid...` and `assert...` suites can iterate it.
 */
const ALL_LEGAL_TRANSITIONS: ReadonlyArray<[AccountStatus, AccountStatus]> = [
  // AccountsService.create()
  [AccountStatus.INITIALIZING, AccountStatus.PENDING_PAYMENT],
  // SchedulerService.runInitializingCleanup() and
  // AccountsService.create()'s catch
  [AccountStatus.INITIALIZING, AccountStatus.FAILED],
  // PaymentMonitorService.processPayment() /
  // PaymentMonitorProvider.markAccountPendingClaim()
  [AccountStatus.PENDING_PAYMENT, AccountStatus.PENDING_CLAIM],
  // SchedulerService.expireAccount()
  [AccountStatus.PENDING_PAYMENT, AccountStatus.EXPIRED],
  // PaymentMonitorProvider.markAccountFailed()
  [AccountStatus.PENDING_PAYMENT, AccountStatus.FAILED],
  // ClaimRedemptionProvider.redeemClaim(), fresh attempt
  [AccountStatus.PENDING_CLAIM, AccountStatus.CLAIMING],
  // ClaimRedemptionProvider.redeemClaim(), partial retry
  [AccountStatus.PARTIAL_SWEEP, AccountStatus.CLAIMING],
  // SchedulerService.expireAccount()
  [AccountStatus.PENDING_CLAIM, AccountStatus.EXPIRED],
  // ClaimRedemptionProvider.redeemClaim(), success
  [AccountStatus.CLAIMING, AccountStatus.CLAIMED],
  // ClaimRedemptionProvider.redeemClaim(), isPartial
  [AccountStatus.CLAIMING, AccountStatus.PARTIAL_SWEEP],
  // ClaimRedemptionProvider.redeemClaim(), rollback from a fresh attempt
  [AccountStatus.CLAIMING, AccountStatus.PENDING_CLAIM],
];

describe('ACCOUNT_STATUS_TRANSITIONS table', () => {
  /**
   * The property that makes this a single source of truth rather than a
   * suggestion (#445). `Record<AccountStatus, …>` already makes a missing key
   * a *compile* error; this test makes it a *build* error too, so it holds
   * even for code that defeats the type system (`as any`, a transpiler, a
   * future refactor to a looser type). A new enum member cannot be added
   * without someone deciding its outgoing transitions.
   */
  it('has an entry for every AccountStatus member — a new enum member cannot be added silently', () => {
    for (const status of ALL_STATUSES) {
      expect(ACCOUNT_STATUS_TRANSITIONS).toHaveProperty(status);
      expect(Array.isArray(ACCOUNT_STATUS_TRANSITIONS[status])).toBe(true);
    }

    // …and the reverse, so a stale key left behind after an enum rename is
    // caught too.
    expect(Object.keys(ACCOUNT_STATUS_TRANSITIONS).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });

  it('lists no status as its own transition anywhere (X -> X is denied by construction)', () => {
    for (const status of ALL_STATUSES) {
      expect(ACCOUNT_STATUS_TRANSITIONS[status]).not.toContain(status);
    }
  });

  it('only ever lists real AccountStatus members as targets', () => {
    for (const status of ALL_STATUSES) {
      for (const target of ACCOUNT_STATUS_TRANSITIONS[status]) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });

  it('is frozen so no call site can mutate the table at runtime', () => {
    expect(Object.isFrozen(ACCOUNT_STATUS_TRANSITIONS)).toBe(true);
  });

  it('marks exactly CLAIMED, EXPIRED and FAILED as terminal', () => {
    expect([...TERMINAL_ACCOUNT_STATUSES].sort()).toEqual(
      [
        AccountStatus.CLAIMED,
        AccountStatus.EXPIRED,
        AccountStatus.FAILED,
      ].sort(),
    );
  });
});

describe('isValidAccountStatusTransition — legal transitions', () => {
  it.each(ALL_LEGAL_TRANSITIONS)('allows %s -> %s', (from, to) => {
    expect(isValidAccountStatusTransition(from, to)).toBe(true);
  });

  /**
   * Exhaustive sweep: for every ordered pair of the 8 statuses (64), the
   * validator must agree with the table. This is the deny-by-default property
   * — anything not explicitly legal is invalid.
   */
  it('agrees with the table for all 64 ordered pairs', () => {
    let legal = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = ACCOUNT_STATUS_TRANSITIONS[from].includes(to);
        expect(isValidAccountStatusTransition(from, to)).toBe(expected);
        if (expected) legal += 1;
      }
    }
    expect(legal).toBe(ALL_LEGAL_TRANSITIONS.length);
  });
});

describe('isValidAccountStatusTransition — rejected transitions', () => {
  it('rejects a backwards transition', () => {
    expect(
      isValidAccountStatusTransition(
        AccountStatus.PENDING_CLAIM,
        AccountStatus.PENDING_PAYMENT,
      ),
    ).toBe(false);
  });

  it('rejects a backwards transition all the way to the start of the lifecycle', () => {
    expect(
      isValidAccountStatusTransition(
        AccountStatus.CLAIMED,
        AccountStatus.INITIALIZING,
      ),
    ).toBe(false);
  });

  it.each([
    AccountStatus.CLAIMED,
    AccountStatus.EXPIRED,
    AccountStatus.FAILED,
  ] as const)('rejects every transition out of terminal status %s', (from) => {
    expect(ACCOUNT_STATUS_TRANSITIONS[from]).toEqual([]);
    for (const to of ALL_STATUSES) {
      expect(isValidAccountStatusTransition(from, to)).toBe(false);
    }
  });

  it.each(ALL_STATUSES)('rejects the self-transition %s -> %s', (status) => {
    expect(isValidAccountStatusTransition(status, status)).toBe(false);
  });

  it('rejects an unknown source status (fails closed, not open)', () => {
    const bogus = 'archived' as AccountStatus;
    expect(isValidAccountStatusTransition(bogus, AccountStatus.CLAIMED)).toBe(
      false,
    );
  });

  it('rejects an unknown target status', () => {
    expect(
      isValidAccountStatusTransition(
        AccountStatus.PENDING_CLAIM,
        'archived' as AccountStatus,
      ),
    ).toBe(false);
  });

  /**
   * The documented `CLAIMING -> FAILED` edge does not exist in the code:
   * ClaimRedemptionProvider's catch *rolls back* to PENDING_CLAIM /
   * PARTIAL_SWEEP so the user can retry. It is asserted here because the docs
   * previously claimed otherwise, and that class of drift is what #445 exists
   * to prevent.
   */
  it('rejects CLAIMING -> FAILED (rollback happens instead; docs were wrong)', () => {
    expect(
      isValidAccountStatusTransition(
        AccountStatus.CLAIMING,
        AccountStatus.FAILED,
      ),
    ).toBe(false);
  });
});

describe('assertValidAccountStatusTransition', () => {
  it('does not throw for a legal transition', () => {
    expect(() =>
      assertValidAccountStatusTransition(
        AccountStatus.PENDING_PAYMENT,
        AccountStatus.PENDING_CLAIM,
      ),
    ).not.toThrow();
  });

  it.each(ALL_LEGAL_TRANSITIONS)('does not throw for %s -> %s', (from, to) => {
    expect(() => assertValidAccountStatusTransition(from, to)).not.toThrow();
  });

  // Acceptance criterion 3: at least one rejected invalid transition.
  it('throws a ConflictException (HTTP 409, not 5xx) for a backwards transition', () => {
    let thrown: unknown;
    try {
      assertValidAccountStatusTransition(
        AccountStatus.CLAIMED,
        AccountStatus.PENDING_CLAIM,
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    const response = (thrown as ConflictException).getResponse() as {
      statusCode: number;
      errorCode: string;
      message: string;
    };
    expect(response.statusCode).toBe(HttpStatus.CONFLICT);
    expect(response.statusCode).toBe(409);
    expect(response.errorCode).toBe('INVALID_STATUS_TRANSITION');
    expect(response.message).toContain('claimed -> pending_claim');
  });

  it('reports the terminal case distinctly so the message is actionable', () => {
    expect(() =>
      assertValidAccountStatusTransition(
        AccountStatus.EXPIRED,
        AccountStatus.CLAIMING,
      ),
    ).toThrow(/is terminal and has no valid transitions/);
  });

  it('lists the legal alternatives when the source is non-terminal', () => {
    expect(() =>
      assertValidAccountStatusTransition(
        AccountStatus.PENDING_PAYMENT,
        AccountStatus.CLAIMING,
      ),
    ).toThrow(/Valid transitions from "pending_payment"/);
  });

  it('reports an unknown source status distinctly', () => {
    expect(() =>
      assertValidAccountStatusTransition(
        'archived' as AccountStatus,
        AccountStatus.CLAIMED,
      ),
    ).toThrow(/is not a known account status/);
  });

  it('appends the optional context to the message', () => {
    expect(() =>
      assertValidAccountStatusTransition(
        AccountStatus.CLAIMED,
        AccountStatus.PENDING_CLAIM,
        'accountId=abc123',
      ),
    ).toThrow(/\(accountId=abc123\)/);
  });

  it('rejects a self-transition', () => {
    expect(() =>
      assertValidAccountStatusTransition(
        AccountStatus.PENDING_CLAIM,
        AccountStatus.PENDING_CLAIM,
      ),
    ).toThrow(ConflictException);
  });
});

describe('isTerminalAccountStatus', () => {
  it.each([
    [AccountStatus.CLAIMED, true],
    [AccountStatus.EXPIRED, true],
    [AccountStatus.FAILED, true],
    [AccountStatus.INITIALIZING, false],
    [AccountStatus.PENDING_PAYMENT, false],
    [AccountStatus.PENDING_CLAIM, false],
    [AccountStatus.CLAIMING, false],
    [AccountStatus.PARTIAL_SWEEP, false],
  ] as const)('reports %s as terminal=%s', (status, expected) => {
    expect(isTerminalAccountStatus(status)).toBe(expected);
  });

  it('treats an unknown status as non-terminal rather than throwing', () => {
    expect(isTerminalAccountStatus('archived' as AccountStatus)).toBe(false);
  });
});
