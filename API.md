# API domains

| Domain | Side effects |
|---|---|
| AUTH | session |
| ORDERS | place / cancel |
| MATCHING | book mutation |
| SETTLEMENT | balance lock/unlock |
| LEDGER | double-entry rows |
| ADMIN | operator |
| HEALTH | none (`GET /api/health`) |

Every state-changing call writes `nf_audit`.

Public market snapshot does not require a session. Place/cancel/balances do.
