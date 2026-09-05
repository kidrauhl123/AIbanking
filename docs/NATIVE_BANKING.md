# Banking UI and Agent boundary

The banking app owns direct account, transfer, card and transaction-list
flows. The AI Assistant tab and home AI card are explicit opt-in entry points;
both open chat without automatically submitting a prompt. A bank action must
never call `/api/agent`, synthesize a prompt, or navigate to chat. Both interfaces
can use the banking core; neither UI is a dependency of the other.

## Native screens

- Home has Transfer and Deposit shortcuts, an explicit AI card, a read-only monthly
  expense summary and recent transactions. Analysis and Subscriptions screens and
  navigation were removed at the user's request; bank actions do not redirect to AI.
- `/api/v1/statements?month=YYYY-MM` remains available at the backend. It aggregates
  the entire month in Asia/Shanghai using one snapshot; Home uses the same summary.
- `POST /api/v1/subscriptions/:id/block` requires a bank session, origin validation,
  ownership and `confirmed: true`. A row lock makes retries idempotent and the
  state change and audit commit together. `BLOCKED` does not mean the merchant's
  subscription was cancelled. This backend endpoint has no current app entry point.
  This remains the competition sandbox, with no
  connection to a live merchant billing or clearing system.
- Activity filters operate on the latest 50 transactions, explicitly labelled.
- Transfers and cards keep their existing native bank flows.

These new endpoints are session-only. External Agent access continues through
the existing scoped APIs/MCP; it does not inherit bank-session permissions.

## Verification

`npm test` runs calendar and existing regression tests. Database integration tests
are opt-in. Create an isolated PostgreSQL cluster with role `bankpilot_test`, apply
`db/migrations/001` through `005`, then run:

```sh
BANKPILOT_DB_TESTS=1 DATABASE_URL=postgresql://bankpilot_test@127.0.0.1:55439/postgres npm test
```

The suite creates its own fixture IDs and removes only those rows. Coverage includes
more than 50 transactions, Shanghai month boundaries, category totals, empty months,
customer isolation, concurrent repeated confirmation and audit attribution.

Browser regression: Home has no Analysis or Subscriptions buttons. Open the AI
card and assert chat appears without a submitted message or `/api/agent` request.
Check native transfer/card forms and Activity filters remain independent of AI.
