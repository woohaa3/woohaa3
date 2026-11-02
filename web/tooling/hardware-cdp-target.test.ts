import { afterEach, describe, expect, it, vi } from "vitest";
import { webTarget } from "../e2e/target";

const options = { port: 4273, server: { command: "never-run", url: "http://127.0.0.1:4273" } };
afterEach(() => vi.unstubAllEnvs());

describe("Playwright target", () => {
  it("uses the explicit target without a web server", () => {
    vi.stubEnv("E2E_BASE_URL", "http://127.0.0.1:5312/");
    expect(webTarget(options)).toEqual({ baseURL: "http://127.0.0.1:5312/", webServer: undefined });
  });
  it("retains the normal local server without an external target", () => {
    vi.stubEnv("E2E_BASE_URL", undefined); vi.stubEnv("WOOHAA_E2E_CDP", undefined);
    expect(webTarget(options)).toEqual({ baseURL: "http://127.0.0.1:4273", webServer: options.server });
  });
  it.each(["", "garbage", "file:///tmp/test", "http://user:pass@example.com", "http://example.com/?x=1"])("rejects invalid target %s", value => {
    vi.stubEnv("WOOHAA_E2E_CDP", undefined); vi.stubEnv("E2E_BASE_URL", value);
    expect(() => webTarget(options)).toThrow(/E2E_BASE_URL/);
  });
  it("rejects a hardware connection without an explicit target", () => {
    vi.stubEnv("WOOHAA_E2E_CDP", "http://127.0.0.1:9222"); vi.stubEnv("E2E_BASE_URL", undefined);
    expect(() => webTarget(options)).toThrow(/requires an explicit E2E_BASE_URL/);
  });
});
