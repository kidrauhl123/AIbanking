# Banking UI and Agent boundary

The banking app owns direct account, transfer, card, statement and subscription
flows. The AI Assistant tab is a separate opt-in interaction. A bank action must
never call `/api/agent`, synthesize a prompt, or navigate to chat. Both interfaces
can use the banking core; neither UI is a dependency of the other.

## Native screens

- Home → Analysis: monthly income, outgoings, categories and flagged transactions.
  `/api/v1/statements?month=YYYY-MM` aggregates the entire month in Asia/Shanghai,
  using one database snapshot. The home summary uses the same aggregation.
- Home → Subscriptions: stored subscriptions, next debit dates, normalized monthly
  cost and a confirmation dialog to stop a bank debit. Unknown billing cycles do
  not produce an invented monthly estimate.
- `POST /api/v1/subscriptions/:id/block` requires a bank session, origin validation,
  ownership and `confirmed: true`. A row lock makes retries idempotent and the
  state change and audit commit together. `BLOCKED` does not mean the merchant's
  subscription was cancelled. This remains the competition sandbox, with no
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

Browser regression: with AI disabled, open both Analysis buttons, change months,
open Subscriptions, dismiss and accept the debit confirmation, filter Activity,
and open native transfer/card forms. Assert zero `/api/agent` requests. The AI tab
must still open independently without submitting a message. Error states must show
a retry action rather than zero balances or a switch to chat.
