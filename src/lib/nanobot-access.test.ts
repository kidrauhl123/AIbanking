import { afterEach, describe, expect, it, vi } from "vitest";
import { nanobotAvailable, requireNanobot, validServiceToken } from "./nanobot-preview";

afterEach(() => vi.unstubAllEnvs());
describe("Nanobot access without enrollment", () => {
  it.each(["", "someone-else-only"])("does not gate bank users on the retired list (%s)", list => {
    vi.stubEnv("NANOBOT_SERVICE_URL", "http://nanobot:8080");
    vi.stubEnv("NANOBOT_SERVICE_TOKEN", "test-service-secret-with-32-characters");
    vi.stubEnv("NANOBOT_ALLOWED_USERS", list);
    expect(nanobotAvailable()).toBe(true);
    expect(() => requireNanobot()).not.toThrow();
  });
  it("still fails honestly if the service is not configured", () => {
    vi.stubEnv("NANOBOT_SERVICE_URL", "");
    expect(nanobotAvailable()).toBe(false);
    expect(() => requireNanobot()).toThrow("NANOBOT_UNAVAILABLE");
  });
  it("does not remove internal service authentication", () => {
    vi.stubEnv("NANOBOT_SERVICE_TOKEN", "test-service-secret-with-32-characters");
    expect(validServiceToken(null)).toBe(false);
    expect(validServiceToken("Bearer wrong")).toBe(false);
    expect(validServiceToken("Bearer test-service-secret-with-32-characters")).toBe(true);
  });
});
