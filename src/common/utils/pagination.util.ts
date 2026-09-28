import { BadRequestException } from '@nestjs/common';

/** Default page size when the caller does not supply `limit`. */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard ceiling on `limit`, regardless of what the caller asks for. */
export const MAX_PAGE_SIZE = 100;
/** Hard ceiling on `offset`, to bound the work a single request can cause. */
export const MAX_OFFSET = 100_000;

export interface PaginationParams {
  limit: number;
  offset: number;
}

function toInteger(raw: unknown, field: string): number {
  // Query params arrive as strings. `Number('')` is 0 and `Number(' 12 ')` is
  // 12, so validate the shape explicitly rather than trusting the coercion.
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) {
      throw new BadRequestException(`${field} must be an integer`);
    }
    return raw;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestException(`${field} must be an integer`);
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new BadRequestException(`${field} must be an integer`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException(`${field} is out of range`);
  }
  return parsed;
}

/**
 * Normalises and bounds `limit`/`offset` query parameters.
 *
 * Without this, a caller sending `?limit=abc` reaches TypeORM as `NaN`
 * (`Math.min(NaN, 100)` is `NaN`), and a negative `offset` reaches
 * `.skip(-1)`. Both surface as a 500 from deep inside the query builder rather
 * than a 400 that says what was wrong.
 *
 * Out-of-range values are clamped rather than rejected, so a client asking
 * for `limit=1000` gets the maximum page instead of an error:
 *
 * - `limit` is clamped to `[1, MAX_PAGE_SIZE]`
 * - `offset` is clamped to `[0, MAX_OFFSET]`
 *
 * Values that are not integers at all (`abc`, `1.5`, `''`, `null`) are a
 * `400` — there is no sensible interpretation of them.
 *
 * @param rawLimit the raw `limit` value, possibly a string or undefined
 * @param rawOffset the raw `offset` value, possibly a string or undefined
 * @param defaults applied when a value is undefined
 */
export function parsePagination(
  rawLimit?: unknown,
  rawOffset?: unknown,
  defaults: { limit?: number; offset?: number } = {},
): PaginationParams {
  const defaultLimit = defaults.limit ?? DEFAULT_PAGE_SIZE;
  const defaultOffset = defaults.offset ?? 0;

  const limit =
    rawLimit === undefined || rawLimit === null
      ? defaultLimit
      : toInteger(rawLimit, 'limit');
  const offset =
    rawOffset === undefined || rawOffset === null
      ? defaultOffset
      : toInteger(rawOffset, 'offset');

  return {
    limit: Math.min(Math.max(limit, 1), MAX_PAGE_SIZE),
    offset: Math.min(Math.max(offset, 0), MAX_OFFSET),
  };
}
