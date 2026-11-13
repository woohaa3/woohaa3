import { describe, expect, it } from "vitest";
import { ASSISTANT_WORLD_TOOLS, ASSISTANT_WORLD_TOOL } from "@woohaa3/contracts";
import { SCENE_DIRECTOR_FLOW, CAMERA_COMPOSER_FLOW } from "../src/backend/prompts.js";
import { sceneDirectorRole } from "../src/backend/roles/scene-director.js";

const text = sceneDirectorRole.definition.instructions;

describe("导演区资源工具协议", () => {
  it("角色使用当前资源与人物动作工具，不混入旧写入或完成工具", () => {
    expect(sceneDirectorRole.definition.tools.required).toEqual(["get_world_context"]);
    expect([...sceneDirectorRole.definition.tools.required, ...sceneDirectorRole.definition.tools.optional].sort()).toEqual([...ASSISTANT_WORLD_TOOLS, "get_model_api"].sort());
    for (const tool of Object.values(ASSISTANT_WORLD_TOOL)) {
      if (["get_world_context", "sample_scene_animation", "animate_humanoid", "get_humanoid_motion", "generate_humanoid_motion", "apply_humanoid_motion"].includes(tool)) continue;
      expect(text).not.toContain(tool);
    }
    const prepared = sceneDirectorRole.prepare({ input: { prompt: "生成一座大型宫殿", action: "generate" }, context: {},
      target: { canvasId: "canvas", nodeId: "area", mode: "world", worldScope: { kind: "scene-area", areaId: "area-1" } }, requestId: "request", nativeCapabilities: [] });
    expect([...(prepared.tools ?? [])].sort()).toEqual([...ASSISTANT_WORLD_TOOLS, "get_model_api"].sort());
  });

  it("规定骨架、首次创建源码、追加、局部修补和回读的顺序", () => {
    const flow = SCENE_DIRECTOR_FLOW.find(line => line.startsWith("写模型的默认路径"))!;
    const steps = ["建立骨架", "operation=create, expectedParentVersion", "逐次调用 edit_world_model_script（operation=append）", "operation=patch", "最后用 read_world_resource"];
    const indices = steps.map(step => { expect(flow).toContain(step); return flow.indexOf(step); });
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(flow).toContain("只有单个小构件");
    expect(text).toContain("骨架模型在脚本追加之前不参与渲染");
  });

  it("保留版本、原子 patch、幂等和失败段恢复约束", () => {
    for (const rule of ["expectedParentVersion", "operationId", "edits:[{oldString,newString}]", "恰好命中一次", "完整语句块", "宿主不插入分隔符、不重排", "不允许复用旧版本", "只重试失败的那一段", "不要重复写入此前已经成功的段", "patch-not-found", "patch-ambiguous", "reference-conflict"]) expect(text).toContain(rule);
    expect(text).toContain("原脚本、局部行和精确版本必须通过 read_world_resource 获取");
    expect(text).toContain("由宿主核实并自动留档");
  });

  it("单镜头流程查询资源版本，并使用 target 与 patch.settings", () => {
    const camera = CAMERA_COMPOSER_FLOW.join("\n");
    for (const rule of ["read_world_resource", "target.cameraId", "patch.settings", "不能创建或修改模型", "不调用完成工具"]) expect(camera).toContain(rule);
  });
});
