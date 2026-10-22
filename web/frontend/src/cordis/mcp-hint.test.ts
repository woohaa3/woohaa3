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
  cameraMcpGuide,
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

describe("cameraMcpGuide（change: add-model-camera-mcp-crud）", () => {
  it("列出镜头读工具、单条 CRUD 工具与整体替换工具", () => {
    const guide = cameraMcpGuide("c1", "m1");
    expect(guide).toContain("get_model_cameras");
    expect(guide).toContain("create_model_camera");
    expect(guide).toContain("update_model_camera");
    expect(guide).toContain("delete_model_camera");
    expect(guide).toContain("rename_model_camera");
    expect(guide).toContain("reset_model_camera");
    expect(guide).toContain("set_model_camera");
    expect(guide).toContain("requestId");
    expect(guide).toContain("elevation");
  });

  it("带上画布 id 与节点 id，且不内嵌服务器地址（与模型节点指引同一约定）", () => {
    const guide = cameraMcpGuide("c1", "m1");
    expect(guide).toContain("画布 c1");
    expect(guide).toContain("节点 m1");
    // 指引文本不携带 MCP 服务器地址；地址由面板单独的只读字段承载。
    expect(guide).not.toContain("http");
    expect(guide).not.toContain("/mcp/");
  });

  it("列出全部镜头 id/名称并标识当前选中镜头", () => {
    const cameras = [
      { id: "cam-a", name: "正面" },
      { id: "cam-b", name: "蚂蚁视角" }
    ];
    const guide = cameraMcpGuide("c1", "m1", cameras, "cam-b");
    expect(guide).toContain("cam-a（正面）");
    expect(guide).toContain("cam-b（蚂蚁视角）");
    expect(guide).toContain("当前选中镜头：cam-b");
  });

  it("切换选中镜头时指引不同（随选中变化）", () => {
    const cameras = [{ id: "cam-a", name: "正面" }, { id: "cam-b", name: "蚂蚁视角" }];
    const a = cameraMcpGuide("c1", "m1", cameras, "cam-a");
    const b = cameraMcpGuide("c1", "m1", cameras, "cam-b");
    expect(a).not.toBe(b);
    expect(a).toContain("当前选中镜头：cam-a");
    expect(b).toContain("当前选中镜头：cam-b");
  });

  it("无镜头时省略镜头列表，不出现 undefined", () => {
    const guide = cameraMcpGuide("c1", "m1");
    expect(guide).not.toContain("现有镜头：");
    expect(guide).not.toContain("undefined");
  });

  it("空画布 id 使用「节点」措辞且不出现 undefined", () => {
    const guide = cameraMcpGuide("", "m1");
    expect(guide).toContain("节点 m1");
    expect(guide).not.toContain("画布 undefined");
  });
});
