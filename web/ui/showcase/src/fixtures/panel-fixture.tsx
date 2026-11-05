/**
 * 生产执行面板的查看页夹具
 * （change: expand-showcase-execution-ux，任务 1.1–1.3 / design D1–D5）。
 *
 * 关键点：查看页渲染的是**生产 `ModelExecutionHost`**，只把它的 IO 依赖换成确定性内存 fixture：
 * - `TaskCatalogService`：进度可控的 catalog（loading / ready / error / 空 / 无可用模型）；
 * - `CanvasRemoteService`：`run/cancel` 只记录请求，不发网络；
 * - `CanvasSession`：`submitCommands` 只记录命令，不写 Y.Doc；
 * - `PromptSnippetSource`：确定性片段搜索与 materialize。
 *
 * fixture 会写**共享的规范画布 store**：这是 `ModelExecutionHost` 的公开组合边界（它从
 * `woohaa3CanvasStore` 解析上下文），不是第二套状态机。`installShowcaseFixture()` 在 story
 * 挂载时重置 store / 草稿 / 选择 / 操作记录，因此 story 之间互不影响。
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { CanvasTaskCatalog, ServerCanvas } from "@woohaa3/contracts";
import {
  applyCanvasCommands,
  type CanvasCommand
} from "@woohaa3/contracts";
import { ModelExecutionHost } from "../../../../frontend/src/cordis/plugins/task-execution/model-execution-host.js";
import { ExecutionPanelSkeleton, ExecutionPanelSurface } from "../../../../frontend/src/cordis/plugins/task-execution/execution-panel-surface.js";
import { GenericModelPanel } from "../../../../frontend/src/cordis/plugins/task-execution/generic-panel.js";
import { ModelInteractionService } from "../../../../frontend/src/cordis/services/model-interaction-service.js";
import { SeedanceVideoPanel } from "../../../../frontend/src/cordis/plugins/video-capture/seedance-panel.js";
import { normalizeVideoEditIntents } from "@woohaa3/contracts";
import { createModelDraftStore } from "../../../../frontend/src/cordis/plugins/task-execution/model-draft.js";
import type { ExecutionPanelPresentation } from "../../../../frontend/src/cordis/navigation/contracts.js";
import type { CanvasRuntimeService } from "../../../../frontend/src/cordis/contracts.js";
import { DialogService } from "../../../../frontend/src/cordis/services/dialogs/service.js";
import { ALERT_DIALOG_ID, alertDefinition } from "../../../../frontend/src/cordis/services/dialogs/alert-dialog.js";
import { nodeDraftStore } from "../../../../frontend/src/cordis/plugins/task-execution/drafts.js";
import { woohaa3CanvasStore } from "../../../../frontend/src/cordis/services/canvas-state/index.js";
import { nodeSelectionStore } from "../../../../frontend/src/cordis/services/selection-store.js";
import { parameterPreviewStore } from "../../../../frontend/src/cordis/services/parameter-preview.js";
import type {
  CanvasCancelResult,
  CanvasRemoteService,
  CanvasRunRequest,
  CanvasRunResult,
  CanvasSession,
  CatalogState,
  ParameterPreviewService,
  PromptSnippetSource,
  TaskCatalogService
} from "../../../../frontend/src/cordis/contracts.js";
import { CATALOG_FIXTURES, DEFAULT_CATALOG_ID, type CatalogFixtureId } from "./catalog.js";
import { CANVAS_NODES, baseCanvas } from "./canvas.js";
import { OPERATIONS, clearOperations, createOperationLog, recordOperation, type OperationLog } from "./operations.js";
import { SNIPPET_FIXTURES } from "./snippets.js";
import { disposeVideoPreviews } from "./video-preview.js";
export { CATALOG_FIXTURES, DEFAULT_CATALOG_ID };
export type { CatalogFixtureId };

// ---------------------------------------------------------------------------
// Catalog fixture（loading / ready / error / 空 / 无可用模型）
// ---------------------------------------------------------------------------

/** 可程序化推进的目录服务：`load()` 后按 fixture 进入 loading → ready/error。 */
export class FixtureCatalogService implements TaskCatalogService {
  private listeners = new Set<() => void>();
  private state: CatalogState = { status: "loading" };
  private readonly table: TaskCatalogService;

  constructor(id: CatalogFixtureId) {
    this.table = CATALOG_FIXTURES[id].service();
  }

  getState = (): CatalogState => this.state;
  invalidate(): void {
    this.table.invalidate();
    this.state = { status: "loading" };
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async load(force = false): Promise<void> {
    if (this.state.status === "ready" && !force) return;
    if (this.state.status !== "loading") {
      this.state = { status: "loading" };
      this.emit();
    }
    await this.table.load(force);
    // 推进到最终态；`useTaskCatalog` 在 effect 里首次调用时看到的是 loading。
    this.state = this.table.getState();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// 远端 / 会话 / 参数预览 / 片段来源
// ---------------------------------------------------------------------------

/** 记录 run/cancel 的远端替身；永不发网络。 */
export function createFixtureCanvasRemote(operations: OperationLog): CanvasRemoteService {
  const notImplemented = async () => {
    throw new Error("查看页不实现该远端能力");
  };
  return {
    issueWorldToolContext: notImplemented as never,
    revokeWorldToolContext: notImplemented as never,
    saveWorldCamera: notImplemented as never,
    restoreWorldCamera: notImplemented as never,
    listWorldCameraHistory: notImplemented as never,
    prepareSceneArea: notImplemented as never,
    executeSceneArea: notImplemented as never,
    historySceneArea: notImplemented as never,
    prepareWorldConversion: notImplemented as never,
    commitWorldConversion: notImplemented as never,
    freezeWorldCapture: notImplemented as never,
    listPendingPageCaptures: notImplemented as never,
    listWorldCaptureStatuses: notImplemented as never,
    commitPageVideoCapture: notImplemented as never,
    commitPageCapture: notImplemented as never,
    mergeNodeHistory: async () => ({ ok: false, error: "fixture has no history merge" }) as never,
    openCanvasSession: (() => {
      throw new Error("查看页不打开同步 socket");
    }) as unknown as CanvasRemoteService["openCanvasSession"],
    closeCanvasSession: (() => undefined) as unknown as CanvasRemoteService["closeCanvasSession"],
    // 查看页没有物理连接可重建（change: 2026-10-21-recover-canvas-connection-explicitly）。
    reconnectCanvasSession: (() => undefined) as unknown as CanvasRemoteService["reconnectCanvasSession"],
    run: (request: CanvasRunRequest): Promise<CanvasRunResult> => {
      operations.record(OPERATIONS.RUN, request);
      return Promise.resolve({ ok: true, runId: request.runId, jobId: request.jobId });
    },
    cancel: (input): Promise<CanvasCancelResult> => {
      operations.record(OPERATIONS.CANCEL, input);
      return Promise.resolve({ ok: true });
    },
    reportModelScript: notImplemented as unknown as CanvasRemoteService["reportModelScript"],
    clearNodeHistory: notImplemented as never,
    listNodeHistory: notImplemented as never,
    listCanvasHistory: notImplemented as never,
    getNodeHistoryDetail: notImplemented as never,
    applyNodeHistory: notImplemented as never,
    nodeHistoryPreviewUrl: notImplemented as never,
    verifyImageProjectReferences: notImplemented as never,
    editBegin: notImplemented as never,
    editComplete: notImplemented as never,
    editStatus: notImplemented as never,
    editAbandon: notImplemented as never,
    listSnippets: notImplemented as never,
    getSnippet: notImplemented as never,
    createSnippet: notImplemented as never,
    updateSnippet: notImplemented as never,
    deleteSnippet: notImplemented as never,
    listSnippetTags: notImplemented as never,
    createSnippetTag: notImplemented as never,
    renameSnippetTag: notImplemented as never,
    deleteSnippetTag: notImplemented as never,
    resolveSnippetMaterial: notImplemented as never,
    taskActivitySnapshot: notImplemented as never,
    taskActivityChanges: notImplemented as never,
    subscribeTaskActivity: (() => () => undefined) as unknown as CanvasRemoteService["subscribeTaskActivity"]
  };
}

/**
 * 只记录命令的会话替身。
 *
 * `submitCommands` 走与生产相同的命令 reducer，但落到内存画布副本，不写 Y.Doc、不推进
 * revision。chips / picker 的 play 断言因此能读回真实的命令 payload。
 */
export function createFixtureCanvasSession(options: {
  operations: OperationLog;
  getCanvas: () => ServerCanvas | null;
  setCanvas: (canvas: ServerCanvas) => void;
  onCanvasChanged?: (canvas: ServerCanvas) => void;
  writable?: () => boolean;
}): CanvasSession {
  return {
    getStatus: () => ({
      phase: "ready",
      error: null,
      hydrated: true,
      remote: { mode: "remote", phase: "synced", confirmedRevision: null, pendingCount: 0, error: null }
    }),
    subscribe: () => () => undefined,
    retry: async () => undefined,
    // 查看页不重建连接：显式重连没有可恢复的物理传输
    // （change: 2026-10-21-recover-canvas-connection-explicitly）。
    reconnect: async () => undefined,
    requestHydrate: () => undefined,
    commandLifecycle: () => null,
    isWritable: () => options.writable?.() ?? true,
    shutdown: () => undefined,
    submitCommands: (commands: readonly CanvasCommand[], commandId: string) => {
      options.operations.record(OPERATIONS.SUBMIT_COMMANDS, { commands, commandId });
      const canvas = options.getCanvas();
      if (!canvas) {
        return { ok: false as const, reason: "画布尚未 hydrate" };
      }
      const applied = applyCanvasCommands(canvas, [...commands], {
        now: "2026-09-27T00:00:00.000Z"
      });
      if (!applied.ok) {
        return { ok: false as const, reason: applied.rejection.message, code: applied.rejection.code };
      }
      options.setCanvas(applied.canvas);
      options.onCanvasChanged?.(applied.canvas);
      return {
        ok: true as const,
        handle: {
          commandId,
          state: "committed" as const,
          baseRevision: applied.canvas.revision,
          resultRevision: applied.canvas.revision,
          error: null,
          settled: Promise.resolve(null as never)
        }
      };
    }
  };
}

/** 记录参数预览的替身。 */
export function createFixtureParameterPreview(operations: OperationLog): ParameterPreviewService {
  return {
    set: (nodeId, patch) => {
      operations.record(OPERATIONS.PARAMETER_PREVIEW, { nodeId, patch });
      parameterPreviewStore.set(nodeId, patch);
    },
    get: (nodeId) => parameterPreviewStore.get(nodeId),
    resolve: (nodeId) => parameterPreviewStore.resolve(nodeId),
    clearAll: () => parameterPreviewStore.clearAll(),
    entries: () => parameterPreviewStore.entries(),
    subscribe: (listener) => parameterPreviewStore.subscribe(listener)
  };
}

/** 确定性片段来源：`#` 搜索命中固定表，materialize 生成可读文本。 */
export function createFixtureSnippetSource(operations?: OperationLog): PromptSnippetSource {
  return {
    search: async (query: string) => {
      operations?.record(OPERATIONS.SNIPPET_SEARCH, { query });
      const text = query.trim().toLowerCase();
      return SNIPPET_FIXTURES.filter(
        (snippet) =>
          text === "" ||
          snippet.name.toLowerCase().includes(text) ||
          snippet.body.toLowerCase().includes(text)
      ).map((snippet) => ({ id: snippet.id, name: snippet.name, summary: snippet.summary }));
    },
    materialize: (snippetId) => {
      operations?.record(OPERATIONS.SNIPPET_SELECT, { snippetId });
      return SNIPPET_FIXTURES.find((snippet) => snippet.id === snippetId)?.body ?? null;
    }
  };
}

// ---------------------------------------------------------------------------
// 组合根
// ---------------------------------------------------------------------------

export type FixtureDeps = {
  canvasSession: CanvasSession;
  canvasRemote: CanvasRemoteService;
  dialogs: DialogService;
  taskCatalog: TaskCatalogService;
  parameterPreview: ParameterPreviewService;
  snippetSource: PromptSnippetSource;
  /** 模型交互 Registry（generic Panel 由 fixture 注入，与生产 Host 契约一致）。 */
  registry: ModelInteractionService;
  /** 受控草稿 store（每个 fixture 独立，避免 Story 间串扰）。 */
  draftStore: ReturnType<typeof createModelDraftStore>;
  /** 画布副本的当前值（picker / chips play 断言用）。 */
  readCanvas: () => ServerCanvas;
};

/**
 * 安装一套全新的 fixture（story 挂载前调用）。
 *
 * 这是「不连接真实服务、不写 Y.Doc」的可执行契约：所有副作用都被重置为内存。
 *
 * `onCanvasChanged` 在 picker / chips 命令被接受后触发；story 据此把新的画布重新
 * `hydrate` 进共享 store，让生产 `ModelExecutionHost` 的 chips 立即反映回调结果。
 */
export function installShowcaseFixture(options: {
  catalogId?: CatalogFixtureId;
  canvas?: ServerCanvas;
  onCanvasChanged?: (canvas: ServerCanvas) => void;
} = {}): FixtureDeps {
  clearOperations();
  disposeVideoPreviews();
  const operations = createOperationLog();
  const initialCanvas = options.canvas ?? baseCanvas("image");

  let canvas = initialCanvas;
  const dialogs = new DialogService();
  dialogs.registerDialog(ALERT_DIALOG_ID, { definition: alertDefinition });
  const registry = new ModelInteractionService();
  registry.register({
    id: "generic-model",
    version: 1,
    owner: "showcase-generic",
    Panel: GenericModelPanel
  });
  // Seedance 专用交互：由 fixture 以 production contract 注册（生产由 Seedance Plugin 注册）。
  if ((options.catalogId ?? DEFAULT_CATALOG_ID) === "seedance") {
    registry.register({
      id: "seedance-video",
      version: 1,
      owner: "showcase-seedance",
      Panel: SeedanceVideoPanel,
      bindings: () => ({
        actions: {
          openVideoEdit: (intentId?: string) =>
            recordOperation(OPERATIONS.OPEN_VIDEO_EDIT, { id: intentId ?? "" }),
          openFrameCapture: () => recordOperation(OPERATIONS.OPEN_VIDEO_EDIT, { id: "frame-capture" }),
          removeIntent: (intentId?: string) =>
            recordOperation(OPERATIONS.OPEN_VIDEO_EDIT, { id: `remove:${intentId ?? ""}` })
        },
        statusSummary: readCanonicalIntentSummary()
      })
    });
  }

  const deps: FixtureDeps = {
    canvasRemote: createFixtureCanvasRemote(operations),
    dialogs,
    registry,
    draftStore: createModelDraftStore(),
    taskCatalog: new FixtureCatalogService(options.catalogId ?? DEFAULT_CATALOG_ID),
    parameterPreview: createFixtureParameterPreview(operations),
    snippetSource: createFixtureSnippetSource(operations),
    canvasSession: createFixtureCanvasSession({
      operations,
      getCanvas: () => canvas,
      setCanvas: (next) => {
        canvas = next;
      },
      ...(options.onCanvasChanged ? { onCanvasChanged: options.onCanvasChanged } : {})
    }),
    readCanvas: () => canvas
  };

  // 首帧之前把画布与选择压进共享 store：`ModelExecutionHost` 直接读它们。
  woohaa3CanvasStore.getState().hydrate(initialCanvas);
  nodeDraftStore.clearAll();
  parameterPreviewStore.clearAll();
  nodeSelectionStore.reset();
  nodeSelectionStore.setFromRuntime(
    { nodeIds: [CANVAS_NODES.targetId], primaryNodeId: CANVAS_NODES.targetId, editingFocus: false },
    new Set(initialCanvas.document.nodes.map((node) => node.id))
  );
  return deps;
}

export type ShowcasePanelSurface = "canvas" | "sidebar" | "dock";
export type ShowcaseAnchor = "center" | "bottom" | "left" | "right" | "offscreen" | "missing";

function fixtureRuntime(anchor: ShowcaseAnchor, areaId: string): CanvasRuntimeService {
  const rect = (nodeId: string) => {
    if (nodeId !== CANVAS_NODES.targetId) return null;
    const area = document.getElementById(areaId);
    if (!area || anchor === "missing") return null;
    const bounds = area.getBoundingClientRect();
    if (anchor === "offscreen") return { left: bounds.right + 20, top: bounds.top, width: 80, height: 60 };
    const left = anchor === "left" ? bounds.left + 24 : anchor === "right" ? bounds.right - 104 : bounds.left + bounds.width / 2 - 40;
    const top = anchor === "bottom" ? bounds.bottom - 160 : bounds.top + 24;
    return { left, top, width: 80, height: 60 };
  };
  return {
    nodeScreenRect: rect,
    nodePresentationScreenRect: rect,
    subscribeViewport: () => () => undefined,
    subscribeScene: () => () => undefined
  } as unknown as CanvasRuntimeService;
}

/** 生产锚定外壳在骨架与真实内容间切换的浏览器夹具。 */
export function ShowcaseAnchorSkeletonSwap() {
  const areaId = `showcase-skeleton-${useId().replace(/:/g, "")}`;
  const runtime = useMemo(() => fixtureRuntime("center", areaId), [areaId]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 500);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="showcase__panel-host">
      <div id={areaId} className="showcase__panel-box" data-node-anchor-area={CANVAS_NODES.targetId}>
        <ExecutionPanelSurface nodeId={CANVAS_NODES.targetId} presentation="compact" runtime={runtime}>
          {ready ? (
            <div className="showcase__anchor-real-content" style={{ minHeight: 260, padding: 16 }}>
              真实执行面板内容
            </div>
          ) : <ExecutionPanelSkeleton />}
        </ExecutionPanelSurface>
      </div>
    </div>
  );
}

/**
 * 渲染生产 `ModelExecutionHost`（依赖由 fixture 注入，组件本身是生产实现）。
 *
 * 交互导致的画布命令（picker / chips remove）被接受后，会重新 `hydrate` 共享 store，
 * 让面板 chips 反映回调结果。
 *
 * surface / presentation / close 真正进入生产组件（change:
 * 2026-09-28-align-execution-reference-and-expansion，design D8）：
 * - `surface` 只影响容器宽度演示；
 * - `presentation` 为受控外观，`onPresentationChange` 驱动 compact↔expanded；
 * - 关闭动作由 harness 记录并可观察到。
 */
export function ShowcasePanelHost({
  catalogId,
  canvas,
  surface = "canvas",
  anchor = "center",
  width,
  writable = true,
  snippetSource = true,
  presentation: presentationProp,
  onPresentationChange,
  onClose,
  onPromptSkill
}: {
  catalogId?: CatalogFixtureId;
  canvas?: ServerCanvas;
  surface?: ShowcasePanelSurface;
  anchor?: ShowcaseAnchor;
  width?: number;
  writable?: boolean;
  /** 未装配片段插件时 `#` 入口不出现（与生产一致）。 */
  snippetSource?: boolean;
  /** 受控 presentation；未提供时由内部受控 harness 管理。 */
  presentation?: ExecutionPanelPresentation;
  onPresentationChange?: (presentation: ExecutionPanelPresentation) => void;
  onClose?: () => void;
  /** 快捷改写回调；提供后菜单选择会交给宿主（fixture 记录 action + 草稿）。 */
  onPromptSkill?: (input: { id: string; label: string; prompt: string }) => void;
}) {
  const [deps] = useState<FixtureDeps>(() => {
    if (canvas) woohaa3CanvasStore.getState().hydrate(canvas);
    return installShowcaseFixture({
      ...(catalogId ? { catalogId } : {}),
      ...(canvas ? { canvas } : {}),
      // 画布命令被接受后重新 hydrate，让面板 chips / intent 反映回调结果。
      onCanvasChanged: (next) => woohaa3CanvasStore.getState().hydrate(next)
    });
  });
  const [internalPresentation, setInternalPresentation] = useState<ExecutionPanelPresentation>("compact");
  const areaId = `showcase-anchor-${useId().replace(/:/g, "")}`;
  const runtime = useMemo(() => fixtureRuntime(anchor, areaId), [anchor, areaId]);
  const presentation = presentationProp ?? internalPresentation;
  const setPresentation = (next: ExecutionPanelPresentation) => {
    if (presentationProp === undefined) setInternalPresentation(next);
    onPresentationChange?.(next);
    recordOperation(OPERATIONS.PANEL_PRESENTATION, { presentation: next });
  };
  return (
    <div className="showcase__panel-host" data-surface={surface}>
      <div id={areaId} className="showcase__panel-box" data-node-anchor-area={CANVAS_NODES.targetId} style={width ? { width } : undefined}>
        <ModelExecutionHost
          canvasId="showcase-canvas"
          runtime={runtime}
          selectedNodeId={CANVAS_NODES.targetId}
          session={deps.canvasSession}
          runClient={deps.canvasRemote}
          writable={writable}
          dialogs={deps.dialogs}
          catalog={deps.taskCatalog}
          registry={deps.registry}
          draftStore={deps.draftStore}
          presentation={presentation}
          onPresentationIntent={(intent) => {
            if (intent.kind === "expand") setPresentation("expanded");
            else if (intent.kind === "collapse") setPresentation("compact");
            else if (intent.kind === "close") {
              recordOperation(OPERATIONS.PANEL_CLOSE, {});
              onClose?.();
            }
          }}
          {...(snippetSource ? { snippetSource: deps.snippetSource } : {})}
          {...(onPromptSkill ? { onPromptSkill } : {})}
        />
      </div>
    </div>
  );
}

/** 从当前 fixture 画布读取 canonical seedance intents，投影为 Panel 摘要。 */
function readCanonicalIntentSummary(): readonly string[] {
  const canvas = woohaa3CanvasStore.getState().canvas;
  const result = normalizeVideoEditIntents(canvas?.nodeData?.[CANVAS_NODES.targetId]?.videoEditIntents);
  const intents = result.ok ? result.value : [];
  return intents.map((intent) => {
    const range = intent.endSeconds !== undefined
      ? `${intent.startSeconds}-${intent.endSeconds}s`
      : `${intent.startSeconds}s`;
    return `${range} ${intent.prompt}`;
  });
}

/** 快捷改写 story 用：把「所选 action + 当前草稿」记进 fixture 操作日志。 */
export function recordPromptSkill(input: { id: string; label: string; prompt: string }): void {
  recordOperation(OPERATIONS.PROMPT_SKILL, input);
}

export type { CanvasTaskCatalog, ReactNode };
