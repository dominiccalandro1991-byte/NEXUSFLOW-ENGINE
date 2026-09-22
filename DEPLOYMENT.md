# Deployment

USERS -> Vercel (web) -> Render worker (matching core, Docker) -> PostgreSQL

Docker is used because the matching actor is a persistent single-writer process. That is a real runtime requirement, not decoration.

The interactive desk currently runs in the Grok App Builder sandbox against PGLite. Deployed database is Neon when DATABASE_URL is injected.

render.yaml defines nexusflow-matching-core.

UNVERIFIED: live Render URL, live Stripe, live Supabase project, GitHub Codespaces runtime (config present; create API not available on this connector).
