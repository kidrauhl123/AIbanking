"""Real MCP lifecycle regression tests, no model calls or fake model replies."""

import os
import tempfile
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from urllib.parse import urlparse

from bank_agent import BankAgent
from evaluate import fixture, json_request, tool
from loguru import logger


@unittest.skipUnless(
    os.environ.get("BANKPILOT_DB_TESTS") == "1", "requires disposable local bank server"
)
class McpShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_after_token_revocation(self):
        url = os.environ.get("BANKPILOT_TEST_URL", "http://127.0.0.1:3012")
        self.assertEqual(urlparse(url).hostname, "127.0.0.1")
        logger.disable("nanobot")
        with tempfile.TemporaryDirectory(prefix="bankpilot-lifecycle-") as directory:
            async with AsyncExitStack() as stack:
                owner = await fixture(stack, url, "连接清理评测", 0)
                async with BankAgent(
                    workspace=Path(directory),
                    bank_url=url + "/api/mcp",
                    bank_token=owner["token"],
                    model_env={
                        "AI_API_KEY": "unused-no-model-call",
                        "AI_MODEL": "unused",
                        "AI_BASE_URL": "https://unused.invalid/v1",
                    },
                    allow_local=True,
                ) as agent:
                    self.assertIn(
                        "accounts", await tool(agent, "banking.accounts.list")
                    )
                    tokens = await json_request(
                        owner["client"], "GET", "/api/v1/developer/tokens"
                    )
                    await json_request(
                        owner["client"],
                        "DELETE",
                        "/api/v1/developer/tokens/" + tokens["tokens"][0]["id"],
                    )
                    self.assertIn(
                        "toolError", await tool(agent, "banking.accounts.list")
                    )
                self.assertTrue(agent.authorization_lost)


if __name__ == "__main__":
    unittest.main()
