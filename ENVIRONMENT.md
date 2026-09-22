# Environment

See `.env.example`. Never commit values.

| Name | Owner | Required |
|---|---|---|
| DATABASE_URL | Postgres | production |
| NEXUSFLOW_SERVICE_ROLE_KEY | server | production |
| STRIPE_SECRET_KEY | billing | optional |
| STRIPE_WEBHOOK_SECRET | webhooks | optional |
| VITE_API_BASE | frontend | optional |

Preview uses PGLite when `DATABASE_URL` is unset.
