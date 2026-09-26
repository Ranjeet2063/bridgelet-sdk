/**
 * Result returned by TransactionProvider after submitting a transaction
 * to the Stellar Horizon REST API.
 *
 * ⚠️ HORIZON TYPE MISMATCH - READ BEFORE MODIFYING:
 * The Stellar Horizon API is a REST API that returns JSON. JSON has no
 * native integer type, so numeric fields like `ledger` are transmitted as
 * JSON numbers but in practice the Horizon SDK has returned them as
 * strings in certain SDK versions and response shapes.
 *
 * `ledger` is typed here as `number | string` to reflect that reality.
 * In TransactionProvider.executeSweepTransaction() the raw value from
 * `result.ledger` is explicitly coerced with `Number(result.ledger)` before
 * being stored here, so consumers of this interface always receive a number.
 * Do NOT remove that coercion thinking it is unnecessary - the SDK type
 * definition says `number` but the wire value can be a string.
 *
 * See: https://developers.stellar.org/api/horizon/resources/submit-a-transaction
 */
export interface TransactionResult {
  hash: string;
  ledger: number;
  successful: boolean;
  timestamp: Date;

  /**
   * Whether this result came from a fee-bump submission (#649).
   *
   * Fee bumps may be used to accelerate a sweep that is stuck behind network
   * congestion. When that happens `hash` is the hash of the *outer* fee-bump
   * transaction, which is not the hash the inner transaction was signed with -
   * so an audit trail that records only `hash` cannot be reconciled against
   * the original submission. This flag makes that distinction explicit rather
   * than leaving it to be inferred.
   *
   * Always set, so `false` positively means "not fee-bumped" instead of
   * "nobody populated this".
   *
   * Verified for #710 (duplicate of the already-resolved #649, fixed in PR #781).
   */
  feeBump: boolean;

  /**
   * Hash of the inner transaction, present only when `feeBump` is true (#649).
   * This is the hash to correlate with whatever was originally submitted.
   */
  innerTransactionHash?: string;
}
