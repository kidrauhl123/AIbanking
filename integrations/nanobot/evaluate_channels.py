"""Local IM-boundary evaluation with synthetic transport and REAL Nanobot/MCP.

Requires evaluate_hosted.py --keep-service on the disposable local database.
Does not claim delivery through Tencent; never use production accounts here.
"""
import asyncio
import json
import os
from uuid import uuid4

import httpx

URL = "http://127.0.0.1:3012"
TOKEN = "local-preview-only-service-token-12345678"
PASSWORD = "NanobotLocalOnly!9"


async def main():
    if os.environ.get("BANKPILOT_DB_TESTS") != "1":
        raise RuntimeError("Disposable database opt-in required")
    headers = {"Origin": URL}
    async with httpx.AsyncClient(base_url=URL, headers=headers, timeout=240) as a, httpx.AsyncClient(base_url=URL, headers=headers, timeout=80) as b, httpx.AsyncClient(base_url=URL, timeout=240) as gateway:
        for client, phone in ((a, "19900006001"), (b, "19900006002")):
            (await client.post("/api/auth/login", json={"phone": phone, "password": PASSWORD})).raise_for_status()
        data = {"action": "configure", "config": {"channelType": "weixin", "credentials": {}}, "password": PASSWORD, "confirmed": True}
        connections = []
        try:
            for client in (a, b):
                response = await client.post("/api/nanobot/channels", json=data)
                response.raise_for_status()
                connections.append(response.json())
            ca, cb = connections
            assert ca["id"] != cb["id"]
            print("PASS two bank users have independent upstream channel workers", flush=True)
            denied = await b.post("/api/nanobot/channels", json={"action": "restart", "connectionId": ca["id"]})
            assert denied.status_code == 404
            denied = await a.post("/api/nanobot/channels", headers={"Origin": "https://evil.example"}, json={"action": "pair", "connectionId": ca["id"]})
            assert denied.status_code == 403
            print("PASS ownership and CSRF gates", flush=True)
            endpoint = "/api/internal/nanobot/channels"
            payload = {"connectionId": ca["id"], "senderId": "synthetic-private-user-a", "chatId": "synthetic-private-chat-a", "messageId": str(uuid4()), "message": ca["pairingCode"]}
            assert (await gateway.post(endpoint, json=payload)).status_code == 401
            internal = {"Authorization": "Bearer " + TOKEN}
            wrong = await gateway.post(endpoint, headers=internal, json={**payload, "connectionId": cb["id"]})
            assert wrong.json() == {"message": ""}
            paired = await gateway.post(endpoint, headers=internal, json=payload)
            assert "已连接" in paired.json()["message"]
            stranger = await gateway.post(endpoint, headers=internal, json={**payload, "senderId": "stranger", "message": "查余额"})
            assert stranger.json() == {"message": ""}
            print("PASS synthetic private sender paired; strangers and cross-connection codes denied", flush=True)
            request = {**payload, "messageId": str(uuid4()), "message": "查一下我的余额"}
            reply = await gateway.post(endpoint, headers=internal, json=request)
            reply.raise_for_status()
            assert reply.json()["message"]
            state = (await a.get("/api/nanobot")).json()
            run = next(row for row in reversed(state["runs"]) if row["conversation_id"] == ca["id"])
            assert run["status"] == "SUCCEEDED", run["status"]
            assert any(event["tool_name"] == "banking.accounts.list" for event in run["events"])
            repeat = await gateway.post(endpoint, headers=internal, json=request)
            assert repeat.json() == reply.json()
            after = (await a.get("/api/nanobot")).json()
            assert next(row for row in after["runs"] if row["id"] == run["id"])["events"] == run["events"]
            assert run["id"] not in json.dumps((await b.get("/api/nanobot")).json())
            print("PASS real model + MCP reply through IM ingress, idempotency and tenant isolation", flush=True)
            await a.post("/api/nanobot/channels", json={"action": "delete", "connectionId": ca["id"]})
            assert (await gateway.post(endpoint, headers=internal, json={**request, "messageId": str(uuid4())})).json() == {"message": ""}
            print("PASS disconnect immediately blocks bank access", flush=True)
        finally:
            for client, connection in zip((a, b), connections):
                await client.post("/api/nanobot/channels", json={"action": "delete", "connectionId": connection["id"]})


if __name__ == "__main__":
    asyncio.run(main())
