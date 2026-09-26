import { BadRequestException } from '@nestjs/common';
import {
  sanitizeMetadata,
  METADATA_MAX_BYTES,
  METADATA_MAX_KEYS,
  METADATA_MAX_DEPTH,
  METADATA_MAX_KEY_LENGTH,
} from './metadata-sanitizer.util.js';

describe('sanitizeMetadata', () => {
  // ── trivial inputs ──────────────────────────────────────────────────────────

  it('returns undefined for null input', () => {
    expect(sanitizeMetadata(null)).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(sanitizeMetadata(undefined)).toBeUndefined();
  });

  it('passes through safe keys unchanged', () => {
    const result = sanitizeMetadata({ userId: 'u123', orderId: 'o456' });
    expect(result).toEqual({ userId: 'u123', orderId: 'o456' });
  });

  // ── rule 1: size (the only rule that throws) ───────────────────────────────

  it('throws BadRequestException when metadata exceeds METADATA_MAX_BYTES', () => {
    const large = { data: 'x'.repeat(METADATA_MAX_BYTES + 1) };
    expect(() => sanitizeMetadata(large)).toThrow(BadRequestException);
  });

  it('names the limit in the error message', () => {
    const large = { data: 'x'.repeat(METADATA_MAX_BYTES + 1) };
    expect(() => sanitizeMetadata(large)).toThrow(
      `metadata exceeds maximum allowed size of ${METADATA_MAX_BYTES} bytes`,
    );
  });

  it('accepts metadata exactly at the byte limit', () => {
    const value = 'x'.repeat(METADATA_MAX_BYTES - '{"data":""}'.length);
    const result = sanitizeMetadata({ data: value });
    expect(result).toHaveProperty('data');
  });

  it('measures size in bytes, not characters', () => {
    // 4 bytes per emoji, so half the character count blows the byte budget.
    const emoji = '\u{1F600}';
    const justUnder = { d: emoji.repeat(METADATA_MAX_BYTES / 8) };
    expect(
      Buffer.byteLength(JSON.stringify(justUnder), 'utf8'),
    ).toBeLessThanOrEqual(METADATA_MAX_BYTES);
    expect(() => sanitizeMetadata(justUnder)).not.toThrow();

    const over = { d: emoji.repeat(METADATA_MAX_BYTES / 4) };
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBeGreaterThan(
      METADATA_MAX_BYTES,
    );
    expect(() => sanitizeMetadata(over)).toThrow(BadRequestException);
  });

  // ── rule 2: prototype pollution ─────────────────────────────────────────────

  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops the dangerous key "%s" without polluting the object prototype',
    (key) => {
      const payload = JSON.parse(
        `{"${key}": {"polluted": true}, "safe": "ok"}`,
      );
      const result = sanitizeMetadata(payload) as Record<string, unknown>;
      expect(result).toHaveProperty('safe', 'ok');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    },
  );

  it('drops dangerous keys at nested levels too', () => {
    const payload = JSON.parse(
      '{"outer": {"__proto__": {"polluted": true}, "safe": "ok"}}',
    );
    const result = sanitizeMetadata(payload) as Record<string, Record<string, unknown>>;
    expect(result.outer).toEqual({ safe: 'ok' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // ── rule 3: PII keys ────────────────────────────────────────────────────────

  it('strips top-level PII keys: email, phone', () => {
    const result = sanitizeMetadata({
      userId: 'u1',
      email: 'user@example.com',
      phone: '555-1234',
    });
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('phone');
    expect(result).toHaveProperty('userId', 'u1');
  });

  it('strips PII keys case-insensitively (Email, PHONE)', () => {
    const result = sanitizeMetadata({ Email: 'x@y.com', PHONE: '1234' });
    expect(result).not.toHaveProperty('Email');
    expect(result).not.toHaveProperty('PHONE');
  });

  it.each([
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
  ])('strips the PII key "%s"', (key) => {
    const result = sanitizeMetadata({ [key]: 'sensitive', safe: 'ok' });
    expect(result).not.toHaveProperty(key);
    expect(result).toHaveProperty('safe', 'ok');
  });

  it('strips PII keys nested inside sub-objects', () => {
    // PII must not be hideable by one level of nesting.
    const result = sanitizeMetadata({
      profile: { email: 'leak@example.com', handle: 'ok' },
    }) as Record<string, Record<string, unknown>>;
    expect(result.profile).toEqual({ handle: 'ok' });
  });

  it('returns an empty object when all keys are PII', () => {
    const result = sanitizeMetadata({ email: 'a@b.com', phone: '123' });
    expect(result).toEqual({});
  });

  it('does not strip a key that merely contains a PII word', () => {
    // Substring matching would destroy legitimate keys like
    // `username` or `emailOptIn`.
    const result = sanitizeMetadata({
      username: 'alice',
      emailOptIn: true,
      addressable: false,
    });
    expect(result).toEqual({
      username: 'alice',
      emailOptIn: true,
      addressable: false,
    });
  });

  // ── rule 4: key budget ──────────────────────────────────────────────────────

  it('keeps at most METADATA_MAX_KEYS top-level keys', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < METADATA_MAX_KEYS + 20; i++) many[`k${i}`] = i;
    const result = sanitizeMetadata(many)!;
    expect(Object.keys(result)).toHaveLength(METADATA_MAX_KEYS);
  });

  it('keeps exactly METADATA_MAX_KEYS when at the limit', () => {
    const exact: Record<string, number> = {};
    for (let i = 0; i < METADATA_MAX_KEYS; i++) exact[`k${i}`] = i;
    expect(Object.keys(sanitizeMetadata(exact)!)).toHaveLength(
      METADATA_MAX_KEYS,
    );
  });

  it('drops keys longer than METADATA_MAX_KEY_LENGTH', () => {
    const result = sanitizeMetadata({
      ok: 'kept',
      ['x'.repeat(METADATA_MAX_KEY_LENGTH + 1)]: 'dropped',
      ['y'.repeat(METADATA_MAX_KEY_LENGTH)]: 'also kept',
    })!;
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty(['y'.repeat(METADATA_MAX_KEY_LENGTH)]);
    expect(result).not.toHaveProperty(['x'.repeat(METADATA_MAX_KEY_LENGTH + 1)]);
  });

  // ── rule 5: depth budget ────────────────────────────────────────────────────

  it('keeps values nested up to METADATA_MAX_DEPTH', () => {
    const result = sanitizeMetadata({
      a: { b: { c: { d: 'too deep' } } },
    })!;
    // Root is depth 1, so a/b/c is depth 3 (kept) and d is depth 4 (dropped).
    expect(result).toEqual({ a: { b: { c: {} } } });
  });

  it('keeps a value at exactly METADATA_MAX_DEPTH', () => {
    const result = sanitizeMetadata({ a: { b: { c: 'kept' } } })!;
    expect(result).toEqual({ a: { b: { c: 'kept' } } });
  });

  it('drops an array nested beyond METADATA_MAX_DEPTH', () => {
    const result = sanitizeMetadata({ a: { b: { c: ['too deep'] } } })!;
    expect(result).toEqual({ a: { b: { c: {} } } });
  });

  it('applies the same depth budget inside arrays', () => {
    // depth 1 = root, 2 = the array, 3 = its objects. One more is dropped.
    const result = sanitizeMetadata({ list: [{ keep: 1 }, { drop: { x: 1 } }] })!;
    expect(result).toEqual({ list: [{ keep: 1 }, {}] });
  });

  // ── rule 6: value types ─────────────────────────────────────────────────────

  it('keeps JSON scalars', () => {
    const result = sanitizeMetadata({
      s: 'text',
      n: 42,
      f: 1.5,
      z: 0,
      b: true,
      b2: false,
      nul: null,
    })!;
    expect(result).toEqual({
      s: 'text',
      n: 42,
      f: 1.5,
      z: 0,
      b: true,
      b2: false,
      nul: null,
    });
  });

  it('keeps nested arrays of scalars', () => {
    const result = sanitizeMetadata({ tags: ['a', 'b', 'c'] })!;
    expect(result).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('drops the non-finite number %s', (_label, value) => {
    // JSON.stringify would silently turn these into null, hiding the fact
    // that the stored value differs from what the caller sent.
    const result = sanitizeMetadata({ n: value, ok: 1 })!;
    expect(result).not.toHaveProperty('n');
    expect(result).toHaveProperty('ok', 1);
  });

  it('drops undefined values rather than storing a phantom key', () => {
    const result = sanitizeMetadata({ a: undefined, b: 'kept' })!;
    expect(result).toEqual({ b: 'kept' });
    expect(Object.keys(result)).not.toContain('a');
  });

  it('drops function values', () => {
    const result = sanitizeMetadata({
      fn: () => 'nope',
      ok: 'kept',
    })!;
    expect(result).toEqual({ ok: 'kept' });
  });

  it('drops symbol and bigint values', () => {
    const result = sanitizeMetadata({
      sym: Symbol('s'),
      big: BigInt(1),
      ok: 'kept',
    })!;
    expect(result).toEqual({ ok: 'kept' });
  });

  it('drops non-plain objects such as Date', () => {
    // A Date would serialise to an ISO string that looks like caller data.
    const result = sanitizeMetadata({ when: new Date(), ok: 'kept' })!;
    expect(result).toEqual({ ok: 'kept' });
  });

  it('drops Map and Set values', () => {
    const result = sanitizeMetadata({
      m: new Map([['a', 1]]),
      s: new Set([1, 2]),
      ok: 'kept',
    })!;
    expect(result).toEqual({ ok: 'kept' });
  });

  it('drops class instances', () => {
    class Payload {
      constructor(public secret = 'leaked') {}
    }
    const result = sanitizeMetadata({ p: new Payload(), ok: 'kept' })!;
    expect(result).toEqual({ ok: 'kept' });
  });

  it('keeps objects created with a null prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.ok = 'kept';
    expect(sanitizeMetadata({ bare, other: 1 })).toEqual({
      bare: { ok: 'kept' },
      other: 1,
    });
  });

  it('drops an object carrying a custom toJSON', () => {
    // toJSON would let a caller render a different payload than the one
    // inspected here.
    const sneaky = { toJSON: () => ({ smuggled: true }) };
    const result = sanitizeMetadata({ sneaky, ok: 'kept' })!;
    expect(result).toEqual({ ok: 'kept' });
  });

  it('compacts undefined entries out of arrays', () => {
    const result = sanitizeMetadata({ list: ['a', undefined, 'b'] })!;
    expect(result).toEqual({ list: ['a', 'b'] });
  });

  // ── round-trip safety ───────────────────────────────────────────────────────

  it('produces output that survives JSON.stringify unchanged', () => {
    const result = sanitizeMetadata({
      a: 1,
      b: { c: 'x' },
      d: [1, 2],
      nan: Number.NaN,
      fn: () => 1,
    })!;
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('does not mutate the caller-supplied object', () => {
    const input = { email: 'leak@example.com', ok: 1 };
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeMetadata(input);
    expect(input).toEqual(snapshot);
  });
});
