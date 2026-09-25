# Deployment

Paper-trading development service only. No exchange, custody, token, or real-money behavior is implemented here.

Nothing in this repository has been deployed by this change. No Cloud Run, Render, Vercel, or Supabase project was created or modified.

## What was proven locally

- `npm test` passes, including the original matching-engine suite.
- `npm run test:integration` passes against disposable local PostgreSQL 16.
- `npm run bench` still runs the in-memory benchmark and is not the process entrypoint.
- `npm start` runs `node --experimental-strip-types src/main.ts`.
- The Docker `CMD` is that same process. This sandbox could not start a container daemon, so an image run was not executed here.

## Runtime shape (not provisioned)

- Vercel, if used later: documentation/frontend only. Do not put the matcher in serverless.
- Supabase, if authorized later: PostgreSQL, Auth, and optional realtime read models for this NEXUSFLOW project only.
- One long-lived Node process: the single-writer matcher. A free always-on worker is not assumed.

## Database

Schema changes are versioned in `supabase/migrations/` and applied by `npm run migrate` or `AUTO_MIGRATE=true` (default off in production).

Local test target used here: disposable PostgreSQL 16 database `nexusflow_test` on `127.0.0.1`.

### Migrations that exist and were applied only to that local database

1. `supabase/migrations/20260922041334_baseline_schema.sql`
2. `supabase/migrations/20260925120000_production_service.sql`

No remote migration was applied. No Supabase project ref was confirmed.

### Later plan, do not run until the NEXUSFLOW project ref is explicitly confirmed

```bash
supabase link --project-ref <CONFIRMED_NEXUSFLOW_PROJECT_REF>
supabase db push --dry-run
supabase db push
```

Do not link VOLTCORE or any other project. Do not apply these files from the Supabase dashboard as untracked edits.

The matcher connects with `DATABASE_URL` as a direct Postgres role that can bypass RLS. Browser keys and the service-role key are not used by this process and must not be committed.
