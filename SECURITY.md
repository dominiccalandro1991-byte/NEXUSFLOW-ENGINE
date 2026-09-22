# Security

Zero-trust chain: IDENTITY -> AUTHENTICATION -> AUTHORIZATION -> SCHEMA -> OWNERSHIP -> RATE LIMIT -> REPLAY -> BUSINESS RULES -> SIDE EFFECT -> AUDIT

Controls: server-side validation, ownership on cancel, token-bucket rate limit, resource caps, duplicate ids rejected, concurrent mutation rejected, balanced ledger postings, structured public errors, secrets only via env.

RLS is enabled in production schema and is not the only authorization layer.
