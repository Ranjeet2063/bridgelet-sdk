import {
  SecretEncryptionUtil,
  type SecretFormat,
} from './secret-encryption.util.js';
import { SecretRotationUtil, type SecretKeyRing } from './secret-rotation.util.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const PLAINTEXT = 'SBPQ2EXAMPLE_SECRET_KEY_1234567890ABCDEFGHIJKLMNOP';

describe('key-id tagged ciphertext (issue #681)', () => {
  describe('encryptWithKeyId', () => {
    it('emits the v2 format with the key id embedded', () => {
      const out = SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_A, 'k1');
      expect(out.startsWith('aes256gcm:v2:k1:')).toBe(true);
      expect(SecretEncryptionUtil.classify(out)).toBe('prefixed-aes-v2');
      expect(SecretEncryptionUtil.keyIdOf(out)).toBe('k1');
    });

    it('falls back to v1 when no key id is supplied', () => {
      // Backwards compatibility: a deployment with no rotation in progress
      // must keep writing the format it already knows how to read.
      const out = SecretEncryptionUtil.encrypt(PLAINTEXT, KEY_A);
      expect(out.startsWith('aes256gcm:v1:')).toBe(true);
      expect(SecretEncryptionUtil.classify(out)).toBe('prefixed-aes-v1');
      expect(SecretEncryptionUtil.keyIdOf(out)).toBeNull();
    });

    it('produces a distinct ciphertext per call, as v1 does', () => {
      const a = SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_A, 'k1');
      const b = SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_A, 'k1');
      expect(a).not.toBe(b);
    });

    it.each(['', 'has:colon', 'a'.repeat(65), 'sp ace'])(
      'rejects an unusable key id: %p',
      (keyId) => {
        expect(() =>
          SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_A, keyId),
        ).toThrow(/Invalid keyId/);
      },
    );
  });

  describe('decrypt with a key ring', () => {
    it('round-trips a tagged value with its own key', () => {
      const ring = { currentKeyId: 'k1', currentKey: KEY_A, tagWrites: true };
      const ct = SecretRotationUtil.encrypt(PLAINTEXT, ring);
      expect(SecretRotationUtil.decrypt(ct, ring)).toBe(PLAINTEXT);
    });

    it('selects the previous key by id during a rotation window', () => {
      // Ciphertext written under k1 while k2 is now current.
      const old = { currentKeyId: 'k1', currentKey: KEY_A, tagWrites: true };
      const ct = SecretRotationUtil.encrypt(PLAINTEXT, old);

      const rotated: SecretKeyRing = {
        currentKeyId: 'k2',
        currentKey: KEY_B,
        previousKeys: { k1: KEY_A },
      };
      expect(SecretRotationUtil.decrypt(ct, rotated)).toBe(PLAINTEXT);
    });

    it('does NOT fall back to the current key for an unknown key id', () => {
      // The whole point of tagging: an unknown id must fail loudly rather than
      // be silently mis-decoded with whatever key happens to be loaded.
      const old = { currentKeyId: 'k1', currentKey: KEY_A, tagWrites: true };
      const ct = SecretRotationUtil.encrypt(PLAINTEXT, old);

      expect(() =>
        SecretRotationUtil.decrypt(ct, { currentKeyId: 'k2', currentKey: KEY_B }),
      ).toThrow(/unknown key id "k1"/);
    });

    it('throws a distinct error when no key ring is supplied at all', () => {
      const ct = SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_A, 'k1');
      expect(() => SecretEncryptionUtil.decrypt(ct, KEY_A)).toThrow(
        /no key ring was supplied/,
      );
    });

    it('rejects a malformed v2 body', () => {
      // keyId present but only 3 parts instead of 4.
      const malformed = `aes256gcm:v2:k1:${'0'.repeat(32)}:${'0'.repeat(32)}`;
      const ring = { currentKeyId: 'k1', currentKey: KEY_A };
      expect(() => SecretRotationUtil.decrypt(malformed, ring)).toThrow(
        /expected 4 colon-separated parts/,
      );
    });

    it('rejects an empty key id', () => {
      const malformed = `aes256gcm:v2::${'0'.repeat(32)}:${'0'.repeat(32)}:${'0'.repeat(8)}`;
      const ring = { currentKeyId: 'k1', currentKey: KEY_A };
      expect(() => SecretRotationUtil.decrypt(malformed, ring)).toThrow(
        /keyId is empty/,
      );
    });
  });

  describe('untagged rows keep working', () => {
    it('decrypts a v1 row through the same ring API', () => {
      const ct = SecretEncryptionUtil.encrypt(PLAINTEXT, KEY_A);
      const ring = { currentKeyId: 'k2', currentKey: KEY_B };
      // v1 rows are not tagged, so the current key is the only candidate.
      expect(SecretRotationUtil.decrypt(ct, ring)).toBe(PLAINTEXT);
    });

    it('fails a v1 row written under a different key', () => {
      const ct = SecretEncryptionUtil.encrypt(PLAINTEXT, KEY_A);
      expect(() =>
        SecretRotationUtil.decrypt(ct, { currentKeyId: 'k2', currentKey: KEY_B }),
      ).toThrow();
    });

    it('still rejects a legacy base64 row', () => {
      const base64 = Buffer.from(PLAINTEXT).toString('base64');
      expect(() =>
        SecretRotationUtil.decrypt(base64, {
          currentKeyId: 'k1',
          currentKey: KEY_A,
        }),
      ).toThrow(/migrate:secrets/);
    });

    it('still rejects an unknown future version', () => {
      expect(() =>
        SecretEncryptionUtil.decrypt(`aes256gcm:v9:${'0'.repeat(32)}`, KEY_A),
      ).toThrow(/not supported by this build/);
    });
  });
});

describe('classify', () => {
  it('classifies a fresh v1 value', () => {
    const ct = SecretEncryptionUtil.encrypt(PLAINTEXT, KEY_A);
    expect(SecretEncryptionUtil.classify(ct)).toBe('prefixed-aes-v1');
  });

  it('classifies a fresh tagged v2 value', () => {
    const ct = SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_A, 'k1');
    expect(SecretEncryptionUtil.classify(ct)).toBe('prefixed-aes-v2');
  });

  it('classifies a truncated v2 body as corrupt, not as a valid v2', () => {
    const corrupt = `aes256gcm:v2:k1:${'0'.repeat(32)}`;
    expect(SecretEncryptionUtil.classify(corrupt)).toBe('corrupt');
    expect(SecretEncryptionUtil.keyIdOf(corrupt)).toBeNull();
  });

  it('classifies a v2 body with a bad key id as corrupt', () => {
    const body = `${'0'.repeat(32)}:${'0'.repeat(32)}:${'0'.repeat(8)}`;
    expect(SecretEncryptionUtil.classify(`aes256gcm:v2:bad id:${body}`)).toBe(
      'corrupt',
    );
  });
});

describe('reencrypt', () => {
  it('moves a v1 row to a tagged v2 row under the new key', () => {
    const old = SecretEncryptionUtil.encrypt(PLAINTEXT, KEY_A);
    const moved = SecretRotationUtil.reencrypt(old, KEY_A, KEY_B, {
      keyId: 'k2',
    });
    expect(SecretEncryptionUtil.classify(moved)).toBe('prefixed-aes-v2');
    expect(
      SecretRotationUtil.decrypt(moved, { currentKeyId: 'k2', currentKey: KEY_B }),
    ).toBe(PLAINTEXT);
  });

  it('stays on v1 when no key id is given', () => {
    const old = SecretEncryptionUtil.encrypt(PLAINTEXT, KEY_A);
    const moved = SecretRotationUtil.reencrypt(old, KEY_A, KEY_B);
    expect(SecretEncryptionUtil.classify(moved)).toBe('prefixed-aes-v1');
  });
});

describe('audit', () => {
  it('counts every format and reports the key ids in use', () => {
    const values = [
      SecretEncryptionUtil.encrypt(PLAINTEXT, KEY_A), // prefixed-aes-v1
      SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_A, 'k1'),
      SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_B, 'k2'),
      Buffer.from(PLAINTEXT).toString('base64'), // legacy-base64
      'garbage', // legacy-base64 (not parseable as AES)
    ];

    const result = SecretRotationUtil.audit(values);
    expect(result.total).toBe(5);
    expect(result.byFormat['prefixed-aes-v1']).toBe(1);
    expect(result.byFormat['prefixed-aes-v2']).toBe(2);
    expect(result.byFormat['legacy-base64']).toBe(2);
    expect(result.keyIdsInUse).toEqual(['k1', 'k2']);
    // Untagged legacy rows keep the decrypt branches load-bearing.
    expect(result.legacyCount).toBe(2);
  });

  it('reports no legacy rows once everything is migrated', () => {
    const values = [
      SecretEncryptionUtil.encrypt(PLAINTEXT, KEY_A),
      SecretEncryptionUtil.encryptWithKeyId(PLAINTEXT, KEY_A, 'k1'),
    ];
    const result = SecretRotationUtil.audit(values);
    expect(result.legacyCount).toBe(0);
  });

  it('treats an unprefixed AES row as legacy', () => {
    // The pre-v1 on-disk shape, minus the prefix.
    const body = `${'0'.repeat(32)}:${'0'.repeat(32)}:${PLAINTEXT
      .split('')
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')}`;
    const result = SecretRotationUtil.audit([body]);
    expect(result.byFormat['unprefixed-aes']).toBe(1);
    expect(result.legacyCount).toBe(1);
  });
});

describe('SecretFormat union', () => {
  it('includes every bucket the audit can return', () => {
    const formats: SecretFormat[] = [
      'prefixed-aes-v1',
      'prefixed-aes-v2',
      'unprefixed-aes',
      'legacy-base64',
      'corrupt',
    ];
    expect(formats).toHaveLength(5);
  });
});
