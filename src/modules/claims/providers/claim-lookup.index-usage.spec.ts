import * as fs from 'fs';
import * as path from 'path';

/**
 * Issue #642: claim redemption is keyed by looking up `claimTokenHash` on
 * `accounts` and joining `claims.accountId`. Rather than requiring a live
 * Postgres instance for an EXPLAIN check, this confirms (structurally,
 * from the migration source) that both lookup columns are backed by a
 * B-tree index, so the runtime queries are not sequential scans.
 */
describe('claim token / account lookup index coverage (issue #642)', () => {
  const migrationsDir = path.join(__dirname, '../../../database/migrations');

  function readMigration(fileName: string): string {
    return fs.readFileSync(path.join(migrationsDir, fileName), 'utf8');
  }

  it('accounts.claimTokenHash is indexed', () => {
    const sql = readMigration('1718100000000-CreateAccountsTable.ts');
    expect(sql).toMatch(
      /CREATE INDEX "IDX_accounts_claimTokenHash" ON "accounts" \("claimTokenHash"\)/,
    );
  });

  it('claims.accountId is indexed', () => {
    const sql = readMigration('1718100001000-CreateClaimsTable.ts');
    expect(sql).toMatch(
      /CREATE INDEX "IDX_claims_accountId" ON "claims" \("accountId"\)/,
    );
  });
});
