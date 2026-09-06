BEGIN;

CREATE TABLE nanobot_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  revoked_at timestamptz
);
CREATE UNIQUE INDEX nanobot_one_consent ON nanobot_consents(customer_id) WHERE revoked_at IS NULL;

CREATE TABLE nanobot_runs (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  consent_id uuid NOT NULL REFERENCES nanobot_consents(id),
  conversation_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES api_clients(id),
  message text NOT NULL,
  reply text,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '4 minutes'
);
CREATE UNIQUE INDEX nanobot_one_run_per_customer ON nanobot_runs(customer_id) WHERE status='RUNNING';
CREATE INDEX nanobot_customer_runs ON nanobot_runs(customer_id,created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('007_nanobot_preview.sql') ON CONFLICT DO NOTHING;
COMMIT;
