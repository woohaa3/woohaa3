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
  it("组创作明确描述根组范围、画布脚本与远程 MCP，不发送损坏的问号占位文案", () => {
    const prompt = buildTargetPrompt({ ...base, mode: "canvas-group" }, "group-turn");
    expect(prompt).toContain("本轮会话配置远程 MCP");
    expect(prompt).toContain("nodeId 是本轮授权的根组");
    expect(prompt).toContain("get_canvas_script_api");
    expect(prompt).toContain("submit_canvas_script");
    expect(prompt).toContain("新片场默认没有拍摄镜头");
    expect(prompt).toContain("sceneCamera 只是无镜头时的回退构图");
    expect(prompt).toContain("clipTemplate");
    expect(prompt).toContain("mutate_film_set_clip");
    expect(prompt).toContain("clips 非空");
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

  it("camera 只说明已停用并指向 film-set 镜头流程", () => {
    const prompt = buildTargetPrompt({ ...base, mode: "camera", cameraId: "camera-1" }, "req-2");
    expect(prompt).toContain("camera 目标模式已停用");
    expect(prompt).toContain("get_film_set_clips");
    expect(prompt).toContain("mutate_film_set_clip");
    expect(prompt).toContain('cameraId="camera-1"');
    expect(prompt).not.toContain("update_model_camera");
    expect(prompt).not.toContain("submit_model_script 提交完整脚本");
  });

  it("film-set 描述片段与绑定工具，同时带上 clip/item", () => {
    const prompt = buildTargetPrompt({ ...base, mode: "film-set", clipId: "clip-1", itemId: "item-1" }, "req-3");
    expect(prompt).toContain('clipId="clip-1"');
    expect(prompt).toContain('itemId="item-1"');
    expect(prompt).toContain("get_film_set_clips");
    expect(prompt).toContain("mutate_film_set_clip");
    expect(prompt).toContain("submit_film_set");
    expect(prompt).toContain("expectedSnapshotHash");
    expect(prompt).toContain("片场只有地面或为空也能生成");
    expect(prompt).toContain("sceneCamera 只是无拍摄镜头时的回退构图");
    expect(prompt).toContain("submit_film_set 不会自动创建镜头");
    expect(prompt).toContain("clipTemplate");
    expect(prompt).toContain('op.kind="create"');
    expect(prompt).toContain("clips 非空");
    expect(prompt).not.toContain("用 submit_model_script 提交完整脚本");
  });
});
