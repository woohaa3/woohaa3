/**
 * 工作区测试 harness
 * （change: 2026-10-21-add-photocraft-document-workspace）。
 *
 * 用最小替身组合出 `DocumentWorkspaceStore` 的活动绑定，避免在组件测试里构造真实内核。
 */
import type { EditorDocumentEntry, EditorDocumentWorkspaceSnapshot } from "@woohaa3/photocraft-editor";
import type { ActiveDocumentBinding } from "../image-editor-overlay.js";
import type { EditorDocumentView } from "../document-view.js";
import { DocumentWorkspaceStore } from "../workspace-store.js";

export type FakeDocumentView = EditorDocumentView & {
  emit: () => void;
  patch: (patch: Partial<Record<string, unknown>>) => void;
};

/** 构造一个可订阅的最小文档呈现替身。 */
export function fakeDocumentView(overrides: Record<string, unknown> = {}): FakeDocumentView {
  let revision = 0;
  let contentRevision = 0;
  const listeners = new Set<() => void>();
  const base: Record<string, unknown> = {
    nodeId: null,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    revisionState: () => revision,
    contentRevisionState: () => contentRevision,
    projectDocument: () => null,
    project: { currentPhase: () => "view", conversionFallbackReason: () => null, beginProjectConversion: () => undefined, establishBaseline: () => undefined },
    focus: { sourceWidth: 100, sourceHeight: 80, viewportState: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: () => undefined, setFitZoom: () => undefined, currentFitZoom: () => 1, adoptSourceSize: () => undefined },
    isReadOnlyPreview: () => false,
    isPresentationReady: () => true,
    isTransitioning: () => false,
    historyOverrideState: () => null,
    setHistoryOverride: () => undefined,
    previewStatus: () => null,
    setViewport: () => undefined,
    setEditorPreview: () => undefined,
    setEditorDetails: () => undefined,
    detailViewportSize: () => ({ width: 800, height: 600 }),
    setRect: () => undefined,
    preserveNextLayoutViewport: () => undefined,
    dispose: () => undefined,
    ...overrides
  };
  return {
    ...(base as unknown as EditorDocumentView),
    emit: () => { revision += 1; for (const listener of listeners) listener(); },
    patch: (patch) => {
      contentRevision += 1;
      Object.assign(base, patch);
      revision += 1;
      for (const listener of listeners) listener();
    }
  };
}

export function entryOf(overrides: Partial<EditorDocumentEntry> = {}): EditorDocumentEntry {
  return {
    id: "doc-1",
    source: { kind: "node", canvasId: "c1", nodeId: "image" },
    name: "图片",
    detail: "image",
    status: "clean",
    message: null,
    writable: true,
    generation: 1,
    ...overrides
  };
}

export function snapshotOf(entries: readonly EditorDocumentEntry[], activeId: string | null = entries[0]?.id ?? null): EditorDocumentWorkspaceSnapshot {
  return { entries: [...entries], activeId, activeGate: null };
}

export function bindingOf(overrides: Partial<ActiveDocumentBinding> = {}): ActiveDocumentBinding {
  return {
    documentId: "doc-1",
    view: fakeDocumentView(),
    controller: null,
    name: "图片",
    detail: "image",
    nodeDocument: true,
    writable: true,
    contentRevision: 0,
    fileActions: null,
    fileStatus: null,
    fileStatusTone: "info",
    fileBusy: false,
    ...overrides
  };
}

/** 构造一个已发布快照的 store（组件测试用）。 */
export function storeWith(input: {
  entries?: readonly EditorDocumentEntry[];
  active?: ActiveDocumentBinding | null;
  busy?: boolean;
  writable?: boolean;
} = {}): DocumentWorkspaceStore {
  const store = new DocumentWorkspaceStore();
  const entries = input.entries ?? [entryOf()];
  const active = input.active === undefined ? bindingOf() : input.active;
  store.update({ documents: snapshotOf(entries, active?.documentId ?? null), active, busy: input.busy ?? false, writable: input.writable ?? true });
  return store;
}
