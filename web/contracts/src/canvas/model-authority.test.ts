/**
 * 权威内容版本归一化与显式目标 ID 测试
 * （change: 2026-10-06-fix-animation3d-runtime-and-authoring，任务 1.1/1.2/1.5）。
 *
 * 覆盖 R2：客户端声明的 hash 不作数，源码/API/placement 的实际内容决定身份；
 * 覆盖 R7：非法模型不被接受；覆盖 R10：显式声明 ID 与自动命名区分。
 */
import { describe, expect, it } from "vitest";
import { normalizeModelDefinition, DEFAULT_MODEL_PLACEMENT } from "./model-definition.js";
import { executeModelScriptV2, executeModelScriptVersioned } from "./model-executor-v2.js";
import { validateSelfContainedModel } from "./model-validity.js";

const SCRIPT = `scene.box({ id: "torso", size: [1, 2, 0.5] });`;

function normalize(overrides: Record<string, unknown> = {}) {
  return normalizeModelDefinition({
    modelScript: SCRIPT,
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    placement: DEFAULT_MODEL_PLACEMENT,
    ...overrides
  });
}

describe("权威内容归一化（任务 1.1/1.2）", () => {
  it("按实际内容派生 hash，忽略客户端声明", () => {
    const first = normalize();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.contentVersion.revision).toBe(1);
    // 传入伪造的旧 revision/hash 不改变按内容派生的身份。
    const forged = normalize({
      previous: { revision: 99, sourceHash: "fake", contentHash: "fake" }
    });
    expect(forged.ok).toBe(true);
    if (!forged.ok) return;
    expect(forged.value.contentVersion.contentHash).toBe(first.value.contentVersion.contentHash);
    expect(forged.value.contentVersion.revision).toBe(100);
  });

  it("无净变化保持 revision，内容变化推进", () => {
    const base = normalize();
    if (!base.ok) throw new Error("base");
    const same = normalize({ previous: base.value.contentVersion });
    if (!same.ok) throw new Error("same");
    expect(same.value.contentVersion.revision).toBe(1);

    const changed = normalize({
      modelScript: `scene.box({ id: "torso", size: [2, 2, 0.5] });`,
      previous: base.value.contentVersion
    });
    if (!changed.ok) throw new Error("changed");
    expect(changed.value.contentVersion.revision).toBe(2);
    expect(changed.value.contentVersion.contentHash).not.toBe(base.value.contentVersion.contentHash);
  });

  it("placement 变化也改变内容标识", () => {
    const base = normalize();
    if (!base.ok) throw new Error("base");

    const placed = normalize({
      placement: { offset: { x: 1, y: 0, z: 0 }, scale: 2, yaw: 0.3 },
      previous: base.value.contentVersion
    });
    if (!placed.ok) throw new Error("placed");
    expect(placed.value.contentVersion.contentHash).not.toBe(base.value.contentVersion.contentHash);
  });

  it("非法模型语言/版本或非法 placement 稳定拒绝", () => {
    expect(normalize({ modelScriptLanguage: "gdscript" }).ok).toBe(false);
    expect(normalize({ placement: { scale: 0 } }).ok).toBe(false);
  });
});

describe("显式声明 ID 与自动命名（任务 1.5 / R10）", () => {
  it("记录作者显式声明的部件 ID", () => {
    const result = executeModelScriptV2(SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.declaredIds]).toEqual(["torso"]);

    const auto = executeModelScriptV2(`scene.box({ size: [1, 1, 1] });`);
    if (!auto.ok) return;
    expect(auto.declaredIds.size).toBe(0);
  });

  it("自动命名 box_1 不被视为显式声明", () => {
    const auto = executeModelScriptV2(`scene.box({ size: [1, 1, 1] });scene.box({ size: [1, 1, 1] });`);
    if (!auto.ok) return;
    expect(auto.declaredIds.has("box_1")).toBe(false);

    const explicit = executeModelScriptV2(`scene.box({ id: "box_1", size: [1, 1, 1] });`);
    if (!explicit.ok) return;
    expect(explicit.declaredIds.has("box_1")).toBe(true);
  });

  it("dispatch 结果携带 declaredIds", () => {
    const result = executeModelScriptVersioned(SCRIPT, "woohaa-model-js-v2");
    expect(result.ok).toBe(true);
    if (!result.ok || !("declaredIds" in result)) return;
    expect([...result.declaredIds]).toEqual(["torso"]);
  });
});

describe("自包含模型可执行性/静态性校验（任务 1.3 / R7）", () => {
  it("合法静态模型通过", () => {
    expect(validateSelfContainedModel(SCRIPT, "woohaa-model-js-v2")).toEqual({ ok: true });
  });

  it("语法非法模型稳定拒绝", () => {
    const result = validateSelfContainedModel("scene.box(", "woohaa-model-js-v2");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code.startsWith("model-script-")).toBe(true);
  });

  it("含旧动画声明的脚本被拒绝并引导迁移", () => {
    const legacy = `scene.box({ id: "b", size: [1,1,1] });\nscene.rotate("b", { axis: "y", speed: 1 });`;
    const result = validateSelfContainedModel(legacy, "woohaa-model-js-v2");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("legacy-animation-in-model");
  });

  it("空运动与合法模型都可执行", () => {
    expect(validateSelfContainedModel(`scene.group({ id: "root" });`, "woohaa-model-js-v2").ok).toBe(true);
  });
});
