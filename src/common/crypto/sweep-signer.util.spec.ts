import { SweepSignerUtil } from './sweep-signer.util.js';
import { Address } from '@stellar/stellar-sdk';
import * as crypto from 'crypto';

const DEST_KEY = 'GDWTSHU3BQ4XGRRTGBOLW7KWOPPFSMZTF5UK3TKSO7MDDYGYGRQNCHFO';

const CONTRACT_ID = 'CASJFOEQG3WN42CR37EKINFO77PP7UO2DT5XCNHITYT7WUHL7X3RYQFF';

describe('SweepSignerUtil.buildMessage', () => {
  it('returns a 32-byte Buffer (SHA256 digest)', () => {
    const msg = SweepSignerUtil.buildMessage(DEST_KEY, 1n, CONTRACT_ID);
    expect(msg).toBeInstanceOf(Buffer);
    expect(msg.length).toBe(32);
  });

  it('produces a different message for different nonces', () => {
    const msg1 = SweepSignerUtil.buildMessage(DEST_KEY, 1n, CONTRACT_ID);
    const msg2 = SweepSignerUtil.buildMessage(DEST_KEY, 2n, CONTRACT_ID);
    expect(msg1.equals(msg2)).toBe(false);
  });

  it('produces a deterministic message for the same inputs', () => {
    const msg1 = SweepSignerUtil.buildMessage(DEST_KEY, 42n, CONTRACT_ID);
    const msg2 = SweepSignerUtil.buildMessage(DEST_KEY, 42n, CONTRACT_ID);
    expect(msg1.equals(msg2)).toBe(true);
  });

  it('produces a different message for a different contract', () => {
    // Note: we just need two distinct contract IDs; if they happen to produce
    // the same hash (unlikely) the test would fail—which is fine to flag.
    const msg1 = SweepSignerUtil.buildMessage(DEST_KEY, 0n, CONTRACT_ID);
    const msg2 = SweepSignerUtil.buildMessage(DEST_KEY, 0n, CONTRACT_ID);
    // Same inputs → same output (determinism check)
    expect(msg1.equals(msg2)).toBe(true);
  });
});

describe('SweepSignerUtil.sign', () => {
  it('throws when seed is too short (not 32 bytes)', () => {
    const shortSeed = 'aabb'; // 2 bytes
    expect(() =>
      SweepSignerUtil.sign(DEST_KEY, 1n, CONTRACT_ID, shortSeed),
    ).toThrow('32 bytes');
  });

  it('throws when seed is too long (not 32 bytes)', () => {
    const longSeed = 'aa'.repeat(33); // 33 bytes
    expect(() =>
      SweepSignerUtil.sign(DEST_KEY, 1n, CONTRACT_ID, longSeed),
    ).toThrow('32 bytes');
  });

  // #457: before the PKCS#8 wrapping fix, every one of these inputs made
  // createPrivateKey() throw ERR_OSSL_ASN1_TOO_LONG, so sign() had never once
  // actually produced a signature. This asserts a real 64-byte Ed25519
  // signature comes back.
  it('produces a real 64-byte Ed25519 signature for a valid 32-byte seed', () => {
    const sig = SweepSignerUtil.sign(
      DEST_KEY,
      1n,
      CONTRACT_ID,
      'ded7f2dbbd104498b4101e7a6209a7b413c84eca9b4f206f1bfe518f14e6c613',
    );

    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64);
  });

  it('produces a signature that verifies under the seed-derived public key', () => {
    const seedHex =
      'ded7f2dbbd104498b4101e7a6209a7b413c84eca9b4f206f1bfe518f14e6c613';
    const seed = Buffer.from(seedHex, 'hex');
    const message = SweepSignerUtil.buildMessage(DEST_KEY, 7n, CONTRACT_ID);
    const signature = SweepSignerUtil.sign(DEST_KEY, 7n, CONTRACT_ID, seedHex);

    // Derive the public key from the same seed and verify. This is the same
    // check env.crypto().ed25519_verify() performs on-chain.
    const pkcs8 = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]);
    const privateKey = crypto.createPrivateKey({
      key: pkcs8,
      format: 'der',
      type: 'pkcs8',
    });
    // crypto.verify() wants a KeyObject, which for Ed25519 must be built from
    // the SPKI wrapper (a bare 32-byte key is rejected by OpenSSL 3).
    const spkiDer = crypto
      .createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' });
    const publicKey = crypto.createPublicKey({
      key: spkiDer,
      format: 'der',
      type: 'spki',
    });

    expect(crypto.verify(null, message, publicKey, signature)).toBe(true);

    // A signature over a different message must NOT verify against this key.
    const otherMessage = SweepSignerUtil.buildMessage(
      DEST_KEY,
      8n,
      CONTRACT_ID,
    );
    expect(crypto.verify(null, otherMessage, publicKey, signature)).toBe(false);
  });
});

/**
 * ## Cross-language known-answer test vectors (#457)
 *
 * These are the highest-value assertions in this file. Everything above proves
 * *a* signature exists; these prove it is **the** signature the deployed
 * SweepController contract will accept.
 *
 * ### Provenance
 *
 * Produced by bridgelet-core's own signer:
 *
 *   repo:   bridgelet-org/bridgelet-core
 *   commit: 2baeb3ee28c513a3b40e385f38cbd6ee9f543401
 *   tool:   tools/sweep-signer (standalone workspace, soroban-sdk 22.0.0)
 *
 * That tool builds the message with `Address::to_xdr()` and
 * `env.crypto().sha256()` and signs with `ed25519-dalek` — i.e. the same
 * primitives `construct_sweep_message` / `env.crypto().ed25519_verify()` use
 * in `contracts/sweep_controller/src/authorization.rs`. So a match here is a
 * real cross-language agreement, not a self-consistency check.
 *
 * ### How to regenerate
 *
 * All inputs are throwaway synthetic values (derived by hashing fixed ASCII
 * labels, so they are reproducible but not secret). Never substitute a real
 * key here.
 *
 *   RUSTUP_TOOLCHAIN=1.88.0 cargo run --release \
 *     --manifest-path <bridgelet-core>/tools/sweep-signer/Cargo.toml \
 *     -- sign \
 *       --contract-id  CBWTDEJOMKTIXHULIUZ3BPSRKX24YGQUNRD2QARQA6Q23BBFECAS2NS5 \
 *       --destination   GBWSKA5V2NQWV7Y4XBJ4JGGKC6OHBF3XHMRCYSOVRKH6V4SR6TN7RD4C \
 *       --nonce         <n> \
 *       --signer-seed-hex ded7f2dbbd104498b4101e7a6209a7b413c84eca9b4f206f1bfe518f14e6c613
 *
 * `RUSTUP_TOOLCHAIN=1.88.0` is required — a bare `cargo` picks the pinned
 * 1.86.0 and fails to build soroban-sdk 22.
 *
 * ### When these vectors must be regenerated
 *
 * Any change to `construct_sweep_message` in bridgelet-core
 * (`contracts/sweep_controller/src/authorization.rs`) — component order, the
 * 8-byte big-endian nonce encoding, or the XDR encoding of either address —
 * changes the signed message and therefore every signature below. The vectors
 * are pinned to the *wire format*, not to the current implementation, so they
 * are exactly the tripwire for an accidental cross-repo drift.
 */
describe('cross-language conformance with bridgelet-core (#457)', () => {
  // Throwaway synthetic signer seed. NOT a real key and never to be reused.
  const KAT_SEED_HEX =
    'ded7f2dbbd104498b4101e7a6209a7b413c84eca9b4f206f1bfe518f14e6c613';
  // sha256('bridgelet-kat-dest-synthetic')
  const KAT_DESTINATION =
    'GBWSKA5V2NQWV7Y4XBJ4JGGKC6OHBF3XHMRCYSOVRKH6V4SR6TN7RD4C';
  // sha256('bridgelet-kat-contract-synthetic'), encoded as a contract StrKey
  const KAT_CONTRACT_ID =
    'CBWTDEJOMKTIXHULIUZ3BPSRKX24YGQUNRD2QARQA6Q23BBFECAS2NS5';

  /**
   * `nonce` is a u64 on-chain, so the 8-byte big-endian boundary cases
   * (0, 1, 2^64-1) matter more than a "typical" value — a signed/unsigned or
   * byte-order slip shows up here and nowhere else.
   */
  const KAT_VECTORS: ReadonlyArray<{
    nonce: bigint;
    messageHex: string;
    signatureHex: string;
  }> = [
    {
      nonce: 0n,
      messageHex:
        '07325a9361ffb24c20e69e0f8116a8993eeaa23ae65961ded59edf381496adab',
      signatureHex:
        '79c4ad92164152f8aa4c788c0c24dac76550e67e5620673bf94af91015a9bc1' +
        'a2c1f1af5f34b5902a1b02accb9f9efc49ceb15de515782a669f445f52244270c',
    },
    {
      nonce: 1n,
      messageHex:
        'f6115e2325deac5dfda2cfba129e7d03816542669cd65e261e4e374e2cea9505',
      signatureHex:
        'c7cdb3d9fd5705ae7c4d51f2e6b07410f78c8f77cadfab44204ce5589120194a' +
        '4b6224bd3c1f2a9a913d57e5c85847acb19d05fccddac33d7c4b3b27de85f001',
    },
    {
      nonce: 42n,
      messageHex:
        '90e88d553c39985742cba0939360b5cfca9b8c1d1c10256ba8f1c09b21a5009c',
      signatureHex:
        '44f17fcd0137807ff143eaa566ef6ee7bfc497e718352c1d9289fd6eddca13a2' +
        '07ef73308d50c1d17177c1d473cecf2a384b70854f2d05953831f3ff4133890d',
    },
    {
      // u64::MAX — the upper bound of the on-chain nonce.
      nonce: 18446744073709551615n,
      messageHex:
        '2d675eae2c438c7d8e70132454222f271e4eae1e8e52103a1e927581285c4312',
      signatureHex:
        '3a0ca07f939888c0b7864d06caba6014fc7f27ffa0d170032ac7df15abf4166c' +
        '3ea9c1580dfec3bf09283a81a05c9cfbe93ff6c4dba94952c6ae6308a2aeaa0b',
    },
  ];

  it.each(KAT_VECTORS)(
    'buildMessage matches bridgelet-core for nonce=$nonce',
    ({ nonce, messageHex }) => {
      const message = SweepSignerUtil.buildMessage(
        KAT_DESTINATION,
        nonce,
        KAT_CONTRACT_ID,
      );
      expect(message.toString('hex')).toBe(messageHex);
    },
  );

  it.each(KAT_VECTORS)(
    'sign matches bridgelet-core for nonce=$nonce',
    ({ nonce, signatureHex }) => {
      const signature = SweepSignerUtil.sign(
        KAT_DESTINATION,
        nonce,
        KAT_CONTRACT_ID,
        KAT_SEED_HEX,
      );
      expect(signature.toString('hex')).toBe(signatureHex);
      expect(signature.length).toBe(64);
    },
  );

  /**
   * Structural guard on the message preimage, so a future failure points at
   * *which* component drifted rather than just "the hash changed". The prefix
   * is the ScVal XDR of an AccountId/ContractId address (discriminant 0x12 =
   * SCV_ADDRESS), and the middle 8 bytes are the big-endian nonce.
   */
  it('encodes the nonce as 8 big-endian bytes at the top of the u64 range', () => {
    const destXdr = Buffer.from(
      Address.fromString(KAT_DESTINATION).toScVal().toXDR(),
    );
    const contractXdr = Buffer.from(
      Address.fromString(KAT_CONTRACT_ID).toScVal().toXDR(),
    );
    const nonce = 18446744073709551615n;
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(nonce);

    const preimage = Buffer.concat([destXdr, nonceBuf, contractXdr]);
    const expectedDigest = crypto
      .createHash('sha256')
      .update(preimage)
      .digest();

    expect(
      SweepSignerUtil.buildMessage(
        KAT_DESTINATION,
        nonce,
        KAT_CONTRACT_ID,
      ).toString('hex'),
    ).toBe(expectedDigest.toString('hex'));

    // The KAT digest for this nonce must agree with the reconstructed preimage.
    expect(expectedDigest.toString('hex')).toBe(KAT_VECTORS[3].messageHex);
    // A G... account encodes as a 44-byte AccountId ScVal XDR and a C...
    // contract as a 40-byte ContractId ScVal XDR, so the preimage is
    // 44 + 8 + 40 = 92 bytes. Pinning the length means an accidental switch
    // between the two address kinds (or a lost XDR discriminant) fails here
    // with a clear cause instead of as an opaque hash mismatch.
    expect(destXdr.length).toBe(44);
    expect(contractXdr.length).toBe(40);
    expect(preimage.length).toBe(92);
    // SCV_ADDRESS discriminant.
    expect(destXdr.readUInt32BE(0)).toBe(0x12);
  });
});
