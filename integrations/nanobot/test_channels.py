import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from cryptography.exceptions import InvalidTag
from nanobot.bus.events import InboundMessage
from nanobot.channels.weixin.connect import WeixinConnectStore
from channel_service import Vault, ChannelProcess
from channel_worker import Gateway, private_message, text_only_boundary


class VaultTests(unittest.TestCase):
    def test_encrypted_roundtrip_tampering_and_tenant_binding(self):
        with tempfile.TemporaryDirectory() as root:
            vault = Vault(root, "test-secret-" * 4)
            first, second = str(uuid4()), str(uuid4())
            credentials = {"credentials": {"secret": "never-in-plaintext"}}
            vault.save(first, credentials)
            ciphertext = vault.path(first).read_bytes()
            self.assertNotIn(b"never-in-plaintext", ciphertext)
            self.assertEqual(vault.load(first), credentials)
            self.assertEqual(vault.path(first).stat().st_mode & 0o777, 0o600)
            vault.path(second).write_bytes(ciphertext)
            with self.assertRaises(InvalidTag):
                vault.load(second)
            vault.path(first).write_bytes(ciphertext[:-1] + bytes([ciphertext[-1] ^ 1]))
            with self.assertRaises(InvalidTag):
                vault.load(first)
            vault.delete(first)
            self.assertFalse(vault.path(first).exists())

    def test_path_and_missing_secret_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                Vault(root, "short")
            vault = Vault(root, "x" * 40)
            with self.assertRaises(ValueError):
                vault.path("../../another-account")

    def test_bank_messages_never_enter_group_chats(self):
        for kind in ("qq", "wecom", "weixin"):
            msg = InboundMessage(kind, "sender", "group", "balance", metadata={"chat_type": "group"})
            self.assertFalse(private_message(kind, msg, SimpleNamespace(_chat_type_cache={"group": "group"})))
        self.assertTrue(private_message("weixin", InboundMessage("weixin", "sender", "sender", "hello"), None))


class UpstreamQrTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_interrupts_in_flight_qr_poll(self):
        started = asyncio.Event()
        async def command(value):
            if value["action"] == "poll":
                started.set()
                await asyncio.Event().wait()
            return {"status": "cancelled"}
        gateway = SimpleNamespace(polling=None, command_lock=asyncio.Lock(), command=command)
        with patch("channel_worker.emit") as emit:
            polling = asyncio.create_task(Gateway.dispatch(gateway, {"id": "poll", "action": "poll", "sessionId": "session"}))
            await asyncio.wait_for(started.wait(), 1)
            await asyncio.wait_for(Gateway.dispatch(gateway, {"id": "cancel", "action": "cancel"}), 1)
            await polling
            self.assertEqual(emit.call_count, 2)
            self.assertIsNone(gateway.polling)

    async def test_media_and_groups_never_reach_upstream_downloads(self):
        from nanobot.channels.weixin.runtime import ITEM_TEXT, ITEM_IMAGE
        channel = SimpleNamespace(_process_message=AsyncMock())
        original = channel._process_message
        text_only_boundary("weixin", channel)
        await channel._process_message({"from_user_id": "group@chatroom", "item_list": [{"type": ITEM_TEXT}]})
        await channel._process_message({"from_user_id": "person", "item_list": [{"type": ITEM_IMAGE}]})
        original.assert_not_awaited()
        await channel._process_message({"from_user_id": "person", "item_list": [{"type": ITEM_TEXT}]})
        original.assert_awaited_once()
        qq = SimpleNamespace(_on_message=AsyncMock())
        original_qq = qq._on_message
        text_only_boundary("qq", qq)
        await qq._on_message(SimpleNamespace(attachments=["untrusted-url"]))
        await qq._on_message(SimpleNamespace(attachments=[]), is_group=True)
        original_qq.assert_not_awaited()

    async def test_upstream_start_poll_save_cancel_and_expire(self):
        # Mock only the network/channel boundary, not the upstream state machine.
        channel = SimpleNamespace(config=SimpleNamespace(base_url="https://example.com"),
            _load_state=lambda: False, _fetch_qr_code=AsyncMock(return_value=("qr-id", "https://example.com/qr")),
            _api_get_with_base=AsyncMock(return_value={"status": "confirmed", "bot_token": "test-only-token"}),
            _save_state=lambda: None, _token="", _running=False)
        store = WeixinConnectStore()
        with patch.object(store, "_build_channel", return_value=channel):
            start = await store.start()
            self.assertEqual(start["status"], "pending")
            self.assertEqual(start["qr_url"], "https://example.com/qr")
            result = await store.poll(start["session_id"])
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(channel._token, "test-only-token")
            self.assertEqual((await store.poll(start["session_id"]))["status"], "expired")
            second = await store.start(force=True)
            self.assertEqual((await store.cancel(second["session_id"]))["status"], "cancelled")

    async def test_real_worker_isolated_config_and_restart(self):
        # Run actual Nanobot config/QR plugin in two separate processes. No login.
        with tempfile.TemporaryDirectory() as root:
            service = SimpleNamespace(vault=Vault(root, "x" * 40))
            children = [ChannelProcess(service, str(uuid4()), {"channelType": "weixin", "credentials": {}}) for _ in range(2)]
            try:
                await asyncio.gather(*(child.start() for child in children))
                self.assertNotEqual(children[0].directory.name, children[1].directory.name)
                for child in children:
                    self.assertEqual(child.status()["state"], "configured")
                    config = json.loads((Path(child.directory.name) / "config.json").read_text())
                    enabled = [key for key, value in config["channels"].items() if isinstance(value, dict) and value.get("enabled")]
                    self.assertEqual(enabled, ["weixin"])
                    self.assertNotIn("AI_API_KEY", config)
                    result = await child.command("validate")
                    self.assertIn(result["validation"], ("needs_setup", "invalid", "configured"))
            finally:
                await asyncio.gather(*(child.stop() for child in children))


if __name__ == "__main__":
    unittest.main()
