# Account Status Reference

Full current values of `AccountStatus`
(`src/modules/accounts/enums/account-status.enum.ts`), which the
`## Account Status Enum` section of `database-schema.md` has drifted out of
sync with — it's missing `partial_sweep`, added in
`1718100008000-AddPartialSweepToAccountStatus.ts`.

| Value             | Meaning                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `initializing`    | Account row created; funding not yet confirmed.                                                                             |
| `pending_payment` | Waiting for the incoming funding payment.                                                                                   |
| `pending_claim`   | Funded; ready for a claim/redemption attempt.                                                                               |
| `claiming`        | A claim is in progress (locked to prevent concurrent claims).                                                               |
| `partial_sweep`   | Sweep's on-chain contract step succeeded but the Horizon payment failed; safe to retry without re-authorizing the contract. |
| `claimed`         | Claim completed successfully; terminal.                                                                                     |
| `expired`         | Account expired before being claimed (set by the scheduler); terminal.                                                      |
| `failed`          | Unrecoverable error (e.g. funding account exhausted); terminal.                                                             |

## Valid transitions

```
initializing -> pending_payment -> pending_claim -> claiming -> claimed
                                                        |  ^
                                                        v  |
                                                  partial_sweep
pending_payment / pending_claim -> expired   (scheduler, on timeout)
initializing -> failed                        (funding error)
```

`claiming` -> `partial_sweep` happens when the contract-authorization step of
a sweep succeeds but the Horizon payment fails; a retry from `partial_sweep`
re-enters `claiming` and skips re-authorizing the contract
(`claim-redemption.provider.ts`).

**Keep this table in sync**: any migration that adds a new
`account_status_enum` value must update this file in the same PR.
