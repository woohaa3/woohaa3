import path from "node:path";
import { expect, it } from "vitest";
import { resolveChatGptServiceConfig } from "../src/backend/config.js";

it("derives the default MCP URL from the host deployment prefix, preserving an explicit override", () => {
  const env = { WOOHAA3_CHATGPT_CREDENTIAL_DIR: path.resolve(".test-credentials"), WOOHAA3_CHATGPT_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), BACKEND_PORT: "5180" };
  for (const prefix of ["/dev/test/", "/dev/test", "/"]) {
    const result = resolveChatGptServiceConfig(env, prefix);
    expect(result.ok && result.config.mcpUrl).toBe(`http://127.0.0.1:5180${prefix === "/" ? "" : "/dev/test"}/mcp/model-canvas`);
  }
  const result = resolveChatGptServiceConfig({ ...env, WOOHAA3_CHATGPT_MCP_URL: "http://localhost:9000/custom" }, "/dev/test/");
  expect(result.ok && result.config.mcpUrl).toBe("http://localhost:9000/custom");
});
