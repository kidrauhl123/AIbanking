import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { acceptImMessage, imHash, issuePairing, ownedChannel } from "./nanobot-channels";

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("Nanobot IM identity boundary (isolated database)", () => {
  const customers = [randomUUID(), randomUUID()];
  const connections = [randomUUID(), randomUUID()];
  const event = (connectionId = connections[0], message = "余额") => ({ connectionId, senderId: "im-user", chatId: "private-chat", messageId: randomUUID(), message });
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Isolated local test DB required");
    for (let i = 0; i < 2; i++) {
      await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'IM boundary test',$2)", [customers[i], randomUUID()]);
      await query("INSERT INTO nanobot_channels(id,customer_id,channel_type) VALUES($1,$2,'qq')", [connections[i], customers[i]]);
      await query("INSERT INTO nanobot_consents(customer_id) VALUES($1)", [customers[i]]);
    }
  });
  afterAll(async () => {
    await query("DELETE FROM nanobot_channel_messages WHERE connection_id=ANY($1::uuid[])", [connections]);
    await query("DELETE FROM nanobot_channels WHERE id=ANY($1::uuid[])", [connections]);
    await query("DELETE FROM nanobot_consents WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
    await db.end();
  });
  it("rejects cross-customer configuration and unknown senders", async () => {
    await expect(ownedChannel(customers[1], connections[0])).rejects.toThrow("CHANNEL_NOT_FOUND");
    expect(await acceptImMessage(event())).toBeNull();
  });
  it("expires pairing codes and never reuses them on another connection", async () => {
    const { pairingCode } = await issuePairing(customers[0], connections[0]);
    expect(await acceptImMessage(event(connections[1], pairingCode))).toBeNull();
    await query("UPDATE nanobot_channels SET pairing_expires_at=now()-interval '1 second' WHERE id=$1", [connections[0]]);
    expect(await acceptImMessage(event(connections[0], pairingCode))).toBeNull();
  });
  it("binds only the verified private sender and deduplicates message runs", async () => {
    const { pairingCode } = await issuePairing(customers[0], connections[0]);
    expect(await acceptImMessage(event(connections[0], pairingCode))).toEqual({ paired: true });
    expect(await acceptImMessage({ ...event(), senderId: "another-user" })).toBeNull();
    expect(await acceptImMessage({ ...event(), chatId: "a-group" })).toBeNull();
    const input = event();
    const first = await acceptImMessage(input);
    expect(first).toMatchObject({ customerId: customers[0], connectionId: connections[0] });
    expect(await acceptImMessage(input)).toEqual(first);
    await expect(issuePairing(customers[0], connections[0])).rejects.toThrow("CHANNEL_ALREADY_BOUND");
  });
  it("fails closed after bank consent or IM connection revocation", async () => {
    await query("UPDATE nanobot_consents SET revoked_at=now() WHERE customer_id=$1", [customers[0]]);
    expect(await acceptImMessage(event())).toEqual({ authorizationRequired: true });
    await query("UPDATE nanobot_channels SET enabled=false WHERE id=$1", [connections[0]]);
    expect(await acceptImMessage(event())).toBeNull();
  });
  it("stops pairing after repeated wrong codes", async () => {
    const { pairingCode } = await issuePairing(customers[1], connections[1]);
    await query("UPDATE nanobot_channels SET pairing_attempts=20 WHERE id=$1", [connections[1]]);
    expect(await acceptImMessage(event(connections[1], pairingCode))).toBeNull();
    expect(imHash("sender/a")).not.toEqual(imHash("sender/b"));
  });
});
