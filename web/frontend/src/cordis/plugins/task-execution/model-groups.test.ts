import { describe, expect, it } from "vitest";
import { isInternalModel, modelGroupLabel } from "./model-groups.js";

describe("model-groups", () => {
  it("已知分类给系列名,未知或缺失给 undefined", () => {
    expect(modelGroupLabel({ category: "image-21" })).toBe("Banana2.1");
    expect(modelGroupLabel({ category: "nope" })).toBeUndefined();
    expect(modelGroupLabel(undefined)).toBeUndefined();
  });
  it("内部模板不出现在用户的模型下拉里", () => {
    expect(isInternalModel({ category: "sixi-internal" })).toBe(true);
    expect(isInternalModel({ category: "image-21" })).toBe(false);
    expect(isInternalModel(undefined)).toBe(false);
  });
});
