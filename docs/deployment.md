# Deployment

## `EPHEMERAL_ACCOUNT_WASM_HASH` (issue #811)

Each `POST /accounts` deploys its **own** `EphemeralAccount` contract instance
and initializes that instance. `EphemeralAccount` in bridgelet-core holds all of
an account's on-chain state (status, expiry ledger, recorded payments,
`swept_to`) and its `initialize()` returns `Error::AlreadyInitialized`
(`Error(Contract, #1)`) on any second call — so a single shared contract ID
allowed exactly one account per deployment.

- `EPHEMERAL_ACCOUNT_WASM_HASH` is the 64-hex-char WASM hash of the uploaded
  ephemeral-account contract. It is required outside tests and validated by
  `validateEnv()` in `src/config/env-validation.ts`, which reports
  `EPHEMERAL_ACCOUNT_WASM_HASH is missing` or
  `EPHEMERAL_ACCOUNT_WASM_HASH must be a 64-character hex string`. A hash that
  is not uploaded on the target network makes the deploy transaction fail, and
  the account is marked `FAILED` rather than handed to the caller.
- On testnet the value is `ephemeralAccountWasmHash` in
  `bridgelet-core/deployments/testnet.json`. On mainnet, take it from the
  `stellar contract upload` output for the mainnet build.
- `stellar.contracts.ephemeralAccount` (`EPHEMERAL_ACCOUNT_CONTRACT_ID`) is still
  required by the payment monitor, sweeps and `ContractProvider`, but account
  creation never initializes it.
- Deploys are salted with 32 random bytes, so retrying an account creation
  cannot collide with an earlier deployment.
- Redeploy the contract and bump this value (and
  `EPHEMERAL_ACCOUNT_CONTRACT_VERSION`) whenever a new ephemeral-account WASM is
  uploaded; instances deployed from an older hash keep running against the
  older code.
- Each new account costs one extra deploy transaction (rent + fees) on top of
  the existing `createAccount` and `initialize` transactions. Size the funding
  account accordingly.

## Database connection pool (issue #516)

Pool settings live in two places that must be kept in sync:

- `src/config/database.config.ts` (`POOL_CONFIG`) – used by the running
  NestJS app via `TypeOrmModule.forRootAsync`.
- `src/config/typeorm.config.ts` – used by the TypeORM CLI
  (`migration:run`, `migration:revert`, `migration:generate`).

Both currently set:

```ts
{
  min: 2,
  max: 10,
  connectionTimeoutMillis: 3000,
}
```

### What each option actually does

This repo previously used `acquireTimeoutMillis` instead of
`connectionTimeoutMillis`. `pg-pool` does not recognize
`acquireTimeoutMillis` as an option and silently ignores it, so the
intended fail-fast behavior was never in effect. Concretely:

- **`max`** is the only hard cap. It limits how many physical
  connections one app instance opens to Postgres.
- **`min`** does _not_ eagerly open connections at startup. In
  `pg-pool`, `min` only stops the pool from closing idle connections
  below that floor once they already exist (see `_isAboveMin` in
  `pg-pool/index.js`). It has no effect on cold-start latency.
- **`connectionTimeoutMillis`** is the real option name. It governs
  two things at once: how long a brand-new physical connection attempt
  may take, and — this is the part that matters for pool exhaustion —
  how long a caller queues waiting for an already-open connection once
  the pool is fully saturated (`_isFull()` in `pg-pool`). If this is
  unset (as it effectively was, since `acquireTimeoutMillis` was
  ignored), a caller that arrives when all `max` connections are busy
  queues **indefinitely** with no error: a silent hang, not
  backpressure. With it set to `3000`, that caller now fails after 3s
  with `timeout exceeded when trying to connect`, which NestJS
  surfaces as a request-level error instead of a hung connection.

### Sizing `max` against expected concurrency

This repo does not currently have a load-testing script or a
documented concurrency figure checked in (issue #516 assumed a
"50 concurrent requests" load test existed; as of this audit it does
not — see the PR for this issue). Until one exists, size `max`
using this reasoning instead of a specific benchmark:

1. **Pool size is not request concurrency.** A request only holds a
   connection for the duration of its DB work, not its full
   lifetime. If the average DB-bound portion of a request is short
   (a few ms to tens of ms), a pool much smaller than the peak
   concurrent HTTP request count can still serve it, as long as
   requests queue briefly rather than reject outright.
2. **Watch for connection-holding operations.** `ClaimRedemptionProvider.redeemClaim`
   opens a `dataSource.transaction(...)` with a `pessimistic_write`
   lock while it validates and transitions account state — this holds
   one pool connection for longer than a typical read, and multiple
   concurrent redemptions against _different_ accounts will each hold
   a connection concurrently (they don't block each other; they're
   different rows). Size `max` with headroom for the expected number
   of concurrent in-flight redemptions/sweeps, not just steady-state
   reads.
3. **Multiply by instance count, not just per-instance `max`.**
   `max: 10` is _per NestJS instance_. If you run N instances behind a
   load balancer, total connections to Postgres are `N * max` (plus
   any CLI/migration connections). Check that against Postgres's own
   `max_connections` (`SHOW max_connections;`) with headroom for
   other services and superuser/admin connections.
4. **Recommended starting point for production:** `max: 10` per
   instance is reasonable for a small number of instances (2-4)
   against a standard managed Postgres tier. If you scale out app
   instances, either lower `max` per instance proportionally or put a
   connection pooler (e.g. PgBouncer in transaction mode) in front of
   Postgres so instance count doesn't multiply raw connections
   linearly.
5. **Before raising `max` in response to timeouts,** check whether
   the real cause is connection-holding queries/transactions running
   long, not too few connections — a bigger pool just delays hitting
   the same ceiling if a query is the actual bottleneck.

When a real load-testing setup is added, replace this section with
the measured concurrency figure and the `max` value it justifies.
