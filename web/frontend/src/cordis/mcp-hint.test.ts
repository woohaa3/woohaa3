/**
 * MCP 通用文案与画布/镜头指引单测
 * （change: 2026-09-29-move-mcp-guide-to-bottom-hint；
 *  change: 2026-09-29-split-mcp-hint-by-canvas）。
 */
import { describe, expect, it } from "vitest";
import {
  MCP_HINT_CANVAS_LABEL,
  MCP_HINT_INSTALL_LABEL,
  MCP_HINT_PREFIX,
  mcpCanvasPrompt,
  mcpHintView,
} from "./mcp-hint.js";

describe("mcpHintView", () => {
  it("派生两行：安装 MCP（服务器地址）与操作画布（画布 id）", () => {
    const hint = mcpHintView("https://canvas.example/mcp/model-canvas", "canvas-a");
    expect(hint.label).toBe(MCP_HINT_PREFIX);
    expect(hint.serverUrl).toBe("https://canvas.example/mcp/model-canvas");
    expect(hint.canvasId).toBe("canvas-a");
    expect(hint.lines).toHaveLength(2);
    expect(hint.lines[0]).toEqual({
      label: MCP_HINT_INSTALL_LABEL,
      value: "安装这个 MCP 服务：https://canvas.example/mcp/model-canvas"
    });
    expect(hint.lines[1].label).toBe(MCP_HINT_CANVAS_LABEL);
    expect(hint.lines[1].value).toContain("canvas-a");
    // 不再提「Streamable HTTP 客户端」这类实现细节。
    expect(hint.text).not.toContain("Streamable HTTP");
  });

  it("两行复制文案：安装整句 + 带画布 id 的操作提示词", () => {
    const hint = mcpHintView("https://canvas.example/mcp/model-canvas", "canvas-a");
    expect(hint.installPayload).toBe("安装这个 MCP 服务：https://canvas.example/mcp/model-canvas");
    expect(hint.canvasPayload).toBe(hint.lines[1].value);
    expect(hint.canvasPayload).toContain("canvas-a");
    expect(hint.canvasPayload).toContain("list_model_requests");
  });

  it("画布 id 缺省时操作画布行降级为「当前画布」", () => {
    const hint = mcpHintView("/mcp/model-canvas", "");
    expect(hint.canvasId).toBe("");
    expect(hint.lines[1].value).toContain("当前画布");
    expect(hint.lines[1].value).not.toContain("画布 undefined");
  });

  it("无浏览器地址时降级为相对路径（与 mcp-endpoint 同源）", () => {
    expect(mcpHintView("/mcp/model-canvas").serverUrl).toBe("/mcp/model-canvas");
  });
});

describe("mcpCanvasPrompt", () => {
  it("显式带上画布 id，使多画布下 Agent 明确操作对象", () => {
    expect(mcpCanvasPrompt("c1")).toContain("画布 c1");
    expect(mcpCanvasPrompt("c1")).toContain("get_model_node");
    expect(mcpCanvasPrompt("c1")).toContain("submit_model_script");
  });

  it("空画布 id 使用「当前画布」措辞", () => {
    expect(mcpCanvasPrompt("")).toContain("当前画布");
  });
});
