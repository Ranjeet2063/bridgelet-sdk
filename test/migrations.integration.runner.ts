import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import EmbeddedPostgres from 'embedded-postgres';
import { DataSource } from 'typeorm';
import { Account } from '../src/modules/accounts/entities/account.entity.js';
import { Claim } from '../src/modules/claims/entities/claim.entity.js';
import { ClaimAuditLog } from '../src/modules/claims/entities/claim-audit-log.entity.js';
import { ContractEvent } from '../src/modules/stellar/entities/contract-event.entity.js';
import { WebhookDelivery } from '../src/modules/webhooks/entities/webhook-delivery.entity.js';
import { Webhook } from '../src/modules/webhooks/entities/webhook.entity.js';
import { CreateAccountsTable1718100000000 } from '../src/database/migrations/1718100000000-CreateAccountsTable.js';
import { CreateClaimsTable1718100001000 } from '../src/database/migrations/1718100001000-CreateClaimsTable.js';
import { AddInitializingToAccountStatus1718100002000 } from '../src/database/migrations/1718100002000-AddInitializingToAccountStatus.js';
import { CreateWebhooksTable1718100003000 } from '../src/database/migrations/1718100003000-CreateWebhooksTable.js';
import { AddClaimingToAccountStatus1718100004000 } from '../src/database/migrations/1718100004000-AddClaimingToAccountStatus.js';
import { CreateWebhookDeliveriesTable1718100005000 } from '../src/database/migrations/1718100005000-CreateWebhookDeliveriesTable.js';
import { AddHighTrafficIndexes1718100006000 } from '../src/database/migrations/1718100006000-AddHighTrafficIndexes.js';
import { CreateContractEventsTable1718100007000 } from '../src/database/migrations/1718100007000-CreateContractEventsTable.js';
import { AddDeletedAtToAccountsTable1718100008000 } from '../src/database/migrations/1718100008000-AddDeletedAtToAccountsTable.js';
import { CreateClaimAuditLogTable1718100008000 } from '../src/database/migrations/1718100008000-CreateClaimAuditLogTable.js';
import { AddPartialSweepToAccountStatus1718100008000 } from '../src/database/migrations/1718100008000-AddPartialSweepToAccountStatus.js';
import { AddContractEventIndexes1718100009000 } from '../src/database/migrations/1718100009000-AddContractEventIndexes.js';

const postgresUser = 'postgres';
const postgresPassword = 'postgres';
const postgresDatabase = 'bridgelet_test';

// Note (issue #517): 1718100008000-AddDeletedAtToAccountsTable,
// 1718100008000-AddPartialSweepToAccountStatus, and
// 1718100008000-CreateClaimAuditLogTable all share the exact same numeric
// timestamp. TypeORM sorts migrations by timestamp with a stable sort
// (MigrationExecutor.getMigrations), so ties are broken by array order —
// which in production comes from `glob`'s alphabetical file listing
// (CONTRIBUTING.md "Notes on timestamps" documents this exact order and
// explicitly says NOT to renumber these files, since environments that
// already recorded these migration names would try to re-run them under
// new names). This array matches that documented order so the round-trip
// check below reflects real execution order, not just "a" valid order.
// None of the three depends on the others (no FK or column overlap), so
// this ordering choice doesn't change correctness — it's for fidelity.
const migrations = [
  CreateAccountsTable1718100000000,
  CreateClaimsTable1718100001000,
  AddInitializingToAccountStatus1718100002000,
  CreateWebhooksTable1718100003000,
  AddClaimingToAccountStatus1718100004000,
  CreateWebhookDeliveriesTable1718100005000,
  AddHighTrafficIndexes1718100006000,
  CreateContractEventsTable1718100007000,
  AddDeletedAtToAccountsTable1718100008000,
  AddPartialSweepToAccountStatus1718100008000,
  CreateClaimAuditLogTable1718100008000,
  AddContractEventIndexes1718100009000,
];

type SqlInMemoryLog = {
  upQueries: unknown[];
};

type IndexRow = { indexname: string };

type PgErrorLike = {
  code?: string;
};

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address == null || typeof address === 'string') {
        reject(
          new Error('Unable to allocate a local port for migration checks.'),
        );
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function main(): Promise<void> {
  const port = await getFreePort();
  const postgresDataDir = await mkdtemp(
    path.join(os.tmpdir(), 'bridgelet-migrations-'),
  );
  const postgresServer = new EmbeddedPostgres({
    databaseDir: postgresDataDir,
    port,
    user: postgresUser,
    password: postgresPassword,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });

  let dataSource: DataSource | null = null;

  try {
    await postgresServer.initialise();
    await postgresServer.start();
    await postgresServer.createDatabase(postgresDatabase);

    dataSource = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port,
      username: postgresUser,
      password: postgresPassword,
      database: postgresDatabase,
      entities: [
        Account,
        Claim,
        ClaimAuditLog,
        Webhook,
        WebhookDelivery,
        ContractEvent,
      ],
      migrations,
      migrationsTransactionMode: 'each',
      synchronize: false,
    });

    await dataSource.initialize();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    const executedMigrations = await dataSource.runMigrations();
    const schemaLog = await (
      dataSource.driver.createSchemaBuilder() as unknown as {
        log: () => Promise<SqlInMemoryLog>;
      }
    ).log();
    console.error(
      'DEBUG upQueries:',
      JSON.stringify(
        (schemaLog.upQueries as Array<{ query: string }>).map((q) => q.query),
        null,
        2,
      ),
    );

    const enumRows: Array<{ enumlabel: string }> = await dataSource.query(`
      SELECT e.enumlabel
      FROM pg_type t
      INNER JOIN pg_enum e ON e.enumtypid = t.oid
      INNER JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname = 'account_status_enum'
      ORDER BY e.enumsortorder
    `);

    const queryRunner = dataSource.createQueryRunner();
    let foreignKeyColumns: string[][] = [];
    let contractEventColumns: string[] = [];
    let foreignKeyRejected = false;
    let contractEventInsertSucceeded = false;
    let deliveryForeignKeyColumns: string[][] = [];
    let deliveryForeignKeyRejected = false;
    let deliveryIndexes: string[][] = [];

    try {
      const claimsTable = await queryRunner.getTable('claims');
      foreignKeyColumns =
        claimsTable?.foreignKeys.map((foreignKey) => foreignKey.columnNames) ??
        [];

      const webhookDeliveriesTable =
        await queryRunner.getTable('webhook_deliveries');
      deliveryForeignKeyColumns =
        webhookDeliveriesTable?.foreignKeys.map(
          (foreignKey) => foreignKey.columnNames,
        ) ?? [];
      deliveryIndexes =
        webhookDeliveriesTable?.indices.map((index) => index.columnNames) ?? [];

      const contractEventsTable = await queryRunner.getTable('contract_events');
      contractEventColumns =
        contractEventsTable?.columns.map((column) => column.name) ?? [];
    } finally {
      await queryRunner.release();
    }

    try {
      await dataSource.query(
        `
          INSERT INTO "claims" (
            "accountId",
            "destinationAddress",
            "sweepTxHash",
            "amountSwept",
            "asset",
            "claimedAt"
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
        `,
        [
          randomUUID(),
          'GBRPYHIL2C6LYK7D5QXHZJ5M5XT4QSLVQOQ43I6QJVU4YQ5N3B7V4XYZ',
          'a'.repeat(64),
          '1.0000000',
          'USDC',
        ],
      );
    } catch (error) {
      const pgError = error as PgErrorLike;
      foreignKeyRejected =
        typeof error === 'object' && error !== null && pgError.code === '23503';
    }

    try {
      await dataSource.query(
        `
          INSERT INTO "webhook_deliveries" (
            "subscription_id",
            "event_type",
            "payload_hash"
          )
          VALUES ($1, $2, $3)
        `,
        [randomUUID(), 'account.created', 'b'.repeat(64)],
      );
    } catch (error) {
      const pgError = error as PgErrorLike;
      deliveryForeignKeyRejected =
        typeof error === 'object' && error !== null && pgError.code === '23503';
    }

    await dataSource.query(
      `
        INSERT INTO "contract_events" (
          "event_type",
          "contract_address",
          "ledger_sequence",
          "tx_hash",
          "payload"
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        'transfer',
        'CBKQ7J6M7YJQ4ZQOZ6M7K6F5Y5N7D7C6B5A4Z3Y2X1W0V9U8T7S6R5Q4',
        12345,
        'b'.repeat(64),
        JSON.stringify({ amount: '1.0000000', asset: 'USDC' }),
      ],
    );
    contractEventInsertSucceeded = true;

    const indexRows: IndexRow[] = await dataSource.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'accounts'
        AND indexname IN (
          'IDX_accounts_status_expiresAt',
          'IDX_accounts_status_createdAt',
          'IDX_accounts_createdAt'
        )
      ORDER BY indexname
    `);
    const highTrafficIndexes = indexRows.map(({ indexname }) => indexname);

    const auditLogIndexRows: IndexRow[] = await dataSource.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'claim_audit_log'
        AND indexname IN (
          'IDX_claim_audit_log_accountId',
          'IDX_claim_audit_log_attemptedAt'
        )
      ORDER BY indexname
    `);
    const claimAuditLogIndexes = auditLogIndexRows.map(
      ({ indexname }) => indexname,
    );

    // --- Issue #517: migration down() round-trip ---------------------
    // Roll back every applied migration, one at a time in reverse order
    // (dataSource.undoLastMigration() reverts exactly the most recently
    // applied migration each call), then verify the schema has actually
    // returned to its pre-migration state: no application tables left
    // behind, the custom enum type gone, and the migrations tracking
    // table itself empty.
    let rollbackError: string | null = null;
    const revertedMigrationNames: string[] = [];

    for (let i = 0; i < executedMigrations.length; i++) {
      try {
        await dataSource.undoLastMigration({ transaction: 'each' });
      } catch (error) {
        rollbackError = `Failed reverting migration #${
          executedMigrations.length - i
        } (${executedMigrations[executedMigrations.length - 1 - i]?.name ?? 'unknown'}): ${
          error instanceof Error ? error.message : String(error)
        }`;
        break;
      }
      revertedMigrationNames.push(
        executedMigrations[executedMigrations.length - 1 - i].name,
      );
    }

    const remainingTableRows: Array<{ tablename: string }> =
      await dataSource.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);
    const remainingTables = remainingTableRows.map(
      ({ tablename }) => tablename,
    );

    const remainingEnumRows: Array<{ typname: string }> =
      await dataSource.query(`
      SELECT typname
      FROM pg_type
      WHERE typname = 'account_status_enum'
    `);

    const migrationsTableRowCountRows: Array<{ count: string }> =
      await dataSource.query(
        `SELECT COUNT(*)::text AS count FROM "migrations"`,
      );
    const migrationsTableRowCount = parseInt(
      migrationsTableRowCountRows[0]?.count ?? '-1',
      10,
    );

    // Full rollback should leave exactly the "migrations" tracking table
    // behind (TypeORM never drops its own tracking table), empty, with no
    // application tables or the custom enum type remaining.
    const rollbackReturnedToPriorState =
      rollbackError === null &&
      revertedMigrationNames.length === executedMigrations.length &&
      remainingTables.length === 1 &&
      remainingTables[0] === 'migrations' &&
      remainingEnumRows.length === 0 &&
      migrationsTableRowCount === 0;

    process.stdout.write(
      JSON.stringify({
        enumValues: enumRows.map(({ enumlabel }) => enumlabel),
        executedMigrationNames: executedMigrations.map(({ name }) => name),
        foreignKeyColumns,
        foreignKeyRejected,
        contractEventColumns,
        contractEventInsertSucceeded,
        deliveryForeignKeyColumns,
        deliveryForeignKeyRejected,
        deliveryIndexes,
        schemaInSync: schemaLog.upQueries.length === 0,
        highTrafficIndexes,
        claimAuditLogIndexes,
        rollbackError,
        revertedMigrationNames,
        remainingTablesAfterRollback: remainingTables,
        rollbackReturnedToPriorState,
      }),
    );

    // Issue #517: this is the actual pass/fail assertion for the down()
    // round-trip, not just informational JSON. A non-zero exit here is
    // meant to fail a CI step running this script.
    if (!rollbackReturnedToPriorState) {
      throw new Error(
        `Migration down() round-trip did not return the schema to its ` +
          `prior state. rollbackError=${rollbackError ?? 'none'}, ` +
          `reverted=${revertedMigrationNames.length}/${executedMigrations.length}, ` +
          `remainingTables=${JSON.stringify(remainingTables)}, ` +
          `accountStatusEnumStillExists=${remainingEnumRows.length > 0}, ` +
          `migrationsTableRowCount=${migrationsTableRowCount}`,
      );
    }
  } finally {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await postgresServer.stop();
    await rm(postgresDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  // Issue #517: process.exitCode alone was observed to not reliably
  // propagate to the shell's exit code when this script is invoked
  // through an ESM loader (e.g. `node --loader ts-node/esm`), which would
  // silently defeat the point of an automated pass/fail check. Call
  // process.exit explicitly so a failure here actually fails the
  // invoking command/CI step.
  process.exitCode = 1;
  process.exit(1);
});
