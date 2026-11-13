/**
 * `model3d` 能力解析：受支持形态只有共享世界实例，旧卡片只保留结构诊断
 * （change: 2026-11-10-remove-legacy-model-card-nodes）。
 */
import { describe, expect, it } from "vitest";
import { builtinNodeCapabilityResolver, hasSharedWorldInstance, legacyDiagnosticCardBodyFor } from "./builtin-node-capabilities.js";
import { LEGACY_MODEL_CARD_BODY } from "./render-scene/scene-builder.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { newWorldInstance } from "./creation-scopes-ui.js";

const canvas = createEmptyWoohaa3ServerCanvas("capabilities");
const node = { id: "m", type: "model3d" } as const;
const context = (data: Record<string, unknown> | undefined) => ({ canvas, node, data: data as never });
const worldData = { sharedWorldInstance: newWorldInstance("instance-m", { x: 0, y: 0 }) };

describe("model3d 能力解析", () => {
  it("世界模型提供准备、世界驻留、聚焦与动作", () => {
    const capabilities = builtinNodeCapabilityResolver.resolve(context(worldData));
    expect(capabilities.modelPreparation).toBeDefined();
    expect(capabilities.resources).toMatchObject({ channel: "model" });
    expect(capabilities.focus?.kind(context(worldData))).toBe("model");
    expect(capabilities.actions?.accepts(context(worldData))).toBe(true);
    // 卡片预览、卡片尺寸抓手与预览渲染槽已删除。
    expect(capabilities).not.toHaveProperty("modelPreview");
    expect(capabilities).not.toHaveProperty("resize");
    expect(capabilities.resources).not.toHaveProperty("previewSlot");
  });

  it("旧卡片模型不提供模型准备、预览、聚焦、动作或缩放", () => {
    const legacy = builtinNodeCapabilityResolver.resolve(context({ modelScript: "scene.box({id:'a'});" }));
    expect(legacy.modelPreparation).toBeUndefined();
    expect(legacy.resources).toBeUndefined();
    expect(legacy.focus).toBeUndefined();
    expect(legacy.actions).toBeUndefined();
    expect(legacy.resize).toBeUndefined();
    expect(legacy).not.toHaveProperty("modelPreview");
    expect(hasSharedWorldInstance(context({}))).toBe(false);
    expect(hasSharedWorldInstance(context(worldData))).toBe(true);
  });

  it("诊断正文与 Render Scene 投影一致", () => {
    expect(legacyDiagnosticCardBodyFor(node, context({}))).toBe(LEGACY_MODEL_CARD_BODY);
    expect(legacyDiagnosticCardBodyFor(node, context(worldData))).toBeNull();
    expect(legacyDiagnosticCardBodyFor({ type: "text" }, context({}))).toBeNull();
    expect(LEGACY_MODEL_CARD_BODY).toContain("旧版 3D 模型卡片已不再支持");
  });
});
