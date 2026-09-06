"""Tenant-bound supervision for unchanged Nanobot channel plugins.

No public endpoints. Bank app authenticates customers and owns pairing/consent.
IM secrets and WeChat state are AES-GCM encrypted on disk. Only each channel's
own credentials are passed to its child process, over stdin (never argv/env).
"""
import asyncio
import contextlib
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from uuid import UUID, uuid4

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def identifier(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("Invalid connection")
    return value


class Vault:
    def __init__(self, root, secret):
        if len(secret) < 32:
            raise ValueError("Missing service secret")
        self.root = Path(root) / "channels"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.aes = AESGCM(hashlib.sha256(("bankpilot/im/v1/" + secret).encode()).digest())

    def path(self, connection_id):
        return self.root / (identifier(connection_id) + ".enc")

    def save(self, connection_id, value):
        path = self.path(connection_id)
        nonce = os.urandom(12)
        data = nonce + self.aes.encrypt(nonce, json.dumps(value).encode(), connection_id.encode())
        temp = path.with_suffix(".tmp")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        temp.replace(path)

    def load(self, connection_id):
        data = self.path(connection_id).read_bytes()
        return json.loads(self.aes.decrypt(data[:12], data[12:], connection_id.encode()))

    def delete(self, connection_id):
        self.path(connection_id).unlink(missing_ok=True)


class ChannelProcess:
    def __init__(self, service, connection_id, config):
        self.service, self.id, self.config = service, connection_id, config
        self.process = None
        self.directory = None
        self.reader = None
        self.futures = {}
        self.tasks = set()
        self.state = "starting"
        self.updated = time.monotonic()
        self.lock = asyncio.Lock()
        self.ready = asyncio.get_running_loop().create_future()

    async def start(self):
        self.directory = tempfile.TemporaryDirectory(prefix="bankpilot-im-")
        env = {key: os.environ[key] for key in ("PATH", "LANG", "SSL_CERT_FILE") if key in os.environ}
        # Do not inherit HOME, AI keys, DB credentials or supervisor authority.
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).with_name("channel_worker.py")),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, env=env, cwd=self.directory.name,
            limit=262144,
        )
        self.reader = asyncio.create_task(self.read())
        self.process.stdin.write((json.dumps(self.config) + "\n").encode())
        await self.process.stdin.drain()
        await asyncio.wait_for(self.ready, 30)

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                value = json.loads(line)
                event = value.get("event")
                if event in ("ready", "status"):
                    self.state = value.get("state", "failed")
                    self.updated = time.monotonic()
                    if event == "ready" and not self.ready.done():
                        self.ready.set_result(True)
                elif event == "snapshot":
                    self.config["weixinState"] = value["weixinState"]
                    self.service.vault.save(self.id, self.config)
                elif event == "message" and len(self.tasks) < 4:
                    task = asyncio.create_task(self.forward(value))
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                elif value.get("id") in self.futures:
                    future = self.futures.pop(value["id"])
                    if not future.done():
                        if value.get("error"):
                            future.set_exception(RuntimeError("CHANNEL_ACTION_FAILED"))
                        else:
                            future.set_result(value["result"])
        finally:
            self.state = "failed"
            if self.process and self.process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    self.process.kill()
            for future in [self.ready, *self.futures.values()]:
                if not future.done():
                    future.set_exception(RuntimeError("CHANNEL_STOPPED"))

    async def command(self, action, **values):
        request_id = str(uuid4())
        future = asyncio.get_running_loop().create_future()
        async with self.lock:
            if not self.process or self.process.returncode is not None:
                raise RuntimeError("CHANNEL_STOPPED")
            self.futures[request_id] = future
            self.process.stdin.write((json.dumps({"id": request_id, "action": action, **values}) + "\n").encode())
            await self.process.stdin.drain()
        # Do not hold the writer lock during QR long-poll: cancel must get through.
        try:
            return await asyncio.wait_for(future, 65)
        finally:
            self.futures.pop(request_id, None)

    async def forward(self, event):
        message = ""
        try:
            async with httpx.AsyncClient(timeout=230) as client:
                response = await client.post(self.service.bank_url, headers=self.service.headers,
                    json={"connectionId": self.id, **{key: event[key] for key in ("senderId", "chatId", "messageId", "message")}})
                if response.is_success:
                    message = response.json().get("message", "")
        except Exception:
            pass  # Never leak SDK exceptions, identities or credentials to logs/IM.
        with contextlib.suppress(Exception):
            await self.command("reply", eventId=event["id"], message=message)

    def status(self):
        alive = self.process is not None and self.process.returncode is None
        return {"state": self.state if alive and time.monotonic() - self.updated < 90 else "failed"}

    async def stop(self):
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.process and self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.reader:
            await asyncio.gather(self.reader, return_exceptions=True)
        if self.directory:
            self.directory.cleanup()


class ChannelService:
    def __init__(self):
        token = os.environ["NANOBOT_SERVICE_TOKEN"]
        self.vault = Vault(os.environ.get("NANOBOT_DATA_DIR", "/data"), token)
        self.headers = {"Authorization": "Bearer " + token}
        self.bank_url = os.environ["BANKPILOT_CALLBACK_URL"].rsplit("/", 1)[0] + "/channels"
        self.processes = {}
        self.lock = asyncio.Lock()

    async def ensure(self, connection_id):
        existing = self.processes.get(connection_id)
        if existing and existing.process and existing.process.returncode is None:
            return existing
        if existing:
            await existing.stop()
            self.processes.pop(connection_id, None)
        if len(self.processes) >= int(os.environ.get("NANOBOT_MAX_CHANNELS", "6")):
            raise RuntimeError("CHANNEL_CAPACITY")
        child = ChannelProcess(self, connection_id, self.vault.load(connection_id))
        self.processes[connection_id] = child
        try:
            await child.start()
            return child
        except Exception:
            await child.stop()
            self.processes.pop(connection_id, None)
            raise

    async def action(self, payload):
        connection_id = identifier(payload["connectionId"])
        action = payload["action"]
        if action == "status":
            child = self.processes.get(connection_id)
            return child.status() if child else {"state": "stopped"}
        async with self.lock:
            if action == "delete":
                child = self.processes.pop(connection_id, None)
                if child:
                    await child.stop()
                self.vault.delete(connection_id)
                return {"state": "stopped"}
            if action == "configure":
                kind = payload["channelType"]
                if kind not in ("qq", "wecom", "weixin"):
                    raise ValueError("Invalid channel")
                credentials = payload.get("credentials", {})
                allowed = {"appId", "secret"} if kind == "qq" else {"botId", "secret"} if kind == "wecom" else set()
                if set(credentials) - allowed or any(not isinstance(v, str) or not 1 <= len(v) <= 512 for v in credentials.values()):
                    raise ValueError("Invalid credentials")
                if kind != "weixin" and set(credentials) != allowed:
                    raise ValueError("Missing credentials")
                old = self.processes.pop(connection_id, None)
                if old:
                    await old.stop()
                self.vault.save(connection_id, {"channelType": kind, "credentials": credentials})
            child = await self.ensure(connection_id)
        if action == "configure":
            return {**child.status(), **(await child.command("validate"))}
        if action not in ("start", "poll", "cancel", "restart", "validate"):
            raise ValueError("Invalid action")
        return await child.command(action, sessionId=payload.get("sessionId", ""))

    async def reconcile(self):
        while True:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    response = await client.get(self.bank_url, headers=self.headers)
                    response.raise_for_status()
                    active = {identifier(item) for item in response.json()["connections"]}
                async with self.lock:
                    saved = {identifier(path.stem) for path in self.vault.root.glob("*.enc")}
                    for cid in (set(self.processes) | saved) - active:
                        child = self.processes.pop(cid, None)
                        if child:
                            await child.stop()
                        self.vault.delete(cid)
                    for cid in active:
                        if self.vault.path(cid).exists():
                            with contextlib.suppress(Exception):
                                await self.ensure(cid)
            except Exception:
                pass  # Bank callback always rechecks consent; fail closed there.
            await asyncio.sleep(30)

    async def close(self):
        await asyncio.gather(*(child.stop() for child in self.processes.values()), return_exceptions=True)
