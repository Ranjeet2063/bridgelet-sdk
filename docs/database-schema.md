# Database Schema

The current schema is created entirely through the migrations in `src/database/migrations/`.

## Tables

- `accounts`: stores ephemeral account lifecycle data, including encrypted secret material, funding metadata, expiry timestamps, and optional claim metadata.
- `claims`: stores completed claim records and references `accounts.id` through a cascading foreign key on `accountId`.
- `webhooks`: stores outbound webhook subscriptions.
- `webhook_deliveries`: stores per-delivery webhook attempts, including the subscribed webhook reference (`subscription_id`), event type, payload hash, retry count, last response details, delivery timestamp, and creation timestamp. It references `webhooks.id` with `ON DELETE CASCADE` and has a composite index on (`subscription_id`, `created_at`).
- `contract_events`: stores indexed Soroban contract events, including event type, contract address, ledger sequence, transaction hash, event payload, and creation timestamp.

## Account Status Enum

`account_status_enum` currently contains these values, in order:

`initializing`, `pending_payment`, `pending_claim`, `claiming`, `partial_sweep`, `claimed`, `expired`, `failed`

### Account Status Lifecycle (issue #639)

> Verified for #700 (duplicate of the already-resolved #639, fixed in PR #774).

State transitions driven by `AccountsService`, `ClaimRedemptionProvider`,
and `SchedulerService`:

```
INITIALIZING --> PENDING_PAYMENT --> PENDING_CLAIM --> CLAIMING --> CLAIMED
                       |                                  |
                       v                                  v
                    EXPIRED                          PARTIAL_SWEEP
                       ^                              |         |
                       |                              v         v
                 (unclaimed timeout)        (retry, skipContractAuth) CLAIMING
                                                       |
                                                       v
                                                    FAILED
```

- `INITIALIZING` → `PENDING_PAYMENT`: funding transaction submitted.
- `PENDING_PAYMENT` / `PENDING_CLAIM` → `EXPIRED`: scheduler expiry job, unclaimed past `expiresAt`.
- `PENDING_CLAIM` / `PARTIAL_SWEEP` → `CLAIMING`: claim redemption acquires the row lock (`ClaimRedemptionProvider.redeemClaim`).
- `CLAIMING` → `CLAIMED`: sweep + Horizon payment both succeed.
- `CLAIMING` → `PARTIAL_SWEEP`: contract authorized but the Horizon payment failed; retried with `skipContractAuth=true`.
- `CLAIMING` → `PENDING_CLAIM` / `PARTIAL_SWEEP` (rollback) → `FAILED`: unrecoverable sweep error on retry.

## Connection Pool Configuration

TypeORM is configured with the following pool settings in both
`src/config/database.config.ts` (NestJS runtime) and
`src/config/typeorm.config.ts` (migration CLI):

| Setting                   | Value | Rationale                                                                                                                                                                |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `min`                     | 2     | Does not eagerly open connections at startup — `pg-pool` only uses `min` as a floor below which idle connections won't be closed once they already exist.                |
| `max`                     | 10    | Caps per-instance connections to leave room for other services sharing the PostgreSQL server. See `docs/deployment.md` for sizing guidance against expected concurrency. |
| `connectionTimeoutMillis` | 3000  | Fail-fast: a caller queued behind a saturated pool gets an error after 3s instead of hanging indefinitely (see `docs/deployment.md`, issue #516).                        |

Settings are passed to the underlying `pg` Pool constructor via the TypeORM `extra` key.

## Pool Health Check

`GET /health` performs a live pool probe: it races a `SELECT 1` against the
`connectionTimeoutMillis` (3 000 ms) timeout and reports one of three states:

| `services.database.healthy` | `services.database.poolExhausted` | Meaning                                                         |
| --------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `true`                      | `false`                           | Normal operation                                                |
| `false`                     | `true`                            | All pool connections are in use — scale up or investigate leaks |
| `false`                     | `false`                           | Database unreachable (network, credentials, etc.)               |

## Database Indexes

### accounts

Every index below is created by a migration, and the `Account` entity mirrors
it with an `@Index` decorator so TypeORM's schema-sync check stays clean. The
"Query served" column names the call site the index exists for: none of these
indexes is declared anywhere near the query that needs it, so before dropping
or renaming one, find that call site first. Because
`scripts/generate-migrations.sh` is the source of truth for the migration
files, a change to an index means a change there too.

| Index name                      | Columns               | Added by  | Query served (call site)                                                                                                                                                                                                                                 |
| ------------------------------- | --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UQ_accounts_publicKey`         | `publicKey` (unique)  | `…000000` | Uniqueness enforced when an account is created. No read path filters on `publicKey` — API lookups are by `id`.                                                                                                                                           |
| `IDX_accounts_publicKey`        | `publicKey`           | `…000000` | Mirrors the entity's `@Index('IDX_accounts_publicKey')` decorator; no query filters on `publicKey`.                                                                                                                                                      |
| `IDX_accounts_status`           | `status`              | `…000000` | `AccountsService.findAll()` status predicate (`GET /accounts?status=…`); also usable as a left-prefix of the two composites below.                                                                                                                       |
| `IDX_accounts_claimTokenHash`   | `claimTokenHash`      | `…000000` | Claim-token redemption: `ClaimRedemptionProvider.redeemClaim()` and `TokenVerificationProvider` (`where: { claimTokenHash, deletedAt: IsNull() }`).                                                                                                      |
| `IDX_accounts_expiresAt`        | `expiresAt`           | `…000000` | Range scans on expiry with no status predicate; the two jobs below always carry a status predicate and use `IDX_accounts_status_expiresAt` instead.                                                                                                      |
| `IDX_accounts_status_expiresAt` | `status`, `expiresAt` | `…006000` | **SchedulerService.runExpiryJob()** — `status IN ('pending_payment','pending_claim') AND expiresAt < NOW()` (TypeORM `LessThan`); **PaymentMonitorService.pollAllAccounts()** — `status = 'pending_payment' AND expiresAt > NOW()` (TypeORM `MoreThan`). |
| `IDX_accounts_status_createdAt` | `status`, `createdAt` | `…006000` | **SchedulerService.runInitializingCleanup()** — `status = 'initializing' AND createdAt < <cutoff>` (TypeORM `LessThan`).                                                                                                                                 |
| `IDX_accounts_createdAt`        | `createdAt`           | `…006000` | No production caller today: audit / time-boxed reporting range scans. Least load-bearing of the high-traffic set.                                                                                                                                        |
| `IDX_accounts_deletedAt`        | `deletedAt`           | `…008000` | Soft-delete predicate (`deletedAt IS NULL`) that TypeORM appends to every `find()` / `findOne()`, including `AccountsService.findOne()`.                                                                                                                 |

`…NNNNNN` abbreviates the migration timestamp prefix; the full names are
`1718100000000-CreateAccountsTable`, `1718100006000-AddHighTrafficIndexes`
and `1718100008000-AddDeletedAtToAccountsTable`.

The three indexes from `1718100006000-AddHighTrafficIndexes` are the ones most
likely to be dropped by mistake: `IDX_accounts_status_expiresAt` serves **two**
pollers in opposite directions (expire-soon rows for the scheduler,
not-yet-expired rows for the payment monitor), and nothing in the migration
file itself references either service. `PaymentMonitorService.pollAllAccounts()`'s
`expiresAt > NOW()` predicate depends on it just as much as the scheduler's
`< NOW()` does. The same mapping is repeated in that migration's header
comment, next to the `CREATE INDEX` statements themselves.

### claims

| Index name             | Columns     | Query served                              |
| ---------------------- | ----------- | ----------------------------------------- |
| `IDX_claims_accountId` | `accountId` | FK lookup when joining claims to accounts |

### webhooks

| Index name              | Columns    | Query served                        |
| ----------------------- | ---------- | ----------------------------------- |
| `IDX_webhooks_isActive` | `isActive` | Filter active webhook subscriptions |

### contract_events

| Index name                                             | Columns                               | Query served                                                         |
| ------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------- |
| `IDX_contract_events_contract_address_ledger_sequence` | `contract_address`, `ledger_sequence` | Events for one contract, ordered by ledger (backward scan = no sort) |
| `IDX_contract_events_event_type_ledger_sequence`       | `event_type`, `ledger_sequence`       | Per-event-type feed over a ledger range                              |
| `IDX_contract_events_ledger_sequence`                  | `ledger_sequence`                     | Ingestion checkpointing, cross-contract ledger range scans           |
| `IDX_contract_events_tx_hash`                          | `tx_hash`                             | Correlate an event back to the transaction that produced it          |

Added by migration `1718100009000`. Before it, the table had only its primary
key on `id`, so every lookup that was not by `id` sequential-scanned an
append-only table (#653).

**These are provisional.** No code queries `contract_events` yet, so the index
set follows the documented access patterns rather than an `EXPLAIN ANALYZE` of
real queries. Re-validate once a consumer lands and drop whichever index earns
nothing — an unused index on an insert-heavy table is pure write amplification.
`IDX_contract_events_tx_hash` is the first to drop if ingestion throughput
becomes the constraint, since it serves human lookups rather than a hot path.

No separate single-column index on `contract_address` or `event_type` is needed:
both composites can be used as left-prefix scans for their leading column.

### contract_events retention and partitioning

`contract_events` is append-only and unbounded — nothing deletes from it, so it
grows for as long as the contract emits events. Indexes keep reads fast but do
nothing about size, and a growing table makes both `VACUUM` and index
maintenance progressively more expensive. Plan for this before the table gets
large rather than after:

1. **Retention first.** Decide how far back events must be queryable. If the
   table is a cache of on-chain data, old rows are re-derivable from Horizon or
   the Soroban RPC and do not need to live here forever. A scheduled delete by
   `ledger_sequence` (not `created_at` — ledger sequence is the authoritative
   ordering) is the simplest effective step, and `SchedulerModule` already hosts
   comparable cleanup jobs.
2. **Then partitioning, if retention is not enough.** Declarative range
   partitioning on `ledger_sequence` turns retention into `DROP TABLE` on an old
   partition instead of a bulk `DELETE` plus `VACUUM`, and lets PostgreSQL prune
   whole partitions for ledger-ranged queries. Note the trade: partitioning
   requires the partition key in the primary key, so `id` alone can no longer be
   the PK — that is a breaking migration and is why it is step 2, not step 1.
3. **Archive before either**, if events are needed for audit beyond the
   retention window: copy to object storage keyed by ledger range, then prune.

### Index design notes (EXPLAIN ANALYZE audit)

- The **composite indexes on `accounts`** use `status` as the leading column because it is a low-cardinality enum (7 values) that prunes the candidate set effectively before the timestamp column filters further. PostgreSQL can also use `IDX_accounts_status_expiresAt` and `IDX_accounts_status_createdAt` as left-prefix scans for status-only queries.
- `IDX_accounts_status` (single-column) is retained alongside the composites to support `EXPLAIN ANALYZE`-verified single-predicate queries.
- All indexes use the default B-tree access method, which supports equality, range (`<`, `>`), and `ORDER BY` optimisations.

## Migration Verification

`test/migrations.integration.runner.ts` provisions a fresh embedded PostgreSQL
database and exercises the whole migration set: `up` in order, `down` back to
zero, then `up` again. Run it with:

```bash
npm run test:migrations
```

It is not part of `npm test` (Jest's `rootDir` is `src/`), so it has to be
invoked explicitly. It verifies:

1. All twelve migrations apply **in the pinned filename order** — the order is
   asserted against a fixed list, so a reordering regression fails the run.
   This matters for the three files sharing the `1718100008000` timestamp
   (`AddDeletedAtToAccountsTable`, `AddPartialSweepToAccountStatus`,
   `CreateClaimAuditLogTable`), whose relative order comes from filename
   comparison rather than from the timestamp itself.
2. The `claims.accountId` and `webhook_deliveries.subscription_id` foreign keys
   are enforced (inserts with orphan UUIDs are rejected).
3. The three high-traffic composite/standalone indexes exist after migration
   `1718100006000`.
4. The `contract_events` table exists with the expected columns and accepts
   inserts after migration `1718100007000`.
5. Reverting every migration, newest first, returns the schema to its prior
   state: no application tables left, `account_status_enum` gone, and the
   `migrations` tracking table empty.
6. Re-running `up` after that full revert restores the same state: the pinned
   order repeats, the `account_status_enum` values and high-traffic indexes
   come back identical, and the entity ↔ schema diff is unchanged. This is
   what catches a `down()` that is missing or only partially reverses its
   `up()`.

Note on `schemaInSync` / `schemaUpQueryCount` in the output: these report
TypeORM's entity ↔ schema diff and are informational, not pass/fail. The diff
is already non-empty on a clean tree because of pre-existing drift unrelated
to the migrations in this folder — `accounts.contractId` (column and
`IDX_accounts_contractId`) exists in the entity but in no migration, and
`claim_audit_log`'s entity declares unnamed `@Index()` decorators while
`CreateClaimAuditLogTable` creates explicitly named indexes, so the diff
proposes renaming them.

`npm run migration:revert` remains the one-step-at-a-time path against a real
database (it reverts only the most recently applied migration per call); see
CONTRIBUTING.md → "Verifying `down()`" for when to use which.

## Foreign Key Cascade Behavior

`claims.accountId` references `accounts.id` with `onDelete: 'CASCADE'`
(`FK_claims_accountId`, set in `1718100001000-CreateClaimsTable` and mirrored
in `src/modules/claims/entities/claim.entity.ts`). This is intentional and
does **not** interact with `accounts` soft-delete: `deletedAt` only sets a
flag and never removes the `accounts` row, so soft-deleting an account never
triggers this FK and existing claims remain intact and queryable. `CASCADE`
only fires on an actual (hard) `DELETE` of an `accounts` row, at which point
its claim records are removed with it rather than being orphaned.
