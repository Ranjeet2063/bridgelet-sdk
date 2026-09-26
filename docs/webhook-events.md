# Webhook Events

## Event catalogue

Every event name passed to `WebhooksService.triggerEvent(...)` in the
codebase, with the payload it carries. Subscribe by listing the exact strings
in `CreateWebhookDto.events`.

The request body delivered to your endpoint is always
`{ "event": "<name>", ...payload }` — the event name is repeated as the
`event` field, and also sent as the `X-Bridgelet-Event` header.

| Event              | Emitted by                                | Meaning                                          |
| ------------------ | ----------------------------------------- | ------------------------------------------------ |
| `account.created`  | `AccountsService.create()`                | An ephemeral account was created and funded.     |
| `account.expired`  | `SchedulerService.handleExpiredClaims()`   | An account passed its expiry and was swept to the recovery address. |
| `sweep.completed`  | `ClaimRedemptionProvider.redeemClaim()`   | A claim was redeemed and funds were swept.       |
| `sweep.partial`    | `ClaimRedemptionProvider.redeemClaim()`   | The contract authorised the sweep but the Horizon payment did not settle. |
| `sweep.failed`     | `ClaimRedemptionProvider.redeemClaim()`   | A redemption attempt failed.                     |

### `account.created`

Emitted after the account is initialised on-chain and persisted.

```json
{
  "event": "account.created",
  "accountId": "550e8400-e29b-41d4-a716-446655440000",
  "publicKey": "GABCD1234EFGH5678IJKL9012MNOP3456QRST7890UVWX1234YZAB5678",
  "amount": "100.0000000",
  "asset": "native",
  "expiresAt": "2026-03-26T10:00:00.000Z"
}
```

| Field       | Type     | Notes                                        |
| ----------- | -------- | -------------------------------------------- |
| `accountId` | string   | Internal account UUID.                       |
| `publicKey` | string   | Stellar address of the ephemeral account.    |
| `amount`    | string   | Decimal string, 7 dp.                        |
| `asset`     | string   | `native`, or `CODE:ISSUER`.                  |
| `expiresAt` | ISO 8601 | When the account becomes unusable.           |

> The claim token is **not** included. It is returned exactly once, in the
> `POST /accounts` response's `claimUrl`, and only a hash is persisted — so
> there is no way to re-deliver it. Capture it at creation time.

### `account.expired`

Emitted by the expiry sweep. Funds have been recovered to the account's
`recovery_address`; the claim token no longer works.

```json
{
  "event": "account.expired",
  "accountId": "550e8400-e29b-41d4-a716-446655440000",
  "publicKey": "GABCD1234EFGH5678IJKL9012MNOP3456QRST7890UVWX1234YZAB5678",
  "expiredAt": "2026-03-26T10:00:00.000Z"
}
```

| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| `accountId` | string   | Internal account UUID.               |
| `publicKey` | string   | Stellar address of the expired account. |
| `expiredAt` | ISO 8601 | When the transition happened.        |

### `sweep.completed`

Emitted on successful redemption. Funds are on their way to `destination`.

```json
{
  "event": "sweep.completed",
  "accountId": "550e8400-e29b-41d4-a716-446655440000",
  "amount": "100.0000000",
  "asset": "native",
  "destination": "GBBD47UZQ5YLQYYTWTCB7X3DUEEVZMDVGFBRNZPMZDWQWKCFN3EOZQKQ",
  "txHash": "571a84bc59fefb3fd17fe167b9c76286e83c31972649441a2d09da87f5b997a7",
  "sweptAt": "2026-01-14T17:49:20.265Z",
  "metadata": { "integration_id": "webhook_123" }
}
```

| Field        | Type              | Notes                                              |
| ------------ | ----------------- | -------------------------------------------------- |
| `accountId`  | string            | Internal account UUID.                             |
| `amount`     | string            | Amount swept.                                      |
| `asset`      | string            | `native`, or `CODE:ISSUER`.                        |
| `destination`| string            | Where the funds were sent.                         |
| `txHash`     | string            | Stellar tx hash — reconcile against this.          |
| `sweptAt`    | ISO 8601          | When the claim was recorded.                       |
| `metadata`   | object \| null    | The account's sanitised metadata, if any.          |

### `sweep.partial`

The contract authorised the sweep but the Horizon payment did not settle. The
account is left in `PARTIAL_SWEEP`; a retry with the **same claim token**
resumes the payment without re-authorising the contract.

```json
{
  "event": "sweep.partial",
  "accountId": "550e8400-e29b-41d4-a716-446655440000",
  "amount": "100.0000000",
  "asset": "native",
  "destination": "GBBD47UZQ5YLQYYTWTCB7X3DUEEVZMDVGFBRNZPMZDWQWKCFN3EOZQKQ",
  "error": "payment failed: tx_submission_failed",
  "contractAuthHash": "571a84bc59fefb3fd17fe167b9c76286e83c31972649441a2d09da87f5b997a7"
}
```

| Field              | Type     | Notes                                        |
| ------------------ | -------- | -------------------------------------------- |
| `error`            | string   | Failure reason from the sweep path.          |
| `contractAuthHash` | string   | The authorisation that already succeeded.    |

Treat this as **retryable**, not terminal. Do not create a replacement account
for a partial sweep — the original still holds the authorised state.

### `sweep.failed`

A redemption attempt failed. The account is returned to `PENDING_CLAIM` (or
left in `PARTIAL_SWEEP` if it was already partially swept) so the holder of the
claim token can retry.

```json
{
  "event": "sweep.failed",
  "accountId": "550e8400-e29b-41d4-a716-446655440000",
  "amount": "100.0000000",
  "asset": "native",
  "destination": "GBBD47UZQ5YLQYYTWTCB7X3DUEEVZMDVGFBRNZPMZDWQWKCFN3EOZQKQ",
  "error": "destination account does not exist",
  "timestamp": "2026-01-14T17:49:20.265Z"
}
```

| Field       | Type     | Notes                                        |
| ----------- | -------- | -------------------------------------------- |
| `error`     | string   | Failure reason. Message text is not stable — do not match on it. |
| `timestamp` | ISO 8601 | When the failure was recorded.               |

`sweep.completed` and `sweep.failed` are mutually exclusive for a given
redemption: a successful redemption fires only `sweep.completed`, a failed one
fires only `sweep.failed`. Exactly one of them (or `sweep.partial`) fires per
redemption attempt.

## Delivery Guarantees

Deliveries are sent with a 10-second timeout. A non-2xx response or a transport
error is logged and **not retried** — at-least-once is not guaranteed, so your
endpoint should be idempotent (keyed on `accountId` + `event`, and on `txHash`
for `sweep.completed`). The same event may in principle be delivered more than
once.

`WebhooksService.triggerEvent()` never throws: a webhook failure cannot fail the
business operation that triggered it.

## Delivery Signing

Every outbound webhook delivery is signed with HMAC-SHA256, computed over
the raw JSON request body using the webhook's `secret` (set at creation via
`CreateWebhookDto.secret`, or rotated later via `UpdateWebhookDto.secret`).

The signature is sent in the `X-Bridgelet-Signature` header as:

```
X-Bridgelet-Signature: sha256=<hex-encoded HMAC-SHA256 digest>
```

The event type is also sent separately in `X-Bridgelet-Event`.

To verify a delivery, recompute the HMAC-SHA256 digest of the exact raw
request body using your webhook's secret and compare it (constant-time) to
the value after `sha256=` in `X-Bridgelet-Signature`. If no secret was set
for the webhook, deliveries are still sent but signed with an empty key —
treat those as unverifiable and prefer always setting a secret.

If a webhook has no secret configured, `X-Bridgelet-Signature` is still
present but cannot be used to authenticate the sender.

## Delivery Records

Each delivery attempt is recorded in the `webhook_deliveries` table
(`WebhookDelivery` entity, `src/modules/webhooks/entities/webhook-delivery.entity.ts`):

- `eventType` — the event that triggered delivery
- `attemptCount` — number of delivery attempts made
- `lastResponseCode` / `lastResponseBody` — the receiving endpoint's last response
- `deliveredAt` — timestamp of the last successful delivery, if any
