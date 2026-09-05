# QQ and WeCom user onboarding

Users connect to the platform's shared bots. They do not create their own bots,
paste API keys or run terminal commands. The AI welcome screen and profile both
link to `/channels`.

## User journey

1. Choose QQ or WeCom. Open the configured official bot add/share link, or expand
   the QR code on desktop and scan with the matching chat app.
2. Send `绑定` in a private conversation. The existing adapter returns a short-lived
   binding link; this is not an Agent task and never requires a model.
3. Open the link. If signed out, sign in within the same page. The fragment token
   stays in the browser and is not moved into server-visible URLs. Check the
   displayed account and explicitly confirm. Login alone does not bind anything.

The confirmation request includes the displayed customer ID. If a different tab
changed the session to another customer, the API rejects the confirmation.
The channel page refreshes on focus and every 8 seconds while a guide is open and
visible. It shows success only after `/api/v1/channels` returns an active identity.
It does not infer success from opening an external link or clicking “next”.

After binding, send the original request again in IM. The first message is not
automatically replayed. Users can inspect and revoke identities on the channel page.

## Operator setup (once per deployment)

Configure bot credentials and start the relevant worker using [QQ.md](QQ.md) or
[WECOM.md](WECOM.md). Then copy the real bot's public HTTPS add/share URL from its
platform profile into the deployment-only `deploy/.env.production`:

```env
QQ_BOT_ENTRY_URL=
QQ_BOT_NAME=BankPilot
WECOM_BOT_ENTRY_URL=
WECOM_BOT_NAME=BankPilot
```

Do not use the QQ developer login page as a bot link. The URL must lead to the
actual shared bot and use HTTPS on `qq.com` or its subdomains (including
`work.weixin.qq.com`). Nonstandard ports and URLs with embedded credentials are
rejected. QR images are generated locally from that exact configured URL; there is
no third-party QR service or invented bot identifier.

Recreate `app` after changing deployment environment values. App receives only the
public entry details and its existing internal adapter token; platform bot secrets
remain exclusive to workers. `GET /api/v1/channels/onboarding` is intentionally
public and returns only provider labels, public URLs, QR images and readiness text.

An entry is offered when a public bank URL, internal adapter token and trusted bot
entry are configured. This is configuration readiness, **not a live bot health
check**. Verify a private message end to end after starting the worker. QQ sandbox
memberships and WeCom visibility remain platform-side requirements.

Missing configuration displays “暂未开放接入”; the app never substitutes a fake QR
code or reports a connection that has not been confirmed in the database.

## References and design choices

- [Nanobot channel guide](https://github.com/HKUDS/nanobot/blob/main/docs/chat-apps.md):
  provider selection, specific setup steps and a private test message; distinguishes
  saved configuration from a working live connection.
- [Nanobot QQ walkthrough](https://github.com/HKUDS/nanobot/blob/main/docs/guides/qq-ai-agent.md):
  sandbox membership, private-message pairing and retry after approval.
- [OpenClaw pairing](https://docs.openclaw.ai/channels/pairing): trusted approval
  before a new sender can use an account. Here approval belongs to the bank user,
  so it happens in the authenticated bank page instead of an administrator's CLI.

## Checks

Unit tests cover missing setup, credential non-disclosure and malicious URLs.
Browser QA uses an isolated PostgreSQL database and test-only adapter configuration:
provider selection, correct QR/link, unavailable state, same-tab login, explicit
confirmation, wrong-account rejection, observed binding state and expired tokens.
This does not replace testing real QQ/WeCom platform delivery with valid bot credentials.
