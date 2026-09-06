"""LOCAL hosted-path regression; synthetic fixtures only. Never production.

Start the bank on 127.0.0.1:3012 with NANOBOT_ALLOWED_USERS=19900006001,19900006002
and the local test service token documented below. Real model settings use the
same explicit environment/authorized SSH mechanism as evaluate.py.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

import httpx
from evaluate import model_settings

URL = "http://127.0.0.1:3012"
TEST_TOKEN = "local-preview-only-service-token-12345678"
TEST_PASSWORD = "NanobotLocalOnly!9"


async def run(args):
    if os.environ.get("BANKPILOT_DB_TESTS") != "1":
        raise RuntimeError("Disposable database opt-in required")
    checks = []

    def check(label, passed):
        checks.append({"name": label, "passed": bool(passed)})
        print(f"{'PASS' if passed else 'FAIL'} {label}", flush=True)
        if not passed:
            raise AssertionError(label)

    settings = model_settings(args.model_env_ssh)
    with tempfile.TemporaryDirectory(prefix="bankpilot-hosted-") as directory:
        env = {
            **os.environ,
            **settings,
            "NANOBOT_SERVICE_TOKEN": TEST_TOKEN,
            "BANKPILOT_MCP_URL": URL + "/api/mcp",
            "NANOBOT_ALLOW_LOCAL_MCP": "1",
            "BANKPILOT_CALLBACK_URL": URL + "/api/internal/nanobot/result",
            "NANOBOT_DATA_DIR": directory,
        }
        process = subprocess.Popen(  # noqa: ASYNC220 -- one local test supervisor boot before requests
            [
                sys.executable,
                "-m",
                "uvicorn",
                "service:app",
                "--host",
                "127.0.0.1",
                "--port",
                "8088",
                "--no-access-log",
                "--log-level",
                "critical",
            ],
            cwd=Path(__file__).parent,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            async with (
                httpx.AsyncClient(timeout=20) as external,
                httpx.AsyncClient(base_url=URL, timeout=30) as a,
                httpx.AsyncClient(base_url=URL, timeout=30) as b,
            ):
                for _ in range(40):
                    try:
                        if (
                            await external.get("http://127.0.0.1:8088/health")
                        ).is_success:
                            break
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.25)
                for client, phone, name in (
                    (a, "19900006001", "Nanobot体验甲"),
                    (b, "19900006002", "Nanobot体验乙"),
                ):
                    response = await client.post(
                        "/api/auth/register",
                        json={
                            "displayName": name,
                            "phone": phone,
                            "password": TEST_PASSWORD,
                        },
                    )
                    if response.status_code == 409:
                        response = await client.post(
                            "/api/auth/login",
                            json={"phone": phone, "password": TEST_PASSWORD},
                        )
                    response.raise_for_status()
                    overview = (await client.get("/api/bootstrap")).json()
                    if overview["totalMinor"] == 0:
                        (
                            await client.post(
                                "/api/v1/deposits",
                                json={
                                    "accountId": overview["accounts"][0]["id"],
                                    "amountMinor": 10000,
                                    "source": "CASH",
                                },
                            )
                        ).raise_for_status()
                check(
                    "unauthenticated preview denied",
                    (await external.get(URL + "/api/nanobot")).status_code == 401,
                )
                check(
                    "forged supervisor callback denied",
                    (
                        await external.post(
                            URL + "/api/internal/nanobot/result", json={}
                        )
                    ).status_code
                    == 401,
                )
                check(
                    "private service rejects missing authority",
                    (
                        await external.post("http://127.0.0.1:8088/runs", json={})
                    ).status_code
                    == 401,
                )
                check(
                    "wrong bank password rejected",
                    (
                        await a.post(
                            "/api/nanobot",
                            json={
                                "action": "connect",
                                "password": "wrong",
                                "confirmed": True,
                            },
                        )
                    ).status_code
                    == 401,
                )
                for client in (a, b):
                    (
                        await client.post(
                            "/api/nanobot",
                            json={
                                "action": "connect",
                                "password": TEST_PASSWORD,
                                "confirmed": True,
                            },
                        )
                    ).raise_for_status()
                check(
                    "consent saved", (await a.get("/api/nanobot")).json()["connected"]
                )
                convo = str(uuid4())

                async def ask(client, message, request_id=None):
                    request_id = request_id or str(uuid4())
                    response = await client.post(
                        "/api/nanobot",
                        json={
                            "action": "send",
                            "message": message,
                            "conversationId": convo,
                            "requestId": request_id,
                        },
                    )
                    response.raise_for_status()
                    for _ in range(120):
                        state = (await client.get("/api/nanobot")).json()
                        row = next(
                            (r for r in state["runs"] if r["id"] == request_id), None
                        )
                        if row and row["status"] != "RUNNING":
                            check(
                                "real Nanobot reply: " + message[:12],
                                row["status"] == "SUCCEEDED" and bool(row["reply"]),
                            )
                            return row
                        await asyncio.sleep(2)
                    raise TimeoutError("Run did not finish")

                first, second = await asyncio.gather(
                    ask(a, "查一下我的余额"), ask(b, "查一下我的余额")
                )
                check(
                    "two users have real separate MCP events",
                    all(
                        any(
                            e["tool_name"] == "banking.accounts.list"
                            for e in r["events"]
                        )
                        for r in (first, second)
                    ),
                )
                check(
                    "other user's run is not visible",
                    first["id"] not in json.dumps((await b.get("/api/nanobot")).json()),
                )
                repeat = await ask(a, "查一下我的余额", first["id"])
                check(
                    "idempotent request does not repeat tool calls",
                    repeat["events"] == first["events"],
                )
                transfer = await ask(a, "给手机号19900006002转1元，备注Nanobot测试")
                operations = [
                    e["operation_id"]
                    for e in transfer["events"]
                    if e["tool_name"] == "banking.transfers.prepare"
                    and e["operation_id"]
                ]
                check("transfer draft backed by bank audit", len(operations) == 1)
                operation = (await a.get("/api/v1/operations/" + operations[0])).json()
                check("draft is not a payment", operation["status"] == "AWAITING_AUTH")
                followup = await ask(a, "刚才那笔转账现在是什么状态？不要重新创建。")
                check(
                    "conversation survives fresh worker process",
                    any(
                        e["tool_name"] == "banking.operations.get"
                        and e["operation_id"] == operations[0]
                        for e in followup["events"]
                    ),
                )
                await b.delete("/api/nanobot")
                denied = await b.post(
                    "/api/nanobot",
                    json={
                        "action": "send",
                        "requestId": str(uuid4()),
                        "conversationId": convo,
                        "message": "余额",
                    },
                )
                check("disconnected account cannot invoke", denied.status_code == 403)
                report = {
                    "checks": checks,
                    "model": settings["AI_MODEL"],
                    "replies": [first, second, transfer, followup],
                    "finished": True,
                }
                args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))
                print(
                    "Hosted evaluation passed. Local fixture A remains connected for browser QA.",
                    flush=True,
                )
                if args.keep_service:
                    await asyncio.Event().wait()
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-env-ssh")
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--keep-service", action="store_true")
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except Exception as error:  # noqa: BLE001 -- no raw SDK exception can leak credentials
        print("Hosted evaluation failed: " + type(error).__name__)
        sys.exit(1)
