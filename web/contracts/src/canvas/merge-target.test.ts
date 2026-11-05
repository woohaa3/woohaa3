import { describe, expect, it } from "vitest";
import {
  MERGE_TARGET_CENTER_RATIO,
  isMergeEligibleNode,
  isMergeableNodeType,
  resolveMergeTarget,
  type MergeTargetCandidate
} from "./merge-target.js";

function candidate(
  nodeId: string,
  x: number,
  y: number,
  width = 200,
  height = 200,
  type = "image"
): MergeTargetCandidate {
  return { nodeId, type, x, y, width, height };
}

describe("resolveMergeTarget", () => {
  it("中心落在目标完整矩形内即命中", () => {
    expect(MERGE_TARGET_CENTER_RATIO).toBe(1);
    // 目标 (0,0,200,200)，完整命中半宽 100、半高 100。
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 100, y: 100 }, candidates: [candidate("t", 0, 0)] }))
      .toMatchObject({ nodeId: "t", distance: 0 });
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 199, y: 1 }, candidates: [candidate("t", 0, 0)] }))
      .toMatchObject({ nodeId: "t" });
  });

  it("边缘之外不命中：恰好等于阈值命中，超出 1px 不命中", () => {
    const half = 200 * MERGE_TARGET_CENTER_RATIO / 2;
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 100 + half, y: 100 }, candidates: [candidate("t", 0, 0)] }))
      .not.toBeNull();
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 100 + half + 1, y: 100 }, candidates: [candidate("t", 0, 0)] }))
      .toBeNull();
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 100, y: 100 + half + 1 }, candidates: [candidate("t", 0, 0)] }))
      .toBeNull();
  });

  it("类型不同不命中", () => {
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 100, y: 100 }, candidates: [candidate("t", 0, 0, 200, 200, "video")] }))
      .toBeNull();
  });

  it("多候选取中心最近者", () => {
    const result = resolveMergeTarget({
      sourceType: "image",
      center: { x: 110, y: 100 },
      candidates: [candidate("far", 100, 0), candidate("near", 0, 0)]
    });
    expect(result?.nodeId).toBe("near");
  });

  it("距离相同时按文档顺序取后者（视觉上层）", () => {
    // 两个目标中心都在 (100,100)，距离同为 10。
    const result = resolveMergeTarget({
      sourceType: "image",
      center: { x: 110, y: 100 },
      candidates: [candidate("lower", 0, 0), candidate("upper", 0, 0)]
    });
    expect(result?.nodeId).toBe("upper");
  });

  it("排除了拖动节点自身", () => {
    expect(resolveMergeTarget({
      sourceType: "image",
      center: { x: 100, y: 100 },
      candidates: [candidate("source", 0, 0)],
      excludeNodeIds: new Set(["source"])
    })).toBeNull();
  });

  it("退化矩形与非有限值不命中", () => {
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 0, y: 0 }, candidates: [candidate("zero", 0, 0, 0, 0)] }))
      .toBeNull();
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 0, y: 0 }, candidates: [candidate("negative", 0, 0, -10, 200)] }))
      .toBeNull();
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 0, y: 0 }, candidates: [candidate("nan", Number.NaN, 0)] }))
      .toBeNull();
    expect(resolveMergeTarget({ sourceType: "image", center: { x: Number.POSITIVE_INFINITY, y: 0 }, candidates: [candidate("t", 0, 0)] }))
      .toBeNull();
  });

  it("空候选返回 null", () => {
    expect(resolveMergeTarget({ sourceType: "image", center: { x: 0, y: 0 }, candidates: [] })).toBeNull();
  });
});

describe("合并节点资格", () => {
  it("v1 只放开 text/image/video/audio/model3d", () => {
    for (const type of ["text", "image", "video", "audio", "model3d"]) {
      expect(isMergeableNodeType(type)).toBe(true);
      expect(isMergeEligibleNode({ node: { id: `${type}-1`, type }, data: {} })).toBe(true);
    }
    for (const type of ["composite-asset", "group", "film-set-shot-preview"]) {
      expect(isMergeableNodeType(type)).toBe(false);
      expect(isMergeEligibleNode({ node: { id: `${type}-1`, type }, data: {} })).toBe(false);
    }
  });

  it("托管节点不可参与", () => {
    expect(isMergeEligibleNode({
      node: { id: "managed", type: "model3d" },
      data: { managedBy: { schemaVersion: 1, extensionId: "demo", ownerNodeId: "set", entityId: "e1", lifecycle: "owner-managed" } }
    })).toBe(false);
  });
});
