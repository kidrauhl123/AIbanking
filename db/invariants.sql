\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ledger_entries
    GROUP BY ledger_transaction_id
    HAVING sum(amount_minor) <> 0 OR count(*) < 2
  ) THEN
    RAISE EXCEPTION 'Ledger invariant failed: unbalanced transaction';
  END IF;

  IF EXISTS (SELECT 1 FROM accounts WHERE customer_id IS NOT NULL AND available_balance_minor < 0) THEN
    RAISE EXCEPTION 'Customer account invariant failed: negative balance';
  END IF;

  IF EXISTS (
    SELECT operation_id FROM transfers
    GROUP BY operation_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Idempotency invariant failed: duplicate operation id';
  END IF;

  IF EXISTS (
    SELECT 1 FROM customers c
    LEFT JOIN auth_credentials a ON a.customer_id=c.id
    WHERE a.customer_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Identity invariant failed: customer without credentials';
  END IF;

  IF EXISTS (
    SELECT 1 FROM accounts WHERE customer_id IS NULL AND system_code IS NULL
  ) THEN
    RAISE EXCEPTION 'Account invariant failed: ownerless non-system account';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_runtime_runs r JOIN agent_threads t ON t.id=r.agent_thread_id
    WHERE r.customer_id<>t.customer_id
  ) THEN
    RAISE EXCEPTION 'Agent invariant failed: run/thread tenant mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_threads t JOIN channel_identities i ON i.id=t.channel_identity_id
    WHERE t.customer_id<>i.customer_id OR t.channel_type<>i.channel_type
  ) THEN
    RAISE EXCEPTION 'Channel invariant failed: thread identity mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM channel_outbox o JOIN channel_identities i ON i.id=o.channel_identity_id
    WHERE o.customer_id<>i.customer_id OR o.channel_type<>i.channel_type
  ) THEN
    RAISE EXCEPTION 'Channel invariant failed: outbox identity mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_runtime_runs
    WHERE status='INTERRUPTED'
      AND (task_id IS NULL OR operation_id IS NULL OR interrupt_kind IS NULL OR final_reply IS NULL)
  ) THEN
    RAISE EXCEPTION 'Agent invariant failed: incomplete interrupt state';
  END IF;
END $$;

SELECT 'All banking invariants passed' AS result;
