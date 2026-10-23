/**
 * 选区草稿的切文档/切标签/关闭门禁（任务 3.3 宿主半的域侧契约）。
 *
 * 宿主 `pendingDraftOf()` 只问本域"有没有必须先结算的草稿"，判定与文案都在本域。这里验两层：
 * 1. 域函数契约（替身上下文）：内核有草稿才拦，内核丢弃后立刻放行，缺文档/缺会话/读失败不拦；
 * 2. 真实接线（真控制器 + 真域会话 + 替身内核）：`features.selections.unsettledDraftReason()`
 *    确实通到内核草稿真值，而不是某个界面影子标记。
 *
 * 真实像素与内核草稿状态机在 Rust 侧（`tests_workflows.rs`）；真实标签栏点击仍属人工走查（4.2）。
 */
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import { EditorHandle, type EditorInstance } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../../editor-workspace.js";
import { DevDocumentSession } from "../../../../../dev/src/dev-session.js";
import { SELECTION_DRAFT_SWITCH_REASON, paintQuickMaskStroke, unsettledDraftReason } from "./workspace.js";

const HASH = "aabbccddeeff0011";

function stateJson(revision: number): string {
  return JSON.stringify({
    session: { active: 0, documents: [{ index: 0, name: "art" }] },
    document: {
      name: "art", width: 8, height: 6, mode: "Rgb", depth: 8, activeLayer: 1, selectedLayers: [1],
      hasSelection: false, canUndo: false, canRedo: false, revision, history: ["打开"], redoHistory: [],
      layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }]
    }
  });
}

/** 内核替身：草稿状态由测试摆布，用来分辨"本域以为有草稿"与"内核真有草稿"。 */
function build(draft: { active: boolean; kind?: string }) {
  const state = draft;
  const revision = 1;
  const instance = {
    openImage: () => stateJson(revision),
    stateJson: () => stateJson(revision),
    contentHash: () => HASH,
    commandsJson: () => "[]",
    allowedCommandIdsJson: () => "[]",
    assetIdsJson: () => "[]",
    // 本域切文档门禁只读这一个导出。
    selectionDraftStateJson: () => JSON.stringify(
      state.active
        ? { active: true, kind: state.kind ?? "magnetic", document: 1, revision: 2, stale: false, bounds: [0, 0, 4, 4], maskBounds: null, invalid: false }
        : { active: false }
    )
  } as unknown as EditorInstance;
  const handle = new EditorHandle(instance, {
    upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: "photocraft-v1", formatVersion: 1
  });
  const controller = new EditorWorkspaceController({
    session: new DevDocumentSession(),
    dialogOwner: () => ({ canvasId: "dev", sessionId: "dev" }),
    load: async () => ({ ok: true, value: handle }),
    digest: async () => "0".repeat(64),
    yieldTask: async () => undefined,
    save: async () => ({ ok: true })
  });
  return { controller, state };
}

async function opened(controller: EditorWorkspaceController) {
  const result = await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([1]) });
  expect(result.ok).toBe(true);
}

describe("选区草稿阻止切文档/关闭（宿主门禁的域侧契约）", () => {
  it("内核里有选区草稿时，本域给出拦截原因", async () => {
    const { controller } = build({ active: true });
    await opened(controller);
    // 宿主 `pendingDraftOf()` 正是问这一个方法；文案由本域提供，不在这里重写。
    expect(controller.features.selections.unsettledDraftReason()).toBe(SELECTION_DRAFT_SWITCH_REASON);
  });

  it("内核草稿结算后立刻放行，不因为残留标记把用户永久挡住", async () => {
    const { controller, state } = build({ active: true });
    await opened(controller);
    expect(controller.features.selections.unsettledDraftReason()).toBe(SELECTION_DRAFT_SWITCH_REASON);
    // 模拟内核丢弃草稿（用户取消，或过期归属被拒后丢弃）。
    state.active = false;
    expect(controller.features.selections.unsettledDraftReason()).toBeNull();
  });

  it("没有草稿的普通文档不受影响", async () => {
    const { controller } = build({ active: false });
    await opened(controller);
    expect(controller.features.selections.unsettledDraftReason()).toBeNull();
  });
});

/** 只带本域判定所需字段的上下文替身。 */
function contextWith(draft: { ok: boolean; value?: unknown }, options: { handle?: boolean; document?: boolean } = {}) {
  const selectionDraftState = vi.fn(() => draft);
  const context = {
    handle: options.handle === false ? null : { features: { selections: { selectionDraftState } } },
    view: { document: options.document === false ? null : { revision: 1, width: 8, height: 8 } }
  } as unknown as WorkspaceFeatureContext;
  return { context, selectionDraftState };
}

const activeDraft = { active: true, kind: "magnetic", document: 1, revision: 2, stale: false, bounds: [0, 0, 4, 4], maskBounds: null, invalid: false };

describe("选区草稿的切文档门禁", () => {
  it("内核里有活动草稿时给出本域文案，宿主据此拦截切换", () => {
    const { context, selectionDraftState } = contextWith({ ok: true, value: activeDraft });
    expect(unsettledDraftReason.call(context)).toBe(SELECTION_DRAFT_SWITCH_REASON);
    expect(SELECTION_DRAFT_SWITCH_REASON).toContain("选区");
    expect(selectionDraftState).toHaveBeenCalledTimes(1);
  });

  it("内核已经丢弃草稿（含过期归属被丢弃）时不再拦截", () => {
    const { context } = contextWith({ ok: true, value: { active: false } });
    // 关键回归：先前 `selectionModifyActive` 可能还停在 true，但草稿已不在内核里——
    // 这时必须放行，否则用户会被一个不存在的草稿永久挡住切换。
    expect(unsettledDraftReason.call(context)).toBeNull();
  });

  it("过期归属的草稿仍然算未结算（要用户先取消），不静默放行", () => {
    const { context } = contextWith({ ok: true, value: { ...activeDraft, stale: true } });
    expect(unsettledDraftReason.call(context)).toBe(SELECTION_DRAFT_SWITCH_REASON);
  });

  it("没有活动文档或没有会话时不拦截（不是本域能判定的场景）", () => {
    const withoutDocument = contextWith({ ok: true, value: activeDraft }, { document: false });
    expect(unsettledDraftReason.call(withoutDocument.context)).toBeNull();
    const withoutHandle = contextWith({ ok: true, value: activeDraft }, { handle: false });
    expect(unsettledDraftReason.call(withoutHandle.context)).toBeNull();
    // 内核拒绝读取时也不能凭空拦人。
    const failing = contextWith({ ok: false });
    expect(unsettledDraftReason.call(failing.context)).toBeNull();
  });
});

describe("快速蒙版笔迹走同一草稿（Q 与画布共用）", () => {
  /** 只带笔迹所需字段的上下文替身：记录内核收到的参数。 */
  function contextWithDraft(active: boolean) {
    const paintQuickMask = vi.fn((_params: Record<string, unknown>) => ({ ok: true, value: { quickMask: true, strokes: 1 } }));
    const context = {
      handle: { features: { selections: { paintQuickMask } } },
      selectionModifyActive: active,
      unavailable: () => ({ ok: false, code: "unavailable", message: "没有可用的编辑器" })
    } as unknown as WorkspaceFeatureContext;
    return { context, paintQuickMask };
  }

  it("画布点位的参数编译留在本域，并显式钉死临时目标", () => {
    const { context, paintQuickMask } = contextWithDraft(true);
    const result = paintQuickMaskStroke.call(context, [{ x: 3.4, y: 5.6 }, { x: 7, y: 9 }], { size: 12, color: "#ffffff" });
    expect(result.ok).toBe(true);
    expect(paintQuickMask).toHaveBeenCalledTimes(1);
    expect(paintQuickMask.mock.calls[0][0]).toMatchObject({
      points: [[3.4, 5.6], [7, 9]],
      size: 12,
      color: "#ffffff",
      // 不写 target 就会落到画笔当前目标的图层像素上，而不是临时选择通道。
      target: "quickMask"
    });
  });

  it("没有活动草稿时拒绝，不会把笔迹漏进图层像素", () => {
    const { context, paintQuickMask } = contextWithDraft(false);
    const result = paintQuickMaskStroke.call(context, [{ x: 1, y: 1 }], { size: 8 });
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(paintQuickMask).not.toHaveBeenCalled();
  });

  it("非法笔迹在到达内核前被拒绝（空点位/非有限坐标）", () => {
    const { context, paintQuickMask } = contextWithDraft(true);
    expect(paintQuickMaskStroke.call(context, [], { size: 8 })).toMatchObject({ ok: false, code: "invalid-params" });
    expect(paintQuickMaskStroke.call(context, [{ x: Number.POSITIVE_INFINITY, y: 0 }], { size: 8 }))
      .toMatchObject({ ok: false, code: "invalid-params" });
    expect(paintQuickMask).not.toHaveBeenCalled();
  });

  it("任意前景色按明度归到黑白两档，与面板的两档笔迹同语义", () => {
    const { context, paintQuickMask } = contextWithDraft(true);
    // 内核是灰度临时通道：红/绿等彩色原样送进去只会被按阈值吸附，用户会以为"没生效"。
    paintQuickMaskStroke.call(context, [{ x: 1, y: 1 }], { size: 6, color: "#ff0000" });
    paintQuickMaskStroke.call(context, [{ x: 1, y: 1 }], { size: 6, color: "#ffffff" });
    paintQuickMaskStroke.call(context, [{ x: 1, y: 1 }], { size: 6, color: "#808080" });
    paintQuickMaskStroke.call(context, [{ x: 1, y: 1 }], { size: 6, color: "#000000" });
    paintQuickMaskStroke.call(context, [{ x: 1, y: 1 }], { size: 6 });
    const colours = paintQuickMask.mock.calls.map((call) => (call[0] as { color: string }).color);
    expect(colours).toEqual(["#000000", "#ffffff", "#ffffff", "#000000", "#ffffff"]);
  });

  it("没有会话手柄时拒绝", () => {
    const context = {
      handle: null,
      selectionModifyActive: true,
      unavailable: () => ({ ok: false, code: "unavailable", message: "没有可用的编辑器" })
    } as unknown as WorkspaceFeatureContext;
    expect(paintQuickMaskStroke.call(context, [{ x: 1, y: 1 }], { size: 4 })).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("Q 快速蒙版与面板共用同一草稿（不是上游命令直通）", () => {
  /** 内核替身：记录快速蒙版调用，并让 `hasActiveDraft()` 与保存门禁看到同一个草稿。 */
  function quickMaskBuild() {
    const calls: string[] = [];
    const draft = { active: false as boolean };
    const state = JSON.stringify({
      session: { active: 0, documents: [{ index: 0, name: "art" }] },
      document: {
        name: "art", width: 8, height: 6, mode: "Rgb", depth: 8, activeLayer: 1, selectedLayers: [1],
        hasSelection: false, canUndo: false, canRedo: false, revision: 1, history: ["打开"], redoHistory: [],
        layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }]
      }
    });
    const instance = {
      openImage: () => state,
      stateJson: () => state,
      contentHash: () => "aabbccddeeff0011",
      commandsJson: () => "[]",
      allowedCommandIdsJson: () => "[]",
      assetIdsJson: () => "[]",
      selectionDraftStateJson: () => JSON.stringify(
        draft.active ? { active: true, kind: "quickMask", document: 1, revision: 2, stale: false, bounds: [0, 0, 4, 4], maskBounds: null, invalid: false } : { active: false }
      ),
      selectionDraftOutlineJson: () => "[]",
      beginQuickMask: () => { calls.push("begin"); draft.active = true; return JSON.stringify({ kind: "quickMask", quickMask: true }); },
      paintQuickMask: (params: string) => { calls.push(`paint:${params}`); return JSON.stringify({ quickMask: true, strokes: 1 }); },
      exitQuickMask: (cancel: boolean) => { calls.push(cancel ? "exit:cancel" : "exit:commit"); draft.active = false; return JSON.stringify({ quickMask: false }); },
      commitSelectionDraft: () => { calls.push("commit"); draft.active = false; return JSON.stringify({ kind: "quickMask" }); },
      cancelSelectionDraft: () => { calls.push("cancel"); draft.active = false; return JSON.stringify({ cancelled: true }); }
    } as unknown as EditorInstance;
    const handle = new EditorHandle(instance, {
      upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: "photocraft-v1", formatVersion: 1
    });
    const controller = new EditorWorkspaceController({
      session: new DevDocumentSession(),
      dialogOwner: () => ({ canvasId: "dev", sessionId: "dev" }),
      load: async () => ({ ok: true, value: handle }),
      digest: async () => "0".repeat(64),
      yieldTask: async () => undefined,
      save: async () => ({ ok: true })
    });
    return { controller, calls, draft };
  }

  it("进入后 hasActiveDraft 为真（保存门禁与切换门禁看到同一草稿）", async () => {
    const { controller, draft } = quickMaskBuild();
    await opened(controller);
    expect(controller.hasActiveDraft()).toBe(false);
    const entered = controller.features.selections.beginQuickMask();
    expect(entered.ok).toBe(true);
    expect(draft.active).toBe(true);
    // 关键：Q 走错路径时这里仍是 false，于是 saveProject/undo 全部放行。
    expect(controller.hasActiveDraft()).toBe(true);
    expect(controller.features.selections.unsettledDraftReason()).toBe(SELECTION_DRAFT_SWITCH_REASON);
  });

  it("绘画、确认、取消都落到同一个草稿，并各自清掉门禁", async () => {
    const { controller, calls, draft } = quickMaskBuild();
    await opened(controller);
    controller.features.selections.beginQuickMask();
    controller.features.selections.paintQuickMaskStroke([{ x: 2, y: 3 }], { size: 8, color: "#ffffff" });
    const painted = calls.find((entry) => entry.startsWith("paint:"));
    expect(painted).toBeDefined();
    // 画布点位的编译结果必须带临时目标，否则会写进图层像素。
    expect(JSON.parse(painted!.slice("paint:".length))).toMatchObject({ points: [[2, 3]], target: "quickMask" });

    const exited = controller.features.selections.exitQuickMask(true);
    expect(exited.ok).toBe(true);
    expect(draft.active).toBe(false);
    expect(controller.hasActiveDraft()).toBe(false);
    expect(calls).toContain("exit:cancel");
  });

  it("确认退出走一次提交，撤销后门禁与草稿都清空", async () => {
    const { controller, calls, draft } = quickMaskBuild();
    await opened(controller);
    controller.features.selections.beginQuickMask();
    controller.features.selections.paintQuickMaskStroke([{ x: 1, y: 1 }], { size: 4 });
    const committed = controller.features.selections.exitQuickMask(false);
    expect(committed.ok).toBe(true);
    expect(draft.active).toBe(false);
    expect(controller.hasActiveDraft()).toBe(false);
    expect(calls).toContain("exit:commit");
  });
});
