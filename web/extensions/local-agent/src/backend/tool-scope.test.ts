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

  it("camera 不授予模型脚本写工具", () => {
    const tools = localAgentToolsForMode("camera");
    expect(tools).toEqual(expect.arrayContaining(["get_model_cameras", "update_model_camera", "set_model_camera"]));
    expect(tools).not.toContain("submit_model_script");
    expect(tools).not.toContain("mutate_film_set_clip");
  });

  it("film-set 授予片段与模型写工具，不授予镜头写工具", () => {
    const tools = localAgentToolsForMode("film-set");
    expect(tools).toEqual(expect.arrayContaining(["get_model_api", "get_film_set_clips", "mutate_film_set_clip", "submit_film_set", "import_model_snapshot"]));
    expect(tools).not.toContain("submit_model_script");
    expect(tools).not.toContain("submit_model_scripts");
    expect(tools).not.toContain("update_model_camera");
  });
});
