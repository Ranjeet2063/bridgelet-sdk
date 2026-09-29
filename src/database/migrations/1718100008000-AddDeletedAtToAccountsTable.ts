import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeletedAtToAccountsTable1718100008000 implements MigrationInterface {
  name = 'AddDeletedAtToAccountsTable1718100008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "accounts"
        ADD COLUMN "deletedAt" timestamp NULL
    `);

    // Index to keep soft-delete filtering fast on high-traffic queries,
    // mirroring the style of 1718100006000-AddHighTrafficIndexes.
    await queryRunner.query(`
      CREATE INDEX "IDX_accounts_deletedAt" ON "accounts" ("deletedAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_accounts_deletedAt"
    `);

    await queryRunner.query(`
      ALTER TABLE "accounts"
        DROP COLUMN "deletedAt"
    `);
  }
}
