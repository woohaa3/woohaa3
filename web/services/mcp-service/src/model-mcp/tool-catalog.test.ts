/**
 * MCP 真实注册目录（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 角色工具声明必须与实际注册面求交：这里直接走同一条注册路径，核对目录包含/排除
 * 条件式工具（world / skill），避免维护第二份手写清单。
 */
import { describe, expect, it } from "vitest";
import { CANVAS_GROUP_TOOLS } from "@woohaa3/contracts";
import { listModelMcpToolNames } from "./mcp-http.js";
import type { AgentCanvasClient, AgentApplyClientInput } from "../downstream/agent-canvas-client.js";

function agentClient(): AgentCanvasClient {
  return {
    async listCanvases() { return { ok: true, canvases: [] }; },
    async getGraph() { return { ok: false, code: "unavailable", message: "unused" } as never; },
    async getChanges() { return { ok: false, code: "unavailable", message: "unused" } as never; },
    async applyPlan(input: AgentApplyClientInput) { return { ok: true, canvasId: input.canvasId ?? "c", requestId: input.requestId, revision: 1, duplicate: false, noop: false, nodes: [], edges: [] }; },
    async runNode(input: { requestId: string; nodeId: string; canvasId?: string }) { return { ok: true, canvasId: input.canvasId ?? "c", nodeId: input.nodeId, runId: "r", jobId: "j", state: "accepted" }; },
    async getRun() { return { ok: false, code: "unavailable", message: "unused" } as never; },
    async cancelRun(input: { nodeId: string; runId: string; canvasId?: string }) { return { ok: true, canvasId: input.canvasId ?? "c", nodeId: input.nodeId, runId: input.runId, state: "cancel-requested" }; },
    async getOutput() { return { ok: false, code: "unavailable", message: "unused" } as never; },
    async scriptCapability() { return { ok: true, available: true, descriptor: {}, nodeKinds: [] }; },
    async validateScript() { return { ok: true, canvasId: "c", token: "t", expiresAt: 0, summary: { nodes: 0, edges: 0 } } as never; },
    async submitScript() { return { ok: false, code: "unavailable", message: "unused" } as never; },
    async importGeneratedImage() { return { ok: false, code: "unavailable", message: "unused" } as never; }
  };
}

describe("MCP 工具目录", () => {
  it("包含模型与画布组工具，且不含未装配的 world/skill 工具", () => {
    const names = listModelMcpToolNames({
      agentAuthoring: {
        client: agentClient(),
        runAvailability: { available: true },
        principalId: "test"
      }
    });
    expect(names).toEqual(expect.arrayContaining([
      "get_model_api",
      "get_model_node",
      "submit_model_script",
      ...CANVAS_GROUP_TOOLS
    ]));
    expect(names).not.toContain("get_world_context");
    expect(names).not.toContain("wait_for_skill_step");
  });

  it("world 源装配后才出现世界工具", () => {
    const names = listModelMcpToolNames({
      agentAuthoring: {
        client: agentClient(),
        runAvailability: { available: true },
        principalId: "test",
        world: {
          readContext: async () => ({ ok: false, code: "unavailable", message: "unused" }),
          createModel: async () => ({ ok: false, code: "unavailable", message: "unused" }),
          replaceModel: async () => ({ ok: false, code: "unavailable", message: "unused" }),
          moveModel: async () => ({ ok: false, code: "unavailable", message: "unused" }),
          setAnimation: async () => ({ ok: false, code: "unavailable", message: "unused" }),
          resizeArea: async () => ({ ok: false, code: "unavailable", message: "unused" }),
          createCamera: async () => ({ ok: false, code: "unavailable", message: "unused" }),
          setCamera: async () => ({ ok: false, code: "unavailable", message: "unused" }),
          completeCamera: async () => ({ ok: false, code: "unavailable", message: "unused" })
        } as never
      }
    });
    expect(names).toEqual(expect.arrayContaining(["get_world_context", "create_world_model", "set_world_camera", "complete_world_camera"]));
  });
});
