-- Additive production service layer for the paper-trading matcher.
-- No destructive changes to the baseline matching schema.
-- Quantities stay integer lots/ticks. Ledger rows are immutable and must balance.

CREATE TABLE IF NOT EXISTS nf_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE nf_orders
  ADD CONSTRAINT nf_orders_remaining_lte_quantity CHECK (remaining <= quantity);

ALTER TABLE nf_orders
  ADD CONSTRAINT nf_orders_status_known CHECK (
    status IN ('open', 'partially_filled', 'filled', 'cancelled', 'rejected')
  );

ALTER TABLE nf_orders
  ADD CONSTRAINT nf_orders_sequence_positive CHECK (sequence_no > 0);

ALTER TABLE nf_ledger
  ADD CONSTRAINT nf_ledger_no_mixed_line CHECK (NOT (debit > 0 AND credit > 0));

CREATE TABLE nf_ledger_transactions (
  transaction_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('trade', 'reservation', 'release', 'adjustment')),
  command_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nf_commands (
  command_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES nf_accounts(user_id),
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('PLACE_ORDER', 'CANCEL_ORDER')),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED_RETRYABLE')
  ),
  result jsonb,
  error_code text,
  error_message text,
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX nf_commands_status_created_idx ON nf_commands (status, created_at);

CREATE TABLE nf_book_state (
  instrument_id text PRIMARY KEY REFERENCES nf_instruments(id),
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nf_outbox (
  event_id text PRIMARY KEY,
  command_id text,
  account_id text,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);

CREATE INDEX nf_outbox_pending_idx ON nf_outbox (next_attempt_at, created_at)
  WHERE published_at IS NULL;

CREATE INDEX nf_orders_recovery_idx ON nf_orders (instrument_id, sequence_no, order_id)
  WHERE status IN ('open', 'partially_filled') AND remaining > 0;

ALTER TABLE nf_trades
  ADD CONSTRAINT nf_trades_instrument_fk FOREIGN KEY (instrument_id) REFERENCES nf_instruments(id);

ALTER TABLE nf_trades
  ADD CONSTRAINT nf_trades_maker_order_fk FOREIGN KEY (maker_order_id) REFERENCES nf_orders(order_id);

ALTER TABLE nf_trades
  ADD CONSTRAINT nf_trades_taker_order_fk FOREIGN KEY (taker_order_id) REFERENCES nf_orders(order_id);

CREATE OR REPLACE FUNCTION nf_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_ROW' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER nf_ledger_immutable
BEFORE UPDATE OR DELETE ON nf_ledger
FOR EACH ROW
EXECUTE FUNCTION nf_reject_mutation();

CREATE TRIGGER nf_ledger_transactions_immutable
BEFORE UPDATE OR DELETE ON nf_ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION nf_reject_mutation();

CREATE OR REPLACE FUNCTION nf_ledger_balance_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tid text;
  d bigint;
  c bigint;
BEGIN
  tid := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO d, c
  FROM nf_ledger
  WHERE transaction_id = tid;
  IF d <> c THEN
    RAISE EXCEPTION 'UNBALANCED_LEDGER transaction_id=% debit=% credit=%', tid, d, c
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER nf_ledger_must_balance
AFTER INSERT OR UPDATE OR DELETE ON nf_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION nf_ledger_balance_check();

ALTER TABLE nf_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE nf_book_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE nf_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE nf_ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nf_schema_migrations ENABLE ROW LEVEL SECURITY;
