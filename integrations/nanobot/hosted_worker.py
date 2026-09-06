"""One tenant/conversation per process. Credentials arrive on stdin, not argv."""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

from bank_agent import BankAgent
from loguru import logger


async def run():
    payload = json.loads(sys.stdin.read(20000))
    logger.disable("nanobot")
    logging.disable(logging.CRITICAL)
    async with BankAgent(
        workspace=Path(payload["workspace"]),
        bank_url=os.environ["BANKPILOT_MCP_URL"],
        bank_token=payload["bankToken"],
        model_env={k: os.environ[k] for k in ("AI_API_KEY", "AI_BASE_URL", "AI_MODEL")},
        allow_local=os.environ.get("NANOBOT_ALLOW_LOCAL_MCP") == "1",
    ) as agent:
        result = await agent.run(payload["message"], session=payload["conversationId"])
        print(
            json.dumps(
                {
                    "message": (result.content or "")[:20000],
                    "failed": bool(result.error) or not result.content,
                },
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception:  # noqa: BLE001 -- secrets must never enter raw exception logs
        print(json.dumps({"message": "", "failed": True}))
        sys.exit(1)
