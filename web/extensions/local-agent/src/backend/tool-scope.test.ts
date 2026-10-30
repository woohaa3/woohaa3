import { describe, expect, it } from "vitest";
import type { ContentAgentTarget } from "@woohaa3/contracts";
import { localAgentToolsForMode } from "./tool-scope.js";

const filmSetTarget: ContentAgentTarget = {
  extensionId: "film-set",
  mode: "film-set",
  readTools: ["get_model_api", "get_model_node", "get_film_set_clips", "get_film_set_export"],
  writeTools: ["submit_film_set", "mutate_film_set_item", "mutate_film_set_clip", "add_film_set_media", "export_film_set_clip", "create_film_set_node", "import_model_snapshot"],
  prompt: [],
  events: ["film-set"],
  hashArgs: ["expectedSnapshotHash", "expectedClipHash"]
};

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

  it("业务目标只使用激活扩展描述符里的工具，不在共享内核硬编码 film-set", () => {
    expect(localAgentToolsForMode("film-set")).toEqual([]);
    const tools = localAgentToolsForMode("film-set", [filmSetTarget]);
    expect(tools).toEqual(expect.arrayContaining(["get_model_api", "get_film_set_clips", "mutate_film_set_clip", "submit_film_set", "import_model_snapshot"]));
    expect(tools).not.toContain("submit_model_script");
    expect(tools).not.toContain("submit_model_scripts");
    expect(tools).toEqual(expect.arrayContaining(["add_film_set_media", "export_film_set_clip", "get_film_set_export"]));
    expect(tools).not.toContain("update_model_camera");
  });

  it("停用或未注册的业务 mode 稳定为空，不退回模型工具", () => {
    expect(localAgentToolsForMode("npc-production", [filmSetTarget])).toEqual([]);
  });

  it("只有 film-set 描述符可导出成片", () => {
    expect(localAgentToolsForMode("model3d")).not.toContain("export_film_set_clip");
    expect(localAgentToolsForMode("camera", [filmSetTarget])).not.toContain("add_film_set_media");
  });

  it("canvas-group 保留通用画布与模型工具，业务工具由描述符另行声明", () => {
    const tools = localAgentToolsForMode("canvas-group");
    expect(tools).toEqual(expect.arrayContaining([
      "create_canvas_node",
      "submit_canvas_script",
      "submit_model_script"
    ]));
  });
});
