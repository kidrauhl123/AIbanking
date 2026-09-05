BEGIN;

ALTER TABLE channel_identities DROP CONSTRAINT IF EXISTS channel_identities_channel_type_check;
ALTER TABLE channel_identities ADD CONSTRAINT channel_identities_channel_type_check
  CHECK (channel_type IN ('WECOM','QQ'));

ALTER TABLE channel_binding_tokens DROP CONSTRAINT IF EXISTS channel_binding_tokens_channel_type_check;
ALTER TABLE channel_binding_tokens ADD CONSTRAINT channel_binding_tokens_channel_type_check
  CHECK (channel_type IN ('WECOM','QQ'));

ALTER TABLE agent_threads DROP CONSTRAINT IF EXISTS agent_threads_channel_type_check;
ALTER TABLE agent_threads ADD CONSTRAINT agent_threads_channel_type_check
  CHECK (channel_type IN ('PWA','WECOM','QQ','MCP'));

ALTER TABLE agent_runtime_runs DROP CONSTRAINT IF EXISTS agent_runtime_runs_channel_type_check;
ALTER TABLE agent_runtime_runs ADD CONSTRAINT agent_runtime_runs_channel_type_check
  CHECK (channel_type IN ('PWA','WECOM','QQ','MCP'));

ALTER TABLE channel_events DROP CONSTRAINT IF EXISTS channel_events_channel_type_check;
ALTER TABLE channel_events ADD CONSTRAINT channel_events_channel_type_check
  CHECK (channel_type IN ('WECOM','QQ'));

ALTER TABLE channel_outbox DROP CONSTRAINT IF EXISTS channel_outbox_channel_type_check;
ALTER TABLE channel_outbox ADD CONSTRAINT channel_outbox_channel_type_check
  CHECK (channel_type IN ('WECOM','QQ'));

INSERT INTO schema_migrations (version)
VALUES ('005_qq_channel.sql') ON CONFLICT DO NOTHING;

COMMIT;
