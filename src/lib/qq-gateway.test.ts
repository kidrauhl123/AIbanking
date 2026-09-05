import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectAgentRun: vi.fn(), resumeAgentRuntime: vi.fn(), runAgentRuntime: vi.fn(),
  commitPreparedCardLock: vi.fn(), commitTransfer: vi.fn(), createChannelBindingToken: vi.fn(),
  recordChannelEvent: vi.fn(), resolveChannelIdentity: vi.fn(), query: vi.fn(),
}));

vi.mock("./agent-runtime", () => ({
  inspectAgentRun: mocks.inspectAgentRun,
  resumeAgentRuntime: mocks.resumeAgentRuntime,
  runAgentRuntime: mocks.runAgentRuntime,
}));
vi.mock("./bank-core", () => ({ commitPreparedCardLock: mocks.commitPreparedCardLock, commitTransfer: mocks.commitTransfer }));
vi.mock("./channels", () => ({
  createChannelBindingToken: mocks.createChannelBindingToken,
  recordChannelEvent: mocks.recordChannelEvent,
  resolveChannelIdentity: mocks.resolveChannelIdentity,
}));
vi.mock("./db", () => ({ query: mocks.query }));

import { handleQqAction, handleQqMessage } from "./qq-gateway";

const messageInput = {
  tenantExternalId: "qq-app-1",
  subjectExternalId: "user-openid-1",
  conversationExternalId: "user-openid-1",
  eventId: "qq-message-1",
  message: "查余额",
};

describe("QQ gateway security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BANKPILOT_PUBLIC_URL = "https://bank.example.com/path-that-must-be-dropped";
    mocks.recordChannelEvent.mockResolvedValue({ rowCount: 1 });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("keeps binding secrets in the QQ page URL fragment", async () => {
    mocks.resolveChannelIdentity.mockResolvedValue(null);
    mocks.createChannelBindingToken.mockResolvedValue({ token: "token.secret", expiresAt: "2030-01-01T00:00:00.000Z" });
    const result = await handleQqMessage(messageInput);
    expect(result.status).toBe("BINDING_REQUIRED");
    expect(result.bindUrl).toBe("https://bank.example.com/connect/qq#token=token.secret");
    expect(mocks.createChannelBindingToken).toHaveBeenCalledWith(expect.objectContaining({ channelType: "QQ" }));
    expect(mocks.runAgentRuntime).not.toHaveBeenCalled();
  });

  it("deduplicates QQ events before invoking the model", async () => {
    mocks.recordChannelEvent.mockResolvedValue({ rowCount: 0 });
    expect(await handleQqMessage(messageInput)).toEqual({ status: "DUPLICATE" });
    expect(mocks.runAgentRuntime).not.toHaveBeenCalled();
  });

  it("never executes an MFA operation inside QQ", async () => {
    mocks.resolveChannelIdentity.mockResolvedValue({ id: "identity-1", customer_id: "customer-1" });
    mocks.inspectAgentRun.mockResolvedValue({ status: "INTERRUPTED", operation_id: "TRF-1", channel_type: "QQ", channel_identity_id: "identity-1", interrupt_kind: "MFA" });
    const result = await handleQqAction({
      tenantExternalId: "qq-app-1", subjectExternalId: "user-openid-1", eventId: "interaction-1",
      taskId: "68b63839-422c-4bf7-9d37-f9e814c406d3", operationId: "TRF-1", approved: true,
    });
    expect(result.status).toBe("MFA_REQUIRED");
    expect(mocks.commitTransfer).not.toHaveBeenCalled();
    expect(mocks.resumeAgentRuntime).not.toHaveBeenCalled();
  });

  it("rejects a button click from another QQ identity", async () => {
    mocks.resolveChannelIdentity.mockResolvedValue({ id: "identity-2", customer_id: "customer-1" });
    mocks.inspectAgentRun.mockResolvedValue({ status: "INTERRUPTED", operation_id: "CARD-1", channel_type: "QQ", channel_identity_id: "identity-1", interrupt_kind: "CONFIRM" });
    await expect(handleQqAction({
      tenantExternalId: "qq-app-1", subjectExternalId: "user-openid-2", eventId: "interaction-2",
      taskId: "68b63839-422c-4bf7-9d37-f9e814c406d3", operationId: "CARD-1", approved: true,
    })).rejects.toThrow("AGENT_RUN_NOT_FOUND");
    expect(mocks.commitPreparedCardLock).not.toHaveBeenCalled();
  });
});
