# Nanobot + BankPilot pilot

This integration runs the **unmodified published `nanobot-ai==0.3.0`** agent
against BankPilot's existing Streamable HTTP MCP endpoint. No custom reasoning
loop, bank intent router, or Nanobot fork. `bank_agent.py` composes the upstream
AgentLoop/SDK and public tool registry; `skills/bankpilot` supplies banking usage
instructions. Bank authorization stays in Bank Core.

The original CLI remains an executable integration/evaluation pilot, **not a
multi-user IM product**. A separate [PWA preview supervisor](../../docs/NANOBOT_HOSTING.md)
now uses this integration beside the existing LangGraph assistant.
See the [measured results and remaining gaps](../../docs/NANOBOT_EVALUATION.md).

## Run one user

Use Python 3.12 and an isolated environment:

```sh
uv venv --python 3.12 integrations/nanobot/.venv
uv pip sync --python integrations/nanobot/.venv/bin/python integrations/nanobot/requirements.txt
```

Supply these environment variables using your local secret manager or a private,
ignored environment file. Do not put actual credentials in shell history or Git:

- `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`: your model provider settings.
- `BANKPILOT_MCP_URL`: `https://<your-bank-domain>/api/mcp`.
- `BANKPILOT_MCP_TOKEN`: a **user-issued** bank token from the bank's developer
  page, with only the scopes needed. This is not the model key or an IM bot key.

```sh
integrations/nanobot/.venv/bin/python integrations/nanobot/bank_agent.py \
  --workspace integrations/nanobot/private/my-account \
  --message '查一下我的余额'
```

The private workspace stores conversation history; protect it as bank data.
The included Skill is installed only when absent; existing customizations are
preserved. It is always loaded, so the pilot needs no model file-reading tool.

The pilot exposes only the eight bank MCP tools. It does not give the model
shell, filesystem, arbitrary HTTP, or generic credential/configuration tools.
This tool set is a choice for this bank integration, not a claim that Nanobot
itself lacks those capabilities. Additional tools can be evaluated separately.

`config.example.json` also demonstrates **native Nanobot** configuration for a
user-operated instance. It does not disable every Nanobot built-in tool and is
not a hosted-bank security profile. Copy the Skill into that instance's private
workspace, configure its model, and use its native channel setup. Never expose
an unrestricted personal Nanobot instance as a shared bank server.

## Multi-user boundary

Use distinct bank tokens, Nanobot instances and workspaces per bank user. A
different `session_key` alone is insufficient: it does not isolate model tools,
MCP credentials or workspace-wide memory. The pilot tests two separate runtime
instances with the same session name and different workspaces/tokens. This is
functional isolation testing, not an OS/container escape security audit.

Hosted IM now reuses the upstream channel plugins in per-connection processes.
See [IM architecture, setup and limitations](../../docs/NANOBOT_IM.md).
The standalone pilot below and actual hosted-channel delivery are separate tests.

## Tests and evaluation

```sh
integrations/nanobot/.venv/bin/python -m unittest discover \
  -s integrations/nanobot -p 'test_*.py' -v
```

By default, seven configuration tests run and the real-MCP lifecycle test is
skipped. To run all eight against the disposable bank server:

```sh
BANKPILOT_DB_TESTS=1 BANKPILOT_TEST_URL=http://127.0.0.1:3012 \
  integrations/nanobot/.venv/bin/python -m unittest discover \
  -s integrations/nanobot -p 'test_*.py' -v
```

The lifecycle test checks token revocation on an established MCP connection.
The pinned MCP SDK can retain the resulting HTTP 401 until transport shutdown;
the adapter handles only bank-endpoint 401/403 cleanup exceptions as expected
authorization loss. Tool calls still fail, and other cleanup errors propagate.

For end-to-end evaluation, provision a **disposable local PostgreSQL database**,
apply the existing migrations, and start a separate development server against
it. Use a test-only `PASSWORD_PEPPER`. Never point it at production: the harness
creates synthetic customers, sandbox deposits, bank tokens and test transfers.
Destroy the disposable database after inspecting the results.

With model credentials already in the environment:

```sh
BANKPILOT_DB_TESTS=1 integrations/nanobot/.venv/bin/python integrations/nanobot/evaluate.py \
  --bank-url http://127.0.0.1:3012 --report /tmp/bankpilot-nanobot-evaluation.json
```

The optional `--model-env-ssh <already-authorized-bank-server>` captures only the
deployed model settings through SSH directly into memory. It does not print or
persist the model key. Do not use this flag without authority for that server
and model account. The real model sees synthetic bank data through MCP, never
the bank session password, TOTP secret, or bank access token.

Evaluation distinguishes deterministic authorization/ledger assertions from
model behavior. It exercises all six competition scenario directions; missing
write tools are reported as capability gaps, not invented successful operations.
The report records public final replies and tool names, not hidden reasoning.

## Sources and versioning

- [Nanobot](https://github.com/HKUDS/nanobot), MIT; installed as a pinned dependency.
- [Architecture](https://github.com/HKUDS/nanobot/blob/main/docs/architecture.md).
- [Chat channels](https://github.com/HKUDS/nanobot/blob/main/docs/chat-apps.md).
- [Bank MCP contract](../../docs/MCP.md).

The pinned release differs from current `main`; changes to SDK/tool lifecycle
must pass this evaluation before upgrading. `requirements.txt` locks dependencies
and hashes; regenerate with `uv pip compile` when intentionally upgrading.
