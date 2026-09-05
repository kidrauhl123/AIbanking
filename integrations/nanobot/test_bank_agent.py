import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from bank_agent import (
    BANK_TOOLS,
    BankAgent,
    install_skill,
    is_authorization_disconnect,
    validate_endpoint,
)


class BankAgentConfigurationTests(unittest.TestCase):
    def test_public_url_validation(self):
        validate_endpoint("https://bank.example/api/mcp")
        for url in [
            "http://bank.example/api/mcp",
            "https://bank.example/api/mcp?token=abc",
            "https://user:pass@bank.example/api/mcp",
            "https://bank.example/other",
        ]:
            with self.assertRaises(ValueError):
                validate_endpoint(url)

    def test_loopback_requires_explicit_test_flag(self):
        with self.assertRaises(ValueError):
            validate_endpoint("http://127.0.0.1:3012/api/mcp")
        validate_endpoint("http://127.0.0.1:3012/api/mcp", True)
        with self.assertRaises(ValueError):
            validate_endpoint("http://169.254.169.254/api/mcp", True)

    def test_no_bank_commit_or_identity_override_tool(self):
        self.assertEqual(len(BANK_TOOLS), 8)
        self.assertFalse(
            any(
                word in name
                for name in BANK_TOOLS
                for word in ("commit", "authorize", "password", "token")
            )
        )

    def test_workspace_skill_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            install_skill(workspace)
            skill = workspace / "skills/bankpilot/SKILL.md"
            self.assertIn("always: true", skill.read_text())
            # This is a generated test artifact, not a repo file edit.
            skill.write_text("user customization")
            install_skill(workspace)
            self.assertEqual(skill.read_text(), "user customization")

    def test_credentials_never_enter_workspace_or_model_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            key = "unit-test-model-key"
            bank_token = "bpt_unit-test-bank-token"
            with patch("bank_agent.AgentLoop.from_config") as factory:
                factory.return_value.tools.tool_names = ["exec", "read_file", "my"]
                agent = BankAgent(
                    workspace=Path(directory),
                    bank_url="https://bank.example/api/mcp",
                    bank_token=bank_token,
                    model_env={
                        "AI_API_KEY": key,
                        "AI_BASE_URL": "https://model.example/v1",
                        "AI_MODEL": "test-model",
                    },
                )
                self.assertEqual(factory.return_value.tools.unregister.call_count, 3)
                self.assertEqual(
                    agent.mcp_config.headers["Authorization"], "Bearer " + bank_token
                )
            text = "".join(
                p.read_text() for p in Path(directory).rglob("*") if p.is_file()
            )
            self.assertNotIn(key, text)
            self.assertNotIn(bank_token, text)

    def test_example_contains_only_environment_references(self):
        config = json.loads((Path(__file__).parent / "config.example.json").read_text())
        self.assertEqual(config["providers"]["custom"]["apiKey"], "${AI_API_KEY}")
        self.assertFalse(config["agents"]["defaults"]["unifiedSession"])

    def test_cleanup_only_accepts_bank_authentication_disconnect(self):
        endpoint = "https://bank.example/api/mcp"
        request = httpx.Request("POST", endpoint)
        error = httpx.HTTPStatusError(
            "redacted", request=request, response=httpx.Response(401, request=request)
        )
        self.assertTrue(
            is_authorization_disconnect(ExceptionGroup("shutdown", [error]), endpoint)
        )
        self.assertFalse(
            is_authorization_disconnect(error, "https://other.example/api/mcp")
        )
        self.assertFalse(
            is_authorization_disconnect(
                ExceptionGroup("mixed", [error, ValueError("bad")]), endpoint
            )
        )
        server_error = httpx.HTTPStatusError(
            "redacted", request=request, response=httpx.Response(500, request=request)
        )
        self.assertFalse(is_authorization_disconnect(server_error, endpoint))


if __name__ == "__main__":
    unittest.main()
