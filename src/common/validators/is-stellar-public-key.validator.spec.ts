import { validate } from 'class-validator';
import { StrKey } from '@stellar/stellar-sdk';
import { IsStellarPublicKey } from './is-stellar-public-key.validator.js';
import { StellarAddressValidator } from './stellar-address.validator.js';

class Dto {
  @IsStellarPublicKey()
  key!: string;
}

const VALID = 'GDV3BRGE2BXK5JMGAEDGE5QWAY2DBK5V2KEG762Y5GH4LPC5RSPRPTTJ';
// Same length/prefix/charset as VALID, but last char tampered so the
// StrKey CRC16 checksum no longer matches the payload.
const CHECKSUM_INVALID =
  'GDV3BRGE2BXK5JMGAEDGE5QWAY2DBK5V2KEG762Y5GH4LPC5RSPRPTTA';

describe('IsStellarPublicKey (StrKey checksum audit)', () => {
  it('accepts a key with a valid StrKey checksum', async () => {
    const dto = Object.assign(new Dto(), { key: VALID });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a format-valid but checksum-invalid key', async () => {
    const dto = Object.assign(new Dto(), { key: CHECKSUM_INVALID });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
  });

  it.each([
    'not-a-key',
    '',
    'MDV3BRGE2BXK5JMGAEDGE5QWAY2DBK5V2KEG762Y5GH4LPC5RSPRPTTJ', // wrong prefix
    'G0000000000000000000000000000000000000000000000000000', // '0' isn't valid base32
  ])('rejects malformed input %p', async (key) => {
    const dto = Object.assign(new Dto(), { key });
    expect(await validate(dto)).toHaveLength(1);
  });

  // ── delegation contract (issue #671) ────────────────────────────────────────
  // IsStellarPublicKey must not carry its own StrKey logic; it is a thin
  // adapter over StellarAddressValidator. These tests pin the two together so
  // the decorator can never drift from the shared implementation.

  it('routes every validation through StellarAddressValidator.isValid', async () => {
    // Force the shared implementation to report "invalid" for a value that
    // is otherwise perfectly valid. If the decorator had its own StrKey logic
    // it would still pass, and this test would fail.
    const spy = jest
      .spyOn(StellarAddressValidator, 'isValid')
      .mockReturnValue(false);
    try {
      const dto = Object.assign(new Dto(), { key: VALID });
      expect(await validate(dto)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['classic Ed25519', VALID, true],
    [
      'contract address',
      StrKey.encodeContract(Buffer.alloc(32, 7)),
      false,
    ],
    [
      'muxed account',
      StrKey.encodeMed25519PublicKey(Buffer.alloc(32, 9), 12345),
      false,
    ],
  ])(
    'agrees with StellarAddressValidator strict defaults for a %s',
    async (_label, value, expected) => {
      expect(StellarAddressValidator.isValid(value)).toBe(expected);
      const dto = Object.assign(new Dto(), { key: value });
      const errors = await validate(dto);
      expect(errors).toHaveLength(expected ? 0 : 1);
    },
  );

  it('rejects non-string values', async () => {
    for (const value of [undefined, null, 42, {}, []]) {
      const dto = Object.assign(new Dto(), { key: value });
      expect(await validate(dto)).toHaveLength(1);
    }
  });
});
