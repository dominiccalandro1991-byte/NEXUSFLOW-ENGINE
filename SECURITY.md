# Security

Paper-trading development service. Not a live exchange.

Chain: JWT identity -> active account -> schema validation -> ownership -> rate limit -> idempotency -> business rules -> one database transaction -> audit.

Controls: server-side validation, integer lots/ticks, body size limit, owner-only reads and cancels, token-bucket rate limit, resource caps, duplicate command keys, single-writer advisory lock, immutable balanced ledger, structured public errors.

Secrets stay in the environment. The HTTP responses do not include database URLs or tokens.

RLS is enabled on account, order, ledger, command, and outbox tables. The matcher uses a direct database role. That is not a substitute for request authorization.
