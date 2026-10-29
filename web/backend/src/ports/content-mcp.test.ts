import { describe, expect, it } from "vitest";
import { ContentContributionRegistry } from "@woohaa3/contracts";
import { createContentMcpBridge } from "./content-mcp.js";

function registry(): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register({
    extensionId: "test-tool",
    mcpTools: [
      {
        name: "create_test_content",
        title: "创建测试内容",
        description: "创建测试内容",
        inputSchema: {},
        parameters: { title: { type: "string" } },
        handle: (input) => ({ ok: true, structured: input })
      },
      {
        name: "delete_test_content",
        title: "删除测试内容",
        description: "删除测试内容",
        inputSchema: {},
        permission: "read",
        handle: () => ({ ok: true, text: "deleted" })
      }
    ]
  });
  return result;
}

function bridge() {
  return createContentMcpBridge({
    content: registry,
    grants: {
      issue: () => {},
      subject: () => "user-1",
      verify: () => null,
      revoke: () => {},
      authorize: () => ({ ok: true })
    },
    developmentPrincipal: "dev",
    loopbackDevelopment: true
  });
}

describe("content MCP bridge", () => {
  it("lists owner tools and forwards loopback calls", async () => {
    const tools = bridge().list();
    expect(tools.map((tool) => [tool.name, tool.permission])).toEqual([
      ["create_test_content", "write"],
      ["delete_test_content", "read"]
    ]);
    await expect(bridge().call({ name: "create_test_content", args: { canvasId: "c", requestId: "r", title: "x" }, bearerToken: null, loopback: true }))
      .resolves.toEqual({ ok: true, structured: { canvasId: "c", requestId: "r", title: "x" } });
  });

  it("rejects calls without a trusted principal", async () => {
    await expect(bridge().call({ name: "create_test_content", args: { canvasId: "c" }, bearerToken: null, loopback: false }))
      .resolves.toEqual({ ok: false, code: "unauthorized", message: "缺少已认证 principal" });
  });

  it("drops tools when the owner is disposed", () => {
    const target = new ContentContributionRegistry();
    const release = target.register({
      extensionId: "test-tool",
      mcpTools: [{ name: "tool", title: "t", description: "t", inputSchema: {}, handle: () => ({ ok: true }) }]
    });
    const live = createContentMcpBridge({ content: () => target, grants: { issue: () => {}, subject: () => "u", verify: () => null, revoke: () => {}, authorize: () => ({ ok: true }) }, loopbackDevelopment: true });
    expect(live.list()).toHaveLength(1);
    release();
    expect(live.list()).toHaveLength(0);
  });
});
