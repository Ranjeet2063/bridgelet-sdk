import { ConflictException, HttpStatus } from '@nestjs/common';
import { AccountStatus } from './account-status.enum.js';

/**
 * Account Status Lifecycle — the single source of truth for
 * `account_status` transitions (#445).
 *
 * ## Why this exists
 *
 * `AccountStatus` grew one member at a time across four migrations
 * (1718100000000, ...2000, ...4000, ...8000), and the writes were spread
 * across five modules that each encoded their own assumptions about what may
 * follow what. Nothing checked any of them. This module is that check.
 *
 * ## Design decisions, and why
 *
 * **1. The table lives next to the enum, and is typed `Record<AccountStatus,
 * readonly AccountStatus[]>` — total over the key space.**
 *
 * This is the property that makes this a single source of truth rather than a
 * suggestion. `Record<AccountStatus, …>` requires a key for *every* enum
 * member, so adding a member to `AccountStatus` without deciding its outgoing
 * transitions is a **compile error**, not a silently-permissive `undefined`.
 * That is deliberately better than a `Partial<Record<…>>` or a
 * `Map`-with-defaults shape, both of which fail open.
 *
 * Note the distinction, which is easy to get wrong: the record is *total over
 * keys* but the *transition list* is partial. See (2).
 *
 * **2. The per-status transition lists are PARTIAL: only legal transitions are
 * listed, and everything not listed is denied.**
 *
 * A "total" table — one that classifies all 64 ordered pairs as allowed or
 * denied — sounds more rigorous but is strictly worse here. It forces a
 * maintainer to write down 64 judgements to express what 11 lines say, and
 * every one of those 53 extra lines is a chance to typo a `true`. More
 * importantly, the *failure direction* differs: with a partial table a new
 * transition is invisible until someone adds it (fail-closed, and the compiler
 * nags about the new enum member), whereas with a total table a new enum
 * member would arrive with 7 rows of invented denials and look deliberate.
 * Deny-by-default is the right bias for a state machine guarding a money-moving
 * lifecycle.
 *
 * An empty array (`CLAIMED`, `EXPIRED`, `FAILED`) therefore means "terminal —
 * nothing leaves it". That is a stronger statement than omitting the key,
 * which the type system would not even allow.
 *
 * **3. Same-status transitions (X → X) are DENIED.**
 *
 * Idempotent retry is a real and pervasive concern in this codebase — the SSE
 * stream and the interval poller are both live at once and both try to move
 * `PENDING_PAYMENT → PENDING_CLAIM`, `DuplicateAsset` is swallowed as a
 * no-op, and per-account loops use `Promise.allSettled`. But none of those
 * need a *self*-transition, because **all of them already get idempotency
 * structurally, from a conditional update** —
 * `update({ id, status: PENDING_PAYMENT }, { status: PENDING_CLAIM })` cannot
 * move an account backwards and is a no-op if the account already moved on.
 * That is the correct mechanism, and it is why this module can be strict
 * without breaking anything.
 *
 * Allowing X → X anyway would be actively harmful: it would make every
 * re-entrant write pass validation, so a genuine bug that resets a `CLAIMED`
 * account to `CLAIMED` (a write that clobbers other columns) would be
 * indistinguishable from a harmless retry. The one place X → X was actually
 * reachable — an *unconditional* write in `PaymentMonitorProvider` — was
 * converted to the conditional form rather than exempted from the rule.
 *
 * **4. What this does and does not guarantee. Read this before trusting it.**
 *
 * This validator is a **development-time guard against logic errors**. It is
 * **not a concurrency control.**
 *
 * It runs in one process, in memory, immediately before a write. It cannot
 * see a concurrent transaction, it cannot order two writers, and it cannot
 * undo a write. Two workers can both read `PENDING_CLAIM`, both validate
 * `PENDING_CLAIM → CLAIMING` as legal, and both then write — the second one
 * clobbering the first. Validation would pass on both.
 *
 * What actually makes these writes atomic and monotonic:
 *
 * - **Conditional updates** (`update({ id, status: FROM }, { status: TO })`),
 *   which are the source of truth for ordering. Prefer them.
 * - **`SELECT … FOR UPDATE` row locks** inside the `dataSource.transaction`
 *   blocks in `ClaimRedemptionProvider`, which serialise competing
 *   redemptions of the same account.
 * - **`Promise.allSettled` + per-account try/catch** so one bad account
 *   cannot abort a scheduler pass.
 *
 * The two mechanisms are complementary and must not be conflated. If you are
 * adding a status write, add the validator to catch the "I typed the wrong
 * constant" class of bug, **and** decide separately whether the write needs a
 * conditional update or a row lock to be correct under concurrency. A helper
 * that is trivially bypassed — and a helper that is *only* a validator, with
 * no atomicity, is exactly that — is worse than none, so the honest framing is
 * "defense in depth, second line", not "enforcement".
 *
 * **5. Failure mode: HTTP 409 Conflict.**
 *
 * An invalid transition is a caller/logic error, not a server fault, so it
 * must not be a 5xx — that would page an on-call engineer for what is really
 * a bug in our own code path, and would tell a client to retry a request that
 * can never succeed. `ContractErrorMapper` already maps the on-chain
 * `InvalidStatus` to `HttpStatus.CONFLICT` with the message "The account is
 * in a terminal state and cannot be modified", so 409 is the code this
 * codebase already uses for precisely this condition; matching it keeps the
 * two error surfaces consistent.
 *
 * **6. `assertValidAccountStatusTransition` vs `isValidAccountStatusTransition`.**
 *
 * Two entry points because **call sites in `catch` blocks must not throw.**
 * `AccountsService.create()` marks an account `FAILED` from a `catch`; if the
 * validator threw there it would replace the real underlying error with a
 * validation error, hiding the actual failure from both the user and the logs
 * — strictly worse than not marking the row. Same reasoning applies to the
 * rollback write in `ClaimRedemptionProvider`'s `catch`. Those sites use the
 * boolean form and log, so the original error always survives.
 *
 * ## Keeping this in sync with the code
 *
 * The table is derived from the actual writes in the repository, not from the
 * diagram in `docs/database-schema.md`. Where the two disagreed, the code won
 * and the doc was corrected — see that file for the specific discrepancies
 * found. If you add a status write, add its transition here *and* update the
 * doc; `account-status-transition.util.spec.ts` fails if a new enum member
 * appears without a table entry.
 */

/**
 * Allowed outgoing transitions, keyed by source status.
 *
 * Every `AccountStatus` member must appear as a key — enforced by the
 * `Record` type, not by convention. An empty array marks a terminal state.
 */
export const ACCOUNT_STATUS_TRANSITIONS: Readonly<
  Record<AccountStatus, readonly AccountStatus[]>
> = Object.freeze({
  // Funding succeeded → awaiting the inbound payment.
  // `FAILED` in two places: AccountsService.create()'s catch (creation blew up
  // after the row was written) and SchedulerService.runInitializingCleanup()
  // (the row has been stuck in INITIALIZING past app.initializingTimeoutMs).
  [AccountStatus.INITIALIZING]: [
    AccountStatus.PENDING_PAYMENT,
    AccountStatus.FAILED,
  ],

  // PaymentMonitorService.processPayment() and
  // PaymentMonitorProvider.markAccountPendingClaim() → PENDING_CLAIM.
  // SchedulerService.expireAccount() → EXPIRED.
  // PaymentMonitorProvider.markAccountFailed() → FAILED, on the non-retryable
  // contract errors TooManyPayments / InvalidAmount.
  [AccountStatus.PENDING_PAYMENT]: [
    AccountStatus.PENDING_CLAIM,
    AccountStatus.EXPIRED,
    AccountStatus.FAILED,
  ],

  // ClaimRedemptionProvider.redeemClaim() → CLAIMING.
  // SchedulerService.expireAccount() → EXPIRED.
  // No → FAILED: no code path marks a PENDING_CLAIM account FAILED.
  [AccountStatus.PENDING_CLAIM]: [
    AccountStatus.CLAIMING,
    AccountStatus.EXPIRED,
  ],

  // The in-flight redemption window, entered under a row lock.
  // → CLAIMED             : sweep + Horizon payment both succeeded.
  // → PARTIAL_SWEEP       : contract authorized, Horizon payment failed
  //                         (`sweepResult.isPartial`), OR the rollback below
  //                         when the attempt began in PARTIAL_SWEEP.
  // → PENDING_CLAIM       : rollback when the attempt began in PENDING_CLAIM.
  [AccountStatus.CLAIMING]: [
    AccountStatus.CLAIMED,
    AccountStatus.PARTIAL_SWEEP,
    AccountStatus.PENDING_CLAIM,
  ],

  // Retry of a partial failure, with `skipContractAuth=true` so the already
  // authorized contract is not re-invoked. This is the one genuine
  // "backwards-looking" recovery edge in the lifecycle, and it is legitimate:
  // the contract is already in Swept state, so the DB has to record that.
  [AccountStatus.PARTIAL_SWEEP]: [AccountStatus.CLAIMING],

  // Terminal.
  [AccountStatus.CLAIMED]: [],
  // Terminal.
  [AccountStatus.EXPIRED]: [],
  // Terminal. Note the asymmetry with CLAIMING: a FAILED sweep *rolls back*
  // to PENDING_CLAIM / PARTIAL_SWEEP and stays retryable. Nothing ever
  // promotes a CLAIMING account to FAILED — see docs/database-schema.md, which
  // previously claimed it did.
  [AccountStatus.FAILED]: [],
});

/** Statuses from which no transition is legal. */
export const TERMINAL_ACCOUNT_STATUSES: readonly AccountStatus[] =
  Object.freeze(
    (Object.keys(ACCOUNT_STATUS_TRANSITIONS) as AccountStatus[]).filter(
      (status) => ACCOUNT_STATUS_TRANSITIONS[status].length === 0,
    ),
  );

/**
 * Whether the table has an entry for `status`.
 *
 * The `Record` type makes a missing entry a compile error for anything the
 * compiler can see, but a value read from the database at runtime is only
 * `AccountStatus` as far as the type system is concerned. An unknown status
 * must fail closed, so this is checked explicitly at every lookup.
 *
 * (Own-property check rather than a plain `in`/`!== undefined`: a status named
 * `toString` or `constructor` must not resolve to something on
 * `Object.prototype`.)
 */
function hasTransitionEntry(status: AccountStatus): boolean {
  return Object.prototype.hasOwnProperty.call(
    ACCOUNT_STATUS_TRANSITIONS,
    status,
  ) as boolean;
}

/**
 * Whether `from` → `to` is a legal transition.
 *
 * Deny-by-default: anything not explicitly listed in
 * {@link ACCOUNT_STATUS_TRANSITIONS} is invalid, including:
 * - a backwards transition (`CLAIMING` → `PENDING_CLAIM` is legal, but
 *   `PENDING_CLAIM` → `INITIALIZING` is not),
 * - any transition out of a terminal status,
 * - a same-status transition (`X` → `X`),
 * - a status value that is not a member of `AccountStatus` at all (e.g. a
 *   value read from a database written by a newer, incompatible release).
 */
export function isValidAccountStatusTransition(
  from: AccountStatus,
  to: AccountStatus,
): boolean {
  if (!hasTransitionEntry(from)) {
    return false;
  }

  return ACCOUNT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Whether `status` is terminal (no outgoing transitions).
 */
export function isTerminalAccountStatus(status: AccountStatus): boolean {
  if (!hasTransitionEntry(status)) return false;
  return ACCOUNT_STATUS_TRANSITIONS[status].length === 0;
}

/**
 * Throws unless `from` → `to` is a legal transition.
 *
 * Use this on the happy path. **Do not use it in a `catch` block that is
 * already handling an unrelated failure** — it would replace the real error
 * with this one. Use {@link isValidAccountStatusTransition} there and log.
 *
 * @param from  - the account's status as read from the database
 * @param to    - the status about to be written
 * @param context - optional free-form detail appended to the message
 * @throws ConflictException (HTTP 409) when the transition is not allowed
 */
export function assertValidAccountStatusTransition(
  from: AccountStatus,
  to: AccountStatus,
  context?: string,
): void {
  if (isValidAccountStatusTransition(from, to)) {
    return;
  }

  const detail = context ? ` (${context})` : '';
  const allowed = ACCOUNT_STATUS_TRANSITIONS[from];

  throw new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    errorCode: 'INVALID_STATUS_TRANSITION',
    message:
      `Invalid account status transition ${from} -> ${to}${detail}. ` +
      (allowed === undefined
        ? `"${from}" is not a known account status.`
        : allowed.length === 0
          ? `"${from}" is terminal and has no valid transitions.`
          : `Valid transitions from "${from}": ${allowed.join(', ')}.`),
  });
}
