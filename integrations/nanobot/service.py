"""Private authenticated job supervisor. Never expose this port publicly.

No database credentials, shell tools, or model reasoning loop here. Each run
starts a clean upstream Nanobot process; only its own workspace is selected.
Process separation is not a per-tenant container sandbox (see hosting docs).
"""

import asyncio
import hmac
import json
import os
import sys
from pathlib import Path
from uuid import UUID

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

jobs: dict[str, asyncio.Task] = {}
owners: set[str] = set()
CHILD_ENV = (
    "PATH",
    "HOME",
    "LANG",
    "SSL_CERT_FILE",
    "AI_API_KEY",
    "AI_BASE_URL",
    "AI_MODEL",
    "BANKPILOT_MCP_URL",
    "NANOBOT_ALLOW_LOCAL_MCP",
)


def authorized(header):
    token = os.environ.get("NANOBOT_SERVICE_TOKEN", "")
    return len(token) >= 32 and hmac.compare_digest(header or "", "Bearer " + token)


def validate_job(payload):
    for key in ("runId", "ownerId", "conversationId"):
        if str(UUID(payload[key])) != payload[key]:
            raise ValueError("Invalid identifier")
    if (
        not isinstance(payload["message"], str)
        or not 1 <= len(payload["message"]) <= 2000
    ):
        raise ValueError("Invalid message")
    if (
        not isinstance(payload["bankToken"], str)
        or not payload["bankToken"].startswith("bpt_")
        or len(payload["bankToken"]) > 200
    ):
        raise ValueError("Invalid credential")
    return {
        key: payload[key]
        for key in ("runId", "ownerId", "conversationId", "message", "bankToken")
    }


async def execute(payload):
    process = None
    result = {"message": "", "failed": True}
    try:
        workspace = (
            Path(os.environ.get("NANOBOT_DATA_DIR", "/data"))
            / payload["ownerId"]
            / payload["conversationId"]
        )
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        child_env = {key: os.environ[key] for key in CHILD_ENV if key in os.environ}
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            str(Path(__file__).with_name("hosted_worker.py")),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=child_env,
            cwd=str(workspace),
        )
        wire = json.dumps({**payload, "workspace": str(workspace)}).encode()
        stdout, _ = await asyncio.wait_for(process.communicate(wire), timeout=200)
        if process.returncode == 0 and len(stdout) < 100000:
            parsed = json.loads(stdout)
            if isinstance(parsed.get("message"), str) and isinstance(
                parsed.get("failed"), bool
            ):
                result = {
                    "message": parsed["message"][:20000],
                    "failed": parsed["failed"],
                }
    except Exception:  # noqa: BLE001 -- only sanitized failure leaves this boundary
        result = {"message": "", "failed": True}
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.wait()
        # Callback authority belongs only to the supervisor, never the model process.
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                for attempt in range(3):
                    try:
                        response = await client.post(
                            os.environ["BANKPILOT_CALLBACK_URL"],
                            headers={
                                "Authorization": "Bearer "
                                + os.environ["NANOBOT_SERVICE_TOKEN"]
                            },
                            json={"runId": payload["runId"], **result},
                        )
                        if response.is_success:
                            break
                    except httpx.HTTPError:
                        pass
                    if attempt < 2:
                        await asyncio.sleep(1)
        finally:
            owners.discard(payload["ownerId"])
            jobs.pop(payload["runId"], None)


async def start(request: Request):
    if not authorized(request.headers.get("authorization")):
        return JSONResponse({"error": "UNAUTHORIZED"}, status_code=401)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 20000:
            return JSONResponse({"error": "TOO_LARGE"}, status_code=413)
    try:
        payload = validate_job(json.loads(body))
    except (ValueError, KeyError, TypeError):
        return JSONResponse({"error": "INVALID_JOB"}, status_code=400)
    if payload["runId"] in jobs:
        return JSONResponse({"accepted": True}, status_code=202)
    if len(jobs) >= 2 or payload["ownerId"] in owners:
        return JSONResponse({"error": "BUSY"}, status_code=429)
    owners.add(payload["ownerId"])
    jobs[payload["runId"]] = asyncio.create_task(execute(payload))
    return JSONResponse({"accepted": True}, status_code=202)


async def health(request: Request):
    configured = (
        all(
            os.environ.get(k)
            for k in (
                "AI_API_KEY",
                "AI_BASE_URL",
                "AI_MODEL",
                "BANKPILOT_MCP_URL",
                "BANKPILOT_CALLBACK_URL",
            )
        )
        and len(os.environ.get("NANOBOT_SERVICE_TOKEN", "")) >= 32
    )
    return JSONResponse({"ok": configured}, status_code=200 if configured else 503)


app = Starlette(
    routes=[Route("/runs", start, methods=["POST"]), Route("/health", health)]
)
