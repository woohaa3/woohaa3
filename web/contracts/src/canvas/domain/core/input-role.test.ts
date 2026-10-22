/**
 * 3D 作者节点的多模态参考角色推断
 * （change: 2026-10-06-fix-model-media-references-and-animation-preview，任务 1.1/1.2）。
 */
import { describe, expect, it } from "vitest";
import { inferWoohaa3CanvasInputRole } from "./input-role.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./composite-asset-identity.js";

function infer(sourceType: string, targetType: string) {
  return inferWoohaa3CanvasInputRole({
    sourceNode: { id: "s", type: sourceType },
    targetNode: { id: "t", type: targetType }
  });
}

describe("3D 节点参考角色推断（任务 1.1）", () => {
  it("video 源对 model3d/composite-asset 推断为 reference_video", () => {
    for (const target of ["model3d", COMPOSITE_ASSET_NODE_TYPE]) {
      expect(infer("video", target), target).toBe("reference_video");
    }
  });

  it("image 源推断 reference_image，audio 源推断 voice_sample", () => {
    for (const target of ["model3d", COMPOSITE_ASSET_NODE_TYPE]) {
      expect(infer("image", target), target).toBe("reference_image");
      expect(infer("audio", target), target).toBe("voice_sample");
    }
  });

  it("text 源始终为 text_prompt", () => {
    expect(infer("text", COMPOSITE_ASSET_NODE_TYPE)).toBe("text_prompt");
  });

  it("视频生成等其它任务节点保留各自规则", () => {
    expect(infer("video", "video")).toBe("reference_video");
    expect(infer("image", "video")).toBe("reference_image");
  });
});
