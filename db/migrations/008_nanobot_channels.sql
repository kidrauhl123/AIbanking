BEGIN;
CREATE TABLE nanobot_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  channel_type text NOT NULL CHECK (channel_type IN ('qq','wecom','weixin')),
  bot_hash text,
  enabled boolean NOT NULL DEFAULT true,
  sender_hash text,
  pairing_hash text,
  pairing_expires_at timestamptz,
  pairing_attempts integer NOT NULL DEFAULT 0,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id,channel_type)
);
CREATE UNIQUE INDEX nanobot_unique_bot ON nanobot_channels(bot_hash) WHERE enabled AND bot_hash IS NOT NULL;
CREATE TABLE nanobot_channel_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES nanobot_channels(id),
  external_hash text NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,external_hash)
);
INSERT INTO schema_migrations(version) VALUES ('008_nanobot_channels.sql') ON CONFLICT DO NOTHING;
COMMIT;
