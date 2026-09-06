"""One private IM connection. Upstream plugins own protocols and QR login.

JSON-lines IPC only; no HTTP/admin surface, model key, bank token or database.
Nanobot's process-global config is isolated in a per-process temporary directory.
Durable state is encrypted by the parent, never kept here after shutdown.
"""
import asyncio
import contextlib
import json
import logging
import os
import sys
from pathlib import Path

from loguru import logger
from nanobot.bus.events import OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.manager import ChannelManager
from nanobot.channels.validation import validate_channel_config
from nanobot.channels.weixin.connect import WeixinConnectStore
from nanobot.config.loader import load_config, save_config, set_config_path
from nanobot.config.schema import Config


def emit(payload):
    sys.__stdout__.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()


def private_message(kind, message, channel):
    if kind == "qq":
        return channel._chat_type_cache.get(message.chat_id) == "c2c"
    if kind == "wecom":
        return message.metadata.get("chat_type") == "single"
    return kind == "weixin" and message.chat_id == message.sender_id and not message.sender_id.endswith("@chatroom")


def text_only_boundary(kind, channel):
    """Reject groups/media before upstream downloads or other inbound effects.

These narrow instance hooks are version-pinned adapters, not protocol forks.
The original parser, transport, reconnect, dedup and sender fields stay upstream.
"""
    if kind == "qq":
        original = channel._on_message

        async def qq(data, is_group=False):
            if not is_group and not getattr(data, "attachments", None):
                await original(data, is_group=False)

        channel._on_message = qq
    elif kind == "wecom":
        original = channel._process_message

        async def wecom(frame, msg_type):
            body = frame.body if hasattr(frame, "body") else frame.get("body", frame) if isinstance(frame, dict) else {}
            if msg_type == "text" and isinstance(body, dict) and body.get("chattype", "single") == "single":
                await original(frame, msg_type)

        channel._process_message = wecom
    elif kind == "weixin":
        from nanobot.channels.weixin.runtime import ITEM_TEXT
        original = channel._process_message

        async def weixin(msg):
            if str(msg.get("from_user_id", "")).endswith("@chatroom"):
                return
            items = msg.get("item_list") or []
            if items and all(isinstance(item, dict) and item.get("type") == ITEM_TEXT for item in items):
                await original(msg)

        channel._process_message = weixin


class Gateway:
    def __init__(self, initial):
        self.kind = initial["channelType"]
        self.bus = MessageBus()
        self.manager = None
        self.runtime_task = None
        self.connector = WeixinConnectStore() if self.kind == "weixin" else None
        self.pending = {}
        self.state = "configured"
        self.qr_session = None
        self.polling = None
        self.command_lock = asyncio.Lock()
        self.root = Path.cwd()
        set_config_path(self.root / "config.json")
        # Explicitly disable every other channel, including default WebUI.
        from nanobot.channels.registry import discover_plugins
        sections = {name: {"enabled": False} for name in discover_plugins()}
        sections[self.kind] = {
            **initial.get("credentials", {}), "enabled": True,
            # Only a bank-side one-time pairing gate can issue model requests.
            "allowFrom": ["*"], "ackMessage": "", "welcomeMessage": "",
            "downloadMaxBytes": 1048576,
        }
        config = Config.model_validate({
            "channels": sections,
            "agents": {"defaults": {"workspace": str(self.root / "workspace")}},
            "tools": {"restrictToWorkspace": True},
        })
        save_config(config)
        if initial.get("weixinState"):
            state_dir = self.root / "weixin"
            state_dir.mkdir(mode=0o700, exist_ok=True)
            (state_dir / "account.json").write_text(json.dumps(initial["weixinState"]))

    def snapshot(self):
        state_file = self.root / "weixin" / "account.json"
        if state_file.exists():
            emit({"event": "snapshot", "weixinState": json.loads(state_file.read_text())})

    async def start(self):
        if self.manager:
            await self.manager.stop_all()
        if self.runtime_task:
            self.runtime_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.runtime_task
        from nanobot.channels.registry import load_channel_plugin
        from nanobot.optional_features import extra_installed
        plugin = load_channel_plugin(self.kind)
        if not extra_installed(self.kind, plugin.dependencies):
            raise RuntimeError("Channel dependency missing; rebuild image")
        self.manager = ChannelManager(load_config(), self.bus, webui_static_dist=False)
        if set(self.manager.channels) != {self.kind}:
            self.state = "failed"
            raise RuntimeError("Channel dependency or configuration unavailable")
        text_only_boundary(self.kind, self.manager.channels[self.kind])
        self.runtime_task = asyncio.create_task(self.manager.start_all())
        self.state = "starting"

    async def receive(self):
        while True:
            msg = await self.bus.consume_inbound()
            channel = self.manager.channels.get(self.kind) if self.manager else None
            if not channel or not private_message(self.kind, msg, channel):
                continue  # Never disclose bank data in groups.
            if len(self.pending) >= 4:
                continue
            mid = str(msg.metadata.get("message_id", ""))
            if not mid or not msg.content.strip() or len(msg.content) > 2000:
                continue
            import uuid
            request_id = str(uuid.uuid4())
            self.pending[request_id] = msg
            emit({"event": "message", "id": request_id, "senderId": msg.sender_id,
                  "chatId": msg.chat_id, "messageId": mid, "message": msg.content})

    async def heartbeat(self):
        while True:
            await asyncio.sleep(5)
            if self.manager:
                status = self.manager.get_status().get(self.kind, {})
                self.state = status.get("state", "failed")
                channel = self.manager.channels.get(self.kind)
                if self.kind == "wecom" and channel and channel._client:
                    if not channel._client.is_authenticated:
                        self.state = "reconnecting"
                if self.kind == "weixin" and channel and channel._session_pause_remaining_s() > 0:
                    self.state = "reauth_required"
            self.snapshot()
            emit({"event": "status", "state": self.state})

    async def command(self, value):
        action = value["action"]
        if action == "reply":
            msg = self.pending.pop(value["eventId"], None)
            if msg and value.get("message"):
                await self.bus.publish_outbound(OutboundMessage(
                    channel=self.kind, chat_id=msg.chat_id,
                    content=value["message"][:20000], metadata=msg.metadata,
                ))
            return {}
        if action == "restart":
            if self.kind == "weixin" and not (self.root / "weixin" / "account.json").exists():
                return {"state": "configured"}
            await self.start()
            return {"state": self.state}
        if action == "validate":
            result = await asyncio.to_thread(validate_channel_config, self.kind)
            # QQ/WeCom generic validation is structural, not live authentication.
            return {"validation": result.get("status", "unsupported")}
        if action in ("start", "poll", "cancel") and self.connector:
            if action == "start":
                if self.qr_session:
                    await self.connector.cancel(self.qr_session)
                # Old runtime stop() saves its token. Stop it BEFORE a fresh QR
                # confirmation writes the replacement state, never afterwards.
                if self.manager:
                    await self.manager.stop_all()
                    self.manager = None
                if self.runtime_task:
                    self.runtime_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self.runtime_task
                    self.runtime_task = None
                self.state = "configured"
            result = await self.connector.handle(action, {
                "session_id": [value.get("sessionId", "")], "force": ["true"],
            })
            self.qr_session = result.get("session_id") if result.get("status") == "pending" else None
            self.snapshot()
            if result.get("status") == "succeeded":
                await self.start()
            # No tokens, account identifiers or raw exception strings leave here.
            return {k: v for k, v in result.items() if k in (
                "session_id", "status", "qr_url", "interval_ms", "expires_at_ms",
            )}
        raise ValueError("Unsupported channel action")

    async def dispatch(self, value):
        if value["action"] in ("start", "cancel", "restart") and self.polling:
            self.polling.cancel()
        try:
            async with self.command_lock:
                if value["action"] == "poll":
                    self.polling = asyncio.current_task()
                try:
                    result = await self.command(value)
                finally:
                    if self.polling is asyncio.current_task():
                        self.polling = None
            emit({"id": value["id"], "result": result})
        except asyncio.CancelledError:
            emit({"id": value["id"], "result": {"session_id": value.get("sessionId", ""), "status": "cancelled"}})
        except Exception:
            emit({"id": value["id"], "error": "CHANNEL_ACTION_FAILED"})


async def main():
    os.umask(0o077)
    logger.remove()
    logging.disable(logging.CRITICAL)
    # Third-party prints must never contaminate IPC or expose credentials.
    sys.stdout = sys.stderr
    reader = asyncio.StreamReader(limit=262144)
    await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin,
    )
    initial = json.loads(await reader.readline())
    gateway = Gateway(initial)
    if gateway.kind != "weixin" or initial.get("weixinState"):
        await gateway.start()
    emit({"event": "ready", "state": gateway.state})
    tasks = [asyncio.create_task(gateway.receive()), asyncio.create_task(gateway.heartbeat())]
    commands = set()
    try:
        while line := await reader.readline():
            command = json.loads(line)
            if len(commands) >= 8:
                emit({"id": command["id"], "error": "CHANNEL_BUSY"})
                continue
            task = asyncio.create_task(gateway.dispatch(command))
            commands.add(task)
            task.add_done_callback(commands.discard)
    finally:
        for task in [*tasks, *commands]:
            task.cancel()
        await asyncio.gather(*tasks, *commands, return_exceptions=True)
        if gateway.manager:
            await gateway.manager.stop_all()
        gateway.snapshot()


if __name__ == "__main__":
    asyncio.run(main())
