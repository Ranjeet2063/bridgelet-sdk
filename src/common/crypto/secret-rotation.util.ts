import {
  SecretEncryptionUtil,
  type SecretFormat,
} from './secret-encryption.util.js';

/**
 * A key ring for a rotation window: the current key plus every key that may
 * still be needed to read rows written before a rotation.
 */
export interface SecretKeyRing {
  /** Id of the key new ciphertext is written with. */
  currentKeyId: string;
  /** Current key material (64-char hex). */
  currentKey: string;
  /**
   * Keys still readable during the rotation window, keyed by id. May be empty
   * when no rotation is in progress.
   */
  previousKeys?: Record<string, string>;
  /**
   * When set, rows are written key-id tagged (`aes256gcm:v2:<keyId>:...`).
   * Leave unset to keep writing v1, which is what a deployment with no
   * rotation in progress wants.
   */
  tagWrites?: boolean;
}

/**
 * SecretRotationUtil
 *
 * The dual-key decrypt path that lets ciphertext written under a previous
 * `ENCRYPTION_KEY` / KMS data key stay readable after a rotation (issue #681).
 *
 * Two mechanisms, because two problems exist:
 *
 *  1. **Untagged rows** (v1, unprefixed, base64-era). These carry no key id,
 *     so the only way to read them is to try the current key and, if that
 *     fails, the previous one. `decryptWithRotation()` does this.
 *  2. **Key-id tagged rows** (`aes256gcm:v2:<keyId>:...`). These name the key
 *     they need, so the correct key is selected directly rather than by trial.
 *
 * During a rotation you want (2): it is unambiguous and it fails loudly with a
 * useful message when the window has closed, instead of silently guessing.
 */
export class SecretRotationUtil {
  /**
   * Builds a `SecretEncryptionUtil.KeyResolver` backed by a key ring.
   */
  static keyResolver(
    ring: SecretKeyRing,
  ): SecretEncryptionUtil.KeyResolver {
    const table: Record<string, string> = {
      ...(ring.previousKeys ?? {}),
      [ring.currentKeyId]: ring.currentKey,
    };
    return (keyId: string) => table[keyId];
  }

  /**
   * Encrypts with the ring's current key, tagging the output when the ring is
   * in tagged mode.
   */
  static encrypt(plaintext: string, ring: SecretKeyRing): string {
    return ring.tagWrites
      ? SecretEncryptionUtil.encryptWithKeyId(
          plaintext,
          ring.currentKey,
          ring.currentKeyId,
        )
      : SecretEncryptionUtil.encrypt(plaintext, ring.currentKey);
  }

  /**
   * Decrypts a value using the whole ring. Handles both tagged and untagged
   * rows, and tries the previous key for untagged rows written before the
   * rotation.
   */
  static decrypt(encryptedString: string, ring: SecretKeyRing): string {
    return SecretEncryptionUtil.decrypt(
      encryptedString,
      ring.currentKey,
      SecretRotationUtil.keyResolver(ring),
    );
  }

  /**
   * Legacy single-previous-key helper, kept for callers that only have the
   * old untagged pair of keys. Prefer {@link decrypt} with a
   * {@link SecretKeyRing}.
   */
  static decryptWithRotation(
    encryptedString: string,
    currentKey: string,
    previousKey?: string,
  ): string {
    try {
      return SecretEncryptionUtil.decrypt(encryptedString, currentKey);
    } catch (currentErr) {
      if (!previousKey) throw currentErr;
      try {
        return SecretEncryptionUtil.decrypt(encryptedString, previousKey);
      } catch {
        throw currentErr;
      }
    }
  }

  /**
   * Re-encrypts a value under a new key. Reads with the old ring, writes with
   * the new one, so this is the operation that lets a rotation window be
   * closed: run it over every row, then drop the previous key.
   */
  static reencrypt(
    encryptedString: string,
    previousKey: string,
    newKey: string,
    options: { keyId?: string } = {},
  ): string {
    const plaintext = SecretEncryptionUtil.decrypt(
      encryptedString,
      previousKey,
    );
    return options.keyId === undefined
      ? SecretEncryptionUtil.encrypt(plaintext, newKey)
      : SecretEncryptionUtil.encryptWithKeyId(
          plaintext,
          newKey,
          options.keyId,
        );
  }

  /**
   * Every key id present in a set of stored values, excluding untagged rows.
   * Operators use this to confirm a rotation window has fully drained before
   * removing a previous key.
   */
  static keyIdsInUse(encryptedValues: string[]): string[] {
    const ids = new Set<string>();
    for (const value of encryptedValues) {
      const keyId = SecretEncryptionUtil.keyIdOf(value);
      if (keyId) ids.add(keyId);
    }
    return [...ids].sort();
  }

  /**
   * Classifies stored values, extended with the key ids in play. Used by the
   * legacy-format audit to report what a rotation would still have to migrate.
   */
  static audit(
    encryptedValues: string[],
  ): {
    total: number;
    byFormat: Record<SecretFormat, number>;
    legacyCount: number;
    keyIdsInUse: string[];
  } {
    const byFormat: Record<SecretFormat, number> = {
      'prefixed-aes-v1': 0,
      'prefixed-aes-v2': 0,
      'unprefixed-aes': 0,
      'legacy-base64': 0,
      corrupt: 0,
    };
    for (const value of encryptedValues) {
      byFormat[SecretEncryptionUtil.classify(value)]++;
    }
    return {
      total: encryptedValues.length,
      byFormat,
      legacyCount:
        byFormat['unprefixed-aes'] + byFormat['legacy-base64'],
      keyIdsInUse: SecretRotationUtil.keyIdsInUse(encryptedValues),
    };
  }
}
