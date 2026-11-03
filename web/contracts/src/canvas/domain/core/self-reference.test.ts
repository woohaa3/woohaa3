import { describe, expect, it } from "vitest";
import { SELF_REFERENCE_ASSET_FIELD, selfReferenceMapping } from "./input-slots";

describe("selfReferenceMapping", () => {
  it("有资产 id 时合成一条指向自己的主图映射，固定到该资产", () => {
    const mapping = selfReferenceMapping("n1", { [SELF_REFERENCE_ASSET_FIELD]: "asset-1" });
    expect(mapping).toMatchObject({ sourceNodeId: "n1", sourceAssetIds: ["asset-1"], role: "reference_image", label: "主图像" });
    expect(mapping?.slotId).toBeTruthy();
  });

  it("缺失、空串或非字符串都视为没有", () => {
    expect(selfReferenceMapping("n1", undefined)).toBeNull();
    expect(selfReferenceMapping("n1", {})).toBeNull();
    expect(selfReferenceMapping("n1", { [SELF_REFERENCE_ASSET_FIELD]: "" })).toBeNull();
    expect(selfReferenceMapping("n1", { [SELF_REFERENCE_ASSET_FIELD]: 3 })).toBeNull();
  });
});
