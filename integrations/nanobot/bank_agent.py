"""Thin composition of unmodified Nanobot 0.3.0 + BankPilot MCP.

No custom model loop, business-intent router, SQL access, or transaction executor.
This pilot exposes bank tools only. It is not a multi-tenant hosting service.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from urllib.parse import urlparse

import httpx
from loguru import logger
from nanobot import Nanobot
from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.mcp import connect_mcp_servers
from nanobot.config.schema import Config, MCPServerConfig
from nanobot.security.network import configure_ssrf_whitelist

BANK_TOOLS = [
    "banking.accounts.list",
    "banking.transactions.list",
    "banking.beneficiaries.list",
    "banking.cards.list",
    "banking.subscriptions.list",
    "banking.investments.products.list",
    "banking.transfers.prepare",
    "banking.operations.get",
]
BUILTIN_SKILLS = [
    "clawhub",
    "cron",
    "github",
    "memory",
    "skill-creator",
    "summarize",
    "tmux",
    "weather",
    "my",
    "update-setup",
    "image-generation",
]


def is_authorization_disconnect(error: BaseException, endpoint: str) -> bool:
    """Only a bank 401/403 is expected when releasing a revoked MCP connection.

    Do not treat unrelated transport errors or mixed exception groups as success.
    This classification applies to cleanup only, never to tool execution.
    """
    if isinstance(error, BaseExceptionGroup):
        return bool(error.exceptions) and all(
            is_authorization_disconnect(e, endpoint) for e in error.exceptions
        )
    return (
        isinstance(error, httpx.HTTPStatusError)
        and error.response.status_code in (401, 403)
        and str(error.request.url) == endpoint
    )


def validate_endpoint(url: str, allow_local: bool = False) -> None:
    parsed = urlparse(url)
    local = parsed.hostname == "127.0.0.1" and allow_local
    if parsed.scheme != "https" and not (local and parsed.scheme == "http"):
        raise ValueError(
            "MCP requires HTTPS; loopback HTTP is opt-in for isolated tests"
        )
    if (
        parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path != "/api/mcp"
    ):
        raise ValueError(
            "Use the bank's /api/mcp endpoint without URL credentials or query parameters"
        )
    if not parsed.hostname:
        raise ValueError("Missing bank hostname")


def install_skill(workspace: Path) -> None:
    target = workspace / "skills" / "bankpilot" / "SKILL.md"
    source = Path(__file__).parent / "skills" / "bankpilot" / "SKILL.md"
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Never silently overwrite a user's customized skill.
    if not target.exists():
        shutil.copyfile(source, target)


class BankAgent:
    def __init__(
        self,
        *,
        workspace: Path,
        bank_url: str,
        bank_token: str,
        model_env: dict[str, str],
        allow_local: bool = False,
    ):
        validate_endpoint(bank_url, allow_local)
        if not bank_token.startswith("bpt_"):
            raise ValueError("A user-issued BankPilot token is required")
        if not all(model_env.get(k) for k in ("AI_API_KEY", "AI_BASE_URL", "AI_MODEL")):
            raise ValueError("Configure AI_API_KEY, AI_BASE_URL and AI_MODEL")
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        install_skill(workspace)
        # Only the explicitly selected local test endpoint is exempted. No broad
        # private-network whitelist and no network tool is exposed to the model.
        configure_ssrf_whitelist(["127.0.0.1/32"] if allow_local else [])
        self.config = Config.model_validate(
            {
                "agents": {
                    "defaults": {
                        "workspace": str(workspace.resolve()),
                        "provider": "custom",
                        "model": model_env["AI_MODEL"],
                        "maxTokens": 2048,
                        "maxToolIterations": 12,
                        "contextWindowTokens": 32000,
                        "unifiedSession": False,
                        "disabledSkills": BUILTIN_SKILLS,
                        "timezone": "Asia/Shanghai",
                        "failOnToolError": False,
                    }
                },
                "providers": {
                    "custom": {
                        "apiKey": model_env["AI_API_KEY"],
                        "apiBase": model_env["AI_BASE_URL"],
                    }
                },
                "tools": {"restrictToWorkspace": True, "mcpServers": {}},
            }
        )
        self.loop = AgentLoop.from_config(self.config)
        # Public registry API, not a fork/patch of Nanobot. No model receives
        # shell/file tools with which to inspect this process's credentials.
        for name in list(self.loop.tools.tool_names):
            self.loop.tools.unregister(name)
        self.bot = Nanobot(self.loop, config=self.config)
        self.mcp_config = MCPServerConfig(
            type="streamableHttp",
            url=bank_url,
            headers={"Authorization": f"Bearer {bank_token}"},
            enabled_tools=BANK_TOOLS,
            tool_timeout=30,
        )
        self.connections = {}
        self.authorization_lost = False

    async def __aenter__(self):
        self.connections = await connect_mcp_servers(
            {"bankpilot": self.mcp_config}, self.loop.tools
        )
        if not self.connections or not self.loop.tools.tool_names:
            raise RuntimeError("Bank MCP did not expose any authorized tools")
        expected = {"mcp_bankpilot_" + name.replace(".", "_") for name in BANK_TOOLS}
        if not set(self.loop.tools.tool_names) <= expected:
            raise RuntimeError("Unexpected tool registered")
        return self

    async def __aexit__(self, *args):
        failures = []
        for connection in self.connections.values():
            try:
                await connection.aclose()
            except Exception as error:  # noqa: BLE001 -- collect, then re-raise unexpected cleanup errors
                if is_authorization_disconnect(error, self.mcp_config.url):
                    self.authorization_lost = True
                else:
                    failures.append(error)
        try:
            await self.bot.aclose()
        finally:
            if failures:
                raise ExceptionGroup("MCP connection cleanup failed", failures)

    async def run(self, message: str, *, session: str = "bankpilot:personal"):
        return await asyncio.wait_for(
            self.bot.run(message, session_key=session), timeout=180
        )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workspace",
        required=True,
        type=Path,
        help="Private per-user workspace; never share between bank users",
    )
    parser.add_argument("--message", required=True)
    parser.add_argument("--allow-local-mcp", action="store_true")
    args = parser.parse_args()
    logger.disable("nanobot")
    logging.disable(logging.CRITICAL)
    async with BankAgent(
        workspace=args.workspace,
        bank_url=os.environ["BANKPILOT_MCP_URL"],
        bank_token=os.environ["BANKPILOT_MCP_TOKEN"],
        model_env={
            k: os.environ.get(k, "") for k in ("AI_API_KEY", "AI_BASE_URL", "AI_MODEL")
        },
        allow_local=args.allow_local_mcp,
    ) as agent:
        result = await agent.run(args.message)
        print(
            json.dumps(
                {
                    "message": result.content,
                    "toolsUsed": result.tools_used,
                    "modelFailed": bool(result.error),
                },
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:  # noqa: BLE001 -- CLI must not print credential-bearing SDK errors
        # SDK/HTTP errors may include credentials. Do not print their raw text.
        raise SystemExit(
            "Agent run failed. Check endpoint, authorization and model configuration."
        ) from None
