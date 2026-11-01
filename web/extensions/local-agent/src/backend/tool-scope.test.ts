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


  it("模型目标不授予片场专属工具", () => {
    const tools = localAgentToolsForMode("model3d");
    for (const removed of ["submit_film_set", "add_film_set_media", "export_film_set_clip", "mutate_film_set_clip", "get_film_set_clips"]) {
      expect(tools).not.toContain(removed);
    }
  });
});
