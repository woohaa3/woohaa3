import { describe, expect, it } from "vitest";
import { resolveBlockingReasons } from "./node-panel-helpers.js";
import { catalogFixture, canvasFixture } from "./test-support/fixtures.js";

const MODEL = catalogFixture([{ modelKey: "m", modelType: "image" }]).models[0]!;
const catalog = () => catalogFixture([MODEL]);

describe("模型选择恢复", () => {
  it("显式选择优先于已生成模型，未提交 prompt/参数不影响恢复", async () => {
    const { resolveSelectedModelKey } = await import("./node-panel-helpers.js");
    expect(resolveSelectedModelKey({ nodeData: { preferredModelKey: "chosen", modelKey: "old", parameters: { model: "old" } }, draftParameters: undefined, models: [MODEL], defaultModelKey: "m" })).toBe("chosen");
    expect(resolveSelectedModelKey({ nodeData: { modelKey: "old" }, draftParameters: undefined, models: [MODEL], defaultModelKey: "m" })).toBe("old");
  });
  it("模型下线保留原身份并明确阻止执行", () => {
    const canvas = canvasFixture({ nodes: [{ id: "target", type: "image", data: {} }], edges: [] });
    expect(resolveBlockingReasons({ panelKind: "image-generation", nodeId: "target", disabledReason: null, pendingSelection: false, catalog: catalog(), catalogState: { status: "ready", catalog: catalog() }, model: "removed", canvas, panelParameters: {} })).toContain("所选模型 removed 当前不可用，请重新选择模型");
  });
});
