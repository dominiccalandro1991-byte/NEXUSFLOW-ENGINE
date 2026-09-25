# Testing

```bash
npm test
npm run test:integration
npm run bench
```

`npm test` covers the original matching, AVL, ledger-posting, and adversarial cases plus configuration, recovery insertion, and the Dockerfile command.

`npm run test:integration` needs PostgreSQL and covers persistence, idempotency, ledger conservation, advisory-lock ownership, recovery/FIFO, restart, abandoned commands, health versus readiness, outbox failure, and SIGTERM/SIGINT.

The benchmark stays a separate script.
