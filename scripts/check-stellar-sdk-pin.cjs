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

const fs = require('fs');
const path = require('path');

const {
  STELLAR_SDK_PACKAGE,
  describePinFailure,
  evaluateStellarSdkPin,
} = require('./stellar-sdk-pin.cjs');

const ROOT = path.join(__dirname, '..');

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
);

const result = evaluateStellarSdkPin(pkg);

if (!result.ok) {
  console.error(`[stellar-sdk-pin] ${describePinFailure(result)}`);
  process.exit(1);
}

console.log(
  `[stellar-sdk-pin] OK — ${STELLAR_SDK_PACKAGE} is pinned to exact version ${result.version}.`,
);
