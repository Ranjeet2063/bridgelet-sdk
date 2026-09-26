import { BadRequestException } from '@nestjs/common';
import {
  parsePagination,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_OFFSET,
} from './pagination.util.js';

describe('parsePagination', () => {
  describe('defaults', () => {
    it('applies the default page size when limit is absent', () => {
      expect(parsePagination(undefined, undefined)).toEqual({
        limit: DEFAULT_PAGE_SIZE,
        offset: 0,
      });
    });

    it('treats null the same as undefined', () => {
      expect(parsePagination(null, null)).toEqual({
        limit: DEFAULT_PAGE_SIZE,
        offset: 0,
      });
    });

    it('honours explicit defaults', () => {
      expect(
        parsePagination(undefined, undefined, { limit: 10, offset: 5 }),
      ).toEqual({ limit: 10, offset: 5 });
    });
  });

  describe('coercion from query strings', () => {
    it('parses numeric strings', () => {
      expect(parsePagination('25', '50')).toEqual({ limit: 25, offset: 50 });
    });

    it('tolerates surrounding whitespace', () => {
      expect(parsePagination(' 25 ', ' 50 ')).toEqual({
        limit: 25,
        offset: 50,
      });
    });

    it('accepts numbers as well as strings', () => {
      expect(parsePagination(25, 50)).toEqual({ limit: 25, offset: 50 });
    });

    it('accepts "0" as a string', () => {
      expect(parsePagination('0', '0')).toEqual({ limit: 1, offset: 0 });
    });
  });

  describe('rejects non-integers (issue #694)', () => {
    it.each([
      ['letters', 'abc'],
      ['mixed', '10abc'],
      ['hex', '0x10'],
      ['exponent', '1e3'],
      ['decimal', '1.5'],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['comma', '1,000'],
    ])('rejects %s (%p)', (_label, value) => {
      expect(() => parsePagination(value, '0')).toThrow(BadRequestException);
      expect(() => parsePagination('10', value)).toThrow(BadRequestException);
    });

    it('names the offending field in the message', () => {
      expect(() => parsePagination('abc', '0')).toThrow(
        /limit must be an integer/,
      );
      expect(() => parsePagination('10', 'abc')).toThrow(
        /offset must be an integer/,
      );
    });

    it('rejects non-integer JavaScript numbers', () => {
      expect(() => parsePagination(1.5, 0)).toThrow(BadRequestException);
      expect(() => parsePagination(Number.NaN, 0)).toThrow(BadRequestException);
    });

    it('rejects values beyond safe-integer range', () => {
      expect(() => parsePagination('99999999999999999999', '0')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('clamps out-of-range values', () => {
    it('caps limit at MAX_PAGE_SIZE', () => {
      expect(parsePagination(String(MAX_PAGE_SIZE + 1), '0').limit).toBe(
        MAX_PAGE_SIZE,
      );
      expect(parsePagination('100000', '0').limit).toBe(MAX_PAGE_SIZE);
    });

    it('floors limit at 1', () => {
      expect(parsePagination('0', '0').limit).toBe(1);
      expect(parsePagination('-10', '0').limit).toBe(1);
    });

    it('floors offset at 0', () => {
      expect(parsePagination('10', '-1').offset).toBe(0);
      expect(parsePagination('10', '-99999').offset).toBe(0);
    });

    it('caps offset at MAX_OFFSET to bound per-request work', () => {
      expect(parsePagination('10', String(MAX_OFFSET + 1)).offset).toBe(
        MAX_OFFSET,
      );
    });

    it('clamps rather than rejecting, so a large page still works', () => {
      // A client asking for limit=1000 should get the max page, not a 400.
      const result = parsePagination('1000', '-5');
      expect(result).toEqual({ limit: MAX_PAGE_SIZE, offset: 0 });
    });
  });

  describe('boundaries', () => {
    it('accepts limit exactly at MAX_PAGE_SIZE', () => {
      expect(parsePagination(String(MAX_PAGE_SIZE), '0').limit).toBe(
        MAX_PAGE_SIZE,
      );
    });

    it('accepts offset exactly at MAX_OFFSET', () => {
      expect(parsePagination('10', String(MAX_OFFSET)).offset).toBe(MAX_OFFSET);
    });

    it('accepts limit 1 and offset 0', () => {
      expect(parsePagination('1', '0')).toEqual({ limit: 1, offset: 0 });
    });
  });
});
