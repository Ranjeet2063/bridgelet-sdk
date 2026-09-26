import { readFileSync, writeFileSync, existsSync } from 'fs';

/**
 * KmsDataKeyStore
 *
 * Persists the KMS-encrypted data key blob to a local file so the same
 * envelope key survives process restarts instead of being regenerated
 * every time (see issue #619). Durable-store side of KmsKeyProvider until
 * a Parameter Store / Secrets Manager backend replaces it.
 */
const DEFAULT_PATH = process.env.KMS_DATA_KEY_PATH ?? '.kms-data-key';

export function loadPersistedEncryptedDataKey(
  path: string = DEFAULT_PATH,
): string | null {
  if (process.env.KMS_ENCRYPTED_DATA_KEY) {
    return process.env.KMS_ENCRYPTED_DATA_KEY;
  }
  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }
  return null;
}

export function persistEncryptedDataKey(
  encryptedKeyBase64: string,
  path: string = DEFAULT_PATH,
): void {
  writeFileSync(path, encryptedKeyBase64, { mode: 0o600 });
}
