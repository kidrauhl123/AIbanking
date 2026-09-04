import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectAgentRun: vi.fn(),
  resumeAgentRuntime: vi.fn(),
  runAgentRuntime: vi.fn(),
  commitPreparedCardLock: vi.fn(),
  commitTransfer: vi.fn(),
  createChannelBindingToken: vi.fn(),
  recordChannelEvent: vi.fn(),
  resolveChannelIdentity: vi.fn(),
  query: vi.fn(),
}));

vi.mock("./agent-runtime", () => ({
  inspectAgentRun: mocks.inspectAgentRun,
  resumeAgentRuntime: mocks.resumeAgentRuntime,
  runAgentRuntime: mocks.runAgentRuntime,
}));
vi.mock("./bank-core", () => ({
  commitPreparedCardLock: mocks.commitPreparedCardLock,
  commitTransfer: mocks.commitTransfer,
}));
vi.mock("./channels", () => ({
  createChannelBindingToken: mocks.createChannelBindingToken,
  recordChannelEvent: mocks.recordChannelEvent,
  resolveChannelIdentity: mocks.resolveChannelIdentity,
}));
vi.mock("./db", () => ({ query: mocks.query }));

import { handleWecomAction, handleWecomMessage } from "./wecom-gateway";

const messageInput = {
  tenantExternalId: "bot-1",
  subjectExternalId: "user-1",
  conversationExternalId: "user-1",
  eventId: "event-1",
  message: "查余额",
};

describe("WeCom gateway security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BANKPILOT_PUBLIC_URL = "https://bank.example.com/path-that-must-be-dropped";
    mocks.recordChannelEvent.mockResolvedValue({ rowCount: 1 });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("uses a fragment for one-time binding secrets", async () => {
    mocks.resolveChannelIdentity.mockResolvedValue(null);
    mocks.createChannelBindingToken.mockResolvedValue({ token: "token.secret", expiresAt: "2030-01-01T00:00:00.000Z" });
    const result = await handleWecomMessage(messageInput);
    expect(result.status).toBe("BINDING_REQUIRED");
    expect(result.bindUrl).toBe("https://bank.example.com/connect/wecom#token=token.secret");
    expect(result.bindUrl).not.toContain("?token=");
    expect(mocks.runAgentRuntime).not.toHaveBeenCalled();
  });

  it("deduplicates inbound events before running the model", async () => {
    mocks.recordChannelEvent.mockResolvedValue({ rowCount: 0 });
    expect(await handleWecomMessage(messageInput)).toEqual({ status: "DUPLICATE" });
    expect(mocks.resolveChannelIdentity).not.toHaveBeenCalled();
    expect(mocks.runAgentRuntime).not.toHaveBeenCalled();
  });

  it("never executes an MFA operation inside WeCom", async () => {
    mocks.resolveChannelIdentity.mockResolvedValue({ id: "identity-1", customer_id: "customer-1" });
    mocks.inspectAgentRun.mockResolvedValue({
      status: "INTERRUPTED",
      operation_id: "TRF-1",
      channel_type: "WECOM",
      channel_identity_id: "identity-1",
      interrupt_kind: "MFA",
    });
    const result = await handleWecomAction({
      tenantExternalId: "bot-1",
      subjectExternalId: "user-1",
      eventId: "action-1",
      taskId: "68b63839-422c-4bf7-9d37-f9e814c406d3",
      operationId: "TRF-1",
      approved: true,
    });
    expect(result.status).toBe("MFA_REQUIRED");
    expect(mocks.commitTransfer).not.toHaveBeenCalled();
    expect(mocks.resumeAgentRuntime).not.toHaveBeenCalled();
  });

  it("rejects authorization from a different channel identity", async () => {
    mocks.resolveChannelIdentity.mockResolvedValue({ id: "identity-2", customer_id: "customer-1" });
    mocks.inspectAgentRun.mockResolvedValue({
      status: "INTERRUPTED",
      operation_id: "CARD-1",
      channel_type: "WECOM",
      channel_identity_id: "identity-1",
      interrupt_kind: "CONFIRM",
    });
    await expect(handleWecomAction({
      tenantExternalId: "bot-1",
      subjectExternalId: "user-2",
      eventId: "action-2",
      taskId: "68b63839-422c-4bf7-9d37-f9e814c406d3",
      operationId: "CARD-1",
      approved: true,
    })).rejects.toThrow("AGENT_RUN_NOT_FOUND");
    expect(mocks.commitPreparedCardLock).not.toHaveBeenCalled();
  });
});
