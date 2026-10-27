import { describe, expect, it } from "vitest";
import { localAgentToolsForMode } from "./tool-scope.js";

describe("本机 Agent 工具面", () => {
  it("model3d 使用真实 MCP 读写工具，不使用抽象 read_node/write_node", () => {
    const tools = localAgentToolsForMode("model3d");
    expect(tools).toEqual(expect.arrayContaining(["get_model_api", "get_model_node", "get_model_statistics", "submit_model_script"]));
    expect(tools).not.toContain("read_node");
    expect(tools).not.toContain("write_node");
    expect(tools).not.toContain("get_model_nodes");
    expect(tools).not.toContain("list_model_requests");
    expect(tools).not.toContain("render_model_preview");
  });

  it("camera 已停用，不再发放任何工具", () => {
    expect(localAgentToolsForMode("camera")).toEqual([]);
  });

  it("film-set 授予片段与模型写工具，不授予镜头写工具", () => {
    const tools = localAgentToolsForMode("film-set");
    expect(tools).toEqual(expect.arrayContaining(["get_model_api", "get_film_set_clips", "mutate_film_set_clip", "submit_film_set", "import_model_snapshot"]));
    expect(tools).not.toContain("submit_model_script");
    expect(tools).not.toContain("submit_model_scripts");
    expect(tools).toEqual(expect.arrayContaining(["add_film_set_media", "export_film_set_clip", "get_film_set_export"]));
    expect(tools).not.toContain("update_model_camera");
  });

  it("只有 film-set 模式可导出成片", () => {
    expect(localAgentToolsForMode("model3d")).not.toContain("export_film_set_clip");
    expect(localAgentToolsForMode("camera")).not.toContain("add_film_set_media");
  });

  it("canvas-group 包含通用六类节点创建与片场编辑工具", () => {
    const tools = localAgentToolsForMode("canvas-group");
    expect(tools).toEqual(expect.arrayContaining([
      "create_canvas_node",
      "submit_canvas_script",
      "submit_model_script",
      "submit_film_set",
      "add_film_set_media",
      "mutate_film_set_item",
      "mutate_film_set_clip"
    ]));
  });
});
