import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddContractEventIndexes1718100009000
 *
 * Background
 * ──────────
 * CreateContractEventsTable1718100007000 created "contract_events" with a
 * primary key on "id" and nothing else. The table is an append-only index of
 * Soroban contract events, so it only ever grows — every lookup that is not by
 * "id" was a sequential scan (#653).
 *
 * No code queries the table yet, so these indexes come from the documented
 * access patterns rather than from an EXPLAIN ANALYZE of live queries. They
 * should be re-validated once a consumer exists, and any that earn nothing
 * should be dropped — an unused index on a high-insert table is pure write
 * amplification.
 *
 * Index decisions
 * ───────────────
 * • IDX_contract_events_contract_address_ledger_sequence
 *     (contract_address, ledger_sequence)
 *   – The dominant pattern: "events for this contract, most recent first".
 *     contract_address leads because it is the selective equality predicate;
 *     ledger_sequence then orders within it, so PostgreSQL can satisfy
 *     ORDER BY ledger_sequence DESC with a backward index scan and no sort.
 *     Left-prefix scans also cover contract_address-only queries, so no
 *     separate single-column index is needed.
 *
 * • IDX_contract_events_event_type_ledger_sequence
 *     (event_type, ledger_sequence)
 *   – Same shape for per-type feeds ("all transfer events since ledger N").
 *     event_type is low cardinality, so on its own it would prune poorly;
 *     pairing it with ledger_sequence keeps range queries index-only.
 *
 * • IDX_contract_events_ledger_sequence  (single-column)
 *   – Ingestion checkpointing and cross-contract range scans: "resume from
 *     ledger N" must not be forced through one of the composites, whose
 *     leading column would not be constrained.
 *
 * • IDX_contract_events_tx_hash  (single-column)
 *   – Correlates an event back to the transaction that produced it, which is
 *     the main support/debugging lookup.
 *
 * Write cost
 * ──────────
 * Four B-tree indexes on an insert-heavy table is deliberate but not free:
 * each insert maintains all four. That is the trade for not sequential-scanning
 * a table with no upper bound. If ingestion throughput becomes the constraint
 * before read volume does, IDX_contract_events_tx_hash is the first to drop —
 * it serves human lookups, not a hot path.
 *
 * All indexes use the default B-tree access method, which supports equality,
 * range (<, >), and ORDER BY optimisation.
 */
export class AddContractEventIndexes1718100009000 implements MigrationInterface {
  name = 'AddContractEventIndexes1718100009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Per-contract history, newest first
    await queryRunner.query(`
      CREATE INDEX "IDX_contract_events_contract_address_ledger_sequence"
        ON "contract_events" ("contract_address", "ledger_sequence")
    `);

    // Per-event-type feeds over a ledger range
    await queryRunner.query(`
      CREATE INDEX "IDX_contract_events_event_type_ledger_sequence"
        ON "contract_events" ("event_type", "ledger_sequence")
    `);

    // Ingestion checkpoint / cross-contract ledger range scans
    await queryRunner.query(`
      CREATE INDEX "IDX_contract_events_ledger_sequence"
        ON "contract_events" ("ledger_sequence")
    `);

    // Correlate an event back to its transaction
    await queryRunner.query(`
      CREATE INDEX "IDX_contract_events_tx_hash"
        ON "contract_events" ("tx_hash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_contract_events_contract_address_ledger_sequence"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_contract_events_event_type_ledger_sequence"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_contract_events_ledger_sequence"`);
    await queryRunner.query(`DROP INDEX "IDX_contract_events_tx_hash"`);
  }
}
