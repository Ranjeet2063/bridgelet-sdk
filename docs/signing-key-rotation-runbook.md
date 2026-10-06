# Sweep Signing Key Rotation Runbook

Operator-facing steps for rotating the KMS key used to wrap sweep signing
material. Engineering support for this lives in
`src/common/crypto/kms-key.provider.ts` (see the data-key re-wrap method).
This is a checklist for _performing_ a rotation, not for implementing it.

## Before you start

1. Confirm a maintenance window — rotation should happen during low sweep
   volume.
2. Note the current KMS key ID/alias and the new key ID/alias you're
   rotating to.
3. Take a database snapshot as a rollback point.

## Verify your signing seed matches the on-chain authorized signer

The SweepController was initialized with a single Ed25519 public key as its
`authorized_signer`, and it verifies every sweep signature against that key. The
SDK signs with the key derived from `SWEEP_SIGNING_KEY_SEED`. **If those two
keys differ, every sweep fails signature verification on-chain** — and the
on-chain error gives no hint that the signing key is the cause.

Derive the public key from the configured seed (do not print the seed itself):

```bash
S='<64-hex seed>' node -e "const {Keypair}=require('@stellar/stellar-sdk');console.log(Keypair.fromRawEd25519Seed(Buffer.from(process.env.S,'hex')).rawPublicKey().toString('hex'))"
```

Compare the 64-character hex output against the `authorizedSigner` recorded for
the network in `bridgelet-core/deployments/<network>.json` under
`config.authorizedSigner` — for testnet,
`16ac79d642e33ac696e822cc7175ad7ddd5587a9dd8b6942640cbb832a1ab4bf`. The
comparison is byte-exact lowercase hex; no prefix conversion is needed.

The check must pass **before** rotation and again after each re-wrap. Note this
verifies the seed only. A sweep can also fail verification when the signed nonce
is stale — the SweepController nonce is a single global counter that increments
after every successful sweep, and the SDK reads it with a `get_nonce`
simulation immediately before signing.

## Rotation steps

1. Deploy the new KMS key alongside the existing one (do not delete the old
   key yet).
2. Run the re-wrap process to re-encrypt existing data-key blobs under the
   new KMS key.
3. Spot-check a small sample of accounts: confirm a sweep signs and submits
   successfully using the re-wrapped key material.
4. Once verified, update configuration to point new account creation at the
   new key.
5. Monitor sweep success/failure rates closely for the next full sweep
   cycle.

## Rollback

If signing failures appear after rotation: revert configuration to the old
KMS key ID immediately — the old key must remain enabled until rotation is
fully verified. Do not disable or schedule deletion of the previous KMS key
until at least one full sweep cycle has passed cleanly on the new key.

## Validation history

This runbook should be re-validated against an actual rotation performed in
a non-production environment before being relied on in production, and kept
in sync as `kms-key.provider.ts` changes.

Should also be linked from `SECURITY.md` given its security relevance.
