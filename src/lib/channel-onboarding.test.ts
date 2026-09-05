import { describe, expect, it } from "vitest";
import { channelSetups, trustedBotEntry } from "./channel-onboarding";

describe("public channel onboarding", () => {
  it("does not advertise an unavailable channel or invent a bot entry", () => {
    for (const setup of channelSetups({})) {
      expect(setup.canStart).toBe(false);
      expect(setup.entryUrl).toBeNull();
      expect(setup.unavailableReason).toBeTruthy();
    }
    const [qq] = channelSetups({ BANKPILOT_PUBLIC_URL: "https://bank.example.com", QQ_ADAPTER_TOKEN: "private-adapter-secret" });
    expect(qq.canStart).toBe(false);
    expect(JSON.stringify(qq)).not.toContain("private-adapter-secret");
  });
  it("returns only configured public entry details, never bot credentials", () => {
    const env = { BANKPILOT_PUBLIC_URL: "https://bank.example.com", QQ_ADAPTER_TOKEN: "private-adapter-secret", QQBOT_APP_SECRET: "private-bot-secret", QQ_BOT_ENTRY_URL: "https://qun.qq.com/test-entry", QQ_BOT_NAME: "My bank" };
    const [qq] = channelSetups(env);
    expect(qq).toMatchObject({ canStart: true, entryUrl: env.QQ_BOT_ENTRY_URL, botName: "My bank" });
    expect(JSON.stringify(qq)).not.toContain("private-");
    expect(channelSetups(env)[1].canStart).toBe(false);
  });
  it("rejects executable URLs, userinfo, lookalike domains, HTTP and unexpected ports", () => {
    for (const entry of ["javascript:alert(1)", "http://q.qq.com/bot", "https://q.qq.com.evil.test/bot", "https://evilqq.com/bot", "https://user:pass@q.qq.com/bot", "https://q.qq.com:8443/bot", "not-a-url"]) expect(trustedBotEntry(entry)).toBeNull();
    expect(trustedBotEntry("https://work.weixin.qq.com/bot")).toBe("https://work.weixin.qq.com/bot");
  });
});
