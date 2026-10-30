import { describe, expect, it, vi } from "vitest";
import type { ContentMcpToolContext } from "@woohaa3/contracts";
import { filmSetMcpTools } from "../src/integration/backend/mcp-tools.js";

function tool(name: string) {
  const found = filmSetMcpTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool: ${name}`);
  return found;
}

function context(overrides: Partial<ContentMcpToolContext> = {}): ContentMcpToolContext {
  return {
    extensionId: "film-set",
    permission: "write",
    resolveRoom: async () => null,
    ...overrides
  };
}

describe("片场内容 MCP 工具目录", () => {
  it("从贡献导出完整片场工具面", () => {
    expect(filmSetMcpTools.map((entry) => entry.name)).toEqual([
      "get_film_set_clips",
      "mutate_film_set_clip",
      "submit_film_set",
      "create_film_set_node",
      "import_model_snapshot",
      "mutate_film_set_item",
      "add_film_set_media",
      "export_film_set_clip",
      "get_film_set_export"
    ]);
    expect(tool("get_film_set_clips").permission).toBe("read");
    expect(tool("mutate_film_set_clip").permission).toBe("write");
  });

  it("读取工具只通过可信上下文读节点，并给出空镜头模板", async () => {
    const readNode = vi.fn(async () => ({
      ok: true as const,
      canvasId: "canvas",
      nodeId: "set",
      title: "片场",
      prompt: "",
      source: "",
      references: [],
      cameras: [],
      animation: {
        motionScript: "",
        motionScriptLanguage: "javascript",
        motionScriptVersion: "woohaa-model-js-v2",
        motionRevision: 1,
        motionSourceHash: "motion",
        modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" },
        motionBasedOnModelVersion: { revision: 1, contentHash: "content" },
        initialCamera: { azimuth: 0, elevation: 0.5, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
        timeline: { duration: 0, loop: false },
        filmSetContent: { schemaVersion: 4, items: [] },
        filmSetAnimations: { schemaVersion: 3, defaultClipId: undefined, clips: [] }
      }
    }));
    const result = await tool("get_film_set_clips").handle(
      { canvasId: "canvas", nodeId: "set" },
      context({ readNode: readNode as unknown as ContentMcpToolContext["readNode"] })
    );
    expect(readNode).toHaveBeenCalledWith({ canvasId: "canvas", nodeId: "set" });
    expect(result).toMatchObject({ ok: true, structured: { clipCount: 0 } });
    expect((result as { structured: { missingClipHash: string } }).structured.missingClipHash).toBeTruthy();
  });

  it("片段修改只经通用命令端口提交", async () => {
    const applyCommands = vi.fn(async (_input: { canvasId: string; commandId: string; baseRevision: number; commands: unknown[] }) => ({
      ok: true as const,
      canvasId: "canvas",
      commandId: "film-set-clip:canvas:set:clip:request",
      duplicate: false,
      noop: false
    }));
    const result = await tool("mutate_film_set_clip").handle({
      canvasId: "canvas",
      nodeId: "set",
      clipId: "clip",
      requestId: "request",
      expectedHash: "hash",
      op: { kind: "rename", name: "新镜头" }
    }, context({ applyCommands: applyCommands as unknown as ContentMcpToolContext["applyCommands"] }));
    expect(result.ok).toBe(true);
    expect(applyCommands).toHaveBeenCalledTimes(1);
    expect(applyCommands.mock.calls[0]?.[0]).toMatchObject({
      canvasId: "canvas",
      commandId: "film-set-clip:canvas:set:clip:request",
      baseRevision: 0
    });
  });
});
