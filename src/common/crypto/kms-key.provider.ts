import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from '@aws-sdk/client-kms';
import { SecretEncryptionUtil } from './secret-encryption.util.js';
import {
  loadPersistedEncryptedDataKey,
  persistEncryptedDataKey,
} from './kms-key-persistence.util.js';
import { SecretRotationUtil, type SecretKeyRing } from './secret-rotation.util.js';

/**
 * KmsKeyProvider
 *
 * Wraps SecretEncryptionUtil with AWS KMS envelope encryption.
 *
 * Key hierarchy:
 *   KMS CMK (Customer Master Key) — never leaves AWS
 *     └─ Data Key (AES-256) — generated once, then persisted encrypted
 *
 * ## Data key persistence (issue #680)
 *
 * The plaintext data key is held in memory only. Its *encrypted* blob is
 * persisted (KMS_ENCRYPTED_DATA_KEY, else `KMS_DATA_KEY_PATH`, else a local
 * file) and re-loaded on the next start, so the same data key survives a
 * restart. Previously every restart called GenerateDataKey again, which meant
 * rows written under the previous data key became undecryptable — and since
 * SecretEncryptionUtil had no versioned-key support at the time, permanently
 * so. Persisting the blob is what makes those rows readable again.
 *
 * A durable backend (AWS Systems Manager Parameter Store / Secrets Manager)
 * should replace the local file for multi-instance deployments; until then the
 * blob path is configurable and the plaintext is never written to disk.
 *
 * ## Key rotation (issue #681)
 *
 * Reads go through {@link SecretRotationUtil}, so a rotation window can keep
 * previous keys readable. Set `ENCRYPTION_KEY_PREVIOUS` (fallback path) to keep
 * old ciphertexts decryptable while rows are re-encrypted.
 *
 * Environment variables:
 *   KMS_KEY_ID           - ARN or alias of the KMS CMK (required when KMS enabled)
 *   KMS_ENABLED          - set to 'false' to fall back to ENCRYPTION_KEY (default: true)
 *   AWS_REGION           - AWS region for KMS (default: us-east-1)
 *   KMS_ENCRYPTED_DATA_KEY - persisted base64 blob of the wrapped data key
 *   KMS_DATA_KEY_PATH    - file to persist the wrapped data key to
 *   ENCRYPTION_KEY_PREVIOUS - previous AES key, for the non-KMS rotation path
 */
@Injectable()
export class KmsKeyProvider implements OnModuleInit {
  private readonly logger = new Logger(KmsKeyProvider.name);
  private plaintextKey: string | null = null;
  private readonly kmsEnabled: boolean;
  private readonly kmsKeyId: string | undefined;
  private readonly fallbackKey: string;
  private readonly kmsClient: KMSClient;

  constructor(private readonly configService: ConfigService) {
    this.kmsEnabled = this.configService.getOrThrow<boolean>('app.kmsEnabled');
    this.kmsKeyId = this.configService.get<string>('app.kmsKeyId');
    this.fallbackKey = this.configService.getOrThrow<string>(
      'stellar.encryptionKey',
    );
    this.kmsClient = new KMSClient({
      region: this.configService.getOrThrow<string>('app.awsRegion'),
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.kmsEnabled || !this.kmsKeyId) {
      this.logger.warn(
        'KMS disabled or KMS_KEY_ID not set — using ENCRYPTION_KEY fallback',
      );
      return;
    }
    await this.loadDataKey();
  }

  /** Returns the active AES-256 key as a 64-char hex string. */
  getEncryptionKey(): string {
    return this.plaintextKey ?? this.fallbackKey;
  }

  /**
   * The key ring used for reads. `tagWrites` is left off by default so a
   * deployment with no rotation in progress keeps writing the v1 format it
   * already knows how to read.
   */
  getKeyRing(): SecretKeyRing {
    const previousKey = this.configService.get<string>(
      'app.encryptionKeyPrevious',
    );
    const keyId = this.configService.get<string>('app.encryptionKeyId');
    return {
      currentKeyId: keyId ?? 'current',
      currentKey: this.getEncryptionKey(),
      ...(previousKey ? { previousKeys: { previous: previousKey } } : {}),
      ...(keyId ? { tagWrites: true } : {}),
    };
  }

  encrypt(plaintext: string): string {
    return SecretRotationUtil.encrypt(plaintext, this.getKeyRing());
  }

  decrypt(encrypted: string): string {
    return SecretRotationUtil.decrypt(encrypted, this.getKeyRing());
  }

  /**
   * Loads the data key, preferring the persisted encrypted blob so the same
   * envelope key is reused across restarts. Falls back to generating and
   * persisting a new one on first run.
   */
  private async loadDataKey(): Promise<void> {
    const persisted = loadPersistedEncryptedDataKey();
    if (persisted) {
      try {
        this.plaintextKey = await this.decryptDataKey(
          Buffer.from(persisted, 'base64'),
        );
        this.logger.log(
          'KMS data key restored from the persisted encrypted blob',
        );
        return;
      } catch (err) {
        // A blob we cannot unwrap (wrong CMK, rotated-away key, corrupted
        // file) must not silently fall through to generating a new data key:
        // that would make every existing row undecryptable and look like
        // success. Fail loudly and leave the fallback key in place.
        this.logger.error(
          `Failed to unwrap the persisted KMS data key: ${(err as Error).message}. ` +
            'Refusing to generate a new data key, because doing so would make ' +
            'every secret encrypted under the previous one permanently ' +
            'undecryptable. Set KMS_ENCRYPTED_DATA_KEY to a blob wrapped by ' +
            'KMS_KEY_ID, or clear it to intentionally start fresh (draining all ' +
            'existing accounts first).',
        );
        return;
      }
    }

    try {
      const cmd = new GenerateDataKeyCommand({
        KeyId: this.kmsKeyId,
        KeySpec: 'AES_256',
      });
      const response = await this.kmsClient.send(cmd);

      if (!response.Plaintext) {
        throw new Error('KMS GenerateDataKey returned no plaintext');
      }

      this.plaintextKey = Buffer.from(response.Plaintext).toString('hex');

      if (response.CiphertextBlob) {
        try {
          persistEncryptedDataKey(
            Buffer.from(response.CiphertextBlob).toString('base64'),
          );
          this.logger.log(
            'KMS data key generated and persisted for reuse across restarts',
          );
        } catch (persistErr) {
          // Persistence is best-effort: a read-only filesystem should not stop
          // the service from booting, but the operator must know that the next
          // restart will produce a different data key.
          this.logger.error(
            `Failed to persist the KMS data key: ${(persistErr as Error).message}. ` +
              'The service will run, but the data key will be regenerated on the ' +
              'next restart and existing secrets will become undecryptable. Set ' +
              'KMS_DATA_KEY_PATH to a writable path, or manage ' +
              'KMS_ENCRYPTED_DATA_KEY out of band.',
          );
        }
      }

      this.logger.log('KMS data key loaded successfully');
    } catch (err) {
      this.logger.error(
        `Failed to load KMS data key: ${(err as Error).message}. Falling back to ENCRYPTION_KEY`,
      );
    }
  }

  /** Re-wraps an existing encrypted data key blob from KMS. Used for key rotation. */
  async decryptDataKey(encryptedKey: Uint8Array): Promise<string> {
    const cmd = new DecryptCommand({
      KeyId: this.kmsKeyId,
      CiphertextBlob: encryptedKey,
    });
    const response = await this.kmsClient.send(cmd);
    if (!response.Plaintext) {
      throw new Error('KMS Decrypt returned no plaintext');
    }
    return Buffer.from(response.Plaintext).toString('hex');
  }

  /**
   * Classifies stored ciphertext, so operators can see which formats and key
   * ids remain before removing a legacy branch or closing a rotation window.
   * Re-exported here so callers holding a KmsKeyProvider do not need a second
   * import.
   */
  static audit(encryptedValues: string[]) {
    return SecretRotationUtil.audit(encryptedValues);
  }
}

export { SecretEncryptionUtil };
