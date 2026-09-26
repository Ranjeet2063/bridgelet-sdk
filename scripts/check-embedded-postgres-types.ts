/**
 * Fails when the hand-maintained `test/embedded-postgres.d.ts` declarations
 * drift from the `embedded-postgres` version the repository is pinned to
 * (issue #673).
 *
 * `embedded-postgres` ships no types, so the ambient declaration file is
 * maintained by hand against a *beta* dependency range. This script compares
 * the version the file was last verified against (`Verified against:` in the
 * file header) with the version resolved by package-lock.json, and with the
 * range declared in package.json. Any mismatch is a signal to re-verify the
 * declarations against the new package before merging the bump.
 *
 * Usage: npm run check:embedded-postgres-types
 * Exits 0 when in sync, 1 otherwise.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Semver-ish: major.minor.patch with an optional -prerelease suffix. */
function normalise(version: string): string {
  return version.trim().replace(/^v/, '');
}

function fail(message: string): never {
  console.error(`[embedded-postgres-types] ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
) as { devDependencies: Record<string, string> };

const lock = JSON.parse(
  readFileSync(join(ROOT, 'package-lock.json'), 'utf8'),
) as { packages: Record<string, { version?: string }> };

const declaredRange = pkg.devDependencies['embedded-postgres'];
if (!declaredRange) {
  fail('embedded-postgres is not listed in devDependencies.');
}

const lockedVersion = lock.packages['node_modules/embedded-postgres']?.version;
if (!lockedVersion) {
  fail(
    'No resolved version for embedded-postgres in package-lock.json. ' +
      'Run `npm install` and re-run this check.',
  );
}

const dtsPath = join(ROOT, 'test', 'embedded-postgres.d.ts');
const dts = readFileSync(dtsPath, 'utf8');
const verifiedMatch = dts.match(/Verified against:\s*(\S+)/);
if (!verifiedMatch?.[1]) {
  fail(
    'test/embedded-postgres.d.ts is missing a `Verified against: <version>` ' +
      'marker. Add one so this check has something to compare against.',
  );
}

const verifiedVersion = normalise(verifiedMatch[1]);
const resolved = normalise(lockedVersion);

if (verifiedVersion !== resolved) {
  fail(
    'test/embedded-postgres.d.ts was verified against ' +
      `${verifiedVersion} but package-lock.json resolves ${resolved}.\n` +
      'embedded-postgres ships no types and is pinned to a beta range, so a ` + "`npm install`" + ' may have pulled a different build.\n' +
      'Re-verify the ambient declarations against the new version, then update the ' +
      '`Verified against:` marker in test/embedded-postgres.d.ts.',
  );
}

if (declaredRange.includes('beta') && !resolved.includes('beta')) {
  fail(
    `package.json requests the beta range "${declaredRange}" but the lockfile ` +
      `resolves ${resolved}, which is not a beta build. Re-verify the declarations.`,
  );
}

console.log(
  `[embedded-postgres-types] OK — declarations verified against ${resolved} ` +
    `(range ${declaredRange}).`,
);
