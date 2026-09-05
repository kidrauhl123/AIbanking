import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { completeChannelBinding, createChannelBindingToken, listChannelIdentities } from "./channels";

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("channel binding database integration", () => {
  const customerIds = [randomUUID(), randomUUID()];
  const tokenIds: string[] = [];
  const tenant = randomUUID();
  const subject = randomUUID();
  const issue = async () => {
    const binding = await createChannelBindingToken({ channelType: "WECOM", tenantExternalId: tenant, subjectExternalId: subject });
    tokenIds.push(binding.token.split(".")[0]);
    return binding.token;
  };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    if (!process.env.PASSWORD_PEPPER) throw new Error("Set a test-only PASSWORD_PEPPER");
    for (const id of customerIds) await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Binding test',$2)", [id, randomUUID()]);
  });
  afterAll(async () => {
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customerIds]);
    await query("DELETE FROM channel_identities WHERE customer_id=ANY($1::uuid[])", [customerIds]);
    await query("DELETE FROM channel_binding_tokens WHERE id=ANY($1::uuid[])", [tokenIds]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customerIds]);
    await db.end();
  });
  it("rejects expired links without creating an identity", async () => {
    const token = await issue();
    await query("UPDATE channel_binding_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [token.split(".")[0]]);
    await expect(completeChannelBinding(customerIds[0], token, "WECOM")).rejects.toThrow("BINDING_TOKEN_INVALID");
    expect(await listChannelIdentities(customerIds[0])).toEqual([]);
  });
  it("rejects the wrong channel, binds once and rejects replay", async () => {
    const token = await issue();
    await expect(completeChannelBinding(customerIds[0], token, "QQ")).rejects.toThrow("CHANNEL_BINDING_MISMATCH");
    expect(await completeChannelBinding(customerIds[0], token, "WECOM")).toMatchObject({ status: "ACTIVE", channelType: "WECOM" });
    await expect(completeChannelBinding(customerIds[0], token, "WECOM")).rejects.toThrow("BINDING_TOKEN_INVALID");
    expect(await listChannelIdentities(customerIds[0])).toHaveLength(1);
  });
  it("does not move an existing IM identity to another customer's account", async () => {
    const token = await issue();
    await expect(completeChannelBinding(customerIds[1], token, "WECOM")).rejects.toThrow("CHANNEL_ALREADY_BOUND");
    expect(await listChannelIdentities(customerIds[1])).toEqual([]);
  });
});
