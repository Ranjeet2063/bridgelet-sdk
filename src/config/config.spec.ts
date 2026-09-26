/**
 * Basic smoke tests to execute the config factory functions and
 * ensure defaults are applied when env vars are absent.
 *
 * These tests do not require any NestJS DI context — they call the
 * factory directly to exercise the branches (|| fallback values).
 *
 * Note: database.config.ts and typeorm.config.ts use import.meta.url (ESM)
 * which Jest cannot dynamically import in CommonJS mode — they are excluded.
 */

type ConfigFactory = () => Record<string, unknown>;

describe('app.config', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    delete process.env.CLAIM_TOKEN_EXPIRY;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    delete process.env.CLAIM_TOKEN_EXPIRY;
  });

  it('returns defaults when env vars are not set', async () => {
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.port).toBe(3000);
    expect(config.env).toBe('development');
  });

  it('uses env var PORT when set', async () => {
    process.env.PORT = '4000';
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.port).toBe(4000);
  });

  it('uses NODE_ENV when set', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.env).toBe('production');
  });

  it('uses JWT_SECRET when set', async () => {
    process.env.JWT_SECRET = 'my-test-secret';
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.jwtSecret).toBe('my-test-secret');
  });

  it('uses CLAIM_TOKEN_EXPIRY when set', async () => {
    process.env.CLAIM_TOKEN_EXPIRY = '86400';
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.claimTokenExpiry).toBe(86400);
  });
});

describe('stellar.config', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_SOROBAN_RPC_URL;
    delete process.env.SWEEP_CONTROLLER_CONTRACT_ID;
    delete process.env.SWEEP_SIGNING_KEY_SEED;
    delete process.env.ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_HORIZON_URL;
  });

  it('returns testnet defaults when env vars are not set', async () => {
    const mod = await import('./stellar.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.network).toBe('testnet');
    expect(config.horizonUrl).toContain('testnet');
    expect(config.sorobanRpcUrl).toContain('testnet');
  });

  it('uses STELLAR_NETWORK when set', async () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    const mod = await import('./stellar.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.network).toBe('mainnet');
  });

  it('rejects an invalid STELLAR_NETWORK value', async () => {
    process.env.STELLAR_NETWORK = 'main-net';
    const mod = await import('./stellar.config.js');
    expect(() => (mod.default as unknown as ConfigFactory)()).toThrow(
      'Expected "mainnet" or "testnet"',
    );
  });

  it('uses STELLAR_HORIZON_URL when set', async () => {
    process.env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';
    const mod = await import('./stellar.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.horizonUrl).toBe('https://horizon.stellar.org');
  });

  it('uses STELLAR_SOROBAN_RPC_URL when set', async () => {
    process.env.STELLAR_SOROBAN_RPC_URL = 'https://soroban.stellar.org';
    const mod = await import('./stellar.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.sorobanRpcUrl).toBe('https://soroban.stellar.org');
  });
});
