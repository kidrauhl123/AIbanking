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
END $$;

SELECT 'All banking invariants passed' AS result;
