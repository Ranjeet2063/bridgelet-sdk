import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhookDeliveriesTable1718100005000
  implements MigrationInterface
{
  name = 'CreateWebhookDeliveriesTable1718100005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhook_deliveries" (
        "id"                  uuid                   NOT NULL DEFAULT gen_random_uuid(),
        "subscription_id"     uuid                   NOT NULL,
        "event_type"          character varying(255) NOT NULL,
        "payload_hash"        character varying(128) NOT NULL,
        "attempt_count"       integer                NOT NULL DEFAULT 1,
        "last_response_code"  integer,
        "last_response_body"  character varying(2048),
        "delivered_at"        TIMESTAMP,
        "created_at"          TIMESTAMP              NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_webhook_deliveries_subscription_id"
          FOREIGN KEY ("subscription_id")
          REFERENCES "webhooks"("id")
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_webhook_deliveries_subscription_id_created_at"
      ON "webhook_deliveries" ("subscription_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_webhook_deliveries_subscription_id_created_at"
    `);
    await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
  }
}
