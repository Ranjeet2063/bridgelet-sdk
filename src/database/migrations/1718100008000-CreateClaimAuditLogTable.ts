import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateClaimAuditLogTable1718100008000 implements MigrationInterface {
  name = 'CreateClaimAuditLogTable1718100008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "claim_audit_log" (
        "id"              uuid                   NOT NULL DEFAULT gen_random_uuid(),
        "accountId"       uuid                   NOT NULL,
        "destinationHash" character varying(64)  NOT NULL,
        "ipHash"          character varying(64),
        "outcome"         character varying(10)  NOT NULL,
        "failureReason"   text,
        "attemptedAt"     TIMESTAMP              NOT NULL DEFAULT now(),
        CONSTRAINT "PK_claim_audit_log" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_claim_audit_log_accountId" ON "claim_audit_log" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_claim_audit_log_attemptedAt" ON "claim_audit_log" ("attemptedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_claim_audit_log_attemptedAt"`);
    await queryRunner.query(`DROP INDEX "IDX_claim_audit_log_accountId"`);
    await queryRunner.query(`DROP TABLE "claim_audit_log"`);
  }
}
