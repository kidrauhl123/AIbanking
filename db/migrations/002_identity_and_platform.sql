BEGIN;

-- The first public prototype shipped with fictional demo customers and transactions.
-- Version 2 intentionally starts empty: every customer, balance and transaction must
-- be created by an authenticated user action.
TRUNCATE audit_events, policy_decisions, task_nodes, agent_tasks, authorization_challenges,
  subscriptions, cards, bank_transactions, ledger_entries, ledger_transactions, transfers,
  beneficiaries, accounts, customers RESTART IDENTITY CASCADE;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customer_status_valid;
ALTER TABLE customers ADD CONSTRAINT customer_status_valid
  CHECK (status IN ('ACTIVE', 'LOCKED', 'CLOSED'));

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS account_no TEXT,
  ADD COLUMN IF NOT EXISTS system_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_no ON accounts(account_no) WHERE account_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_system_code ON accounts(system_code) WHERE system_code IS NOT NULL;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS account_balance_nonnegative;
ALTER TABLE accounts ADD CONSTRAINT account_balance_nonnegative
  CHECK (customer_id IS NULL OR available_balance_minor >= 0);

ALTER TABLE beneficiaries
  ADD COLUMN IF NOT EXISTS recipient_customer_id UUID REFERENCES customers(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_beneficiary_owner_target
  ON beneficiaries(customer_id, settlement_account_id);

ALTER TABLE authorization_challenges ALTER COLUMN code_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS auth_credentials (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_customer ON user_sessions(customer_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS mfa_totp (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  source TEXT NOT NULL CHECK (source IN ('CASH', 'EXTERNAL_TRANSFER')),
  reference TEXT,
  ledger_transaction_id UUID UNIQUE REFERENCES ledger_transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_customer ON api_tokens(customer_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS mcp_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  client_id UUID REFERENCES api_clients(id),
  tool_name TEXT NOT NULL,
  request_id TEXT,
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome TEXT NOT NULL,
  operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_invocations_customer ON mcp_invocations(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS investment_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  issuer TEXT NOT NULL,
  product_type TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  risk_level TEXT NOT NULL CHECK (risk_level IN ('R1','R2','R3','R4','R5')),
  minimum_purchase_minor BIGINT NOT NULL CHECK (minimum_purchase_minor >= 0),
  term_days INTEGER,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED','SUSPENDED')),
  source_url TEXT NOT NULL,
  source_published_at TIMESTAMPTZ,
  source_checked_at TIMESTAMPTZ NOT NULL,
  facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  answers JSONB NOT NULL,
  score INTEGER NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('R1','R2','R3','R4','R5')),
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS investment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  product_id UUID NOT NULL REFERENCES investment_products(id),
  side TEXT NOT NULL CHECK (side IN ('SUBSCRIBE','REDEEM')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL CHECK (status IN ('AWAITING_AUTH','SUCCEEDED','FAILED','CANCELLED')),
  suitability_evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('001_init.sql'),('002_identity_and_platform.sql') ON CONFLICT DO NOTHING;

COMMIT;
