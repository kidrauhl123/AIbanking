CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  risk_profile TEXT NOT NULL DEFAULT 'BALANCED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  masked_no TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  available_balance_minor BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_balance_nonnegative CHECK (available_balance_minor >= 0),
  CONSTRAINT account_status_valid CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED'))
);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  phone TEXT,
  bank_name TEXT NOT NULL,
  masked_account TEXT NOT NULL,
  settlement_account_id UUID NOT NULL REFERENCES accounts(id),
  trusted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  from_account_id UUID NOT NULL REFERENCES accounts(id),
  beneficiary_id UUID NOT NULL REFERENCES beneficiaries(id),
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  note TEXT,
  risk_level TEXT NOT NULL,
  required_auth TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREPARED',
  authorization_fingerprint TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  failure_code TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT transfer_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT transfer_risk_valid CHECK (risk_level IN ('GREEN', 'YELLOW', 'RED')),
  CONSTRAINT transfer_status_valid CHECK (status IN ('PREPARED', 'AWAITING_AUTH', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'CANCELLED'))
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  transfer_id UUID UNIQUE REFERENCES transfers(id),
  transaction_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED',
  description TEXT,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  amount_minor BIGINT NOT NULL,
  direction TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_amount_nonzero CHECK (amount_minor <> 0),
  CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ledger_sign_matches_direction CHECK (
    (direction = 'DEBIT' AND amount_minor < 0) OR
    (direction = 'CREDIT' AND amount_minor > 0)
  )
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  merchant_name TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  occurred_at TIMESTAMPTZ NOT NULL,
  is_anomaly BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  card_name TEXT NOT NULL,
  masked_no TEXT NOT NULL,
  card_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  online_enabled BOOLEAN NOT NULL DEFAULT true,
  overseas_enabled BOOLEAN NOT NULL DEFAULT false,
  contactless_enabled BOOLEAN NOT NULL DEFAULT true,
  daily_limit_minor BIGINT NOT NULL DEFAULT 500000,
  CONSTRAINT card_status_valid CHECK (status IN ('ACTIVE', 'LOCKED', 'LOST', 'CLOSED'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  card_id UUID NOT NULL REFERENCES cards(id),
  merchant_name TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  billing_cycle TEXT NOT NULL,
  next_charge_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  cancellation_channel TEXT NOT NULL DEFAULT 'MERCHANT',
  CONSTRAINT subscription_status_valid CHECK (status IN ('ACTIVE', 'CANCEL_PENDING', 'CANCELLED', 'BLOCKED'))
);

CREATE TABLE IF NOT EXISTS authorization_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  operation_id TEXT NOT NULL,
  method TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  user_utterance TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  dependencies JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(task_id, node_key)
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES agent_tasks(id),
  operation_id TEXT,
  base_level TEXT NOT NULL,
  final_level TEXT NOT NULL,
  matched_rules JSONB NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  task_id UUID REFERENCES agent_tasks(id),
  operation_id TEXT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  event_summary TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_account_time ON bank_transactions(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_customer_prepared ON transfers(customer_id, prepared_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('001_init.sql') ON CONFLICT DO NOTHING;
