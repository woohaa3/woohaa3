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
  const value = {
    dispose,
    isDirty: () => false,
    currentState: () => ({ phase: "editing", message: null, dirty: false, retriable: false }),
    hasLayerProperties: () => false,
    hasAdjustment: () => false,
    hasText: () => false,
    hasTransform: () => false
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
    (controllerValue as unknown as { hasText: () => boolean }).hasText = () => true;
    expect(pendingDraftOf(controllerValue)).toBe("请先确认或取消文字编辑");
    (controllerValue as unknown as { hasText: () => boolean }).hasText = () => false;
    expect(pendingDraftOf(controllerValue)).toBeNull();
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
    await view.start();
    expect(view.previewState()).toBeNull();
    view.setEditorPreview({ width: 2, height: 2, pixels: new Uint8Array(16) }, { width: 800, height: 400 });
    expect(view.displaySize()).toEqual({ width: 800, height: 400 });
    expect(view.focus.viewportState().zoom).toBeCloseTo(0.5);
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
