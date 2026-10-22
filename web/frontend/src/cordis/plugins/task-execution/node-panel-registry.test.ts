/**
 * 节点类型 → 面板映射测试（任务 3.3）。
 *
 * 覆盖图片、文本、其它类型、无选中（undefined/null）四种情况。
 */
import { describe, expect, it } from "vitest";
import { modelTypeForPanelKind,
  nodeTypeForPanelKind,
  panelKindForNodeType } from "./node-panel-registry.js";

describe("panelKindForNodeType", () => {
  it("image 映射到 image-generation", () => {
    expect(panelKindForNodeType("image")).toBe("image-generation");
  });

  it("text 映射到 text-generation", () => {
    expect(panelKindForNodeType("text")).toBe("text-generation");
  });

  it("其它节点类型没有执行入口", () => {
    for (const type of ["model3d", "composite-asset", "generate", "edit", "shot", "start", ""]) {
      expect(panelKindForNodeType(type)).toBeNull();
    }
  });

  it("video / audio 映射到对应面板", () => {
    expect(panelKindForNodeType("video")).toBe("video-generation");
    expect(panelKindForNodeType("audio")).toBe("audio-generation");
  });

  it("无选中（null / undefined）时为 null", () => {
    expect(panelKindForNodeType(null)).toBeNull();
    expect(panelKindForNodeType(undefined)).toBeNull();
  });
});

describe("反向映射", () => {
  it("image-generation → image，text-generation → text", () => {
    expect(nodeTypeForPanelKind("image-generation")).toBe("image");
    expect(nodeTypeForPanelKind("text-generation")).toBe("text");
  });

  it("模型类型与节点类型一一对应", () => {
    expect(modelTypeForPanelKind("image-generation")).toBe("image");
    expect(modelTypeForPanelKind("text-generation")).toBe("language");
    expect(modelTypeForPanelKind("video-generation")).toBe("video");
    expect(modelTypeForPanelKind("audio-generation")).toBe("audio");
  });

  it("反向映射覆盖四类", () => {
    expect(nodeTypeForPanelKind("video-generation")).toBe("video");
    expect(nodeTypeForPanelKind("audio-generation")).toBe("audio");
  });
});
