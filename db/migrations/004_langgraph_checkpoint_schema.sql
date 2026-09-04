BEGIN;

-- Pinned to @langchain/langgraph-checkpoint-postgres 1.0.5 migrations 0..4.
-- Keeping this DDL in BankPilot migrations avoids creating tables lazily on the
-- first customer request. Future package upgrades must add a new migration.
CREATE SCHEMA IF NOT EXISTS langgraph;

CREATE TABLE IF NOT EXISTS langgraph.checkpoint_migrations (
  v INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoint_blobs (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  blob BYTEA,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  blob BYTEA NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

INSERT INTO langgraph.checkpoint_migrations (v)
SELECT value FROM generate_series(0, 4) AS value
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('004_langgraph_checkpoint_schema.sql') ON CONFLICT DO NOTHING;

COMMIT;
