import { BadRequestException } from '@nestjs/common';

/** Maximum allowed serialised size of metadata (4 KB). */
export const METADATA_MAX_BYTES = 4096;

/** Maximum number of top-level keys retained after sanitisation. */
export const METADATA_MAX_KEYS = 32;

/**
 * Maximum nesting depth retained after sanitisation. The top-level object is
 * depth 1, so a value three objects deep is kept and anything deeper is
 * dropped. `IsBoundedMetadata` enforces the same budget at the DTO layer using
 * this constant.
 */
export const METADATA_MAX_DEPTH = 3;

/** Maximum length of any single top-level key. */
export const METADATA_MAX_KEY_LENGTH = 64;

/**
 * Keys that must never be copied onto a plain object literal, since
 * `obj[key] = value` for these triggers Object.prototype's special
 * accessors/inherited members instead of creating an own data property
 * (a classic prototype-pollution vector when metadata is attacker-supplied
 * JSON).
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Keys whose values may contain PII and should be stripped before storage.
 * All comparisons are case-insensitive.
 */
const PII_KEYS = new Set([
  'email',
  'phone',
  'phonenumber',
  'mobile',
  'ssn',
  'dob',
  'dateofbirth',
  'address',
  'fullname',
  'firstname',
  'lastname',
  'name',
  'nationalid',
  'passport',
  'taxid',
]);

/** Value types that survive sanitisation. */
export type MetadataValue =
  | string
  | number
  | boolean
  | null
  | MetadataValue[]
  | { [key: string]: MetadataValue };

/**
 * Only JSON-representable scalars are kept. Anything else — functions,
 * symbols, `undefined`, class instances, `BigInt`, `Date`, `Map`, `NaN`,
 * `Infinity` — is dropped.
 *
 * This is not pedantry. `JSON.stringify` renders several of these in
 * surprising ways: `undefined` properties vanish entirely, `NaN` and
 * `Infinity` both become `null`, and a `Date` becomes an ISO string that
 * looks like caller-supplied data but was not. Rejecting them at the
 * boundary keeps "what you sent" and "what got stored" the same shape, and
 * stops an object with a `toJSON()` method from smuggling a different
 * payload past inspection.
 */
function sanitiseValue(
  value: unknown,
  depth: number,
): MetadataValue | undefined {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // NaN / ±Infinity are not representable in JSON.
      return Number.isFinite(value) ? value : undefined;
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint
      return undefined;
  }

  if (depth > METADATA_MAX_DEPTH) return undefined;

  if (Array.isArray(value)) {
    const out = value
      .map((item) => sanitiseValue(item, depth + 1))
      .filter((item): item is MetadataValue => item !== undefined);
    return out;
  }

  // Plain objects only. A class instance, Date, Map or object with a custom
  // prototype is not caller-authored key/value data.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;

  const out: Record<string, MetadataValue> = {};
  let kept = 0;
  for (const [key, nested] of Object.entries(value as object)) {
    if (kept >= METADATA_MAX_KEYS) break;
    if (DANGEROUS_KEYS.has(key)) continue;
    if (key.length > METADATA_MAX_KEY_LENGTH) continue;
    if (!PII_KEYS.has(key.toLowerCase())) {
      const clean = sanitiseValue(nested, depth + 1);
      if (clean !== undefined) {
        out[key] = clean;
        kept++;
      }
    }
  }
  return out;
}

/**
 * Validates and sanitises caller-supplied account metadata.
 *
 * Rules, in the order they are applied:
 *
 * 1. **Size** — the whole object must serialise to at most
 *    {@link METADATA_MAX_BYTES} bytes. Exceeding this throws
 *    {@link BadRequestException}; it is a client error, not something to
 *    silently trim.
 * 2. **Dangerous keys** — `__proto__`, `constructor` and `prototype` are
 *    dropped, preventing prototype pollution when the result is assigned
 *    onto an object literal.
 * 3. **PII keys** — a fixed list of PII-looking top-level and nested keys is
 *    stripped, case-insensitively, so secrets cannot be parked in
 *    free-form metadata.
 * 4. **Key budget** — at most {@link METADATA_MAX_KEYS} keys survive per
 *    object, and keys longer than {@link METADATA_MAX_KEY_LENGTH} are
 *    dropped. Bounds the fan-out of a single row.
 * 5. **Depth budget** — values nested deeper than {@link METADATA_MAX_DEPTH}
 *    are dropped. Bounds recursive serialisation cost.
 * 6. **Value types** — only JSON scalars, arrays and plain objects survive.
 *    Non-finite numbers, functions, symbols, `BigInt` and non-plain objects
 *    (`Date`, `Map`, class instances) are dropped.
 *
 * Everything except rule 1 is a silent drop: metadata is advisory, and
 * failing a whole account creation over an unexpected metadata shape would be
 * a worse outcome than storing a subset of it. Callers should therefore treat
 * the returned object as possibly smaller than what they sent.
 *
 * @throws BadRequestException when the serialised metadata exceeds the size limit.
 * @returns A sanitised copy, or undefined if the input is falsy.
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const serialised = JSON.stringify(metadata);
  if (serialised === undefined) {
    throw new BadRequestException('metadata must be JSON-serialisable');
  }
  if (Buffer.byteLength(serialised, 'utf8') > METADATA_MAX_BYTES) {
    throw new BadRequestException(
      `metadata exceeds maximum allowed size of ${METADATA_MAX_BYTES} bytes`,
    );
  }

  // Root object counts as depth 1, matching IsBoundedMetadata's depthOf().
  const sanitised = sanitiseValue(metadata, 1);
  if (sanitised === undefined || sanitised === null) return undefined;
  return sanitised as Record<string, unknown>;
}
