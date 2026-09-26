import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Webhook } from './entities/webhook.entity.js';
import { CreateWebhookDto } from './dto/create-webhook.dto.js';
import { UpdateWebhookDto } from './dto/update-webhook.dto.js';
import { WebhookResponseDto } from './dto/webhook-response.dto.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';
import { SecretEncryptionUtil } from '../../common/crypto/secret-encryption.util.js';
import { parsePagination } from '../../common/utils/pagination.util.js';

/**
 * WebhooksService
 *
 * ## Webhook secrets at rest (issue #688)
 *
 * A webhook `secret` is a shared HMAC key: whoever holds it can forge
 * deliveries that your receiver will accept. It is therefore encrypted at rest
 * with the same `SecretEncryptionUtil` + `KmsKeyProvider` envelope used for
 * account secret keys, and decrypted only at the moment a delivery is signed.
 *
 * The plaintext is never returned by any endpoint — `toResponseDto()` omits
 * it entirely — so a leaked database does not let an attacker forge signed
 * deliveries.
 *
 * Rows written before this change hold a plaintext secret. `readSecret()`
 * detects that (the stored value is not a recognised ciphertext format) and
 * uses it as-is, so existing subscriptions keep working. Those rows are
 * re-encrypted the next time the secret is rotated via `PUT /webhooks/:id`.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(Webhook)
    private readonly webhookRepository: Repository<Webhook>,
    private readonly kmsKeyProvider: KmsKeyProvider,
  ) {}

  async create(dto: CreateWebhookDto): Promise<WebhookResponseDto> {
    const webhook = this.webhookRepository.create({
      url: dto.url,
      events: dto.events,
      secret: dto.secret ? this.encryptSecret(dto.secret) : null,
      description: dto.description ?? null,
      isActive: true,
    });
    const saved = await this.webhookRepository.save(webhook);
    return this.toResponseDto(saved);
  }

  /**
   * Returns active subscriptions, paginated.
   *
   * `limit`/`offset` are normalised by `parsePagination`, which rejects
   * non-integer input with a 400 and clamps out-of-range values. Without it a
   * `?limit=abc` reached TypeORM as `NaN` and surfaced as a 500 from the
   * query builder.
   *
   * The explicit `ORDER BY createdAt, id` matters: without a deterministic
   * order PostgreSQL may return matching rows in any order, so a row could
   * appear on two consecutive pages or on neither as the table changes.
   */
  async findAll(
    limit?: number | string,
    offset?: number | string,
  ): Promise<{ webhooks: WebhookResponseDto[]; total: number }> {
    const page = parsePagination(limit, offset);

    const query = this.webhookRepository
      .createQueryBuilder('webhook')
      .where('webhook.isActive = :isActive', { isActive: true })
      .orderBy('webhook.createdAt', 'ASC')
      .addOrderBy('webhook.id', 'ASC')
      .skip(page.offset)
      .take(page.limit);

    const [webhooks, total] = await query.getManyAndCount();
    return { webhooks: webhooks.map((w) => this.toResponseDto(w)), total };
  }

  async update(id: string, dto: UpdateWebhookDto): Promise<WebhookResponseDto> {
    const webhook = await this.webhookRepository.findOne({
      where: { id },
    });

    if (!webhook) {
      throw new NotFoundException(`Webhook with ID ${id} not found`);
    }

    if (dto.url !== undefined) {
      webhook.url = dto.url;
    }

    if (dto.events !== undefined) {
      webhook.events = dto.events;
    }

    if (dto.description !== undefined) {
      webhook.description = dto.description;
    }

    if (dto.isActive !== undefined) {
      webhook.isActive = dto.isActive;
    }

    if (dto.secret !== undefined) {
      webhook.secret = this.encryptSecret(dto.secret);
    }

    const updatedWebhook = await this.webhookRepository.save(webhook);

    return this.toResponseDto(updatedWebhook);
  }

  async remove(id: string): Promise<void> {
    const webhook = await this.webhookRepository.findOne({
      where: { id },
    });

    if (!webhook) {
      throw new NotFoundException(`Webhook with ID ${id} not found`);
    }

    webhook.isActive = false;

    await this.webhookRepository.save(webhook);
  }

  /**
   * Fires an event to all active webhooks subscribed to that event type.
   * Never throws — delivery failures are logged but do not propagate.
   */
  async triggerEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    let webhooks: Webhook[];
    try {
      webhooks = await this.webhookRepository
        .createQueryBuilder('webhook')
        .where('webhook.isActive = :isActive', { isActive: true })
        .andWhere('webhook.events @> :events::jsonb', {
          events: JSON.stringify([eventType]),
        })
        .getMany();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to query webhooks for event ${eventType}: ${msg}`,
      );
      return;
    }

    if (webhooks.length === 0) return;

    await Promise.allSettled(
      webhooks.map((webhook) => this.deliver(webhook, eventType, payload)),
    );
  }

  private async deliver(
    webhook: Webhook,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const secret = this.readSecret(webhook);

    if (secret === undefined) {
      // The stored secret exists but could not be decrypted. Signing with a
      // wrong or empty key would produce a delivery the receiver rejects —
      // or worse, one it cannot distinguish from forgery. Refuse to send.
      this.logger.error(
        `Skipping delivery: event=${eventType}, webhook=${webhook.id}, ` +
          'url=${webhook.url} — the stored secret could not be decrypted. ' +
          'Rotate it with PUT /webhooks/:id to re-encrypt under the current key.',
      );
      return;
    }

    const body = JSON.stringify({ event: eventType, ...payload });
    const signature = this.computeSignature(body, secret);

    const rawAccountId = payload['accountId'];
    const accountId =
      typeof rawAccountId === 'string' ? rawAccountId : 'unknown';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridgelet-Signature': `sha256=${signature}`,
          'X-Bridgelet-Event': eventType,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.error(
          `Webhook delivery failed: event=${eventType}, accountId=${accountId}, ` +
            `url=${webhook.url}, status=${response.status}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Webhook delivery error: event=${eventType}, accountId=${accountId}, ` +
          `url=${webhook.url}, error=${msg}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    try {
      await this.webhookRepository.update(webhook.id, {
        lastTriggeredAt: new Date(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to update lastTriggeredAt for webhook ${webhook.id}: ${msg}`,
      );
    }
  }

  private computeSignature(payload: string, secret: string | null): string {
    return crypto
      .createHmac('sha256', secret ?? '')
      .update(payload)
      .digest('hex');
  }

  /** Encrypts a plaintext secret for storage. */
  private encryptSecret(plaintext: string): string {
    return this.kmsKeyProvider.encrypt(plaintext);
  }

  /**
   * Returns the plaintext signing secret for a delivery, or null when the
   * webhook has no secret configured.
   *
   * Returns `undefined` — distinct from null — when a secret is stored but
   * cannot be decrypted, so the caller can refuse to deliver rather than sign
   * with a bogus key.
   *
   * Tolerates legacy plaintext rows written before secrets were encrypted at
   * rest: a value that is not a recognised ciphertext format is used as-is.
   */
  private readSecret(webhook: Webhook): string | null | undefined {
    const stored = webhook.secret;
    if (!stored) return null;

    const format = SecretEncryptionUtil.classify(stored);
    if (format === 'legacy-base64' || format === 'corrupt') {
      // Pre-encryption row: the column held the plaintext secret.
      return stored;
    }

    try {
      return this.kmsKeyProvider.decrypt(stored);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to decrypt secret for webhook ${webhook.id}: ${msg}`,
      );
      return undefined;
    }
  }

  private toResponseDto(webhook: Webhook): WebhookResponseDto {
    // `secret` is deliberately absent: it is write-only via the API so a
    // leaked response cannot be used to forge signed deliveries.
    return {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      isActive: webhook.isActive,
      description: webhook.description,
      lastTriggeredAt: webhook.lastTriggeredAt,
      createdAt: webhook.createdAt,
    };
  }
}
