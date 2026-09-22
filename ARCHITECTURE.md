# Architecture

CLIENT -> EDGE/API -> AUTH -> AUTHZ -> VALIDATE -> RATE LIMIT -> RISK
      -> MATCHING ENGINE (single writer) -> TRADES -> SETTLEMENT -> POSTGRES LEDGER
      -> AUDIT -> REALTIME SNAPSHOT

## Order lifecycle

RECEIVED -> VALIDATED -> AUTHORIZED -> QUEUED -> MATCHING -> SETTLEMENT_PENDING -> SETTLED

Alternates: REJECTED | CANCELLED | PARTIALLY_FILLED | FILLED

## Matching topology

PRICE TREE (AVL) -> PRICE LEVEL -> FIFO doubly-linked ORDER NODE
OrderIndex: orderId -> OrderNode (O(1) lookup, O(1) unlink)

Bids cache max; asks cache min so best bid/ask is O(1).

## Where things run

| Component | Runtime | Why |
|---|---|---|
| Web UI | Vercel / TanStack Start | Stateless |
| Matching actor | Long-lived Node (Render worker) | Stateful, single-writer |
| Ledger | PostgreSQL (Neon in preview, Supabase-capable schema) | ACID |

Do not put matching-engine ownership in a serverless isolate.
