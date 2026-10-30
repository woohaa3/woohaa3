import { describe, expect, it } from "vitest";
import type { ContentAgentTarget } from "@woohaa3/contracts";
import { buildTargetPrompt } from "./target-prompt.js";

const base = {
  action: "generate" as const,
  canvasId: "canvas-1",
  nodeId: "node-1",
  mode: "model3d" as const,
  prompt: "改成两层楼的建筑"
};

const businessTarget: ContentAgentTarget = {
  extensionId: "film-set",
  mode: "film-set",
  readTools: [],
  writeTools: [],
  prompt: [
    "业务目标先读取 get_film_set_clips。",
    "用 submit_film_set 保存 expectedSnapshotHash，并用 mutate_film_set_clip 创建镜头。",
    "sceneCamera 只是无拍摄镜头时的回退构图。"
  ],
  events: ["film-set"],
  hashArgs: ["expectedSnapshotHash", "expectedClipHash"]
};

describe("本机 Agent 目标提示词", () => {
  it("组创作明确描述根组范围与画布脚本，不夹带具体业务提交流程", () => {
    const prompt = buildTargetPrompt({ ...base, mode: "canvas-group" }, "group-turn");
    expect(prompt).toContain("本轮会话配置远程 MCP");
    expect(prompt).toContain("nodeId 是本轮授权的根组");
    expect(prompt).toContain("get_canvas_script_api");
    expect(prompt).toContain("submit_canvas_script");
    expect(prompt).toContain("能力目录中的扩展工具");
    expect(prompt).not.toContain("新片场默认没有拍摄镜头");
    expect(prompt).not.toContain("submit_film_set");
    expect(prompt).not.toContain("???");
  });

  it("model3d 注入冻结目标、真实工具名与写入约束", () => {
    const prompt = buildTargetPrompt({ ...base, expectedContentHash: "hash-1" }, "req-1");
    expect(prompt).toContain('canvasId="canvas-1"');
    expect(prompt).toContain('nodeId="node-1"');
    expect(prompt).toContain('mode="model3d"');
    expect(prompt).toContain("get_model_api");
    expect(prompt).toContain("get_model_node");
    expect(prompt).toContain("submit_model_script");
    expect(prompt).toContain("get_model_statistics");
    expect(prompt).toContain("自行推算");
    expect(prompt).toContain("hash-1");
    expect(prompt).toContain('requestId="req-1"');
    expect(prompt).toContain("不要要求用户上传图片或模型文件");
    expect(prompt).toContain("改成两层楼的建筑");
  });

  it("camera 只说明已停用，不再泄漏具体业务工具", () => {
    const prompt = buildTargetPrompt({ ...base, mode: "camera", cameraId: "camera-1" }, "req-2");
    expect(prompt).toContain("camera 目标模式已停用");
    expect(prompt).toContain('cameraId="camera-1"');
    expect(prompt).not.toContain("get_film_set_clips");
    expect(prompt).not.toContain("mutate_film_set_clip");
    expect(prompt).not.toContain("update_model_camera");
    expect(prompt).not.toContain("submit_model_script 提交完整脚本");
  });

  it("业务目标追加 owner 描述符提示词，同时带上 clip/item", () => {
    const prompt = buildTargetPrompt({ ...base, mode: "film-set", clipId: "clip-1", itemId: "item-1" }, "req-3", [businessTarget]);
    expect(prompt).toContain('clipId="clip-1"');
    expect(prompt).toContain('itemId="item-1"');
    expect(prompt).toContain("film-set 的「film-set」目标");
    expect(prompt).toContain("get_film_set_clips");
    expect(prompt).toContain("submit_film_set");
    expect(prompt).toContain("mutate_film_set_clip");
    expect(prompt).toContain("sceneCamera 只是无拍摄镜头时的回退构图");
  });

  it("未激活的业务 mode 稳定 fail closed，不退回 model3d 提示词", () => {
    const prompt = buildTargetPrompt({ ...base, mode: "npc-production" }, "req-4", [businessTarget]);
    expect(prompt).toContain("未被任何激活扩展公布");
    expect(prompt).not.toContain("先调用 get_model_api 了解当前脚本 API");
    expect(prompt).not.toContain("submit_film_set");
  });
});
