# Architecture

```text
CLIENT
  -> authenticated HTTP ingress
  -> validation, account check, rate limit
  -> durable command inbox + idempotency key
  -> one PostgreSQL advisory-lock owner
  -> in-memory MatchingEngine (reconstructed cache)
  -> one database transaction
  -> orders, trades, balances, balanced ledger, events, audit, outbox
  -> read models: GET order / GET book
```

PostgreSQL is authoritative. The matching engine is rebuilt from open orders in sequence order before it accepts commands. A second process that cannot take `pg_try_advisory_lock` does not become ready and does not match.

Reservations move `available` and `locked` on `nf_balances`. Trade settlement writes immutable `nf_ledger` lines. A deferred constraint rejects a commit unless the sum of debits equals the sum of credits for that transaction.

Outbox delivery runs after commit. A failed notification does not roll back a trade.

## Order lifecycle

RECEIVED -> VALIDATED -> AUTHORIZED -> QUEUED -> MATCHING -> SETTLEMENT_PENDING -> SETTLED

Alternates: REJECTED | CANCELLED | PARTIALLY_FILLED | FILLED

Durable command status is `PENDING`, `PROCESSING`, `COMPLETED`, `REJECTED`, or `FAILED_RETRYABLE`.

## Matching topology

PRICE TREE (AVL) -> PRICE LEVEL -> FIFO doubly-linked ORDER NODE

OrderIndex: orderId -> OrderNode (O(1) lookup, O(1) unlink)

Bids cache max; asks cache min so best bid/ask is O(1).

## Where things run

| Component | Runtime | Why |
|---|---|---|
| Web UI, if added later | Static host only | Stateless |
| Matching actor | Long-lived Node process | Stateful single writer |
| Ledger and orders | PostgreSQL | ACID and recovery |

Do not put matching-engine ownership in a serverless isolate.
