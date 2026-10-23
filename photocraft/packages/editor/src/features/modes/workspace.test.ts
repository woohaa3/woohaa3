import { expect, it, vi } from "vitest";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { ImageModePlan } from "./mode-data.js";
import { applyColorTable, applyMode, modeInfo, planColorTable, planMode } from "./workspace.js";

/**
 * 本域工作区门禁回归
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.1 / 3.3）。
 *
 * 只用替身内核，不加载 WASM：验证归属（代际 → 修订 → 内容指纹）、保存阶段门禁、草稿门禁、
 * 无变化不提交，以及确认时一定把预览的基线一起交回内核。像素级转换证据在 Rust 域测试里；
 * 真实控制器与宿主的接线回归在 `modes-workspace-gate.test.ts` 与
 * `integrations/woohaa/tests/document-session.test.ts`。
 */

const view = (revision: number): EditorViewModel => ({
  hasDocument: true,
  sessionActiveIndex: 0,
  document: {
    channelTarget: { kind: "composite" },

    name: "test", width: 8, height: 8, mode: "Rgb", depthBits: 8, activeLayerId: 1, selectedLayerIds: [1],
    hasSelection: false, editTarget: "pixels", maskView: null, transformFrame: null, selectionOutline: [],
    selectionFrame: null, canUndo: false, canRedo: false, revision, history: [], redoHistory: [], layers: []
  }
});

const plan = (overrides: Partial<ImageModePlan> = {}): ImageModePlan => ({
  report: {
    target: "grayscale", label: "Grayscale", fromMode: "rgb", toMode: "grayscale", depth: 8,
    layersBefore: 1, layersAfter: 1, flattened: false, dropped: {}, lossy: false,
    colorCount: null, colors: null, transparentIndex: null, inks: null, notes: [], changed: true
  },
  preview: { width: 1, height: 1, pixels: new Uint8Array(4) },
  baseRevision: 3,
  baseContentHash: "hash-3",
  changed: true,
  ...overrides
});

function harness(options: {
  revision?: number;
  /** 内核返回的计划基线（默认与 `revision` 相同；可造出过期计划）。 */
  planRevision?: number;
  /** 当前文档内容指纹（默认与计划的基线一致；可造出同修订不同内容）。 */
  contentHash?: string;
  blocked?: { code: string; message: string } | null;
  activeDraft?: boolean;
  handle?: boolean;
  /** 当前文档归属代际（默认 0）。 */
  generation?: number;
  /** 宿主文档 id（默认 "doc-1"）。 */
  documentId?: string | null;
  /** 是否处于冻结/保存阶段。 */
  saving?: boolean;
} = {}) {
  const modes = {
    modeInfo: vi.fn(() => ({ ok: true as const, value: { mode: "rgb" } })),
    planMode: vi.fn(() => ({ ok: true as const, value: plan({ baseRevision: options.planRevision ?? options.revision ?? 3 }) })),
    applyMode: vi.fn(() => ({ ok: true as const, value: plan({ committed: true }) })),
    planColorTable: vi.fn(() => ({ ok: true as const, value: plan({ baseRevision: options.planRevision ?? options.revision ?? 3 }) })),
    applyColorTable: vi.fn(() => ({ ok: true as const, value: plan({ committed: true }) }))
  };
  const contentHash = vi.fn(() => ({ ok: true as const, value: options.contentHash ?? "hash-3" }));
  const afterWrite = vi.fn(() => ({ ok: true as const, value: view(options.revision ?? 3) }));
  const unavailable = vi.fn(() => ({ ok: false as const, code: "no-document", message: "编辑器尚未就绪" }));
  const context = {
    handle: options.handle === false ? null : { features: { modes }, contentHash },
    view: view(options.revision ?? 3),
    owner: { documentId: options.documentId === undefined ? "doc-1" : options.documentId, generation: options.generation ?? 0 },
    saving: options.saving ?? false,
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => options.activeDraft ?? false,
    blockingDraft: () => options.blocked ?? null,
    unavailable,
    fail: (failure: never) => failure,
    afterWrite
  } as unknown as WorkspaceFeatureContext;
  return { context, modes, afterWrite, unavailable };
}

it("plans on the current revision and forwards only the target parameters", () => {
  const { context, modes } = harness({ revision: 3 });
  const result = planMode.call(context, "grayscale", {});
  expect(result.ok).toBe(true);
  expect(modes.planMode).toHaveBeenCalledWith("grayscale", { maxSide: 256 });
  // 计划带上当前文档归属，确认时据此判定它是否仍属于这份文档。
  if (result.ok) expect(result.value.owner).toEqual({ documentId: "doc-1", generation: 0 });
});

it("rejects a plan whose baseline is not the current document revision", () => {
  const { context, modes } = harness({ revision: 4, planRevision: 3 });
  const result = planMode.call(context, "grayscale", {});
  expect(result).toEqual({ ok: false, code: "stale", message: "文档已变化，请重新预览" });
  expect(modes.planMode).toHaveBeenCalledTimes(1);
});

it("rejects a plan made against a different document with the same revision", () => {
  // 两份新文档都可能是修订 1：只有内容指纹能区分，否则旧计划会被当成当前文档的结果。
  const { context } = harness({ revision: 1, planRevision: 1, contentHash: "other-document" });
  expect(planMode.call(context, "grayscale", {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览"
  });
  expect(planColorTable.call(context, {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览颜色表"
  });
});

it("rejects applying a plan carried over from another document with the same revision", () => {
  const { context, modes, afterWrite } = harness({ revision: 1, contentHash: "other-document" });
  expect(applyMode.call(context, "grayscale", plan({ baseRevision: 1 }), {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  expect(applyColorTable.call(context, plan({ baseRevision: 1 }), {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  expect(modes.applyMode).not.toHaveBeenCalled();
  expect(modes.applyColorTable).not.toHaveBeenCalled();
  expect(afterWrite).not.toHaveBeenCalled();
});

it("rejects applying a plan after the document revision advanced", () => {
  const { context, modes, afterWrite } = harness({ revision: 4 });
  expect(applyMode.call(context, "grayscale", plan({ baseRevision: 3 }), {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  expect(applyColorTable.call(context, plan({ baseRevision: 3 }), {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  expect(modes.applyMode).not.toHaveBeenCalled();
  expect(modes.applyColorTable).not.toHaveBeenCalled();
  expect(afterWrite).not.toHaveBeenCalled();
});

it("rejects a late plan whose document generation moved on", () => {
  // 关闭后重开同一节点：又是修订 3、内容指纹也相同，数值上完全匹配，只有代际能说明它属于
  // 已经销毁的会话（任务 3.3）。内核会接受这份基线，所以在域内就必须拒绝。
  const issued = harness({ revision: 3, generation: 1 });
  const planned = planMode.call(issued.context, "grayscale", {});
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const reopened = harness({ revision: 3, generation: 2 });
  expect(applyMode.call(reopened.context, "grayscale", planned.value, {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  expect(applyColorTable.call(reopened.context, planned.value, {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  expect(reopened.modes.applyMode).not.toHaveBeenCalled();
  expect(reopened.afterWrite).not.toHaveBeenCalled();

  // 同一代际下仍然可以确认（拒绝的是代际变化，不是计划本身）。
  const same = harness({ revision: 3, generation: 1 });
  expect(applyMode.call(same.context, "grayscale", planned.value, {}).ok).toBe(true);
  expect(same.modes.applyMode).toHaveBeenCalledTimes(1);
});

it("rejects a plan issued for another host document even at the same generation", () => {
  const issued = harness({ revision: 3, documentId: "doc-a" });
  const planned = planMode.call(issued.context, "grayscale", {});
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;
  const other = harness({ revision: 3, documentId: "doc-b" });
  expect(applyMode.call(other.context, "grayscale", planned.value, {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  expect(other.modes.applyMode).not.toHaveBeenCalled();
});

it("refuses new conversions while the document is freezing or saving", () => {
  // 保存期间文档正在被序列化：这时候写入会让「已冻结的修订」与内容不一致。
  const { context, modes, afterWrite } = harness({ saving: true });
  const blocked = { ok: false, code: "frozen", message: "正在保存，请等待保存完成后再修改图像模式" };
  expect(planMode.call(context, "grayscale", {})).toEqual(blocked);
  expect(planColorTable.call(context, {})).toEqual(blocked);
  expect(applyMode.call(context, "grayscale", plan(), {})).toEqual(blocked);
  expect(applyColorTable.call(context, plan(), {})).toEqual(blocked);
  expect(modes.planMode).not.toHaveBeenCalled();
  expect(modes.applyMode).not.toHaveBeenCalled();
  expect(afterWrite).not.toHaveBeenCalled();
  // 只读入口不受保存影响：面板仍要能显示当前模式。
  expect(modeInfo.call(context).ok).toBe(true);
});

it("blocks conversion while another draft is open and does not call the kernel", () => {
  const blocked = { code: "selection-modify-active", message: "请先确认或取消选区修改" };
  const { context, modes } = harness({ blocked });
  expect(planMode.call(context, "grayscale", {})).toEqual({ ok: false, ...blocked });
  expect(modes.planMode).not.toHaveBeenCalled();

  const active = harness({ activeDraft: true });
  expect(planMode.call(active.context, "grayscale", {})).toEqual({
    ok: false, code: "gesture-active", message: "请先结算当前草稿再修改图像模式"
  });
  expect(active.modes.planMode).not.toHaveBeenCalled();
});

it("requires a document handle before reading mode info or planning", () => {
  const { context, unavailable, modes } = harness({ handle: false });
  expect(modeInfo.call(context)).toEqual({ ok: false, code: "no-document", message: "编辑器尚未就绪" });
  expect(planMode.call(context, "grayscale", {})).toEqual({ ok: false, code: "no-document", message: "编辑器尚未就绪" });
  expect(unavailable).toHaveBeenCalledTimes(2);
  expect(modes.modeInfo).not.toHaveBeenCalled();
  expect(modes.planMode).not.toHaveBeenCalled();
});

it("commits with the previewed baseline and refreshes the shared view", () => {
  const { context, modes, afterWrite } = harness({ revision: 3 });
  const preview = plan();
  const result = applyMode.call(context, "grayscale", preview, {});
  expect(result.ok).toBe(true);
  expect(modes.applyMode).toHaveBeenCalledWith("grayscale", { baseRevision: 3, baseContentHash: "hash-3" });
  expect(afterWrite).toHaveBeenCalledTimes(1);
});

it("does not commit a no-change plan", () => {
  const { context, modes, afterWrite } = harness();
  const result = applyMode.call(context, "grayscale", plan({ changed: false }));
  expect(result).toEqual({ ok: false, code: "no-change", message: "这次转换没有变化，不需要提交" });
  expect(modes.applyMode).not.toHaveBeenCalled();
  expect(afterWrite).not.toHaveBeenCalled();
});

it("applies color table edits through the same baseline gate", () => {
  const { context, modes, afterWrite } = harness({ revision: 3 });
  const tablePlan = planColorTable.call(context, { table: "grayscale" });
  expect(tablePlan.ok).toBe(true);
  expect(modes.planColorTable).toHaveBeenCalledWith({ table: "grayscale", maxSide: 256 });

  const applied = applyColorTable.call(context, plan(), { entries: { 0: "#00ff00" } });
  expect(applied.ok).toBe(true);
  expect(modes.applyColorTable).toHaveBeenCalledWith({
    entries: { 0: "#00ff00" }, baseRevision: 3, baseContentHash: "hash-3"
  });
  expect(afterWrite).toHaveBeenCalledTimes(1);

  const stale = harness({ revision: 5, planRevision: 3 });
  expect(planColorTable.call(stale.context, {})).toEqual({ ok: false, code: "stale", message: "文档已变化，请重新预览颜色表" });
  const unchanged = harness();
  expect(applyColorTable.call(unchanged.context, plan({ changed: false }), {})).toEqual({
    ok: false, code: "no-change", message: "颜色表没有变化，不需要提交"
  });
});
