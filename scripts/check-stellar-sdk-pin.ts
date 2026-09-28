/**
 * Fails when `@stellar/stellar-sdk` is not pinned to an exact version in
 * package.json (issue #446).
 *
 * The SDK is pinned exactly on purpose: it produces the Stellar XDR and
 * Soroban ScVal encodings this service signs and submits, and those encodings
 * can drift between releases in ways a test suite will not catch. A caret
 * range lets a patch release change them silently, so the exact pin has to be
 * enforced rather than merely intended.
 *
 * Usage: npm run check:stellar-sdk-pin
 * Exits 0 when the pin is exact, 1 otherwise.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Loaded through an explicit file URL rather than a static `from './…js'`
// specifier: `ts-node --esm` resolves the URL against this file and then
// applies its TypeScript loader, whereas the static form is handed straight to
// Node's ESM resolver, which has no `.ts` on disk. This also keeps the rule
// itself in a side-effect-free module that Jest can import directly.
const { STELLAR_SDK_PACKAGE, describePinFailure, evaluateStellarSdkPin } =
  (await import(
    new URL('./stellar-sdk-pin.ts', import.meta.url).href
  )) as typeof import('./stellar-sdk-pin.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, unknown>;
};

const result = evaluateStellarSdkPin(pkg);

if (!result.ok) {
  console.error(`[stellar-sdk-pin] ${describePinFailure(result)}`);
  process.exit(1);
}

console.log(
  `[stellar-sdk-pin] OK — ${STELLAR_SDK_PACKAGE} is pinned to exact version ${result.version}.`,
);
