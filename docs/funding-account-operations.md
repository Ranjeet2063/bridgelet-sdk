# Funding Account Operations

Operational guidance for whoever manages the account behind
`FUNDING_ACCOUNT_SECRET` (see `src/config/stellar.config.ts`) in production.

## Minimum balance

Keep at least **20 XLM** above the account's base reserve at all times. This
covers the base reserve for the funding account itself, its trustlines, plus
headroom for several in-flight account-creation and sweep transactions before
a human can react. Treat this as a floor, not a target — size it up with
transaction volume.

## Monitoring

Balance should be polled on an interval short enough to catch a burn-rate
spike between checks (e.g. every few minutes), not just checked ad hoc. This
document only covers the manual baseline; the automated low-balance alert
that pages an operator before the account actually runs dry is tracked
separately (see the low-balance alerting work referenced in the deployment
backlog) — this doc is not a substitute for that alert.

## If it runs dry

Account creation and sweep operations that depend on the funding account
will fail (see `AccountStatus.FAILED` handling in
`src/modules/accounts/accounts.service.ts`). Top up immediately; failed
accounts do not auto-retry.

## Securing the secret

`FUNDING_ACCOUNT_SECRET` must never be committed, logged, or included in
error messages. Store it in a secrets manager (not plain environment files
checked into any repo), restrict read access to the deploying service
identity only, and rotate it if it is ever suspected of exposure.
