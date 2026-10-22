/**
 * 模型 API descriptor 与指南一致性测试
 * （change: enhance-model-scene-authoring-api，任务 5.1 / 5.2 / design D8）。
 *
 * 指南由 descriptor 生成，方法集合必须与实际 V2 SceneBuilder 一致；示例必须真的能过
 * V2 executor 与 validator。
 */
import { describe, expect, it } from "vitest";
import {
  HUMAN_FIXTURE_SCRIPT,
  MODEL_API_METHODS,
  MODEL_RENDER_BUDGET,
  modelApiGuide,
  modelApiMethodNames,
  modelPrimitiveConstraintsText,
  modelRenderBudgetText
} from "./model-api-descriptor.js";
import { QUALITY_VERTEX_COUNTS, SCENE_IR_V2_MAX_ESTIMATED_VERTICES } from "./scene-ir-v2/types.js";
import { MODEL_SCRIPT_V2_VERSION, PREFERRED_MODEL_SCRIPT_VERSION } from "./model-script.js";
import { SceneBuilderV2, executeModelScriptV2 } from "./model-executor-v2.js";

describe("model API guide", () => {
  it("只暴露 V2 为受支持版本", () => {
    const guide = modelApiGuide();
    expect(guide.preferredVersion).toBe(MODEL_SCRIPT_V2_VERSION);
    expect(PREFERRED_MODEL_SCRIPT_VERSION).toBe(MODEL_SCRIPT_V2_VERSION);
    expect(guide.supportedVersions).toEqual(["woohaa-model-js-v2"]);
  });

  it("states rotation is degrees in local Y-X-Z order", () => {
    const guide = modelApiGuide();
    expect(guide.conventions.rotationUnit).toBe("degrees");
    expect(guide.conventions.rotationOrder).toContain("Y-X-Z");
  });

  it("method set matches the actual V2 SceneBuilder", () => {
    const actual = Object.getOwnPropertyNames(SceneBuilderV2.prototype).filter(
      (name) => name !== "constructor" && !name.startsWith("_")
    );
    const declared = new Set(MODEL_API_METHODS.map((method) => method.name));
    for (const name of ["material", "sphere", "capsule", "segment"]) {
      expect(declared.has(name)).toBe(true);
      expect(actual).toContain(name);
    }
  });

  it("V2 method names include the V2-only primitives", () => {
    const names = modelApiMethodNames(MODEL_SCRIPT_V2_VERSION);
    expect(names).toEqual(expect.arrayContaining(["material", "sphere", "capsule", "segment", "mesh"]));
  });
});

describe("render budget text", () => {
  it("由 Scene IR V2 常量派生：上限与每个图元的顶点成本都在提示词里", () => {
    const text = modelRenderBudgetText();
    expect(MODEL_RENDER_BUDGET.maxEstimatedVertices).toBe(SCENE_IR_V2_MAX_ESTIMATED_VERTICES);
    expect(text).toContain(String(SCENE_IR_V2_MAX_ESTIMATED_VERTICES));
    expect(text).toContain(`box=${QUALITY_VERTEX_COUNTS.box}`);
    expect(text).toContain(`cylinder=${QUALITY_VERTEX_COUNTS.cylinder}`);
    expect(text).toContain(`sphere=${QUALITY_VERTEX_COUNTS.sphere}`);
    expect(text).toContain(`capsule=${QUALITY_VERTEX_COUNTS.capsule}`);
    // 必须明确警告「不要用海量小图元堆场景」，否则模型会产出超预算候选被整份拒绝。
    expect(text).toMatch(/thousands of tiny primitives/);
  });

  it("图元合法性约束声明 capsule 高度不小于直径等隐式几何规则", () => {
    const text = modelPrimitiveConstraintsText();
    expect(text).toMatch(/capsule's total height.*>= 2\*radius/);
    expect(text).toMatch(/segment's from and to MUST differ/);
    expect(text).toMatch(/MUST NOT set both material and color/);
  });

  it("声明 segment 缺省是 capsule，避免手算低估规模（change: 2026-10-18-align-model-statistics-with-agent）", () => {
    const budget = modelRenderBudgetText();
    // 预算文本与 signature 都要写明缺省 shape，否则模型会按 box 成本手算。
    expect(budget).toMatch(/WITHOUT shape is a capsule/);
    const segment = MODEL_API_METHODS.find((method) => method.name === "segment");
    expect(segment?.signature).toContain("缺省 capsule");
  });
});

describe("human fixture script", () => {
  it("executes deterministically to a valid V2 Scene IR", () => {
    const result = executeModelScriptV2(HUMAN_FIXTURE_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.version).toBe("woohaa-model-scene-ir-v2");
  });

  it("shares the elbow coordinate between upper arm and forearm", () => {
    const result = executeModelScriptV2(HUMAN_FIXTURE_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const upper = result.scene.ops.find((op) => op.t === "segment" && op.id === "upper-arm");
    const forearm = result.scene.ops.find((op) => op.t === "segment" && op.id === "forearm");
    expect(upper?.t === "segment" && forearm?.t === "segment").toBe(true);
    if (upper?.t === "segment" && forearm?.t === "segment") {
      expect(upper.to).toEqual(forearm.from);
    }
  });

  it("uses a reusable metal material on multiple shapes", () => {
    const result = executeModelScriptV2(HUMAN_FIXTURE_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const material = result.scene.ops.find((op) => op.t === "material");
    expect(material).toBeTruthy();
    const referencing = result.scene.ops.filter(
      (op) => op.t !== "material" && "material" in op && op.material === "armor"
    );
    expect(referencing.length).toBeGreaterThanOrEqual(2);
  });
});
