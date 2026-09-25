# API

Paper-trading HTTP ingress. Matching runs in the long-lived Node process, not in a serverless function.

| Method | Path | Auth | Effect |
|---|---|---|---|
| GET | `/healthz` | no | Process liveness only |
| GET | `/readyz` | no | Ready only after config, database, schema, advisory lock, recovery, processor, and ingress are up |
| POST | `/v1/orders` | Bearer JWT | Durable place command. Requires `Idempotency-Key` |
| POST | `/v1/orders/{orderId}/cancel` | Bearer JWT | Durable cancel. Owner only. Requires `Idempotency-Key` |
| GET | `/v1/orders/{orderId}` | Bearer JWT | Owner read model, including fills |
| GET | `/v1/books/{instrumentId}` | no | Committed depth aggregated from PostgreSQL |

Account id is the JWT `sub`. A body account id is ignored. Same idempotency key and payload returns the stored result. A different payload with the same key returns 409.

`POST /v1/orders` returns 201 when the command completes, 200 on a completed retry, 202 if still queued, 422 if the command was rejected.

Example place body, using fake values:

```json
{
  "instrumentId": "BTC-USD",
  "side": "buy",
  "type": "limit",
  "priceTicks": 100,
  "quantity": 2
}
```

Market orders send `"priceTicks": null`.
