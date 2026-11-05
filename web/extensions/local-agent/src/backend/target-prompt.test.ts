import { describe, expect, it } from "vitest";
import { buildTargetPrompt } from "./target-prompt.js";

const base = {
  action: "generate" as const,
  canvasId: "canvas-1",
  nodeId: "node-1",
  mode: "model3d" as const,
  prompt: "改成两层楼的建筑"
};

describe("本机 Agent 目标提示词", () => {
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
    expect(prompt).not.toContain("???");
  });

  it("camera 只说明已停用，不再指向片场镜头流程", () => {
    const prompt = buildTargetPrompt({ ...base, mode: "camera", cameraId: "camera-1" }, "req-2");
    expect(prompt).toContain("camera 目标模式已停用");
    expect(prompt).toContain('cameraId="camera-1"');
    expect(prompt).not.toContain("get_film_set_clips");
    expect(prompt).not.toContain("mutate_film_set_clip");
    expect(prompt).not.toContain("update_model_camera");
  });

});
