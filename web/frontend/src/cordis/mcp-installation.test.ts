import { describe, expect, it } from "vitest";
import { mcpInstallation } from "./mcp-installation.js";

describe("MCP installation content", () => {
  it.each(["https://canvas.example/mcp/model-canvas", "https://canvas.example/workspace/mcp/model-canvas"])("uses the complete public URL without a canvas binding: %s", url => {
    expect(mcpInstallation(url).content).toBe(`安装这个 MCP 服务：${url}`);
  });
});
