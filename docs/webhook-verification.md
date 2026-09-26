# Webhook Payload Verification

Companion to [`webhook-events.md`](./webhook-events.md). Every outbound
delivery is signed with HMAC-SHA256 over the raw JSON body, using the
webhook's `secret` (`WebhooksService.computeSignature`), and sent as:

```
X-Bridgelet-Signature: sha256=<hex-digest>
```

The event name is sent alongside it in `X-Bridgelet-Event`.

## Verifying a payload (Node.js)

```js
const crypto = require('crypto');

function isValidSignature(rawBody, header, secret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;

  // timingSafeEqual throws when the two buffers differ in length, so compare
  // lengths first. A length check on a hex digest leaks nothing useful.
  const a = Buffer.from(header, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
```

Always verify against the raw request body (before JSON parsing) — a
re-serialized body will not match the signature.

## Rotating the secret

`secret` is set on create and rotated with `PUT /webhooks/:id`:

```json
{ "secret": "a-new-signing-secret-at-least-16-chars" }
```

Rotation takes effect on the next delivery. There is **no grace period** in
which both the old and new secret are accepted, so update your verifier in the
same deploy that changes the secret, or you will reject your own deliveries.

Secrets must be at least 16 characters and contain only `[A-Za-z0-9_-]`.

## Handling secrets safely

- `secret` is **write-only**. It is accepted on create and update and is
  never present in any response body (`WebhookResponseDto` has no `secret`
  field), so it cannot be read back through the API. If you lose it, rotate
  it — there is no way to recover the current value.
- Secrets are stored **encrypted at rest** with the same envelope encryption
  used for account secret keys, and are decrypted only at the moment a
  delivery is signed.
- Keep the secret out of logs and out of your receiver's request logs. It is a
  shared HMAC key: anyone holding it can forge deliveries your endpoint will
  accept.
- If a webhook has no secret, deliveries are still sent but signed with an
  empty key. Treat those as unverifiable and reject them.

## Example payload

```json
{
  "event": "sweep.partial",
  "accountId": "acc_9f2c...",
  "amount": "100.0000000",
  "asset": "native",
  "destination": "GBD...",
  "error": "payment failed: tx_submission_failed",
  "contractAuthHash": "571a84bc...",
  "timestamp": "2026-09-24T10:00:00.000Z"
}
```

Fields are stable per `event` type; new optional fields may be added without
notice, but no field is ever removed or renamed within a major API version —
integrators should ignore unrecognized fields rather than reject them. See
[`webhook-events.md`](./webhook-events.md) for the per-event payload shapes.

## Delivery records

Each delivery attempt is recorded against the subscription in the
`webhook_deliveries` table (`WebhookDelivery`,
`src/modules/webhooks/entities/webhook-delivery.entity.ts`), which is useful
when debugging why a receiver did not see an event:

| Column             | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `subscriptionId`   | The webhook the delivery was for (`ON DELETE CASCADE`).    |
| `eventType`        | The event that triggered it.                               |
| `payloadHash`      | SHA-256 of the delivered body, for correlating duplicates. |
| `attemptCount`     | Number of delivery attempts made.                          |
| `lastResponseCode` | The receiver's HTTP status, if it responded.               |
| `lastResponseBody` | Truncated receiver response body (max 2048 chars).         |
| `deliveredAt`      | When a delivery last succeeded; null while failing.        |

A `subscriptionId` with `deliveredAt: null` and a non-null
`lastResponseCode` is a delivery your endpoint rejected.

Note that these records survive `DELETE /webhooks/:id`, which is a soft
delete (`isActive = false`) rather than a row removal.
