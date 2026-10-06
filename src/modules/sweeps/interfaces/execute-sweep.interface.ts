export interface SweepExecutionRequest {
  accountId: string;
  ephemeralPublicKey: string;
  ephemeralSecret: string;
  destinationAddress: string;
  amount: string;
  asset: string;
  /**
   * The EphemeralAccount contract instance holding this account's state (#812).
   *
   * Always invoke the instance recorded in this column rather than the shared
   * `stellar.contracts.ephemeralAccount` config ID. Since #811 each new account
   * gets its own instance deployed for it, so for those rows the config ID
   * belongs to a different account entirely.
   *
   * Nullable because the column is nullable. Accounts created before #811
   * stored the shared `stellar.contracts.ephemeralAccount` ID in this column,
   * and they keep working: they genuinely share that contract's state, so
   * reading the ID out of the column still targets the right instance. Null
   * only means the row never finished creation — `accounts.service.ts` saves
   * the row as INITIALIZING before deploying, and assigns `contractId` only
   * once the deploy succeeds. `SweepsService.executeSweep` rejects null with
   * an error naming the account rather than falling back to the shared ID.
   */
  contractId: string | null;
  /**
   * When true, the sweeper skips the smart-contract auth signature
   * generation AND the `execute_sweep` contract call (steps 2 and 3)
   * and only runs the Horizon payment (step 4). Used for retrying an
   * account in `PARTIAL_SWEEP` state whose contract is already in
   * `Swept` state from a prior partial failure — re-invoking
   * `execute_sweep` would revert on-chain.
   */
  skipContractAuth?: boolean;
}
