/**
 * 多文档工作区会话回归
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 1.2/1.4 / design D1/D3/D8）。
 *
 * 用替身呈现与控制器覆盖：身份分源、活动绑定、关闭后资源释放、代际隔离、后台保存归属。
 * 不加载 wasm、不采集渲染。
 */
import { describe, expect, it, vi } from "vitest";
import { EditorDocumentRegistry, type EditorDocumentEntry } from "@woohaa3/photocraft-editor";
import { DocumentWorkspaceSession, pendingDraftOf, type DocumentResource } from "../src/document-session.js";
import { FileDocumentWorkspace } from "../src/file-document-workspace.js";
import type { EditorWorkspaceController } from "../src/editor-workspace.js";
import type { ImageFocusWorkspace } from "../src/workspace.js";

/** 节点呈现替身：记录释放与内容替换。 */
function nodeView(nodeId: string) {
  const dispose = vi.fn();
  const replaceContent = vi.fn(async () => undefined);
  const subscriptions = new Set<() => void>();
  const view = {
    nodeId,
    projectDocument: () => null,
    baseAsset: () => ({ id: `asset-${nodeId}` }),
    project: {
      isDirty: () => false,
      currentPhase: () => "editing",
      conversionFallbackReason: () => null,
      beginProjectConversion: () => undefined,
      establishBaseline: () => undefined
    },
    focus: { sourceWidth: 800, sourceHeight: 600, viewportState: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: () => undefined, setFitZoom: () => undefined, currentFitZoom: () => 1, adoptSourceSize: () => undefined },
    subscribe: (listener: () => void) => { subscriptions.add(listener); return () => subscriptions.delete(listener); },
    revisionState: () => 0,
    contentRevisionState: () => 0,
    isPresentationReady: () => true,
    isTransitioning: () => false,
    isReadOnlyPreview: () => false,
    historyOverrideState: () => null,
    setHistoryOverride: () => undefined,
    previewStatus: () => null,
    setViewport: () => undefined,
    setEditorPreview: () => undefined,
    setEditorDetails: () => undefined,
    detailViewportSize: () => ({ width: 800, height: 600 }),
    setRect: () => undefined,
    preserveNextLayoutViewport: () => undefined,
    replaceContent,
    dispose
  } as unknown as ImageFocusWorkspace;
  return { view, dispose, replaceContent };
}

/** 控制器替身：只实现会话关心的部分。 */
function controller() {
  const dispose = vi.fn();
  let vectorDraft = false;
  const value = {
    dispose,
    isDirty: () => false,
    currentState: () => ({ phase: "editing", message: null, dirty: false, retriable: false }),
    // 真实控制器把 `blockingDraft()` 以这个名字暴露给宿主；替身默认「没有草稿」。
    pendingDraftFailure: () => null,
    isSaving: () => false,
    hasLayerProperties: () => false,
    hasAdjustment: () => false,
    hasText: () => false,
    hasTransform: () => false,
    // 本域只暴露"有没有必须先结算的草稿"，宿主不复制它的状态机。
    features: { selections: { unsettledDraftReason: () => null as string | null } },
    hasVectorDraft: () => vectorDraft,
    hasActiveDraft: () => vectorDraft,
    setVectorDraft: (active: boolean) => { vectorDraft = active; }
  } as unknown as EditorWorkspaceController;
  return { controller: value, dispose };
}
function harness() {
  const views = new Map<string, ReturnType<typeof nodeView>>();
  const controllers = new Map<string, ReturnType<typeof controller>>();
  const changes = vi.fn();
  const registry = new EditorDocumentRegistry(8);
  const session = new DocumentWorkspaceSession(registry, {
    canvasId: () => "c1",
    createNodeView: (nodeId) => {
      const created = nodeView(nodeId);
      views.set(nodeId, created);
      return created.view;
    },
    createController: (resource) => {
      const created = controller();
      controllers.set(resource.documentId, created);
      return created.controller;
    },
    decodeImage: async () => ({ width: 640, height: 480 }),
    rect: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    onChange: changes
  });
  return { session, registry, views, controllers, changes };
}

describe("文档身份与打开", () => {
  it("同一节点复用文档与控制器；复制节点与文件各自独立", async () => {
    const h = harness();
    const first = h.session.openNode({ nodeId: "n1", name: "图片 1", writable: true });
    expect(first).toMatchObject({ ok: true, created: true });
    const again = h.session.openNode({ nodeId: "n1", name: "图片 1", writable: true });
    expect(again).toMatchObject({ ok: true, created: false, documentId: (first as { documentId: string }).documentId });
    // 控制器只创建一次（切换不重建内核）。
    expect(h.controllers.size).toBe(1);

    h.session.openNode({ nodeId: "n1-copy", name: "图片 1", writable: true });
    h.session.openFile({ fileName: "same.png", bytes: new Uint8Array([1]), kind: "image" });
    h.session.openFile({ fileName: "same.png", bytes: new Uint8Array([2]), kind: "image" });
    expect(h.session.metrics()).toMatchObject({ documents: 4, nodeDocuments: 2, fileDocuments: 2 });
  });

  it("目标不可呈现时不留下空 tab", () => {
    const h = harness();
    // createNodeView 返回 null（目标不可编辑）。
    h.session = new DocumentWorkspaceSession(h.registry, {
      canvasId: () => "c1",
      createNodeView: () => null,
      createController: (resource) => { const created = controller(); h.controllers.set(resource.documentId, created); return created.controller; },
      rect: () => ({ x: 0, y: 0, width: 1000, height: 700 })
    });
    const opened = h.session.openNode({ nodeId: "gone", name: "图片", writable: true });
    expect(opened.ok).toBe(false);
    expect(h.session.metrics().documents).toBe(0);
    expect(h.session.activeId()).toBeNull();
  });

  it("达到上限时拒绝新打开且保留已有文档", () => {
    const h = harness();
    for (let index = 0; index < 8; index++) {
      h.session.openFile({ fileName: `f${index}.png`, bytes: new Uint8Array([index]), kind: "image" });
    }
    const rejected = h.session.openFile({ fileName: "overflow.png", bytes: new Uint8Array([9]), kind: "image" });
    expect(rejected).toMatchObject({ ok: false });
    if (rejected.ok) return;
    expect(rejected.reason).toContain("最多同时打开 8 个文档");
    expect(h.session.metrics().documents).toBe(8);
  });

  it("按呈现/控制器反查资源，保存能落到发起保存的文档（A2）", () => {
    // 回归：`projectPort.save` 曾忽略入参、改取 `session.active()`，多标签下切过 tab 之后
    // 「应用到节点」会写到另一篇文档或错误节点。反查是修复的前提。
    const h = harness();
    const first = h.session.openNode({ nodeId: "n1", name: "海报", writable: true });
    const second = h.session.openNode({ nodeId: "n2", name: "橘猫", writable: true });
    if (!first.ok || !second.ok) throw new Error("打开失败");
    // n2 是活动文档；用 n1 的呈现与控制器保存必须解析到 n1。
    expect(h.session.activeId()).toBe(second.documentId);
    const resource = h.session.resource(first.documentId)!;
    expect(h.session.findByView(resource.view)?.documentId).toBe(first.documentId);
    expect(h.session.findByController(resource.controller)?.documentId).toBe(first.documentId);
    expect(h.session.findByNode("n1")?.documentId).toBe(first.documentId);
    expect(h.session.findByNode("n2")?.documentId).toBe(second.documentId);
    // 未知身份不伪造结果（调用方退回 active）。
    expect(h.session.findByNode("n3")).toBeNull();
    expect(h.session.findByView({})).toBeNull();
    expect(h.session.findByController(null)).toBeNull();
  });

  it("每次打开都是一次新的编辑会话身份（A2）", () => {
    // 回归：sessionId 曾经按 `image-edit:<canvas>:<node>` 恒定复用。服务端 `begin:<sessionId>`
    // 幂等返回第一次的基线、complete 又优先用持久化基线，于是该节点保存成功过一次之后，
    // 之后每次提交都被判基线过期（库里能看到成串的 EDIT_SESSION_BASELINE_STALE）。
    const h = harness();
    const first = h.session.openNode({ nodeId: "n1", name: "海报", writable: true });
    if (!first.ok) throw new Error("打开失败");
    const a = h.session.resource(first.documentId)!;
    expect(a.kind).toBe("node");
    const firstSession = a.sessionId;
    expect(firstSession).toMatch(/^img-session-/);
    // 关闭后重开同一节点 → 新会话（重新捕获基线）。
    h.session.close(first.documentId);
    const again = h.session.openNode({ nodeId: "n1", name: "海报", writable: true });
    if (!again.ok) throw new Error("重开失败");
    expect(h.session.resource(again.documentId)!.sessionId).not.toBe(firstSession);
  });

  it("节点标签的 detail 只在显式给出时写入，不回落到内部节点 id（A12）", () => {
    const h = harness();
    const opened = h.session.openNode({ nodeId: "asset-image-c5d9f2e9", name: "开业海报", writable: true, detail: "图片" });
    if (!opened.ok) throw new Error("打开失败");
    const entry = h.registry.entry(opened.documentId)!;
    expect(entry.name).toBe("开业海报");
    expect(entry.detail).toBe("图片");
    // 未给 detail 时保持注册表默认（节点身份仍可见于 source），不额外暴露更长 id 到画面。
    const plain = h.session.openNode({ nodeId: "n2", name: "橘猫", writable: true });
    if (!plain.ok) throw new Error("打开失败");
    expect(h.registry.entry(plain.documentId)!.name).toBe("橘猫");
  });
});

describe("活动绑定与关闭", () => {
  it("关闭释放控制器与呈现，激活左邻项", () => {
    const h = harness();
    const a = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    const b = h.session.openNode({ nodeId: "n2", name: "B", writable: true });
    if (!a.ok || !b.ok) throw new Error("open failed");
    h.session.activate(a.documentId);
    const closed = h.session.close(b.documentId);
    expect(closed).toMatchObject({ ok: true, nextActiveId: a.documentId });
    expect(h.controllers.get(b.documentId)?.dispose).toHaveBeenCalledOnce();
    expect(h.views.get("n2")?.dispose).toHaveBeenCalledOnce();
  });

  it("关闭最后一项后没有活动文档", () => {
    const h = harness();
    const a = h.session.openFile({ fileName: "a.png", bytes: new Uint8Array([1]), kind: "image" });
    if (!a.ok) return;
    expect(h.session.close(a.documentId)).toMatchObject({ ok: true, nextActiveId: null });
    expect(h.session.activeId()).toBeNull();
  });

  it("代际递增使旧回调失效", () => {
    const h = harness();
    const opened = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!opened.ok) return;
    const entry = h.registry.entry(opened.documentId)!;
    expect(h.registry.isCurrent(entry.id, entry.generation)).toBe(true);
    const next = h.session.beginContentReplacement(entry.id);
    expect(next).toBeGreaterThan(entry.generation);
    expect(h.registry.isCurrent(entry.id, entry.generation)).toBe(false);
  });

  it("节点失效标为不可写但仍保留内容", () => {
    const h = harness();
    const opened = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!opened.ok) return;
    h.session.setWritable(opened.documentId, false);
    h.session.setStatus(opened.documentId, "unavailable", "节点已被删除");
    const entry = h.registry.entry(opened.documentId)!;
    expect(entry).toMatchObject({ writable: false, status: "unavailable" });
    // 仍可读取出净变化状态（供导出/关闭）。
    expect(h.session.dirtyState(opened.documentId)).not.toBeNull();
  });
});

describe("门禁与草稿", () => {
  it("未确认的受控草稿阻止切换（由导航门禁查询）", () => {
    const h = harness();
    const opened = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!opened.ok) return;
    const controllerValue = h.controllers.get(opened.documentId)!.controller;
    // 走控制器的权威入口：宿主不再自己列草稿种类。
    (controllerValue as unknown as { pendingDraftFailure: () => unknown }).pendingDraftFailure =
      () => ({ ok: false, code: "text-active", message: "请先确认或取消文字编辑" });
    expect(pendingDraftOf(controllerValue)).toBe("请先确认或取消文字编辑");
    (controllerValue as unknown as { pendingDraftFailure: () => unknown }).pendingDraftFailure = () => null;
    expect(pendingDraftOf(controllerValue)).toBeNull();
  });

  it("滤镜草稿期间切换标签被会话本身拒绝（不依赖 UI 先拦一次）", () => {
    const h = harness();
    const a = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    const b = h.session.openNode({ nodeId: "n2", name: "B", writable: true });
    if (!a.ok || !b.ok) throw new Error("open failed");
    h.session.activate(a.documentId);
    const controllerValue = h.controllers.get(a.documentId)!.controller;
    // 滤镜草稿：旧写法在宿主侧漏掉了这一种，现在统一由 `blockingDraft()` 给出。
    const gate = controllerValue as unknown as { pendingDraftFailure: () => unknown };
    gate.pendingDraftFailure = () => ({ ok: false, code: "filter-active", message: "请先确认或取消滤镜草稿" });
    expect(h.session.activate(b.documentId)).toEqual({ ok: false, reason: "请先确认或取消滤镜草稿" });
    // 门禁拒绝时活动项不变：不能留下「tab 已经切走、文档还开着草稿」的状态。
    expect(h.session.activeId()).toBe(a.documentId);
    gate.pendingDraftFailure = () => null;
    expect(h.session.activate(b.documentId)).toMatchObject({ ok: true, nextActiveId: b.documentId });
  });

  it("保存中拒绝切换与关闭（等待权威回执）", () => {
    const h = harness();
    const a = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    const b = h.session.openNode({ nodeId: "n2", name: "B", writable: true });
    if (!a.ok || !b.ok) throw new Error("open failed");
    h.session.activate(a.documentId);
    const controllerValue = h.controllers.get(a.documentId)!.controller;
    (controllerValue as unknown as { isSaving: () => boolean }).isSaving = () => true;
    expect(h.session.activate(b.documentId)).toEqual({ ok: false, reason: "文档正在保存，请等待完成后再切换或关闭" });
    expect(h.session.close(a.documentId)).toEqual({ ok: false, reason: "文档正在保存，请等待完成后再切换或关闭" });
    expect(h.controllers.get(a.documentId)?.dispose).not.toHaveBeenCalled();
  });

  it("草稿期间关闭被拒绝，结算后可以关闭", () => {
    const h = harness();
    const opened = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!opened.ok) return;
    const controllerValue = h.controllers.get(opened.documentId)!.controller;
    const gate = controllerValue as unknown as { pendingDraftFailure: () => unknown };
    gate.pendingDraftFailure = () => ({ ok: false, code: "text-active", message: "请先确认或取消文字编辑" });
    expect(h.session.close(opened.documentId)).toEqual({ ok: false, reason: "请先确认或取消文字编辑" });
    expect(h.controllers.get(opened.documentId)?.dispose).not.toHaveBeenCalled();
    gate.pendingDraftFailure = () => null;
    expect(h.session.close(opened.documentId)).toMatchObject({ ok: true });
    expect(h.controllers.get(opened.documentId)?.dispose).toHaveBeenCalledOnce();
  });

  it("草稿期间打开新文档也被拒绝（打开会切走活动文档）", () => {
    const h = harness();
    const a = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!a.ok) throw new Error("open failed");
    const gate = h.controllers.get(a.documentId)!.controller as unknown as { pendingDraftFailure: () => unknown };
    gate.pendingDraftFailure = () => ({ ok: false, code: "stroke-active", message: "请先结束当前笔迹" });
    expect(h.session.openFile({ fileName: "b.png", bytes: new Uint8Array([1]), kind: "image" })).toEqual({
      ok: false, reason: "请先结束当前笔迹"
    });
    expect(h.session.openNode({ nodeId: "n2", name: "B", writable: true })).toEqual({
      ok: false, reason: "请先结束当前笔迹"
    });
    // 拒绝时不留下空条目：既没有新 tab，活动项也没变。
    expect(h.session.size()).toBe(1);
    expect(h.session.activeId()).toBe(a.documentId);
    gate.pendingDraftFailure = () => null;
    expect(h.session.openNode({ nodeId: "n2", name: "B", writable: true })).toMatchObject({ ok: true, created: true });
  });

  it("重开已打开的节点同样走门禁，不从「已开着」的路径绕过", () => {
    const h = harness();
    const a = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    const b = h.session.openNode({ nodeId: "n2", name: "B", writable: true });
    if (!a.ok || !b.ok) throw new Error("open failed");
    h.session.activate(b.documentId);
    const gate = h.controllers.get(b.documentId)!.controller as unknown as { pendingDraftFailure: () => unknown };
    gate.pendingDraftFailure = () => ({ ok: false, code: "filter-active", message: "请先确认或取消滤镜草稿" });
    expect(h.session.openNode({ nodeId: "n1", name: "A", writable: true })).toEqual({
      ok: false, reason: "请先确认或取消滤镜草稿"
    });
    expect(h.session.activeId()).toBe(b.documentId);
  });

  it("关闭后重开同一节点得到新代际，旧文档的计划不可能对上新文档", () => {
    const h = harness();
    const first = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!first.ok) return;
    const before = h.registry.entry(first.documentId)!.generation;
    const firstController = h.controllers.get(first.documentId)!.controller;
    h.session.close(first.documentId);
    const again = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!again.ok) return;
    expect(again.created).toBe(true);
    expect(h.registry.entry(again.documentId)!.generation).toBeGreaterThan(before);
    expect(h.registry.isCurrent(first.documentId, before)).toBe(false);
    // 重建后是新控制器实例：上一会话的计划不会落到新文档上。
    expect(h.controllers.get(again.documentId)!.controller).not.toBe(firstController);
  });

  it("活动选区草稿阻止切换，文案由本域给出（不在这里重写一遍）", () => {
    const h = harness();
    const opened = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!opened.ok) return;
    const controllerValue = h.controllers.get(opened.documentId)!.controller;
    const target = controllerValue as unknown as {
      features: { selections: { unsettledDraftReason: () => string | null } };
    };
    // 宿主只搬运本域判定结果：改这里的文案就等于改本域文案，说明没有第二份实现。
    target.features.selections.unsettledDraftReason = () => "请先确认或取消选区草稿";
    expect(pendingDraftOf(controllerValue)).toBe("请先确认或取消选区草稿");
    // 内核草稿结算后立刻放行（过期草稿被丢弃时也是这样）。
    target.features.selections.unsettledDraftReason = () => null;
    expect(pendingDraftOf(controllerValue)).toBeNull();
  });

  it("选区草稿也进关闭/离开的结算计划（脏状态回执带上原因）", () => {
    const h = harness();
    const opened = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!opened.ok) return;
    const controllerValue = h.controllers.get(opened.documentId)!.controller;
    (controllerValue as unknown as {
      features: { selections: { unsettledDraftReason: () => string | null } };
    }).features.selections.unsettledDraftReason = () => "请先确认或取消选区草稿";
    expect(h.session.dirtyState(opened.documentId)?.pendingDraft).toBe("请先确认或取消选区草稿");
  });

  it("未结算的矢量草稿阻止切换、关闭与离开", () => {
    const h = harness();
    const opened = h.session.openNode({ nodeId: "n1", name: "A", writable: true });
    if (!opened.ok) return;
    const controllerValue = h.controllers.get(opened.documentId)!.controller;
    controllerValue.setVectorDraft(true);
    expect(controllerValue.hasVectorDraft()).toBe(true);
    expect(pendingDraftOf(controllerValue)).toBe("请先完成或取消当前矢量操作");
    // 同一草稿也进入统一门禁：保存/换文档的判定与宿主呈现使用同一原因。
    expect(controllerValue.hasActiveDraft()).toBe(true);
    controllerValue.setVectorDraft(false);
    expect(pendingDraftOf(controllerValue)).toBeNull();
    expect(controllerValue.hasActiveDraft()).toBe(false);
  });
});

describe("独立文件文档", () => {
  it("打开图片文件得到源尺寸与适合窗口取景，不伪造节点身份", async () => {
    const view = new FileDocumentWorkspace({
      documentId: "file-1",
      fileName: "art.png",
      kind: "image",
      bytes: new Uint8Array([1, 2, 3]),
      rect: { x: 0, y: 0, width: 640, height: 480 },
      decodeImage: async () => ({ width: 1280, height: 960 })
    });
    expect(view.nodeId).toBeNull();
    expect(view.isPresentationReady()).toBe(false);
    await expect(view.start()).resolves.toBe(true);
    expect(view.focus.sourceWidth).toBe(1280);
    expect(view.focus.sourceHeight).toBe(960);
    // 适合窗口：1280×960 放进 640×480 → 0.5。
    expect(view.focus.viewportState().zoom).toBeCloseTo(0.5);
    // 文件文档没有可信磁盘写入：版本历史与工程定义都不存在。
    expect(view.historyOverrideState()).toBeNull();
    expect(view.projectDocument()).toBeNull();
    // 位图文件仍以图片方式打开内核（只有 `.pcraft` 走工程路径）。
    expect(view.openMode()).toBe("image");
    view.dispose();
    expect(view.isPresentationReady()).toBe(true);
  });

  it("工程文件等待内核给出尺寸；预览发布更新源尺寸与取景", async () => {
    const view = new FileDocumentWorkspace({
      documentId: "file-2",
      fileName: "art.pcraft",
      kind: "project",
      bytes: new Uint8Array([9]),
      rect: { x: 0, y: 0, width: 400, height: 400 }
    });
    // 回归：`.pcraft` 是分层工程包，必须声明走工程打开，不能被当成位图解码。
    expect(view.openMode()).toBe("project");
    expect(view.projectDocument()).toBeNull();
    await view.start();
    expect(view.previewState()).toBeNull();
    view.setEditorPreview({ width: 2, height: 2, pixels: new Uint8Array(16) }, { width: 800, height: 400 });
    expect(view.displaySize()).toEqual({ width: 800, height: 400 });
    expect(view.focus.viewportState().zoom).toBeCloseTo(0.5);
    view.dispose();
  });

  it("浏览器解码不了的格式交给内核，不用浏览器能力冒充打开结果", async () => {
    // TIFF/QOI/TGA/PNM/PCX/XPM/DDS：`createImageBitmap` 一律失败，但内核能解码。
    // 这里必须先进「打开中」（start 成功、无尺寸），尺寸与像素由内核首帧预览补上；
    // 若在这里就返回 false，U05 新增格式会在宿主里完全打不开。
    const view = new FileDocumentWorkspace({
      documentId: "file-tif",
      fileName: "scan.tif",
      kind: "image",
      bytes: new Uint8Array([0x49, 0x49, 0x2a, 0x00]),
      rect: { x: 0, y: 0, width: 640, height: 480 },
      decodeImage: async () => null
    });
    await expect(view.start()).resolves.toBe(true);
    expect(view.isPresentationReady()).toBe(true);
    // 还没有尺寸：等内核发布预览，而不是自己编一个。
    expect(view.focus.sourceWidth).toBe(0);
    expect(view.previewStatus()).toBeNull();
    view.setEditorPreview({ width: 120, height: 80, pixels: new Uint8Array(120 * 80 * 4) }, { width: 120, height: 80 });
    expect(view.focus.sourceWidth).toBe(120);
    expect(view.focus.sourceHeight).toBe(80);
    view.dispose();
  });

  it("释放后不再接受预览/细节（迟到结果不复活）", async () => {
    const view = new FileDocumentWorkspace({
      documentId: "file-3",
      fileName: "art.png",
      kind: "image",
      bytes: new Uint8Array([1]),
      rect: { x: 0, y: 0, width: 100, height: 100 },
      decodeImage: async () => ({ width: 10, height: 10 })
    });
    await view.start();
    view.dispose();
    view.setEditorPreview({ width: 1, height: 1, pixels: new Uint8Array(4) }, { width: 10, height: 10 });
    expect(view.previewState()).toBeNull();
  });
});

void (null as unknown as DocumentResource);
void (null as unknown as EditorDocumentEntry);
