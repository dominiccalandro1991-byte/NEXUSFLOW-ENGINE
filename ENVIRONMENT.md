# Environment

See `.env.example`. Never commit values.

| Name | Required | Notes |
|---|---|---|
| DATABASE_URL | yes | Direct Postgres URL. Not exposed to a browser |
| NEXUSFLOW_JWT_SECRET or SUPABASE_JWT_SECRET | hmac mode | At least 16 characters |
| SUPABASE_URL | supabase auth mode | JWKS and default issuer `{url}/auth/v1` |
| DATABASE_SSL | remote production | `require` or `no-verify`. `disable` only for localhost |
| MATCHER_LOCK_KEY | no | Default `nexusflow:global-matcher` |
| AUTO_MIGRATE | no | Default true outside production, false in production |
| PORT | no | Default 8080. `0` selects an ephemeral port |

Startup throws if required configuration is missing or invalid. The historical note that preview uses PGLite when `DATABASE_URL` is unset is not how this process behaves: there is no embedded fallback.
