import { describe, expect, it } from "vitest";
import { buildTargetPrompt } from "./target-prompt.js";

describe("canvas-group 生图导入提示", () => {
  it("说明导入工具与 index，且不包含授权 token", () => {
    const prompt = buildTargetPrompt({
      action: "generate",
      mode: "canvas-group",
      canvasId: "canvas-1",
      nodeId: "root-1",
      prompt: "画一张三视图"
    }, "req-1");
    expect(prompt).toContain("import_generated_image");
    expect(prompt).toContain("index");
    expect(prompt).toContain("totalGenerated");
    expect(prompt).not.toMatch(/Bearer|token=/i);
  });
});
