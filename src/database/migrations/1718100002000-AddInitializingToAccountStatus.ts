import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInitializingToAccountStatus1718100002000 implements MigrationInterface {
  name = 'AddInitializingToAccountStatus1718100002000';

  // ALTER TYPE ADD VALUE cannot run inside a transaction on some PostgreSQL
  // versions -- setting transaction = false keeps this migration safe.
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."account_status_enum"
        ADD VALUE 'initializing' BEFORE 'pending_payment'
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
        'pending_payment',
        'pending_claim',
        'claimed',
        'expired',
        'failed'
      )
    `);
    // Remap any rows that were in INITIALIZING back to PENDING_PAYMENT.
    await queryRunner.query(
      `UPDATE "accounts" SET "status" = 'pending_payment' WHERE "status" = 'initializing'`,
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
