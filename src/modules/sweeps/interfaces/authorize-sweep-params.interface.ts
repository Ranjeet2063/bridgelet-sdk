export interface AuthorizeSweepParams {
  ephemeralPublicKey: string;
  destinationAddress: string;
  /**
   * The EphemeralAccount contract instance to authorize against (#812).
   *
   * Required and per-call: since #811 each account has its own instance, so
   * this provider can no longer hold one contract ID bound in its constructor.
   */
  contractId: string;
  /**
   * The SweepController's current `get_nonce()` value (#812).
   *
   * Required: `SweepController::verify_sweep_auth` rebuilds the signed message
   * from the nonce it reads in storage, so signing anything else fails
   * on-chain. It is not optional because an omitted nonce used to be silently
   * signed as `0n`, which is only ever correct for the first sweep ever
   * executed by a controller.
   */
  nonce: bigint;
}
