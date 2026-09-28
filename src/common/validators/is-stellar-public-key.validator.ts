import { registerDecorator, ValidationOptions } from 'class-validator';
import { StellarAddressValidator } from './stellar-address.validator.js';

/**
 * `class-validator` decorator form of {@link StellarAddressValidator.isValid}.
 *
 * This is intentionally a thin adapter with no validation logic of its own —
 * `StellarAddressValidator` is the single source of truth (see issue #671).
 * DTO properties decorated here always require a classic `G...` Ed25519
 * account ID, so the strict defaults apply. Use
 * `StellarAddressValidator.assertValid(address, { allowContractAddress: true })`
 * at a call site that legitimately accepts a `C...` contract address, or
 * `{ allowMuxedAccount: true }` for an `M...` muxed account.
 */
export function IsStellarPublicKey(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStellarPublicKey',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a valid Stellar public key (56 characters, starts with G, valid StrKey checksum)`,
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          return StellarAddressValidator.isValid(value);
        },
      },
    });
  };
}
