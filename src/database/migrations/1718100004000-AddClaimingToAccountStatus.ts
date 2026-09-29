import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClaimingToAccountStatus1718100004000 implements MigrationInterface {
  name = 'AddClaimingToAccountStatus1718100004000';

  // ALTER TYPE ADD VALUE cannot run inside a transaction on some PostgreSQL
  // versions -- setting transaction = false keeps this migration safe.
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."account_status_enum"
        ADD VALUE 'claiming' AFTER 'pending_claim'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL has no DROP VALUE -- must recreate the enum type.
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" TYPE text USING "status"::text`,
    );
    await queryRunner.query(`DROP TYPE "public"."account_status_enum"`);
    await queryRunner.query(`
      CREATE TYPE "public"."account_status_enum" AS ENUM(
        'initializing',
        'pending_payment',
        'pending_claim',
        'claimed',
        'expired',
        'failed'
      )
    `);
    await queryRunner.query(
      `UPDATE "accounts" SET "status" = 'pending_claim' WHERE "status" = 'claiming'`,
    );
    await queryRunner.query(`
      ALTER TABLE "accounts"
        ALTER COLUMN "status" TYPE "public"."account_status_enum"
        USING "status"::"public"."account_status_enum"
    `);
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" SET DEFAULT 'pending_payment'`,
    );
  }
}
