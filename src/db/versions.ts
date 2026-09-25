export const REQUIRED_MIGRATIONS = [
  "20260922041334_baseline_schema",
  "20260925120000_production_service",
] as const;

export const REQUIRED_TABLES = [
  "nf_assets",
  "nf_instruments",
  "nf_accounts",
  "nf_balances",
  "nf_orders",
  "nf_trades",
  "nf_ledger",
  "nf_ledger_transactions",
  "nf_order_events",
  "nf_audit",
  "nf_commands",
  "nf_book_state",
  "nf_outbox",
  "nf_schema_migrations",
] as const;

export const REQUIRED_TRIGGERS = [
  "nf_ledger_immutable",
  "nf_ledger_transactions_immutable",
  "nf_ledger_must_balance",
] as const;
