/**
 * 图片聚焦编辑 Plugin（多文档工作区）
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.3–4.6/5.2–5.7；
 *   change: 2026-10-16-integrate-photocraft-image-editing，design D1/D2/D7；
 *   change: 2026-10-21-add-photocraft-document-workspace，design D1–D8：把单文档会话改为
 *   Canvas page-scoped 多文档工作区，tab 切换不保存、不释放文档）。
 *
 * 职责：
 * - 拥有当前 Canvas 页面的文档注册表与宿主资源（每文档一个呈现 + 控制器 + 保存 attempt）；
 * - 节点文档经 `canvas.focus-workspace`（kind=image）呈现，独立文件文档经
 *   `canvas.document-workspace` 呈现；任一时刻只有一个活动呈现；
 * - 返回画布暂停呈现而保留文档；关闭 tab/离开页面才结算；
 * - 保存目的地按文档绑定：节点写原节点，独立文件走本地交付端口。
 */
import { useSyncExternalStore } from "react";
import { runtimeComponents, imageEditorReadiness } from "@woohaa3/frontend/plugin-api";
import { createEditorPreparation } from "./editor-preparation.js";
import { NodeEditorReadiness } from "./node-editor-readiness.js";
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { appPublicUrl, woohaa3CanvasStore, workingCanvasOf } from "@woohaa3/frontend/plugin-api";
import { resolveImageFocusTarget, ImageFocusWorkspace } from "./workspace.js";
import { imageEditRequestId } from "./save.js";
import { MediaOperationBoundary } from "@woohaa3/frontend/plugin-api";
import { rasterizeDrawable, defaultRasterCanvasFactory, BEVY_TEXTURE_MAX_DIMENSION } from "@woohaa3/frontend/plugin-api";
import { ImageEditorWorkspace, fileBackgroundPort } from "./image-editor-overlay.js";
import { definePlugin } from "@woohaa3/frontend/plugin-api";
import { IMAGE_EDIT_SERVICE, type ImageEditService } from "@woohaa3/frontend/plugin-api";
import { EditorWorkspaceController } from "./editor-workspace.js";
import type { ProjectEditorPort } from "./project-editor-pane.js";
import { IMAGE_PROJECT_CONTENT_TYPE } from "@woohaa3/contracts";
import { EditorDocumentRegistry, type EditorDocumentEntry, MAX_OPEN_DOCUMENTS } from "@woohaa3/photocraft-editor";
import { DocumentWorkspaceSession, pendingDraftOf, type DocumentResource } from "./document-session.js";
import type { FileDocumentWorkspace } from "./file-document-workspace.js";
import { settleDocument } from "./document-settlement.js";
import { createBrowserFilePort, decodeImageSize } from "./file-delivery-adapter.js";
import { classifyOpenFile, OPEN_FILE_ACCEPT } from "./open-file.js";
import { SerialGate, canOpenDocument, DEFAULT_WORKSPACE_POLICY, describePolicy } from "./workspace-policy.js";
import { createPublishOperation, publishToCanvas, type PublishOperation } from "./publish-node.js";
import { normalizeEditorImage } from "@woohaa3/photocraft-editor";
import { DocumentWorkspaceStore } from "./workspace-store.js";

export const IMAGE_EDITOR_PLUGIN_ID = "image-editor";
const IMAGE_EDITOR_WORKSPACE_ID = "image-editor-workspace";
const DOCUMENT_WORKSPACE_ID = "image-document-workspace";
const RECOVERY_ACTION_ID = "image-editor-reopen";

export type ImageEditorPluginOptions = {
  canvasId?: string;
};

export function imageEditorExtension(options: ImageEditorPluginOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const canvasId = options.canvasId ?? "default";
      const registry = new EditorDocumentRegistry(MAX_OPEN_DOCUMENTS);
      const store = new DocumentWorkspaceStore();
      const gate = new SerialGate(DEFAULT_WORKSPACE_POLICY.maxOpenConcurrency);
      /** 独立文件字节（同一文档的打开/保存/发布复用）。 */
      const fileBytes = new Map<string, Uint8Array>();
      /** 添加到画布的稳定操作身份（按文档；重试复用同一 operationId/nodeId）。 */
      const publishOperations = new Map<string, PublishOperation>();
      /** 等待权威修订到达后重开内容的节点文档。 */
      const pendingCanonical = new Map<string, number>();
      let busy = false;
      let notice: { message: string; tone: "info" | "error" } | null = null;
      let disposed = false;
      let removingRecovery: (() => void) | null = null;
      /** 当前概览入口的文案（用于判断是否需要重新注册）。 */
      let recoveryLabel: string | null = null;

      const getCanvas = () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;

      let preparationMode = ctx.canvasNavigation.getSnapshot().mode;
      const preparation = createEditorPreparation({
        prepare: () => { preparationMode = ctx.canvasNavigation.getSnapshot().mode; return runtimeComponents.prepareImageEditor(); },
        enter: (input, signal) => ctx.canvasNavigation.requestEnterNodeFocus({ ...input, kind: "image", signal }),
        stillCurrent: nodeId => !disposed && ctx.canvasNavigation.getSnapshot().mode === preparationMode && resolveImageFocusTarget(getCanvas(), nodeId) !== null
      });
      const unregisterEntryGuard = ctx.canvasNavigation.registerNodeFocusGuard(IMAGE_EDITOR_PLUGIN_ID, preparation.guard);
      const manageRuntime = () => {
        const settings = ctx.get("settingsOpen" as never) as { open(input: { canvasId: string; section: "runtimes" }): Promise<unknown> } | undefined;
        if (settings) void settings.open({ canvasId, section: "runtimes" });
      };
      const removeReadinessOverlay = ctx.slots.register("canvas.overlay", {
        id: "image-editor-readiness", owner: IMAGE_EDITOR_PLUGIN_ID,
        render: function EditorReadinessOverlay() {
          const pending = useSyncExternalStore(preparation.subscribe, preparation.getSnapshot, preparation.getSnapshot);
          if (!pending.nodeId) return null;
          return <PendingReadiness nodeId={pending.nodeId} phase={pending.phase} message={pending.message} />;
        }

      });

      /** 可用内容矩形：与 overlay DOM（铺满聚焦内容区）及 Bevy 取景共用同一表面。 */
      const workspaceRect = (): { x: number; y: number; width: number; height: number } => {
        const controller = ctx.canvasRuntime.controller();
        const surface = controller?.surface() ?? { width: 1, height: 1, pixelRatio: 1 };
        return ctx.canvasRuntime.focusContentRect?.() ?? { x: 0, y: 0, width: surface.width, height: surface.height };
      };

      const session = new DocumentWorkspaceSession(registry, {
        canvasId: () => canvasId,
        createNodeView: (nodeId) => createNodeWorkspace(nodeId),
        createController: (resource, entry) => createController(resource, entry),
        decodeImage: decodeImageSize,
        rect: workspaceRect,
        onChange: () => publish()
      });

      function PendingReadiness({ nodeId, phase, message }: { nodeId: string; phase: "loading" | "failed"; message: string }) {
        const runtimeState = useSyncExternalStore(runtimeComponents.subscribeImageEditor, runtimeComponents.getSnapshot, runtimeComponents.getSnapshot);
        const hostReadiness = imageEditorReadiness(runtimeState);
        const readiness = phase === "failed"
          ? { phase: "failed" as const, label: "编辑器准备失败", tip: message }
          : { phase: "loading" as const, label: hostReadiness.phase === "loading" ? hostReadiness.label : "正在准备图片编辑器…", tip: "准备好后自动进入编辑。你可以继续查看画布。" };
        return <NodeEditorReadiness runtime={ctx.canvasRuntime} nodeIds={[nodeId]} readiness={readiness} activeNodeId={nodeId}
          onSelect={() => preparation.cancel()} onManage={manageRuntime} onRetry={preparation.retry} />;
      }

      // ------------------------------------------------------------ 呈现发布

      /** 把当前工作区状态推给 React（未变化时 store 不通知）。 */
      function publish(): void {
        const active = session.active();
        const entry = active ? registry.entry(active.documentId) : null;
        const binding = active && entry ? activeBinding(active, entry) : null;
        store.update({
          documents: registry.snapshotState(),
          active: binding,
          busy,
          // 恢复入口的数量随打开文档数变化（返回画布后仍可见）。
          writable: ctx.canvasSession.isWritable(),
          notice
        });
        syncRecoveryAction();
      }

      function activeBinding(resource: DocumentResource, entry: EditorDocumentEntry) {
        const fileView = resource.kind === "file" ? resource.view : null;
        return {
          documentId: resource.documentId,
          view: resource.view,
          controller: resource.controller,
          name: entry.name,
          detail: entry.detail,
          nodeDocument: resource.kind === "node",
          writable: entry.writable && (resource.kind === "file" || ctx.canvasSession.isWritable()),
          contentRevision: resource.view.contentRevisionState(),
          fileActions: fileView ? {
            saveProject: () => void deliverActive("project"),
            exportPng: () => void deliverActive("png"),
            addToCanvas: () => void addActiveToCanvas(),
            addToCanvasBlocked: ctx.canvasSession.isWritable() ? null : "当前画布只读或未连接"
          } : null,
          fileStatus: fileStatusOf(entry, fileView),
          fileStatusTone: entry.status === "error" || entry.status === "conflict" ? "error" as const : "info" as const,
          fileBusy: busy
        };
      }

      function fileStatusOf(entry: EditorDocumentEntry, view: FileDocumentWorkspace | null): string | null {
        if (notice?.tone === "info") return notice.message;
        if (entry.status === "error" || entry.status === "conflict") return entry.message ?? "保存失败，请重试";
        if (entry.status === "saving") return "正在处理…";
        const dirty = view?.project.isDirty() ?? entry.status === "dirty";
        if (dirty) return "有未保存修改 · 保存工程会下载 .pcraft；导出 PNG 不改变保存状态";
        return null;
      }

      function setNotice(next: { message: string; tone: "info" | "error" } | null): void {
        notice = next;
        publish();
      }

      function setBusy(next: boolean): void {
        busy = next;
        publish();
      }

      /**
       * 概览入口（“打开文件…”/“图像编辑（n）”）。
       *
       * 这是画布上**唯一**能从概览进入 PhotoCraft 的入口：没有它，独立文件文档在工作区之外
       * 无处可开（“打开文件…”按钮只在工作区的 tab 条里，形成先有文档才能打开文件的死循环）。
       * 有未关闭文档时显示文档数并恢复上次活动文档；没有文档时直接打开文件选择器。
       * 聚焦中（工作区自身可见）不显示，避免与工作区 tab 条重复。
       */
      function syncRecoveryAction(): void {
        const count = registry.snapshotState().entries.length;
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        const focused = mode.type === "node-focus" || mode.type === "document-workspace";
        const label = count > 0 ? `图像编辑（${count}）` : "打开文件…";
        if (focused) {
          if (removingRecovery) {
            removingRecovery();
            removingRecovery = null;
            recoveryLabel = null;
          }
          return;
        }
        // label 是贡献的静态字段：数量变化时重新注册，保证按钮文案与文档数一致。
        if (removingRecovery && recoveryLabel === label) return;
        removingRecovery?.();
        removingRecovery = ctx.slots.register("canvas.toolbar-action", {
          id: RECOVERY_ACTION_ID,
          owner: IMAGE_EDITOR_PLUGIN_ID,
          priority: 40,
          label,
          icon: PhotoEditIcon,
          onActivate: () => {
            const id = registry.activeId() ?? registry.snapshotState().entries[0]?.id ?? null;
            if (id) activateDocument(id);
            else openFile();
          }
        });
        recoveryLabel = label;
      }

      // ------------------------------------------------------------ 节点呈现

      /** 节点呈现：原节点由 Bevy 呈现；只有活动文档会发布纹理、细节与投影。 */
      function createNodeWorkspace(nodeId: string): ImageFocusWorkspace | null {
        const target = resolveImageFocusTarget(getCanvas(), nodeId);
        if (!target) return null;
        const controller = ctx.canvasRuntime.controller();
        const savedViewport = controller?.viewport() ?? { x: 0, y: 0, zoom: 1 };
        const controllerRef = controller;
        const runtime = ctx.canvasRuntime.runtime();
        const focusTextures = runtime ? new MediaOperationBoundary(runtime) : null;
        const activeNow = () => isActiveNode(nodeId);
        return new ImageFocusWorkspace({
          nodeId,
          target,
          getCanvas,
          rect: workspaceRect(),
          transition: ctx.canvasRuntime.focusTransitionPort(),
          setProjection: (projection) => { if (activeNow()) ctx.canvasRuntime.setImageFocus(projection); },
          savedViewport,
          restoreViewport: (viewport) => { if (activeNow()) controllerRef?.restoreViewport(viewport); },
          onTexture: (image) => {
            if (!activeNow()) return;
            ctx.canvasRuntime.setImageFocusDetails(null);
            if (!image) {
              ctx.canvasRuntime.setImageFocusTexture(null);
              focusTextures?.clear(`focus-raster:${nodeId}`);
              return;
            }
            const retry = () => {
              if (!activeNow()) return;
              if ("pixels" in image) {
                ctx.canvasRuntime.setImageFocusTexture({ nodeId, ...image });
                return;
              }
              focusTextures?.run(`focus-raster:${nodeId}`, image, nodeId, () => {
                const raster = rasterizeDrawable(image.bitmap, image, defaultRasterCanvasFactory, BEVY_TEXTURE_MAX_DIMENSION);
                if (!raster) throw new Error("聚焦图片无法读取预览像素");
                ctx.canvasRuntime.setImageFocusTexture({ nodeId, ...raster });
              });
            };
            retry();
          },
          onDetails: (frame) => {
            if (!activeNow()) return;
            ctx.canvasRuntime.setImageFocusDetails(frame ? {
              nodeId, width: frame.width, height: frame.height,
              onUploadFailure: frame.onUploadFailure,
              tiles: frame.tiles.map((tile) => ({ x: tile.x, y: tile.y, width: tile.width, height: tile.height, pixels: tile.preview.pixels }))
            } : null);
          }
        });
      }

      /** 活动呈现是否为该节点文档（切走的文档不得发布纹理/投影）。 */
      function isActiveNode(nodeId: string): boolean {
        if (disposed) return false;
        const active = session.active();
        if (active?.kind !== "node" || active.nodeId !== nodeId) return false;
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        return mode.type === "node-focus" && mode.nodeId === nodeId;
      }

      // ------------------------------------------------------------ 控制器

      /** 编辑器控制器：保存目的地按文档绑定（节点写原节点 / 独立文件走本地交付）。 */
      function createController(resource: DocumentResource, _entry: EditorDocumentEntry): EditorWorkspaceController {
        const controller: EditorWorkspaceController = new EditorWorkspaceController({
          dialogOwner: () => {
            const active = session.active();
            if (active !== resource || resource.controller !== controller) return null;
            return {
              canvasId,
              documentId: resource.documentId,
              ...(resource.kind === "node" ? { nodeId: resource.nodeId } : {}),
              sessionId: resource.kind === "node" ? resource.sessionId : `image-edit:${canvasId}:${resource.documentId}`
            };
          },
          // 节点文档沿用原来的工程会话；独立文件的会话由文件呈现自持。
          session: resource.view.project,
          sessionId: resource.kind === "node" ? resource.sessionId : `image-edit:${canvasId}:${resource.documentId}`,
          baselineDocument: resource.kind === "node" ? resource.view.projectDocument() : null,
          assetUrl: appPublicUrl,
          ...(resource.kind === "file"
            ? { fileDelivery: createBrowserFilePort(() => (resource.view as FileDocumentWorkspace).fileName) }
            : {}),
          saveDeps: {
            uploadProject: async (bytes) => {
              const file = new File([bytes.slice().buffer as ArrayBuffer], "project.pcraft", { type: IMAGE_PROJECT_CONTENT_TYPE });
              const result = await ctx.mediaRemote.upload({ file, canvasId });
              if (!result.ok) throw new Error(result.error);
              return result.media;
            },
            uploadOutput: async (bytes) => {
              const file = new File([bytes.slice().buffer as ArrayBuffer], "output.png", { type: "image/png" });
              const result = await ctx.mediaRemote.upload({ file, canvasId });
              if (!result.ok) throw new Error(result.error);
              return result.media;
            },
            complete: (request) => ctx.canvasRemote.editComplete(request),
            status: async (request) => {
              const result = await ctx.canvasRemote.editStatus(request);
              return result.ok ? { ok: true as const, receipt: result.value } : result;
            },
            assetIdFor: (checksum) => `asset-image-edit-${checksum}`
          }
        });
        return controller;
      }

      // ------------------------------------------------------------ 打开

      /**
       * 从画布节点进入编辑：已有对应文档则激活，否则按现有路径打开一个文档。
       *
       * 只读查看与历史预览不创建可写副本或额外 tab。
       */
      async function openNodeDocument(nodeId: string): Promise<boolean> {
        if (disposed) return false;
        const existing = registry.findByNode(canvasId, nodeId);
        if (existing) {
          session.activate(existing.id);
          return enterDocumentPresentation(existing.id, { preserveOverviewReturn: true });
        }
        const capacity = canOpenDocument(registry.snapshotState().entries.length);
        if (!capacity.ok) {
          setNotice({ message: capacity.reason, tone: "error" });
          return false;
        }
        const canvas = getCanvas();
        const node = canvas?.document.nodes.find((candidate) => candidate.id === nodeId);
        const name = (canvas?.nodeData[nodeId] as { title?: string } | undefined)?.title ?? node?.type ?? "图片";
        const opened = await gate.run(async () => session.openNode({ nodeId, name, writable: ctx.canvasSession.isWritable() }));
        if (!opened.ok) {
          setNotice({ message: opened.reason, tone: "error" });
          return false;
        }
        // 打开文档时就建立编辑会话基线（与旧单文档行为一致）；切换 tab 不重建、不重发。
        const resource = session.resource(opened.documentId);
        if (resource?.kind === "node") resource.begin = beginNodeSession(resource);
        setNotice(null);
        return enterDocumentPresentation(opened.documentId, { preserveOverviewReturn: false });
      }

      /**
       * 发起一次 `editBegin`：捕获本次编辑会话的权威基线。
       *
       * 保存前等待它（复用同一请求身份），保存成功换新 sessionId 后重新发起
       * （change: 2026-10-21-add-photocraft-document-workspace，design D5）。
       */
      function beginNodeSession(resource: DocumentResource): Promise<{ ok: true; baselineContentIdentity: string } | { ok: false; message: string }> {
        if (resource.kind !== "node") return Promise.resolve({ ok: false, message: "该文档没有节点身份" });
        const target = resolveImageFocusTarget(getCanvas(), resource.nodeId);
        return ctx.canvasRemote.editBegin({
          canvasId,
          nodeId: resource.nodeId,
          sessionId: resource.sessionId,
          requestId: `begin:${resource.sessionId}`,
          kind: "image",
          baselineContentIdentity: target ? `media:${readKey(target.asset as never)}` : ""
        }).then(
          (result) => {
            if (!result.ok) return { ok: false as const, message: result.error || "编辑会话连接失败" };
            resource.begun = true;
            return { ok: true as const, baselineContentIdentity: result.value.baselineContentIdentity };
          },
          (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : "编辑会话连接失败" })
        );
      }

      /**
       * 让文档成为活动呈现：节点文档提交 node-focus，独立文件提交 document-workspace。
       *
       * 两种情况都经唯一 Navigation/runtime coordinator 原子切换；失败保留原呈现与草稿。
       */
      async function enterDocumentPresentation(documentId: string, options: { preserveOverviewReturn: boolean }): Promise<boolean> {
        const resource = session.resource(documentId);
        if (!resource) return false;
        const prepared = await startResource(resource);
        if (!prepared) return false;
        const result = resource.kind === "node"
          ? await ctx.canvasNavigation.requestEnterNodeFocus({
              nodeId: resource.nodeId, kind: "image", owner: "direct", preserveOverviewReturn: options.preserveOverviewReturn
            })
          : await ctx.canvasNavigation.requestEnterDocumentWorkspace(documentId, { preserveOverviewReturn: options.preserveOverviewReturn });
        if (!result.ok) {
          setNotice({ message: result.reason, tone: "error" });
          return false;
        }
        return true;
      }

      /** 准备呈现（节点入场过渡/文件尺寸解码）；失败给出可重试原因。 */
      async function startResource(resource: DocumentResource): Promise<boolean> {
        // 已初始化过的文档只把既有呈现重新绑定到导航，不重放 overview 入场或重新解码
        // （tab 往返与“图像编辑（n）”恢复入口共用；change: 2026-10-21，design D4）。
        if (resource.started) return true;
        if (resource.kind === "file") {
          const started = await resource.view.start();
          if (!started) {
            setNotice({ message: resource.view.previewStatus() ?? "文档无法打开", tone: "error" });
            return false;
          }
          resource.started = true;
          return true;
        }
        const started = await resource.view.start();
        resource.started = started || resource.view.loadErrorMessage() === null;
        if (!started && resource.view.loadErrorMessage()) {
          setNotice({ message: resource.view.loadErrorMessage()!, tone: "error" });
          return false;
        }
        return true;
      }

      /** 激活已打开文档（tab 点击 / 恢复入口）。 */
      function activateDocument(documentId: string): void {
        if (disposed) return;
        const previous = session.activeId();
        const result = session.activate(documentId);
        if (!result.ok) {
          setNotice({ message: result.reason, tone: "error" });
          return;
        }
        if (previous !== documentId) {
          // tab 切换：保留本轮首次进入捕获的 overview 返回位置。
          void enterDocumentPresentation(documentId, { preserveOverviewReturn: true });
        }
      }

      // ------------------------------------------------------------ 打开文件

      /** 显式“打开文件”：受支持位图与 `.pcraft`；取消/失败保留原文档与取景。 */
      function openFile(): void {
        if (disposed || typeof document === "undefined") return;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = OPEN_FILE_ACCEPT;
        input.style.display = "none";
        const finish = () => input.remove();
        input.addEventListener("change", () => {
          const file = input.files?.[0] ?? null;
          finish();
          // 取消不创建条目、不替换已有内容。
          if (!file) return;
          void openFileDocument(file);
        });
        input.addEventListener("cancel", finish);
        document.body.appendChild(input);
        input.click();
      }

      async function openFileDocument(file: File): Promise<void> {
        const classified = classifyOpenFile({ name: file.name, type: file.type });
        if (!classified.ok) {
          setNotice({ message: classified.reason, tone: "error" });
          return;
        }
        const capacity = canOpenDocument(registry.snapshotState().entries.length);
        if (!capacity.ok) {
          setNotice({ message: capacity.reason, tone: "error" });
          return;
        }
        setBusy(true);
        notice = null;
        try {
          const raw = new Uint8Array(await file.arrayBuffer());
          // 复用现有方向/sRGB/RGBA8 归一与有界解码；超限明确拒绝，不缩小原图。
          const bytes = classified.kind === "image"
            ? await gate.run(() => normalizeEditorImage(raw))
            : raw;
          const opened = session.openFile({ fileName: file.name, bytes, kind: classified.kind });
          if (!opened.ok) {
            setNotice({ message: opened.reason, tone: "error" });
            return;
          }
          fileBytes.set(opened.documentId, bytes);
          await enterDocumentPresentation(opened.documentId, { preserveOverviewReturn: false });
        } catch (error) {
          setNotice({ message: error instanceof Error ? error.message : "无法打开文件，请重试", tone: "error" });
        } finally {
          setBusy(false);
        }
      }

      // ------------------------------------------------------------ 交付

      /** 独立文件保存工程 / 导出 PNG（本地文件端口；只有可信写入推进基线）。 */
      async function deliverActive(kind: "project" | "png"): Promise<void> {
        const resource = session.active();
        if (!resource || resource.kind !== "file" || !resource.controller) return;
        const baseName = resource.view.fileName.replace(/\.[^.]+$/, "") || "photocraft";
        setBusy(true);
        notice = null;
        try {
          const outcome = await resource.controller.deliverFile(kind, {
            fileName: kind === "project" ? `${baseName}.pcraft` : `${baseName}.png`
          });
          if (!outcome.ok) {
            const message = outcome.status === "cancelled" ? "已取消保存，文档保留" : (outcome.message ?? "保存失败，文档仍保留");
            session.setStatus(resource.documentId, "error", message);
            setNotice({ message, tone: "error" });
            return;
          }
          if (outcome.status === "download-started") {
            // 浏览器下载：只提示已发起，不宣称落盘、不清除未保存状态。
            session.setStatus(resource.documentId, resource.controller.isDirty() ? "dirty" : "clean");
            setNotice({ message: "已发起下载；请确认文件已保存到目标位置（未自动标记为已保存）", tone: "info" });
            return;
          }
          session.setStatus(resource.documentId, resource.controller.isDirty() ? "dirty" : "clean");
          setNotice({ message: kind === "project" ? "工程已保存" : "PNG 已导出（不影响工程保存状态）", tone: "info" });
        } finally {
          setBusy(false);
        }
      }

      /** 显式“添加到画布”：成对上传 + 原子发布；成功原位绑定为节点文档。 */
      async function addActiveToCanvas(): Promise<void> {
        const resource = session.active();
        if (!resource || resource.kind !== "file" || !resource.controller) return;
        if (!ctx.canvasSession.isWritable()) {
          setNotice({ message: "当前画布只读或未连接，无法添加（可先保存到本地文件）", tone: "error" });
          return;
        }
        const entry = registry.entry(resource.documentId);
        if (!entry) return;
        setBusy(true);
        notice = null;
        try {
          const frozen = await resource.controller.freezeForPublish();
          if (!frozen.ok) {
            setNotice({ message: frozen.message, tone: "error" });
            return;
          }
          const operation = publishOperations.get(resource.documentId)
            ?? createPublishOperation(`${canvasId}:${resource.documentId}:${entry.generation}`);
          publishOperations.set(resource.documentId, operation);
          const position = insertPosition();
          const published = await publishToCanvas(frozen.value, operation, {
            uploadProject: async (bytes) => {
              const file = new File([bytes.slice().buffer as ArrayBuffer], `${entry.name}.pcraft`, { type: IMAGE_PROJECT_CONTENT_TYPE });
              const result = await ctx.mediaRemote.upload({ file, canvasId });
              return result.ok ? result.media : null;
            },
            uploadOutput: async (bytes) => {
              const file = new File([bytes.slice().buffer as ArrayBuffer], `${entry.name}.png`, { type: "image/png" });
              const result = await ctx.mediaRemote.upload({ file, canvasId });
              return result.ok ? result.media : null;
            },
            submit: (commands, operationId) => {
              const result = ctx.canvasCommands.submit(commands, operationId);
              return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            findNode: (nodeId) => {
              const current = getCanvas();
              return {
                exists: current?.document.nodes.some((node) => node.id === nodeId) ?? false,
                outputAssetId: (current?.nodeData[nodeId] as { outputAssetId?: string } | undefined)?.outputAssetId ?? null
              };
            },
            isWritable: () => ctx.canvasSession.isWritable(),
            insertPosition: () => position,
            canvasId: () => canvasId
          }, { title: entry.name });
          if (!published.ok) {
            session.setStatus(resource.documentId, "error", published.message);
            setNotice({ message: published.message, tone: "error" });
            return;
          }
          // 成功：原 tab 原位绑定节点并聚焦（保留控制器、撤销与取景，不新开重复 tab）。
          const nodeView = createNodeWorkspace(published.nodeId);
          if (!nodeView) {
            notice = { message: "节点已创建，但当前无法在编辑器中打开它", tone: "error" };
            publish();
            return;
          }
          session.rebindFileToNode(resource.documentId, { nodeId: published.nodeId, name: entry.name, view: nodeView });
          publishOperations.delete(resource.documentId);
          fileBytes.delete(resource.documentId);
          // 新节点文档的编辑会话从这里开始（begin 捕获刚发布内容的权威基线）。
          const rebound = session.resource(resource.documentId);
          if (rebound?.kind === "node") rebound.begin = beginNodeSession(rebound);
          await enterDocumentPresentation(resource.documentId, { preserveOverviewReturn: true });
          setNotice({ message: "已添加到画布，文档已转为节点文档", tone: "info" });
        } catch (error) {
          setNotice({ message: error instanceof Error ? error.message : "添加到画布失败", tone: "error" });
        } finally {
          setBusy(false);
        }
      }

      /** 当前可见画布中心附近作为插入位置（不改变视口）。 */
      function insertPosition(): { x: number; y: number } {
        const controller = ctx.canvasRuntime.controller();
        if (!controller) return { x: 0, y: 0 };
        const surface = controller.surface();
        const viewport = controller.viewport();
        return {
          x: (surface.width / 2 - viewport.x) / viewport.zoom,
          y: (surface.height / 2 - viewport.y) / viewport.zoom
        };
      }

      // ------------------------------------------------------------ 保存

      /** 节点保存：同一文档的冻结产物与 requestId 重试；失败标在该 tab。 */
      async function persistNode(resource: DocumentResource): Promise<{ ok: boolean; message?: string }> {
        if (resource.kind !== "node") return { ok: true };
        const controller = resource.controller;
        if (!controller || !controller.isDirty()) return { ok: true };
        const target = resolveImageFocusTarget(getCanvas(), resource.nodeId);
        const base = resource.view.baseAsset();
        if (!target || !base) return { ok: false, message: "原图不可用，无法保存" };
        const begun = await ensureBegun(resource);
        if (!begun.ok) return { ok: false, message: begun.message };
        const outcome = await controller.save({
          canvasId,
          nodeId: resource.nodeId,
          sessionId: resource.sessionId,
          requestId: resource.requestId ??= imageEditRequestId(resource.sessionId),
          baselineContentIdentity: begun.baselineContentIdentity,
          baseAsset: base as never,
          baseStorageKey: readKey(base as never),
          baseChecksum: readMeta(base as never, "checksum") ?? "",
          baseContentType: readMeta(base as never, "contentType") ?? "image/png",
          baseSize: readMetaNumber(base as never, "size") ?? 0
        });
        // 后台保存与活动保存都只更新所属文档；不按 active node 决定回执目标。
        if (!outcome.ok && (!outcome.retriable || outcome.code === "conflict")) resource.requestId = null;
        if (outcome.ok) {
          session.setStatus(resource.documentId, outcome.status === "history-pending" ? "history-pending" : "clean");
          resource.requestId = null;
        } else {
          session.setStatus(resource.documentId, outcome.code === "conflict" ? "conflict" : "error", outcome.message);
        }
        return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
      }

      /** 保证编辑会话已 begin（同一 session 的 begin 请求身份稳定，切 tab 不重发）。 */
      async function ensureBegun(
        resource: DocumentResource
      ): Promise<{ ok: true; baselineContentIdentity: string } | { ok: false; message: string }> {
        if (resource.kind !== "node") return { ok: false, message: "该文档没有节点身份" };
        if (!resource.begin) resource.begin = beginNodeSession(resource);
        const begun = await resource.begin;
        // 失败后允许显式重试（下次保存重新发起同 requestId）。
        if (!begun.ok) resource.begin = null;
        return begun;
      }

      // ------------------------------------------------------------ 关闭与离开

      /** 结算并关闭单个文档；脏文档先按用户选择保存或放弃。 */
      async function closeDocument(documentId: string): Promise<void> {
        if (disposed) return;
        const resource = session.resource(documentId);
        const entry = registry.entry(documentId);
        if (!resource || !entry) return;
        setBusy(true);
        try {
          const outcome = await settleDocument({
            ...settlementItemOf(resource, entry),
            scope: "close",
            ui: {
              confirm: async (reason) => confirmInWorkspace(entry.name, reason),
              abandon: async (reason) => confirmInWorkspace(entry.name, reason)
            }
          });
          if (!outcome.ok) {
            if (outcome.reason !== "已取消") setNotice({ message: outcome.reason, tone: "error" });
            return;
          }
          const closed = session.close(documentId);
          if (!closed.ok) {
            setNotice({ message: closed.reason, tone: "error" });
            return;
          }
          const next = session.activeId();
          // 关闭活动项：优先左邻；最后一项关闭后返回画布（不保存）。
          if (next === null) ctx.canvasNavigation.exitNodeFocus();
          else await enterDocumentPresentation(next, { preserveOverviewReturn: true });
        } finally {
          setBusy(false);
        }
      }

      /** 关闭/离开确认在工作区内呈现（不依赖先触发全局 Dialog cleanup）。 */
      function confirmInWorkspace(name: string, reason: string): boolean {
        if (typeof window === "undefined" || typeof window.confirm !== "function") return false;
        return window.confirm(`${name}\n\n${reason}\n\n继续会先保存并关闭；取消则保留文档与草稿。`);
      }

      function settlementItemOf(resource: DocumentResource, entry: EditorDocumentEntry) {
        const state = session.dirtyState(resource.documentId);
        return {
          documentId: resource.documentId,
          name: entry.name,
          nodeDocument: resource.kind === "node",
          dirty: (state?.dirty ?? false) || entry.status === "dirty",
          pendingDraft: state?.pendingDraft ?? null,
          phase: state?.phase ?? "idle",
          message: state?.message ?? entry.message,
          receiptUnknown: false,
          save: async () => {
            if (resource.kind === "node") {
              const saved = await persistNode(resource);
              return saved.ok ? { ok: true } : { ok: false, message: saved.message };
            }
            // 独立文件：只能发起浏览器下载；由 settleDocument 再要求用户明确确认。
            if (!resource.controller || !resource.controller.isDirty()) return { ok: true };
            const baseName = resource.view.fileName.replace(/\.[^.]+$/, "") || "photocraft";
            const outcome = await resource.controller.deliverFile("project", { fileName: `${baseName}.pcraft` });
            if (!outcome.ok) return { ok: false, message: outcome.message ?? "保存失败，文档仍保留" };
            return { ok: true, downloadOnly: outcome.status === "download-started" };
          }
        };
      }

      /** 离开页面/切换画布：串行结算全部文档，失败即停止并定位失败项。 */
      async function prepareLeave(): Promise<{ ok: true } | { ok: false; reason: string }> {
        for (const entry of registry.snapshotState().entries) {
          const resource = session.resource(entry.id);
          if (!resource) continue;
          const outcome = await settleDocument({
            ...settlementItemOf(resource, entry),
            scope: "leave",
            ui: {
              confirm: async (reason) => confirmInWorkspace(entry.name, reason),
              abandon: async (reason) => confirmInWorkspace(entry.name, reason)
            }
          });
          if (!outcome.ok) {
            // 已经成功的项保留已推进基线；这里只停止并定位失败项。
            if (outcome.reason !== "已取消") setNotice({ message: `${entry.name}：${outcome.reason}`, tone: "error" });
            return { ok: false, reason: outcome.reason === "已取消" ? `已取消离开（${entry.name}）` : `${entry.name}：${outcome.reason}` };
          }
        }
        return { ok: true };
      }

      // ------------------------------------------------------------ 导航

      const unsubscribeNav = ctx.canvasNavigation.subscribe(() => {
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        // A queued auto-entry must not resume after another navigation changes the scene.
        // Our own successful entry also clears its now-completed node loading indicator.
        if (preparation.getSnapshot().nodeId && mode !== preparationMode) preparation.cancel();
        if (mode.type === "overview") {
          // 返回画布：暂停呈现而不是关闭文档（不保存、不新增版本）。
          pausePresentation();
          publish();
          return;
        }
        if (mode.type === "document-workspace") {
          if (session.activeId() !== mode.documentId) {
            session.activate(mode.documentId);
            publish();
          }
          return;
        }
        if (mode.kind === "image") {
          const existing = registry.findByNode(canvasId, mode.nodeId);
          if (!existing) void openNodeDocument(mode.nodeId);
          else if (session.activeId() !== existing.id) {
            session.activate(existing.id);
            publish();
          }
        }
      });

      /** 暂停活动呈现：清空节点投影/纹理与文件背景（文档、草稿与撤销保留）。 */
      function pausePresentation(): void {
        ctx.canvasRuntime.setImageFocusTexture(null);
        ctx.canvasRuntime.setImageFocusDetails(null);
        ctx.canvasRuntime.setImageFocus(null);
      }

      // 有效图片焦点目标推给 adapter（isTargetValid）。
      const syncTargets = () => {
        const canvas = getCanvas();
        const ids = canvas
          ? canvas.document.nodes
              .filter((node) => resolveImageFocusTarget(canvas, node.id) !== null)
              .map((node) => node.id)
          : [];
        ctx.canvasRuntime.setImageFocusTargets(ids);
        // 节点删除/权限丢失：标为不可写并保留本地内容；焦点经既有失效路径收敛。
        for (const entry of registry.snapshotState().entries) {
          if (entry.source.kind !== "node" || entry.source.canvasId !== canvasId) continue;
          if (ids.includes(entry.source.nodeId)) continue;
          if (!entry.writable) continue;
          session.setWritable(entry.id, false);
          session.setStatus(entry.id, "unavailable", "节点已被删除或失去访问权限，内容仍可导出");
          const mode = ctx.canvasNavigation.getSnapshot().mode;
          if (mode.type === "node-focus" && mode.nodeId === entry.source.nodeId) {
            ctx.canvasNavigation.invalidateNodeFocus("image-target-removed");
          }
        }
      };

      /** HTTP 回执可能早于 WebSocket 回流；只在对应修订已发布后重开内容。 */
      const refreshCanonical = () => {
        const canvas = woohaa3CanvasStore.getState().canvas;
        if (!canvas) return;
        for (const [documentId, revision] of pendingCanonical) {
          if (canvas.revision < revision) continue;
          const entry = registry.entry(documentId);
          if (!entry || entry.source.kind !== "node") continue;
          const target = resolveImageFocusTarget(canvas, entry.source.nodeId);
          if (!target) continue;
          pendingCanonical.delete(documentId);
          // 内容被权威替换：只更新该文档，旧回调按新代际作废。
          session.beginContentReplacement(documentId);
          const resource = session.resource(documentId);
          if (resource?.kind === "node") {
            resource.controller?.dispose();
            resource.controller = createController(resource, entry);
            void resource.view.replaceContent(target);
          }
        }
      };

      // 动态导出的权威变化（历史恢复/外部更新）：刷新“干净”节点文档的内容。
      const unsubscribeCanonical = woohaa3CanvasStore.subscribe(() => {
        syncTargets();
        refreshCanonical();
      });

      syncTargets();

      const unsubscribeRect = ctx.canvasRuntime.subscribeFocusContentRect(() => {
        const resource = session.active();
        resource?.view.setRect(workspaceRect());
      });

      // 视口目标：只有活动节点文档参与画布输入取景（文件文档自己消费手势）。
      const unregisterViewport = ctx.canvasRuntime.registerImageViewportTarget({
        read: () => {
          const resource = session.active();
          return resource?.kind === "node"
            ? { viewport: resource.view.focus.viewportState(), rect: resource.view.rectState() }
            : null;
        },
        write: (viewport) => {
          const resource = session.active();
          if (resource?.kind === "node") resource.view.setViewport(viewport);
        }
      });

      // ------------------------------------------------------------ 退出协调

      const disposeParticipant = ctx.focusExit.register({
        id: IMAGE_EDITOR_PLUGIN_ID,
        hasUnsavedChanges: () => registry.unsettled().length > 0,
        prepare: async () => {
          // 返回画布 / 切换 tab ≠ 关闭：**不**自动保存，也不释放文档（design D6）。
          // 真正离开页面或切换画布时由 `requestLeave()` 串行结算全部文档。
          return { ok: true };
        },
        abandon: () => {
          // 放弃：只丢弃本地草稿；不回滚已权威提交内容。
          for (const entry of registry.snapshotState().entries) {
            session.resource(entry.id)?.controller?.dispose();
          }
        }
      });

      // 活动操作门禁：笔迹与未确认草稿拒绝切换 tab / 返回画布。
      const unregisterGate = ctx.focusExit.registerSwitchGate(IMAGE_EDITOR_PLUGIN_ID, () => {
        const resource = session.active();
        if (!resource?.controller) return null;
        return pendingDraftOf(resource.controller);
      });

      // 页面离开守卫：切换画布 / 离开页面 / 窗口关闭时才结算全部文档（design D6）。
      const unregisterLeave = ctx.pageLeave.register({
        id: IMAGE_EDITOR_PLUGIN_ID,
        hasUnsaved: () => registry.unsettled().length > 0,
        settle: prepareLeave
      });

      // 硬刷新 / 浏览器关闭不能依赖异步保存完成：存在未保存文档时尽力提示（不承诺恢复）。
      const onBeforeUnload = (event: BeforeUnloadEvent) => {
        if (!registry.unsettled().length) return;
        event.preventDefault();
        // 现代浏览器忽略自定义文案，但必须赋值才显示通用提示。
        event.returnValue = "";
      };
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("beforeunload", onBeforeUnload);
      }

      // ------------------------------------------------------------ 呈现贡献

      const projectPort: ProjectEditorPort = {
        dialogs: ctx.dialogs,
        // 控制器由工作区持有（tab 切换不销毁），面板只复用。
        createController: () => {
          const resource = session.active();
          if (!resource) throw new Error("没有活动文档");
          return resource.controller!;
        },
        loadProjectBytes: async (storageKey) => loadMediaBytes(storageKey),
        loadBaseImageBytes: async () => {
          const resource = session.active();
          if (!resource) return null;
          if (resource.kind === "file") return fileBytes.get(resource.documentId) ?? null;
          return loadMediaBytes(readKey(resource.view.baseAsset() as never));
        },
        save: async () => {
          const resource = session.active();
          if (!resource?.controller) return { ok: false, message: "没有活动文档" };
          if (resource.kind === "file") {
            // 独立文件的“保存/应用”= 保存工程到本地；不写节点、不产生版本。
            const baseName = resource.view.fileName.replace(/\.[^.]+$/, "") || "photocraft";
            const outcome = await resource.controller.deliverFile("project", { fileName: `${baseName}.pcraft` });
            return outcome.ok ? { ok: true } : { ok: false, message: outcome.message ?? "保存失败" };
          }
          const saved = await persistNode(resource);
          return saved.ok ? { ok: true } : { ok: false, message: saved.message ?? "保存失败" };
        },
        // 独立文件文档没有画布节点资产：允许它在无 baseAsset 的情况下用自己的字节开工程
        // （change: 2026-10-21-add-photocraft-document-workspace，design D3/D4）。
        get fileDestination() {
          return session.active()?.kind === "file";
        },
        exit: () => {
          void ctx.canvasNavigation.requestExitNodeFocus();
        }
      };

      async function loadMediaBytes(storageKey: string): Promise<Uint8Array | null> {
        const url = storageKey ? ctx.mediaRemote.urlFor(storageKey, canvasId) : null;
        if (!url) return null;
        const response = await fetch(url, { credentials: "same-origin" });
        return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
      }

      /** 文件文档的背景端口（按当前活动文档决定）。 */
      function activeBackground() {
        const resource = session.active();
        return resource?.kind === "file" ? fileBackgroundPort(resource.view) : undefined;
      }

      // 两种 slot 贡献渲染同一界面；后台文档不挂载隐藏编辑器。
      const renderWorkspace = () => {
        const background = activeBackground();
        return (
          <ImageEditorWorkspace
            store={store}
            projectPort={background ? { ...projectPort, renderCanvasBackground: background } : projectPort}
            onActivateDocument={activateDocument}
            onCloseDocument={(documentId) => void closeDocument(documentId)}
            onOpenFile={openFile}
          />
        );
      };

      const removeOverlay = ctx.slots.register("canvas.focus-workspace", {
        id: IMAGE_EDITOR_WORKSPACE_ID,
        owner: IMAGE_EDITOR_PLUGIN_ID,
        kind: "image",
        available: () => registry.snapshotState().entries.length > 0,
        render: renderWorkspace
      });
      const removeDocumentWorkspace = ctx.slots.register("canvas.document-workspace", {
        id: DOCUMENT_WORKSPACE_ID,
        owner: IMAGE_EDITOR_PLUGIN_ID,
        isAvailable: (documentId) => registry.entry(documentId)?.source.kind === "file",
        render: renderWorkspace
      });

      // ------------------------------------------------------------ service

      const service: ImageEditService = {
        isActive: () => session.activeId() !== null,
        nodeId: () => {
          const resource = session.active();
          return resource?.kind === "node" ? resource.nodeId : null;
        },
        setHistoryOverride: (override) => {
          // 历史只属于节点文档；文件文档没有节点版本。
          const resource = session.active();
          if (resource?.kind !== "node") return;
          resource.view.setHistoryOverride(override);
        },
        refreshFromCanonical: (revision) => {
          const resource = session.active();
          if (!resource) return;
          pendingCanonical.set(resource.documentId, revision);
          refreshCanonical();
        },
        draftState: () => {
          const resource = session.active();
          if (!resource?.controller) return "saved";
          const phase = resource.controller.currentState().phase;
          if (phase === "saving" || phase === "freezing") return "saving";
          if (phase === "failed") return "error";
          return resource.controller.isDirty() ? "unsaved" : "saved";
        }
      };
      ctx.provide(IMAGE_EDIT_SERVICE as never, service as never);
      publish();

      // 只读/断线变化影响“添加到画布”与节点保存的可写性展示。
      const unsubscribeSession = typeof ctx.canvasSession.subscribe === "function"
        ? ctx.canvasSession.subscribe(() => publish())
        : () => undefined;

      // 仅开发构建暴露排障镜像。
      if (import.meta.env.DEV) {
        (globalThis as unknown as { __imageEditDebug?: unknown }).__imageEditDebug = () => ({
          ...session.metrics(),
          policy: describePolicy(),
          documents: registry.snapshotState().entries.map((entry) => ({
            id: entry.id, name: entry.name, status: entry.status, source: entry.source.kind, generation: entry.generation
          })),
          activeId: session.activeId(),
          notice
        });
        // 测试/排障：工作区 store 快照（不写入业务状态）。
        (globalThis as unknown as { __imageWorkspaceStore?: DocumentWorkspaceStore }).__imageWorkspaceStore = store;
      }

      ctx.effect(
        () => () => {
          disposed = true;
          unsubscribeNav();
          preparation.dispose();
          unregisterEntryGuard();
          removeReadinessOverlay();
          unsubscribeCanonical();
          unsubscribeSession();
          unregisterViewport();
          unsubscribeRect();
          removeOverlay();
          removeDocumentWorkspace();
          removingRecovery?.();
          removingRecovery = null;
          recoveryLabel = null;
          disposeParticipant();
          unregisterGate();
          unregisterLeave();
          if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
            window.removeEventListener("beforeunload", onBeforeUnload);
          }
          session.dispose();
          fileBytes.clear();
          publishOperations.clear();
          store.dispose();
          delete (globalThis as unknown as { __imageWorkspaceStore?: unknown }).__imageWorkspaceStore;
        },
        "image-editor-lifecycle"
      );
    },
    {
      name: IMAGE_EDITOR_PLUGIN_ID,
      inject: ["slots", "canvasRuntime", "canvasRemote", "canvasSession", "mediaRemote", "canvasNavigation", "focusExit", "dialogs", "canvasCommands", "pageLeave"]
    }
  );
}

function readKey(asset: { metadata?: Record<string, unknown> } | null): string {
  const value = asset?.metadata?.storageKey;
  return typeof value === "string" ? value : "";
}

function readMeta(asset: { metadata?: Record<string, unknown> } | null, key: string): string | null {
  const value = asset?.metadata?.[key];
  return typeof value === "string" ? value : null;
}

function readMetaNumber(asset: { metadata?: Record<string, unknown> } | null, key: string): number | null {
  const value = asset?.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 右下角「图像编辑」恢复入口图标（与工具栏其它动作同尺寸）。 */
function PhotoEditIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="3" y="4" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="9.5" r="1.6" fill="currentColor" />
      <path d="M4.5 16.5l4.2-4.2 3.1 3.1 2.6-2.6 4.1 4.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7 21h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
