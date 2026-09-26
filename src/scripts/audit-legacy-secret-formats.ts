import { readFileSync } from 'fs';
import { SecretRotationUtil } from '../common/crypto/secret-rotation.util.js';
import type { SecretFormat } from '../common/crypto/secret-encryption.util.js';

/**
 * `audit:secrets` — reports how many `accounts.secretKeyEncrypted` rows are
 * still in a legacy format, and which key ids are in play (issue #682).
 *
 * The legacy-format branches in `SecretEncryptionUtil.decrypt()` (unprefixed
 * AES-GCM, and the pre-AES base64 placeholder) are retained so a half-migrated
 * database still decrypts. They can only be deleted once this script reports
 * zero rows in those buckets, so it exists to answer one question: "are we done
 * yet?"
 *
 * Reads the ciphertexts from a JSON file containing either a bare array of
 * strings or an array of objects with a `secretKeyEncrypted` property, so it
 * can be pointed at a `psql` dump without a database connection:
 *
 *   psql -At -c 'SELECT "secretKeyEncrypted" FROM accounts' > secrets.json
 *   npm run audit:secrets -- ./secrets.json
 *
 * Exits 1 when legacy or corrupt rows remain, so it can gate a cleanup PR once
 * the migration is complete.
 */

const argv = process.argv.slice(2);
const inputPath = argv.find((a) => !a.startsWith('-'));

if (!inputPath) {
  console.error(
    'Usage: npm run audit:secrets -- <path-to-json>\n' +
      '  The file must contain a JSON array of ciphertext strings, or of ' +
      'objects with a "secretKeyEncrypted" property.',
  );
  process.exit(2);
}

let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (err) {
  console.error(`Could not read ${inputPath}: ${(err as Error).message}`);
  process.exit(2);
}

if (!Array.isArray(parsed)) {
  console.error(
    `${inputPath} must contain a JSON array, got ${typeof parsed}.`,
  );
  process.exit(2);
}

const values: string[] = parsed.map((row) => {
  if (typeof row === 'string') return row;
  if (row && typeof row === 'object' && 'secretKeyEncrypted' in row) {
    const value = (row as { secretKeyEncrypted: unknown })
      .secretKeyEncrypted;
    return typeof value === 'string' ? value : '';
  }
  return '';
});

const result = SecretRotationUtil.audit(values);

const rows: Array<[SecretFormat, number]> = (
  Object.keys(result.byFormat) as SecretFormat[]
).map((format) => [format, result.byFormat[format]]);

const width = Math.max(...rows.map(([format]) => format.length));
console.log(`\nScanned ${result.total} secret row(s) from ${inputPath}\n`);
for (const [format, count] of rows) {
  console.log(`  ${format.padEnd(width)}  ${count}`);
}
console.log();

if (result.keyIdsInUse.length > 0) {
  console.log(
    `  key ids in use: ${result.keyIdsInUse.join(', ')} — remove the matching ` +
      'previous key only once this list is empty',
  );
  console.log();
}

if (result.byFormat.corrupt > 0) {
  console.error(
    `${result.byFormat.corrupt} row(s) are corrupt and will fail to decrypt. ` +
      'Investigate before migrating; scripts/migrate-secrets.ts halts on these.',
  );
  console.error();
}

if (result.legacyCount > 0) {
  console.error(
    `${result.legacyCount} row(s) are still in a legacy format, so the legacy ` +
      'branches in SecretEncryptionUtil.decrypt() are still load-bearing. Run: ' +
      'npm run migrate:secrets -- --i-have-a-backup --execute',
  );
  console.error();
  process.exit(1);
}

console.log(
  'No legacy-format rows remain. The unprefixed-AES and base64 branches in ' +
    'SecretEncryptionUtil.decrypt() can now be removed.',
);
