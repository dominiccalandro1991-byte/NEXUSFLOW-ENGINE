# NEXUSFLOW-ENGINE

Token-agnostic real-time digital-asset **order matching** platform.

This repository is independent of OmniAgent Matrix and of every other GitHub repository under this account.

## What it is

A paper-trading matching core with:

- Deterministic **single-writer** matching actor
- AVL price tree + FIFO levels + O(1) order-id index
- Limit / market orders, partial fills, cancellation
- Double-entry settlement posting (total debit = total credit)
- PostgreSQL ledger schema
- Hard resource limits

It does **not** issue, sell, or launch any token. A future asset is another `nf_assets` / `nf_instruments` row.

It is **not** a legal authorization to operate a real-money exchange.

## Run

```bash
npm test
npm run test:integration   # needs DATABASE_URL and local PostgreSQL
npm run bench              # in-memory benchmark only
npm start                  # persistent matcher; requires env from .env.example
```

Node 22 required. The benchmark is not the production entrypoint.

## Measured (this sandbox, 2026-09-22)

| Path | Result |
|---|---|
| 2000 inserts | 12.89 ms (~155k/s) |
| 200 best-price lookups | 0.01 ms |
| 200 cancellations | 1.18 ms |
| Market match 400 lots | 0.64 ms |

These are measurements, not latency SLAs. Re-run `npm run bench` for a fresh local number.
