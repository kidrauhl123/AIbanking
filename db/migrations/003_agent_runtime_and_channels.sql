BEGIN;

-- LangGraph owns only workflow checkpoints. BankPilot remains the tenant and
-- authorization boundary, so its tables deliberately live in a separate schema.
CREATE SCHEMA IF NOT EXISTS langgraph;

CREATE TABLE IF NOT EXISTS channel_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('WECOM')),
  tenant_hash TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  subject_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE(channel_type, tenant_hash, subject_hash)
);
CREATE INDEX IF NOT EXISTS idx_channel_identities_customer
  ON channel_identities(customer_id, channel_type, status);

CREATE TABLE IF NOT EXISTS channel_binding_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_type TEXT NOT NULL CHECK (channel_type IN ('WECOM')),
  tenant_hash TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  subject_ciphertext TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_channel_binding_expiry
  ON channel_binding_tokens(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('PWA','WECOM','MCP')),
  channel_identity_id UUID REFERENCES channel_identities(id) ON DELETE SET NULL,
  external_conversation_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(customer_id, channel_type, external_conversation_hash)
);

CREATE TABLE IF NOT EXISTS agent_runtime_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_thread_id UUID NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  task_id UUID UNIQUE REFERENCES agent_tasks(id) ON DELETE SET NULL,
  graph_thread_id UUID NOT NULL UNIQUE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('PWA','WECOM','MCP')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING','INTERRUPTED','COMPLETED','FAILED','CANCELLED')),
  interrupt_kind TEXT CHECK (interrupt_kind IS NULL OR interrupt_kind IN ('CONFIRM','MFA')),
  operation_id TEXT,
  final_reply JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_runtime_customer
  ON agent_runtime_runs(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runtime_interrupted
  ON agent_runtime_runs(customer_id, status) WHERE status='INTERRUPTED';

CREATE TABLE IF NOT EXISTS channel_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_identity_id UUID REFERENCES channel_identities(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('WECOM')),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  external_event_id TEXT,
  event_type TEXT NOT NULL,
  payload_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_events_dedupe
  ON channel_events(channel_type, external_event_id)
  WHERE direction='INBOUND' AND external_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_identity_id UUID NOT NULL REFERENCES channel_identities(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('WECOM')),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_channel_outbox_pending
  ON channel_outbox(channel_type, available_at) WHERE status IN ('PENDING','SENDING','FAILED');

INSERT INTO schema_migrations (version)
VALUES ('003_agent_runtime_and_channels.sql') ON CONFLICT DO NOTHING;

COMMIT;
