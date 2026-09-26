# JWT Secret Rotation Runbook

Operator-facing steps for rotating `JWT_SECRET` without invalidating the
unredeemed claim tokens that depend on it. The supporting grace-window
implementation lives in `src/common/guards/jwt-rotation.util.ts` and is
applied by `TokenVerificationProvider.decodeClaimToken()` (see issue #683).

This is a checklist for _performing_ a rotation, not for implementing it.

## Why a window is mandatory

Claim tokens are signed JWTs, and only a SHA-256 **hash** of each token is
persisted. The plaintext token exists in exactly one place: the `claimUrl`
handed back by `POST /accounts`. That has two consequences:

- A token cannot be re-issued or re-signed. If it stops verifying, it is dead.
- Tokens can be valid for up to `CLAIM_TOKEN_EXPIRY` (default 30 days), so
  outstanding ones can live for a long time after a rotation.

Rotating `JWT_SECRET` by simply replacing it invalidates every outstanding
claim token at once. Each affected account can no longer be claimed; its funds
sit in the ephemeral account until `expiresAt`, at which point the expiry
sweep recovers them to the account's `recovery_address`. From the
integrator's point of view that is a lost claim.

The rotation window exists to make that a non-event.

## Rotation steps

1. **Confirm the window you need.** It must be at least
   `CLAIM_TOKEN_EXPIRY` measured from the moment of the switch in step 2 —
   that is how long a token minted under the old secret can still be
   presented. With the 30-day default that means a 30-day window.

2. **Set both secrets and deploy.**

   ```
   JWT_SECRET=<new>
   JWT_SECRET_PREVIOUS=<old>
   ```

   From this deploy onward:
   - new claim tokens are signed with the new secret;
   - verification tries the new secret first, then `JWT_SECRET_PREVIOUS`;
   - a token that verifies under neither secret still fails, with the error
     from the new-secret attempt (so `TokenExpiredError` is still reported as
     an expired token rather than a signature failure).

3. **Verify the window is open.** Redeem a token minted *before* the deploy —
   it must still succeed. Then confirm a freshly created account's token also
   verifies. If the pre-deploy token fails, `JWT_SECRET_PREVIOUS` is not
   reaching the process; do not proceed.

4. **Wait out the window** (≥ `CLAIM_TOKEN_EXPIRY` from step 2). Monitor
   redemption success rates throughout. Note that an account whose token has
   expired is not necessarily lost — see
   [`expires-at-scope.md`](./expires-at-scope.md) for how account expiry
   interacts with token expiry.

5. **Close the window.**

   ```
   JWT_SECRET=<new>
   # JWT_SECRET_PREVIOUS removed
   ```

   Deploy. Only outstanding tokens that are *also* past their own `exp` can
   now fail — which is the intended steady state.

## Rollback

Reverting is symmetric and safe at any point in the window: set
`JWT_SECRET` back to the old value and move the new one into
`JWT_SECRET_PREVIOUS`. Tokens minted under either secret then verify again.

After step 5 the old secret is gone from the process, so a rollback to it
would invalidate tokens minted during the window. Prefer rolling **forward**
once step 5 is done.

## Notes and limits

- `JWT_SECRET_PREVIOUS` is a single previous secret. There is no support for
  rotating twice inside one window; complete a rotation before starting the
  next.
- The window widens the set of secrets that will verify a token. Keep the
  window no longer than necessary, and treat `JWT_SECRET_PREVIOUS` as
  production-secret material: same storage, same access controls, same
  rotation policy as `JWT_SECRET` itself.
- Rotating the **sweep signing key** or the **secret-encryption key** is a
  different procedure — see
  [`signing-key-rotation-runbook.md`](./signing-key-rotation-runbook.md) and
  the key-management section of [`SECURITY.md`](../SECURITY.md).

## Validation history

This runbook should be re-validated against an actual rotation performed in a
non-production environment before being relied on in production, and kept in
sync as `jwt-rotation.util.ts` changes.
