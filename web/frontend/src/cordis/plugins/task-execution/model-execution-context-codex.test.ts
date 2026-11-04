import { describe, expect, it } from "vitest";
import { canvasFixture } from "./test-support/fixtures.js";
import { resolveModelExecutionContext } from "./model-execution-context.js";

describe("Codex 成品图的执行面板", () => {
  it("带成品标记的图片节点不打开生成面板", () => {
    const canvas = canvasFixture({
      nodes: [{ id: "img-codex", type: "image", data: { codexImageImport: true, outputAssetId: "asset-1" } }]
    });
    expect(resolveModelExecutionContext(canvas, "img-codex")).toBeNull();
  });

  it("普通图片节点仍打开生成面板", () => {
    const canvas = canvasFixture({
      nodes: [{ id: "img-1", type: "image", data: { prompt: "一只猫" } }]
    });
    expect(resolveModelExecutionContext(canvas, "img-1")?.panelKind).toBe("image-generation");
  });
});
