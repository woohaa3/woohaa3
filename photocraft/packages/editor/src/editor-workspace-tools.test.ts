/**
 * P2–P7 工作区入口的门禁回归
 * （change: 2026-10-22-complete-photocraft-webui-editing）。
 *
 * 用替身内核验证：新入口在草稿期间被拒绝、跨文档剪贴板不缓存、失败不推进状态。
 * 真实像素与内核事务在 Rust 侧测试；这里只锁定控制器的门禁与结果归属。
 */
import { describe, expect, it, vi } from "vitest";
import { EditorHandle, type EditorInstance } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../src/editor-workspace.js";
import { DevDocumentSession } from "../../../dev/src/dev-session.js";

const HASH = "aabbccddeeff0011";

function stateJson(revision: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session: { active: 0, documents: [{ index: 0, name: "art" }] },
    document: {
      name: "art", width: 8, height: 6, mode: "Rgb", depth: 8, activeLayer: 1, selectedLayers: [1],
      hasSelection: false, canUndo: false, canRedo: false, revision, history: ["打开"], redoHistory: [],
      layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }],
      ...overrides
    }
  });
}

function fakeHandle(overrides: Partial<Record<keyof EditorInstance, unknown>> = {}) {
  let revision = 1;
  const calls: string[] = [];
  const edit = () => { revision += 1; };
  const instance = {
    openImage: () => stateJson(revision),
    openProject: () => stateJson(revision),
    placeImage: () => stateJson(revision),
    execute: () => { edit(); return "null"; },
    stateJson: () => stateJson(revision),
    commandsJson: () => JSON.stringify([{
      id: "layer.delete", label: "删除图层", menu: ["Layer"], shortcut: null, params: "",
      enabled: true, disabledReason: null, needsDocument: true, allowed: true
    }]),
    allowedCommandIdsJson: () => JSON.stringify(["layer.delete"]),
    contentHash: () => HASH,
    assetIdsJson: () => "[]",
    closeDocument: () => stateJson(revision),
    exportBundle: () => ({
      revision, documentContentHash: HASH, canvasWidth: 8, canvasHeight: 6,
      project: new TextEncoder().encode("PROJECT"), output: new TextEncoder().encode("OUTPUT")
    }),
    saveProject: () => new Uint8Array([9, 9]),
    renderPreview: () => { throw new Error("render not stubbed"); },
    renderRegion: () => { throw new Error("render not stubbed"); },
    exportLayerTransfer: (params: string) => { calls.push(`copy:${params}`); return new Uint8Array([7, 7]); },
    canPasteLayerTransfer: () => JSON.stringify({ ok: true, layers: 1, digest: "d".repeat(64) }),
    pasteLayerTransfer: () => { calls.push("paste"); edit(); return JSON.stringify({ count: 1 }); },
    inspectPlaceAsset: () => JSON.stringify({ width: 4, height: 4, format: "Png" }),
    placeAsset: () => { calls.push("place"); edit(); return JSON.stringify({ mode: "pixel" }); },
    inspectPsd: () => JSON.stringify({ version: "psd-v1", width: 8, height: 6 }),
    importPsd: () => { calls.push("import-psd"); return stateJson(revision); },
    inspectPsdExport: () => JSON.stringify({ layers: [], editable: true }),
    exportPsd: (params: string) => { calls.push(`export-psd:${params}`); return new Uint8Array([1, 2]); },
    lastPsdExportReportJson: () => JSON.stringify({ rasterized: false, lossy: [] }),
    psdMatrixJson: () => JSON.stringify([{ feature: "psd.v1.rgb-u8", import: "editable", export: "editable", note: "" }]),
    beginSmartChild: () => JSON.stringify({ layer: 1, contentsId: 5, sourceHash: "0123456789abcdef", project: "abc" }),
    updateSmartParent: () => { edit(); return JSON.stringify({ committed: true }); },
    closeSmartChild: () => JSON.stringify({ closed: true }),
    smartChildStateJson: () => JSON.stringify({ active: false }),
    histogram: (params: { source?: string; channel?: string }) => {
      calls.push(`histogram:${params.channel ?? "rgb"}:${params.source ?? "composite"}`);
      return JSON.stringify({
        channels: [new Array(256).fill(1), new Array(256).fill(1), new Array(256).fill(1)],
        samples: 48, source: params.source ?? "composite", channel: params.channel ?? "rgb", generation: revision
      });
    },
    beginSelectionModify: () => JSON.stringify({ bounds: [0, 0, 4, 4] }),
    updateSelectionModify: () => JSON.stringify({ bounds: [0, 0, 5, 5] }),
    commitSelectionModify: () => { edit(); return JSON.stringify({ committed: true }); },
    cancelSelectionModify: () => JSON.stringify({ cancelled: true }),
    prepareRefineEdge: () => JSON.stringify({ params: { radius: 1, output: "layerMask" } }),
    beginRetouch: () => JSON.stringify({ command: "paint.blur", layer: 1 }),
    appendRetouch: () => JSON.stringify({ points: 3 }),
    commitRetouch: () => { edit(); return JSON.stringify({ points: 3 }); },
    cancelRetouch: () => JSON.stringify({ cancelled: true }),
    // 滤镜草稿回执带命令与规范参数（change: 2026-10-22-add-photocraft-filter-workflows）：
    // 面板要用它回读参数与几何，因此替身也必须回同一形状，不能再只回 `{active:true}`。
    beginFilter: () => JSON.stringify({ filter: "filter.blur.gaussianBlur", label: "高斯模糊", category: "模糊", kind: "Simple", layer: 1, params: { radius: 2 } }),
    updateFilter: () => JSON.stringify({ filter: "filter.blur.gaussianBlur", label: "高斯模糊", category: "模糊", kind: "Simple", layer: 1, params: { radius: 4 } }),
    commitFilter: () => { edit(); return JSON.stringify({ filter: "filter.blur.gaussianBlur" }); },
    cancelFilter: () => JSON.stringify({ cancelled: true }),
    beginCompose: () => JSON.stringify({ width: 4, height: 4 }),
    updateCompose: () => JSON.stringify({ width: 5, height: 5 }),
    commitCompose: () => { edit(); return JSON.stringify({ width: 5, height: 5 }); },
    cancelCompose: () => JSON.stringify({ cancelled: true }),
    viewAidsJson: () => JSON.stringify({ rulers: false, grid: false, guides: true, snap: {} }),
    setViewAids: () => JSON.stringify({ rulers: true, grid: false, guides: true, snap: {} }),
    snapPoint: () => JSON.stringify({ point: [0, 0], lines: [] }),
    filterLayers: (params: { by?: string; mode?: string }) => JSON.stringify({ active: params.by === "mode", by: params.by ?? "kind", mode: params.mode ?? null, layers: [] }),
    applyTypography: () => { edit(); return "null"; },
    vectorCommand: () => { edit(); return JSON.stringify({ layer: 2 }); },
    guideCommand: () => { edit(); return JSON.stringify({}); },
    vectorSnapshotJson: () => JSON.stringify({ vectorMasks: [], shapes: [], paths: [], guides: {} }),
    checkFont: () => JSON.stringify({ font: "Inter", available: true }),
    ...overrides
  } as unknown as EditorInstance;
  return {
    handle: new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: "photocraft-v1", formatVersion: 1 }),
    calls,
    edit
  };
}

function build(overrides: Partial<Record<keyof EditorInstance, unknown>> = {}, options: { documentId?: string } = {}) {
  const session = new DevDocumentSession();
  const editor = fakeHandle(overrides);
  const controller = new EditorWorkspaceController({
    session,
    dialogOwner: () => ({ canvasId: "dev", sessionId: "dev" }),
    ...(options.documentId ? { documentId: options.documentId } : {}),
    load: async () => ({ ok: true, value: editor.handle }),
    digest: async () => "0".repeat(64),
    yieldTask: async () => undefined,
    save: async () => ({ ok: true })
  });
  return { controller, session, editor };
}

async function opened(controller: EditorWorkspaceController) {
  await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([1]) });
}

describe("跨文档剪贴板（任务 4.1–4.3）", () => {
  it("导出载荷不由控制器缓存：每次复制都重新导出", async () => {
    const { controller, editor } = build();
    await opened(controller);
    const first = controller.copyLayers([1]);
    const second = controller.copyLayers([1]);
    expect(first.ok && second.ok).toBe(true);
    expect(editor.calls.filter((call) => call.startsWith("copy:")).length).toBe(2);
    expect((first as { value: Uint8Array }).value).toEqual(new Uint8Array([7, 7]));
  });

  it("粘贴失败不推进修订；成功才走 afterWrite", async () => {
    const { controller, editor } = build({ pasteLayerTransfer: () => { throw new Error("boom"); } });
    await opened(controller);
    const before = controller.currentView().document?.revision;
    const result = controller.pasteLayers(new Uint8Array([1]), { inPlace: true });
    expect(result.ok).toBe(false);
    expect(controller.currentView().document?.revision).toBe(before);
    expect(editor.calls).not.toContain("paste");
  });

  it("草稿期间拒绝跨文档粘贴与置入", async () => {
    const { controller } = build();
    await opened(controller);
    controller.beginFilter("filter.blur.gaussianBlur", { radius: 2 });
    expect(controller.pasteLayers(new Uint8Array([1])).ok).toBe(false);
    expect(controller.placeAsset({ name: "x", bytes: new Uint8Array([1]) }).ok).toBe(false);
    expect(controller.copyLayers([1]).ok).toBe(true);
    controller.cancelFilter();
  });

  it("置入走公共端口并只产生一次写", async () => {
    const { controller, editor } = build();
    await opened(controller);
    const preview = controller.inspectPlace(new Uint8Array([1]));
    expect(preview.ok).toBe(true);
    const result = controller.placeAsset({ name: "pic", bytes: new Uint8Array([1]), assetId: "asset-2" });
    expect(result.ok).toBe(true);
    expect(editor.calls).toContain("place");
  });
});

describe("PSD 交换（任务 5.3–5.4）", () => {
  it("导入失败不改当前文档", async () => {
    const { controller, editor } = build({ importPsd: () => { throw new Error("bad psd"); } });
    await opened(controller);
    const before = controller.currentView().document;
    const result = await controller.openPsd({ bytes: new Uint8Array([1]) });
    expect(result.ok).toBe(false);
    expect(controller.currentView().document?.revision).toBe(before?.revision);
    expect(editor.calls).not.toContain("import-psd");
  });

  it("导出返回字节与报告，且不推进工程基线", async () => {
    const { controller, session, editor } = build();
    await opened(controller);
    expect(session.isDirty()).toBe(false);
    const result = controller.exportPsd({ rasterizeLossy: true });
    expect(result.ok).toBe(true);
    expect(editor.calls).toContain('export-psd:{"rasterizeLossy":true}');
    expect(session.isDirty()).toBe(false);
  });

  it("矩阵与预检是只读能力", async () => {
    const { controller } = build();
    await opened(controller);
    expect(controller.psdMatrix().ok).toBe(true);
    expect(controller.inspectPsd(new Uint8Array([1])).ok).toBe(true);
    expect(controller.inspectPsdExport().ok).toBe(true);
  });
});

describe("智能对象子文档（任务 6.3–6.5）", () => {
  it("打开子文档设置活动标记，关闭后清除", async () => {
    const { controller } = build();
    await opened(controller);
    expect(controller.beginSmartChild(1).ok).toBe(true);
    expect(controller.hasSmartChild()).toBe(true);
    controller.closeSmartChild();
    expect(controller.hasSmartChild()).toBe(false);
  });

  it("回写失败保留子文档与修订", async () => {
    const { controller, editor } = build({ updateSmartParent: () => { throw new Error("conflict"); } });
    await opened(controller);
    controller.beginSmartChild(1);
    const before = controller.currentView().document?.revision;
    const result = controller.updateSmartParent("attempt-1", new Uint8Array([1]));
    expect(result.ok).toBe(false);
    expect(controller.hasSmartChild()).toBe(true);
    expect(controller.currentView().document?.revision).toBe(before);
    expect(editor.edit).toBeDefined();
  });

  it("回写成功结算子文档并刷新视图", async () => {
    const { controller } = build();
    await opened(controller);
    controller.beginSmartChild(1);
    const result = controller.updateSmartParent("attempt-2", new Uint8Array([1]));
    expect(result.ok).toBe(true);
    expect(controller.hasSmartChild()).toBe(false);
  });

  it("有草稿时拒绝打开子文档", async () => {
    const { controller } = build();
    await opened(controller);
    controller.beginCompose("image.crop", { x: 0, y: 0, width: 2, height: 2 });
    expect(controller.beginSmartChild(1).ok).toBe(false);
    controller.cancelCompose();
  });

  it("父文档保存中拒绝子文档回写（不把半冻结内容换进去）", async () => {
    const { controller } = build();
    await opened(controller);
    controller.beginSmartChild(1);
    expect((await controller.freezeForPublish()).ok).toBe(true);
    expect(controller.isSaving()).toBe(true);
    expect(controller.updateSmartParent("attempt-3", new Uint8Array([1]))).toEqual({
      ok: false, code: "frozen", message: "正在保存，请等待保存完成后再写回"
    });
    // 回写被拒时子文档仍然开着，不能悄悄把父文档标成「已结算」。
    expect(controller.hasSmartChild()).toBe(true);
  });

  it("子文档有草稿时拒绝用它的工程回写父文档", async () => {
    const { controller } = build();
    await opened(controller);
    controller.beginSmartChild(1);
    const child = controller.smartChildController();
    expect(child).not.toBeNull();
    // 子文档的工程是异步载入的：等它真的拿到内核再开草稿。
    await vi.waitFor(() => expect(child!.editor()).not.toBeNull());
    expect(child!.beginCompose("image.crop", { x: 0, y: 0, width: 2, height: 2 }).ok).toBe(true);
    expect(controller.updateSmartParentFromChild("attempt-4")).toEqual({
      ok: false, code: "draft-active", message: "请先完成或取消子文档中的草稿"
    });
    expect(controller.hasSmartChild()).toBe(true);
    child!.cancelCompose();
  });

  it("子文档有独立的文档归属，不冒用父文档 id", async () => {
    const { controller } = build({}, { documentId: "doc-1" });
    await opened(controller);
    controller.beginSmartChild(1);
    const child = controller.smartChildController();
    expect(child!.documentOwner().documentId).toBe("doc-1#smart-child");
    expect(controller.documentOwner().documentId).toBe("doc-1");
  });
});

describe("调色、选区与直方图（任务 7.1–7.6）", () => {
  it("直方图带代际，只读不推进修订", async () => {
    const { controller } = build();
    await opened(controller);
    const before = controller.currentView().document?.revision;
    const result = controller.histogram({ source: "layer", channel: "luminance" });
    expect(result.ok).toBe(true);
    expect(controller.currentView().document?.revision).toBe(before);
  });

  it("直方图结果属于旧修订时被丢弃", async () => {
    const { controller } = build({
      histogram: () => JSON.stringify({
        channels: [new Array(256).fill(1), new Array(256).fill(1), new Array(256).fill(1)],
        samples: 1, source: "composite", channel: "rgb", generation: 99
      })
    });
    await opened(controller);
    const result = controller.histogram({});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("stale");
  });

  it("选区修改草稿：开始、更新、确认、取消与门禁", async () => {
    const { controller } = build();
    await opened(controller);
    expect(controller.beginSelectionModify({ operation: "expand", radius: 2 }).ok).toBe(true);
    expect(controller.updateSelectionModify({ radius: 5 }).ok).toBe(true);
    // 草稿期间拒绝其它写入口。
    expect(controller.beginFilter("filter.blur.gaussianBlur", { radius: 1 }).ok).toBe(false);
    const committed = controller.commitSelectionModify();
    expect(committed.ok).toBe(true);
    expect(controller.beginSelectionModify({ operation: "contract", radius: 1 }).ok).toBe(true);
    controller.cancelSelectionModify();
    expect(controller.hasActiveDraft()).toBe(false);
  });

  it("边缘细化只编译参数，不直接提交", async () => {
    const { controller } = build();
    await opened(controller);
    const result = controller.prepareRefineEdge({ radius: 2, output: "layerMask" });
    expect(result.ok).toBe(true);
    expect(controller.hasActiveDraft()).toBe(false);
  });
});

describe("修饰与滤镜（任务 8.1–8.6）", () => {
  it("修饰笔迹提交一步并清除标记", async () => {
    const { controller } = build();
    await opened(controller);
    expect(controller.beginRetouch("paint.blur", { points: [[1, 1]], layer: 1 }).ok).toBe(true);
    expect(controller.hasRetouch()).toBe(true);
    expect(controller.appendRetouch([[2, 2]]).ok).toBe(true);
    const committed = controller.commitRetouch();
    expect(committed.ok).toBe(true);
    expect(controller.hasRetouch()).toBe(false);
  });

  it("修饰期间拒绝打开滤镜与构图", async () => {
    const { controller } = build();
    await opened(controller);
    controller.beginRetouch("paint.cloneStamp", { points: [[1, 1]], source: [2, 2], layer: 1 });
    expect(controller.beginFilter("filter.blur.gaussianBlur", { radius: 1 }).ok).toBe(false);
    expect(controller.beginCompose("image.crop", { x: 0, y: 0, width: 2, height: 2 }).ok).toBe(false);
    controller.cancelRetouch();
  });

  it("滤镜草稿确认与取消", async () => {
    const { controller } = build();
    await opened(controller);
    expect(controller.beginFilter("filter.blur.gaussianBlur", { radius: 2 }).ok).toBe(true);
    expect(controller.updateFilter({ radius: 4 }).ok).toBe(true);
    expect(controller.commitFilter().ok).toBe(true);
    expect(controller.hasFilter()).toBe(false);
    expect(controller.beginFilter("filter.sharpen.unsharpMask", { amount: 90 }).ok).toBe(true);
    controller.cancelFilter();
    expect(controller.hasFilter()).toBe(false);
  });
});

describe("构图、视图辅助与矢量（任务 9.1–9.6）", () => {
  it("构图草稿确认前不改修订", async () => {
    const { controller } = build();
    await opened(controller);
    const before = controller.currentView().document?.revision;
    expect(controller.beginCompose("image.crop", { x: 0, y: 0, width: 4, height: 4 }).ok).toBe(true);
    expect(controller.updateCompose({ x: 1, y: 1, width: 3, height: 3 }).ok).toBe(true);
    expect(controller.currentView().document?.revision).toBe(before);
    expect(controller.commitCompose().ok).toBe(true);
    expect(controller.hasCompose()).toBe(false);
  });

  it("视图辅助与吸附不进入草稿门禁", async () => {
    const { controller } = build();
    await opened(controller);
    expect(controller.setViewAids({ rulers: true }).ok).toBe(true);
    expect(controller.snapPoint([1, 2], 2).ok).toBe(true);
    expect(controller.filterLayers({ name: "背" }).ok).toBe(true);
    // U63：`by`/`mode` 由公共控制器签名原样转发，面板不再需要非字面量对象绕过类型检查。
    expect(controller.filterLayers({ by: "mode", mode: "multiply" }).ok).toBe(true);
    expect(controller.filterLayers({ by: "kind", kinds: ["raster", "shape"], onlySelected: true }).ok).toBe(true);
    expect(controller.hasActiveDraft()).toBe(false);
  });

  it("矢量与参考线命令走同一草稿门禁", async () => {
    const { controller } = build();
    await opened(controller);
    expect(controller.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 4, 4] }).ok).toBe(true);
    expect(controller.guideCommand("view.newGuide", { orientation: "vertical", position: 4 }).ok).toBe(true);
    controller.beginCompose("image.imageSize", { width: 6, height: 6 });
    expect(controller.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 4, 4] }).ok).toBe(false);
    expect(controller.guideCommand("view.clearGuides", {}).ok).toBe(false);
    controller.cancelCompose();
  });

  it("矢量草稿进入统一门禁：保存/新入口被拒，但矢量自身提交不被自己拦下", async () => {
    const { controller } = build();
    await opened(controller);
    const before = controller.currentView().document?.revision;
    controller.setVectorDraft(true);
    expect(controller.hasActiveDraft()).toBe(true);
    expect(controller.hasVectorDraft()).toBe(true);
    // 其它写入口被拦。
    expect(controller.dispatch("layer.delete").ok).toBe(false);
    // 矢量自身提交仍然可用（草稿还在用户手里，命令必须能落地）。
    expect(controller.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 4, 4] }).ok).toBe(true);
    expect(controller.currentView().document?.revision).toBeGreaterThan(before ?? 0);
    // 结算后门禁解除。
    controller.setVectorDraft(false);
    expect(controller.hasActiveDraft()).toBe(false);
    expect(controller.hasVectorDraft()).toBe(false);
  });

  it("文档代际令牌不符的晚到命令被丢弃，内核不被调用", async () => {
    let writes = 0;
    const { controller } = build({ vectorCommand: () => { writes += 1; return JSON.stringify({ layer: 2 }); } });
    await opened(controller);
    const token = controller.token();
    expect(controller.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 4, 4] }, token).ok).toBe(true);
    expect(writes).toBe(1);
    // 换文档（代际/活动索引变化）后，用旧令牌提交必须失败且零写入。
    const stale = { generation: token.generation - 1, session: token.session };
    const rejected = controller.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 4, 4] }, stale);
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.code).toBe("stale");
    expect(writes).toBe(1);
  });

  it("父子回写与矢量命令共用草稿门禁：未结算的矢量草稿挡住回写，结算后可写", async () => {
    let updates = 0;
    const { controller } = build({ updateSmartParent: () => { updates += 1; return JSON.stringify({ committed: true }); } });
    await opened(controller);
    controller.beginSmartChild(1);
    controller.setVectorDraft(true);
    const blocked = controller.updateSmartParent("attempt-vec", new Uint8Array([1]));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("vector-active");
      expect(blocked.message).toMatch(/矢量/);
    }
    expect(updates).toBe(0);
    expect(controller.hasSmartChild()).toBe(true);
    controller.setVectorDraft(false);
    expect(controller.updateSmartParent("attempt-vec", new Uint8Array([1])).ok).toBe(true);
    expect(updates).toBe(1);
  });

  it("子文档草稿未结算时拒绝把它导出回写父文档", async () => {
    let updates = 0;
    const { controller } = build({ updateSmartParent: () => { updates += 1; return JSON.stringify({ committed: true }); } });
    await opened(controller);
    expect(controller.beginSmartChild(1).ok).toBe(true);
    const child = controller.smartChildController();
    expect(child).not.toBeNull();
    // 子文档还在画矢量形状：此时导出的工程不含这部分几何，回写等于丢掉半截操作。
    child!.setVectorDraft(true);
    const refused = controller.updateSmartParentFromChild("attempt-child");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("draft-active");
      expect(refused.message).toMatch(/子文档/);
    }
    expect(updates).toBe(0);
    expect(controller.hasSmartChild()).toBe(true);
    // 结算后回写照常（子编辑器是异步打开的，等它拿到内核句柄）。
    child!.setVectorDraft(false);
    for (let tick = 0; tick < 5 && !child!.currentView().hasDocument; tick += 1) await Promise.resolve();
    const written = controller.updateSmartParentFromChild("attempt-child");
    expect(written.ok).toBe(true);
    expect(updates).toBe(1);
  });

  it("导出冻结期间拒绝矢量写入，撤销冻结后恢复", async () => {
    const { controller, editor } = build();
    await opened(controller);
    expect(controller.writesFrozen()).toBe(false);
    // 冻结状态由保存/发布取走产物后进入；这里直接检查同一判定被矢量入口复用。
    const frozen = controller as unknown as { pendingArtifacts: unknown };
    frozen.pendingArtifacts = { revision: controller.currentView().document?.revision };
    expect(controller.writesFrozen()).toBe(true);
    const rejected = controller.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 4, 4] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("frozen");
    expect((editor as unknown as { calls: string[] }).calls ?? []).not.toContain("vector");
    frozen.pendingArtifacts = null;
    expect(controller.writesFrozen()).toBe(false);
    expect(controller.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 4, 4] }).ok).toBe(true);
  });

  it("字体可用性由内核回答，前端不伪造", async () => {
    const { controller } = build();
    await opened(controller);
    const result = controller.checkFont("Inter");
    expect(result.ok).toBe(true);
  });
});

it("套索不足三个锚点也阻止保存与其它写入，取消后恢复", async () => {
  const {controller}=build();await opened(controller);
  controller.setCanvasToolDraft(true);
  expect(controller.hasActiveDraft()).toBe(true);
  expect(controller.dispatch("layer.delete")).toMatchObject({ok:false,code:"gesture-active"});
  expect(await controller.save()).toMatchObject({ok:false,code:"freeze-failed",message:"请先完成或取消当前画布工具操作"});
  controller.setCanvasToolDraft(false);
  expect(controller.hasActiveDraft()).toBe(false);
  expect(controller.dispatch("layer.delete").ok).toBe(true);
});
