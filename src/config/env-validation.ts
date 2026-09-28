/**
 * Fails startup fast with one clear error listing every missing/invalid
 * required env var, instead of failing confusingly deep in a request
 * handler. Call from main.ts before the Nest app is created.
 */
const REQUIRED_VARS = [
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
  'STELLAR_SOROBAN_RPC_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
];

export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const errors: string[] = [];

  for (const key of REQUIRED_VARS) {
    if (!env[key] || env[key]?.trim() === '') {
      errors.push(`${key} is missing`);
    }
  }

  if (env.DATABASE_PORT && Number.isNaN(Number(env.DATABASE_PORT))) {
    errors.push('DATABASE_PORT must be a number');
  }

  if (env.ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY)) {
    errors.push('ENCRYPTION_KEY must be a 64-character hex string');
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }
}
