import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateContractEventsTable1718100007000 implements MigrationInterface {
  name = 'CreateContractEventsTable1718100007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "contract_events" (
        "id"                uuid                   NOT NULL DEFAULT gen_random_uuid(),
        "event_type"        character varying(255) NOT NULL,
        "contract_address"  character varying(128) NOT NULL,
        "ledger_sequence"   bigint                 NOT NULL,
        "tx_hash"           character varying(64)  NOT NULL,
        "payload"           jsonb                  NOT NULL DEFAULT '{}'::jsonb,
        "created_at"        TIMESTAMP              NOT NULL DEFAULT now(),
        CONSTRAINT "PK_contract_events" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "contract_events"`);
  }
}
