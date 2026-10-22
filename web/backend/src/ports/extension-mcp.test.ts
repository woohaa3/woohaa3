import { expect, it } from "vitest";
import type { ApplicationService } from "@woohaa3/application-service";
import { createExtensionMcpBridge } from "./extension-mcp.js";
import { createToolGrantRegistry } from "./authoring-adapters.js";

it("扩展 MCP 委托绑定真实主体、目标、工具预算与当前实例生命周期", async () => {
  const grants = createToolGrantRegistry();
  const contexts: unknown[] = [];
  let state = "active";
  const application = {
    plugins: () => ({ status: () => ({ actualState: state }) }),
    host: () => ({ dispatch: async (_route: string, input: { context: unknown }) => {
      contexts.push(input.context); return { body: { ok: true } };
    } })
  } as unknown as ApplicationService;
  const bridge = createExtensionMcpBridge({ application: () => application, grants, loopbackDevelopment: false,
    definitions: () => [{ extensionId: "test", activate() {}, mcpTools: [
      { name: "test_submit", description: "test", route: "test/submit", permission: "write", newWork: true }
    ] }] });
  const args = { canvasId: "c", nodeId: "n", requestId: "r" };
  expect(await bridge.call({ name: "test_submit", args, bearerToken: null, loopback: true })).toMatchObject({ ok: false, code: "unauthorized" });
  grants.issue({ token: "grant", canvasIds: ["c"], nodeIds: ["n"], tools: ["test_submit"], maxCalls: 1, expiresAt: Date.now() + 60000 }, "owner");
  expect(await bridge.call({ name: "test_submit", args: { canvasId: "c", requestId: "create" }, bearerToken: "grant", loopback: false })).toMatchObject({ ok: false, code: "unauthorized" });
  expect(await bridge.call({ name: "test_submit", args: { ...args, nodeId: "other" }, bearerToken: "grant", loopback: false })).toMatchObject({ ok: false, code: "unauthorized" });
  expect(await bridge.call({ name: "test_submit", args, bearerToken: "grant", loopback: false })).toEqual({ ok: true });
  expect(contexts).toEqual([expect.objectContaining({ principal: { subject: "owner", identityProvider: "extension-tool-grant" }, authLevel: "authenticated" })]);
  expect(await bridge.call({ name: "test_submit", args, bearerToken: "grant", loopback: false })).toMatchObject({ ok: false, code: "unauthorized" });
  state = "draining";
  expect(bridge.list()).toEqual([]);
  grants.issue({ token: "next", canvasIds: ["c"], nodeIds: ["n"], tools: ["test_submit"], maxCalls: 1, expiresAt: Date.now() + 60000 }, "owner");
  expect(await bridge.call({ name: "test_submit", args, bearerToken: "next", loopback: false })).toMatchObject({ ok: false, code: "plugin-disabled" });
  expect(contexts).toHaveLength(1);
});
