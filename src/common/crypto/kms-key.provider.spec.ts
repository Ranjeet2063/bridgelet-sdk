import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KmsKeyProvider } from './kms-key.provider.js';
import { SecretEncryptionUtil } from './secret-encryption.util.js';
import {
  loadPersistedEncryptedDataKey,
  persistEncryptedDataKey,
} from './kms-key-persistence.util.js';

const FALLBACK_KEY = 'a'.repeat(64);

/**
 * Issue #680 — the KMS data key must survive a restart.
 *
 * These tests cover the load order in KmsKeyProvider.loadDataKey():
 * persisted blob -> generate-and-persist -> fail loudly rather than
 * regenerate when a blob exists but cannot be unwrapped.
 */
const mockConfigService = {
  getOrThrow: jest.fn().mockReturnValue(FALLBACK_KEY),
  get: jest.fn().mockReturnValue(undefined),
};

// Mock the KMS client at module level. `__send` is created once and shared by
// every instance the constructor hands back, so a test can reach the exact
// `send` the provider under test uses.
jest.mock('@aws-sdk/client-kms', () => {
  const send = jest.fn();
  return {
    __send: send,
    KMSClient: jest.fn().mockImplementation(() => ({ send })),
    GenerateDataKeyCommand: jest.fn().mockImplementation((input) => input),
    DecryptCommand: jest.fn().mockImplementation((input) => input),
  };
});

/** The shared `send` mock backing every mocked KMSClient instance. */
function kmsSendMock(): jest.Mock {
  return (
    jest.requireMock('@aws-sdk/client-kms') as { __send: jest.Mock }
  ).__send;
}

/** A ConfigService that reports KMS as enabled with a CMK id. */
function kmsEnabledConfig(extra: Record<string, string> = {}): ConfigService {
  return {
    getOrThrow: (key: string) =>
      key === 'app.kmsEnabled'
        ? true
        : key === 'app.awsRegion'
          ? 'us-east-1'
          : FALLBACK_KEY,
    get: (key: string) => {
      if (key === 'app.kmsKeyId') return 'alias/test-cmk';
      return extra[key];
    },
  } as unknown as ConfigService;
}

async function buildProvider() {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      KmsKeyProvider,
      { provide: ConfigService, useValue: mockConfigService },
    ],
  }).compile();
  return module.get<KmsKeyProvider>(KmsKeyProvider);
}

describe('KmsKeyProvider', () => {
  const savedEnv = { ...process.env };
  let dataKeyDir: string;

  beforeEach(() => {
    dataKeyDir = mkdtempSync(join(tmpdir(), 'kms-key-provider-'));
    delete process.env.KMS_ENCRYPTED_DATA_KEY;
    delete process.env.KMS_DATA_KEY_PATH;
  });

  afterEach(() => {
    rmSync(dataKeyDir, { recursive: true, force: true });
    process.env = { ...savedEnv };
    jest.clearAllMocks();
    mockConfigService.getOrThrow.mockReturnValue(FALLBACK_KEY);
    mockConfigService.get.mockReturnValue(undefined);
  });

  describe('when KMS is disabled', () => {
    it('returns the fallback ENCRYPTION_KEY', async () => {
      mockConfigService.getOrThrow.mockImplementation((key: string) =>
        key === 'app.kmsEnabled' ? false : FALLBACK_KEY,
      );
      const provider = await buildProvider();
      await provider.onModuleInit();
      expect(provider.getEncryptionKey()).toBe(FALLBACK_KEY);
    });
  });

  describe('when KMS_KEY_ID is not set', () => {
    it('returns the fallback ENCRYPTION_KEY', async () => {
      mockConfigService.getOrThrow.mockImplementation((key: string) =>
        key === 'app.kmsEnabled' ? true : FALLBACK_KEY,
      );
      mockConfigService.get.mockReturnValue(undefined);
      const provider = await buildProvider();
      await provider.onModuleInit();
      expect(provider.getEncryptionKey()).toBe(FALLBACK_KEY);
    });
  });

  describe('encrypt / decrypt', () => {
    it('delegates to SecretEncryptionUtil with the active key', async () => {
      const provider = await buildProvider();
      const encSpy = jest
        .spyOn(SecretEncryptionUtil, 'encrypt')
        .mockReturnValue('encrypted');
      const decSpy = jest
        .spyOn(SecretEncryptionUtil, 'decrypt')
        .mockReturnValue('plaintext');

      expect(provider.encrypt('secret')).toBe('encrypted');
      expect(encSpy).toHaveBeenCalledWith('secret', FALLBACK_KEY);

      expect(provider.decrypt('encrypted')).toBe('plaintext');
      expect(decSpy).toHaveBeenCalledWith(
        'encrypted',
        FALLBACK_KEY,
        expect.any(Function),
      );
    });

    it('round-trips a real secret with no previous key configured', async () => {
      const provider = await buildProvider();
      const ct = provider.encrypt('SBPQ_ROUND_TRIP');
      expect(provider.decrypt(ct)).toBe('SBPQ_ROUND_TRIP');
    });

    it('reads a row written under the previous key during rotation', () => {
      // #681: the dual-key path is actually wired in, not just implemented.
      const previous = 'b'.repeat(64);
      const old = SecretEncryptionUtil.encrypt('OLD_SECRET', previous);

      const provider = new KmsKeyProvider({
        getOrThrow: () => FALLBACK_KEY,
        get: (key: string) =>
          key === 'app.encryptionKeyPrevious' ? previous : undefined,
      } as unknown as ConfigService);

      expect(provider.decrypt(old)).toBe('OLD_SECRET');
    });
  });

  describe('data key persistence across restarts', () => {
    it('generates and persists a data key on first run', async () => {
      const plaintext = Buffer.from('c'.repeat(32), 'utf8');
      kmsSendMock().mockResolvedValue({
        Plaintext: plaintext,
        CiphertextBlob: Buffer.from('wrapped-blob'),
      });
      process.env.KMS_DATA_KEY_PATH = join(dataKeyDir, 'data-key');

      const provider = new KmsKeyProvider(kmsEnabledConfig());
      await provider.onModuleInit();

      expect(provider.getEncryptionKey()).toBe(plaintext.toString('hex'));
      // The blob is on disk, so the next start can reuse this key.
      expect(
        loadPersistedEncryptedDataKey(join(dataKeyDir, 'data-key')),
      ).toBe(Buffer.from('wrapped-blob').toString('base64'));
    });

    it('reuses the persisted blob instead of generating a new key', async () => {
      const original = 'd'.repeat(64);
      const path = join(dataKeyDir, 'data-key');
      persistEncryptedDataKey(
        Buffer.from('persisted-blob').toString('base64'),
        path,
      );
      process.env.KMS_DATA_KEY_PATH = path;

      kmsSendMock().mockResolvedValue({ Plaintext: Buffer.from(original, 'hex') });

      const provider = new KmsKeyProvider(kmsEnabledConfig());
      await provider.onModuleInit();

      // Same data key as the previous run — rows stay decryptable.
      expect(provider.getEncryptionKey()).toBe(original);
      const calls = kmsSendMock().mock.calls;
      expect(calls.some(([c]) => 'KeySpec' in c)).toBe(false);
    });

    it('prefers KMS_ENCRYPTED_DATA_KEY over the file', () => {
      const path = join(dataKeyDir, 'data-key');
      persistEncryptedDataKey('from-file', path);
      process.env.KMS_ENCRYPTED_DATA_KEY = 'from-env';
      expect(loadPersistedEncryptedDataKey(path)).toBe('from-env');
    });

    it('returns null when nothing has been persisted', () => {
      process.env.KMS_DATA_KEY_PATH = join(dataKeyDir, 'missing');
      expect(
        loadPersistedEncryptedDataKey(join(dataKeyDir, 'missing')),
      ).toBeNull();
    });

    it('refuses to generate a new key when a persisted blob cannot be unwrapped', async () => {
      // The critical safety case: silently regenerating here would make every
      // existing secret permanently undecryptable while appearing healthy.
      const path = join(dataKeyDir, 'data-key');
      persistEncryptedDataKey(
        Buffer.from('unwrappable').toString('base64'),
        path,
      );
      process.env.KMS_DATA_KEY_PATH = path;

      kmsSendMock().mockRejectedValue(new Error('access denied'));

      const provider = new KmsKeyProvider(kmsEnabledConfig());
      await provider.onModuleInit();

      // Fell back to the static key rather than minting a new data key.
      expect(provider.getEncryptionKey()).toBe(FALLBACK_KEY);
      const calls = kmsSendMock().mock.calls;
      expect(calls.some(([c]) => 'KeySpec' in c)).toBe(false);
    });
  });

  describe('key ring', () => {
    it('writes v1 format when no key id is configured', () => {
      const provider = new KmsKeyProvider({
        getOrThrow: () => FALLBACK_KEY,
        get: () => undefined,
      } as unknown as ConfigService);

      const ring = provider.getKeyRing();
      expect(ring.tagWrites).toBeUndefined();
      expect(ring.previousKeys).toBeUndefined();
    });

    it('opts into tagged writes when a key id is configured', () => {
      const provider = new KmsKeyProvider({
        getOrThrow: () => FALLBACK_KEY,
        get: (key: string) =>
          key === 'app.encryptionKeyId' ? 'k2026q1' : undefined,
      } as unknown as ConfigService);

      const ring = provider.getKeyRing();
      expect(ring.tagWrites).toBe(true);
      expect(ring.currentKeyId).toBe('k2026q1');
      expect(
        SecretEncryptionUtil.classify(provider.encrypt('x')),
      ).toBe('prefixed-aes-v2');
    });
  });
});
