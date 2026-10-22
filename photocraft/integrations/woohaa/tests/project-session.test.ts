/**
 * 工程本地会话测试
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/3.3/3.7）。
 *
 * 覆盖：装配/退出/取消/历史只读切换的无渲染状态、v1 → 工程转换与超限回退、
 * 未保存标注切换保留净变化、project 禁止旧标注保存、基线推进与失败保留现场。
 * 不涉及 GPU 渲染（渲染按 verification 第 1–9 项人工验收）。
 */
import { describe, expect, it } from "vitest";
import { IMAGE_PROJECT_CONTENT_TYPE, PHOTOCRAFT_ENGINE_VERSION, type LegacyImageEditDocument } from "@woohaa3/contracts";
import { ProjectSession, isSupportedProject } from "../src/project-session.js";

const HASH_A = "a".repeat(64);

function annotation(shapes = 1): LegacyImageEditDocument {
  return {
    version: "woohaa-image-edit-v1",
    baseAssetId: "asset-base",
    sourceWidth: 1024,
    sourceHeight: 768,
    shapes: Array.from({ length: shapes }, (_, index) => ({
      id: `s${index}`,
      tool: "pen" as const,
      color: "#ff3b30",
      widthInSourcePixels: 2,
      points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]
    }))
  };
}

function projectDoc(overrides: Record<string, unknown> = {}) {
  return {
    version: "woohaa-image-project-v1" as const,
    engine: "photocraft" as const,
    engineVersion: PHOTOCRAFT_ENGINE_VERSION,
    formatVersion: 1,
    baseAssetId: "asset-base",
    sourceWidth: 1024,
    sourceHeight: 768,
    canvasWidth: 800,
    canvasHeight: 600,
    documentContentHash: "0123456789abcdef",
    project: { storageKey: `sha256-${HASH_A}`, checksum: HASH_A, contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 4096 },
    sourceAssetIds: ["asset-base"],
    ...overrides
  };
}

const base = {
  nodeId: "node-1",
  baseAssetId: "asset-base",
  baseStorageKey: `sha256-${HASH_A}`,
  sourceWidth: 1024,
  sourceHeight: 768
};

describe("ProjectSession 生命周期（任务 3.2）", () => {
  it("纯媒体进入 view，不产生净变化", () => {
    const session = new ProjectSession({ ...base, edit: null });
    expect(session.currentPhase()).toBe("view");
    expect(session.isDirty()).toBe(false);
    expect(session.canSaveAnnotation()).toBe(false);
  });

  it("旧标注进入 annotation 并可保存旧标注分支", () => {
    const session = new ProjectSession({ ...base, edit: annotation(0) });
    expect(session.currentPhase()).toBe("annotation");
    expect(session.canSaveAnnotation()).toBe(true);
    expect(session.isDirty()).toBe(false);
  });

  it("工程定义进入 loading → editing，且禁止旧标注保存（不丢失工程）", () => {
    const session = new ProjectSession({ ...base, edit: projectDoc(), projectObjectAvailable: true });
    expect(session.currentPhase()).toBe("loading");
    expect(session.canSaveAnnotation()).toBe(false);
    session.applyContentState({
      canvasWidth: 800,
      canvasHeight: 600,
      layerCount: 3,
      activeLayerIndex: 0,
      revision: 1,
      documentContentHash: "0123456789abcdef",
      dirty: false,
      frozen: false
    });
    expect(session.currentPhase()).toBe("editing");
    expect(session.isDirty()).toBe(false);
  });

  it("工程对象缺失或版本过新 → 只读查看 PNG，不从 PNG 静默建立替代工程", () => {
    const missing = new ProjectSession({ ...base, edit: projectDoc(), projectObjectAvailable: false });
    expect(missing.currentPhase()).toBe("readonly-project");
    expect(missing.readOnlyReason()).toContain("工程对象缺失");
    expect(missing.canOpenProject()).toBe(false);
    const tooNew = new ProjectSession({ ...base, edit: projectDoc({ formatVersion: 99 }), projectObjectAvailable: true });
    expect(tooNew.currentPhase()).toBe("readonly-project");
    expect(isSupportedProject(projectDoc() as never)).toBe(true);
    expect(isSupportedProject(projectDoc({ formatVersion: 99 }) as never)).toBe(false);
  });

  it("冻结 → 保存 → 基线推进；取消/失败保留现场", () => {
    const session = new ProjectSession({ ...base, edit: projectDoc(), projectObjectAvailable: true });
    session.applyContentState({
      canvasWidth: 800,
      canvasHeight: 600,
      layerCount: 3,
      activeLayerIndex: 0,
      revision: 1,
      documentContentHash: "ffffffffffffffff",
      dirty: true,
      frozen: false
    });
    expect(session.isDirty()).toBe(true);
    session.beginFreeze();
    expect(session.currentPhase()).toBe("freezing");
    session.beginSave();
    expect(session.currentPhase()).toBe("saving");
    session.failSave("upload failed");
    expect(session.currentPhase()).toBe("editing");
    expect(session.errorState()).toBe("upload failed");
    expect(session.isDirty()).toBe(true);
    session.beginFreeze();
    session.beginSave();
    session.commitBaseline("ffffffffffffffff");
    expect(session.currentPhase()).toBe("editing");
    expect(session.isDirty()).toBe(false);
    expect(session.errorState()).toBeNull();
  });

  it("取消导出恢复编辑现场", () => {
    const session = new ProjectSession({ ...base, edit: projectDoc(), projectObjectAvailable: true });
    session.applyContentState({
      canvasWidth: 800,
      canvasHeight: 600,
      layerCount: 3,
      activeLayerIndex: 0,
      revision: 1,
      documentContentHash: "0123456789abcdef",
      dirty: false,
      frozen: false
    });
    session.beginFreeze();
    session.resumeEditing();
    expect(session.currentPhase()).toBe("editing");
  });

  it("释放会话后回到 view", () => {
    const session = new ProjectSession({ ...base, edit: annotation(2) });
    session.dispose();
    expect(session.currentPhase()).toBe("view");
  });
});

describe("v1 标注 → 工程转换（任务 3.3）", () => {
  it("每 shape 转换为一层，背景保留原图；转换初始化不产生净变化", () => {
    const session = new ProjectSession({ ...base, edit: annotation(2) });
    const plan = session.planV1Conversion();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.annotations).toBe(2);
    expect(plan.content.layers).toHaveLength(3);
    expect(plan.content.layers[0].id).toBe("background");
    expect(plan.content.layers[0].pixel?.sourceAssetId).toBe("asset-base");
    // 转换初始化即基线：进入时无净变化。
    expect(session.isDirty()).toBe(false);
  });

  it("来源删除后转换仍只用稳定引用（不依赖来源 URL）", () => {
    const session = new ProjectSession({ ...base, edit: annotation(1) });
    const plan = session.planV1Conversion();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const serialized = JSON.stringify(plan.content);
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("blob:");
  });

  it("超出首期层数上限时回退旧标注且不静默压平", () => {
    const session = new ProjectSession({ ...base, edit: annotation(80) });
    expect(session.conversionFallbackReason()).toBe("shape-limit");
    expect(session.planV1Conversion()).toMatchObject({ ok: false, reason: "shape-limit" });
  });

  it("超出画布上限时回退旧标注", () => {
    const session = new ProjectSession({ ...base, sourceWidth: 20000, sourceHeight: 20000, edit: annotation(1) });
    expect(session.conversionFallbackReason()).toBe("canvas-limit");
  });

  it("未保存标注切换为工程时保留净变化（基线含当前标注）", () => {
    const session = new ProjectSession({ ...base, edit: annotation(3) });
    // 基线内容包含了进入时的 3 个标注：未改动即无净变化；改动后才有。
    expect(session.isDirty()).toBe(false);
    expect(session.baselineContent()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("文档内容 hash 不可用时基线为 null（不把未知当作无变化）", () => {
    const session = new ProjectSession({ ...base, sourceWidth: 0, sourceHeight: 0, edit: annotation(1) });
    expect(session.baselineContent()).toBeNull();
    expect(session.planV1Conversion()).toMatchObject({ ok: false, reason: "canvas-limit" });
  });
});

describe("进入编辑器的基线（打开 ≠ 修改）", () => {
  const state = (documentContentHash: string) => ({
    canvasWidth: 800,
    canvasHeight: 600,
    layerCount: 2,
    activeLayerIndex: 0,
    revision: 1,
    documentContentHash,
    dirty: false,
    frozen: false
  });

  it("纯媒体以原图开新工程：建立进入基线后才无净变化", () => {
    const session = new ProjectSession({ ...base, edit: null });
    session.applyContentState(state("0123456789abcdef"));
    expect(session.currentPhase()).toBe("editing");
    // 纯媒体没有进入指纹：刚打开会被判为有变化，建立基线后才是「打开 ≠ 修改」。
    expect(session.isDirty()).toBe(true);
    session.establishBaseline();
    expect(session.isDirty()).toBe(false);
  });

  it("v1 转换完成后切到工程分支，退出聚焦不再写 v1 定义", () => {
    const session = new ProjectSession({ ...base, edit: annotation(2) });
    session.applyContentState(state("0123456789abcdef"));
    // 打开内核不改分支：转换由面板在成功置入图层后才切换。
    expect(session.currentPhase()).toBe("annotation");
    expect(session.canSaveAnnotation()).toBe(true);
    session.beginProjectConversion();
    expect(session.currentPhase()).toBe("editing");
    expect(session.canSaveAnnotation()).toBe(false);
    expect(session.annotationDocument()).toBeNull();
    session.establishBaseline();
    expect(session.isDirty()).toBe(false);
  });
});
