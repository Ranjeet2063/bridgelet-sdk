/**
 * #726: `synchronize: true` auto-alters the schema from entities and must
 * never run against a migration-driven database. It is only honoured when
 * NODE_ENV=test AND DATABASE_SYNC=true (a dedicated, disposable test DB);
 * setting DATABASE_SYNC=true in any other environment fails loudly at boot.
 *
 * Kept separate from database.config.ts (which uses import.meta.url) so Jest
 * can exercise it directly.
 */
export function isSynchronizeAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.DATABASE_SYNC !== 'true') return false;
  if (env.NODE_ENV !== 'test') {
    throw new Error(
      'DATABASE_SYNC=true is only permitted when NODE_ENV=test. ' +
        'Schema changes outside tests must go through migrations.',
    );
  }
  return true;
}
