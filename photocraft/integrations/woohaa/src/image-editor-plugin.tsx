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
import { imageEditRequestId, imageEditSessionId } from "./save.js";
import { MediaOperationBoundary } from "@woohaa3/frontend/plugin-api";
import { rasterizeDrawable, defaultRasterCanvasFactory, BEVY_TEXTURE_MAX_DIMENSION } from "@woohaa3/frontend/plugin-api";
import { ImageEditorWorkspace, fileBackgroundPort } from "./image-editor-overlay.js";
import { definePlugin } from "@woohaa3/frontend/plugin-api";
import { IMAGE_EDIT_SERVICE, type ImageEditService } from "@woohaa3/frontend/plugin-api";
import { EditorWorkspaceController } from "./editor-workspace.js";
import type { ProjectEditorPort } from "./project-editor-pane.js";
import { IMAGE_PROJECT_CONTENT_TYPE, resolveNodeDisplayName } from "@woohaa3/contracts";
import { EditorDocumentRegistry, type EditorDocumentEntry, MAX_OPEN_DOCUMENTS, RequestSequence, setAnimationCodecPort } from "@woohaa3/photocraft-editor";
import { heldBytesAfterSave, planCloseAll, planCloseOthers, planReopenRecent, runClosePlan, type RecentFileEntry } from "@woohaa3/photocraft-protocol";
import { DocumentWorkspaceSession, pendingDraftOf, type DocumentResource } from "./document-session.js";
import type { FileDocumentWorkspace } from "./file-document-workspace.js";
import { settleDocument } from "./document-settlement.js";
import { createBrowserFilePort, decodeImageSize } from "./file-delivery-adapter.js";
import { classifyOpenFile, OPEN_FILE_ACCEPT } from "./open-file.js";
import { PLACE_IMAGE_ACCEPT, deliverPsd, pickFile, pickPsd, placeImageFile } from "./place-file.js";
import { SerialGate, canOpenDocument, DEFAULT_WORKSPACE_POLICY, describePolicy } from "./workspace-policy.js";
import { createPublishOperation, publishToCanvas, type PublishOperation } from "./publish-node.js";
import { normalizeEditorImage } from "@woohaa3/photocraft-editor";
import { DocumentWorkspaceStore } from "./workspace-store.js";
import { createAnimationCodecPort } from "./animation-codec-port.js";
import { RecentFilesIndex, planReleasedBytes, trackDocumentWhenReady } from "./recent-files-index.js";

export const IMAGE_EDITOR_PLUGIN_ID = "image-editor";
const IMAGE_EDITOR_WORKSPACE_ID = "image-editor-workspace";
const DOCUMENT_WORKSPACE_ID = "image-document-workspace";

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
      /**
       * 最近文件索引（U04）：只记身份与大小，字节仍在 `fileBytes`。
       *
       * 关标签/发布到画布时字节会被释放，那条记录同步移除——否则界面会显示一条点不开的
       * 「最近文件」，用户点了才发现打不开。
       */
      const recentFiles = new RecentFilesIndex();
      /**
       * 等内核视图出现后再记录最近文件（打开路径的控制器是异步建好的）。
       *
       * 值是取消订阅：文档在视图出现前被关闭/发布时用它取消，避免记录一条已经不存在的文档。
       */
      const recentTracked = new Map<string, () => void>();
      let layerClipboard: Uint8Array | null = null;
      function transferLayers(id: string): void {
        const resource = session.active();
        const controller = resource?.controller;
        if (!resource || !controller || resource.view.isReadOnlyPreview()) return;
        if (controller.hasActiveDraft()) { setNotice({message: "请先确认或取消当前草稿", tone: "error"}); return; }
        if (id === "edit.layerTransferCopy") {
          const result = controller.copyLayers();
          if (result.ok) layerClipboard = result.value;
          setNotice({message: result.ok ? "已复制到工作区剪贴板" : result.message, tone: result.ok ? "info" : "error"});
          return;
        }
        if (!layerClipboard) { setNotice({message: "工作区剪贴板为空，请先复制图层", tone: "error"}); return; }
        const document = controller.currentView().document;
        const result = controller.pasteLayers(layerClipboard, {inPlace: id === "edit.layerTransferPasteInPlace", ...(document ? {center: [document.width / 2, document.height / 2] as [number, number]} : {})});
        setNotice(result.ok ? null : {message: result.message, tone: "error"});
      }
      /** 添加到画布的稳定操作身份（按文档；重试复用同一 operationId/nodeId）。 */
      const publishOperations = new Map<string, PublishOperation>();
      /** 等待权威修订到达后重开内容的节点文档。 */
      const pendingCanonical = new Map<string, number>();
      let busy = false;
      let notice: { message: string; tone: "info" | "error" } | null = null;
      let disposed = false;
      /**
       * 宿主视频编解码端口（U77）。
       *
       * 编辑器只依赖公共 `AnimationCodecPort` 契约；真实 WebCodecs + 容器封装在这里注册。
       * 注册后时间轴面板的「导入视频 / 导出视频」才可用；浏览器缺 WebCodecs 时端口自己回答
       * `supported:false`（面板禁用并显示原因），不会静默只取首帧。
       */
      const animationCodec = createAnimationCodecPort();
      setAnimationCodecPort(animationCodec);

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
          writable: ctx.canvasSession.isWritable(),
          recentFiles: recentFiles.snapshot(),
          recentFilesError: recentFiles.lastError,
          notice
        });
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
          // 状态变化即刷新该文档的门禁：草稿开始/结束、保存开始/结束都会改变能否切换或关闭。
          onState: () => syncDocumentGate(resource.documentId),
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
          // 文档归属：条目 id 与注册表代际。关闭后重开同一节点会拿到新代际，
          // 因此上一会话的模式计划不会被确认到新文档上（任务 3.3）。
          documentId: resource.documentId,
          documentGeneration: () => registry.entry(resource.documentId)?.generation ?? 0,
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
        // 标签用**用户可读的节点名**：`nodeData.title` → 已提交提示词摘要 → 中文默认名。
        // 直接退回 `node.type` 会让所有图片节点都叫 `image`，同名时标签条再露出内部节点 id
        // （`asset-image-c5d…`，2026-10-24 审片 A12）。
        const name = resolveNodeDisplayName({
          type: node?.type,
          explicitName: (canvas?.nodeData[nodeId] as { title?: unknown } | undefined)?.title,
          prompt: (canvas?.nodeData[nodeId] as { prompt?: unknown } | undefined)?.prompt
        }).displayName;
        const opened = await gate.run(async () => session.openNode({
          nodeId,
          name,
          writable: ctx.canvasSession.isWritable(),
          // 同名时才露出的来源补充：用用户能认出的东西（类型中文名 + 已提交提示词摘要），
          // 不能是内部节点 id（A12）。
          detail: detailForNode(node?.type, (canvas?.nodeData[nodeId] as { prompt?: unknown } | undefined)?.prompt, name)
        }));
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
       * 同名文档的来源补充（A12）。
       *
       * 标签条只在重名时显示 detail；这里给出**用户能认出的**信息（内容类型中文名，必要时
       * 再加已提交提示词摘要）。绝不能回落到节点 id —— 那是内部标识，`asset-image-c5d…`
       * 会直接出现在画面上。
       */
      function detailForNode(type: string | undefined, prompt: unknown, name: string): string | null {
        const resolved = resolveNodeDisplayName({ type, prompt });
        const label = resolved.contentTypeLabel;
        // 名字本身已经来自提示词摘要时，再重复一遍摘要没有信息量。
        if (resolved.nameSource === "prompt-summary" && resolved.displayName === name) return label;
        return label;
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
       * 保存成功后轮换编辑会话身份（A2 回归）。
       *
       * 服务端按 `begin:<sessionId>` 幂等返回**第一次** begin 的基线，`complete` 又优先用持久化的
       * 基线而不是请求里的值。于是同一个 sessionId 在第一次成功保存之后，节点身份就与那份
       * 陈旧基线不同，之后每一次「应用到节点」都以 `EDIT_SESSION_BASELINE_STALE` 被拒 ——
       * 表现就是「点了应用到节点，刷新后没有新版本」。
       *
       * 因此每次成功写入都必须换新 sessionId（并清掉 requestId 与缓存的 begin），让下一次
       * 保存重新捕获基线；`editAbandon` 顺手让服务端丢掉上一条 prepared 记录。
       */
      function rotateEditSession(resource: DocumentResource): void {
        if (resource.kind !== "node") return;
        const previous = resource.sessionId;
        resource.sessionId = imageEditSessionId(resource.nodeId);
        resource.requestId = null;
        resource.begin = null;
        resource.begun = false;
        // `edit-abandon` 按 begin 记录键（`begin:<sessionId>`）定位，不是按 sessionId。
        void ctx.canvasRemote.editAbandon?.({
          canvasId,
          nodeId: resource.nodeId,
          requestId: `begin:${previous}`
        }).catch(() => undefined);
      }

      /**
       * 呈现请求序号（change: 2026-10-22-add-photocraft-file-workflows，任务 3.3）。
       *
       * 打开/重开都是异步的（解码 + WASM 打开 + 入场过渡）。先发起的请求可能后完成；
       * 若它无条件提交导航，就会把用户在等待期间切到的文档挤掉。规则：只有最新一次请求
       * 可以改变呈现——更早的请求仍完成打开（tab 保留），只是不抢呈现。
       */
      const presentationRequests = new RequestSequence();

      /** 让文档成为活动呈现：节点文档提交 node-focus，独立文件提交 document-workspace。
       *
       * 两种情况都经唯一 Navigation/runtime coordinator 原子切换；失败保留原呈现与草稿。
       * 被更新的呈现请求取代时提前返回 `false`（文档已打开，只是不抢呈现）。
       */
      async function enterDocumentPresentation(documentId: string, options: { preserveOverviewReturn: boolean }): Promise<boolean> {
        const token = presentationRequests.next("presentation");
        const resource = session.resource(documentId);
        if (!resource) return false;
        const prepared = await startResource(resource);
        if (!prepared) return false;
        // 准备期间用户已经切到别的文档：不提交导航，避免把新的呈现挤掉。这不是失败——
        // 文档确实打开了（tab 已存在），呈现权交给更新的那次请求，所以仍返回成功。
        if (!presentationRequests.isLatest("presentation", token)) return true;
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
        // （tab 往返与重新进入同一节点共用；change: 2026-10-21，design D4）。
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

      /**
       * 切换活动文档。
       *
       * 门禁在会话里统一判定（`DocumentWorkspaceSession.activate` 先按活动控制器刷新未结算
       * 草稿/保存阶段，再交给注册表），因此键盘、程序化导航与这里的点击共用同一条规则
       * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
       */
      function activateDocument(documentId: string): void {
        if (disposed) return;
        const previous = session.activeId();
        const result = session.activate(documentId);
        if (!result.ok) {
          syncDocumentGate(previous);
          setNotice({ message: result.reason, tone: "error" });
          return;
        }
        if (previous !== documentId) {
          // tab 切换：保留本轮首次进入捕获的 overview 返回位置。
          void enterDocumentPresentation(documentId, { preserveOverviewReturn: true });
        }
        syncDocumentGate(documentId);
      }

      /**
       * 把活动文档的门禁状态写进注册表，供标签栏显示与任何激活路径拒绝。
       *
       * 判定本身复用会话里的同一个 `pendingDraftOf`（其权威是控制器的 `blockingDraft()`），
       * 不在这里另写一套条件。注册表的 gate 是「**当前活动**文档不能被离开」的共享位：
       * 只允许活动文档写它——后台文档保存结束若来改这个位，会把之后的切换永久挡住，
       * 而那时没有任何活动文档的手续会再去清它。
       */
      function syncDocumentGate(documentId: string | null): void {
        if (!documentId) return;
        if (session.activeId() !== documentId) return;
        const resource = session.resource(documentId);
        const reason = resource?.controller ? pendingDraftOf(resource.controller) : null;
        registry.setGate(documentId, reason);
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

      /**
       * 记录一条最近文件（U04）。
       *
       * 尺寸取自**已打开文档的视图**（内核真实画布），不是从文件名或字节头猜的；没有文档视图
       * 时不记录——一条尺寸错误的记录会误导用户在重开前判断内容。
       */
      function recordRecent(documentId: string, name: string, bytes: Uint8Array): void {
        const resource = session.resource(documentId);
        const document = resource?.controller?.currentView().document;
        if (!document) return;
        recentFiles.record({
          id: documentId,
          name,
          width: document.width,
          height: document.height,
          bytes
        });
        pruneRetainedBytes();
        publish();
      }

      /**
       * 等内核真正打开文档后再记录（尺寸来自内核，不从字节头猜）。
       *
       * 打开路径只拿到字节：控制器由呈现层异步 `openProject`/`openImage`，此刻
       * `currentView().document` 还是 null。直接记录会静默漏掉每一条最近文件，因此这里等
       * 第一份带尺寸的视图出现再记一次（规则见 `trackDocumentWhenReady`）。
       */
      function trackRecent(documentId: string, name: string, bytes: Uint8Array): void {
        const controller = session.resource(documentId)?.controller;
        if (!controller) return;
        const cancel = trackDocumentWhenReady(controller, () => {
          recentTracked.delete(documentId);
          recordRecent(documentId, name, bytes);
        });
        recentTracked.set(documentId, cancel);
      }

      /** 取消尚未成立的记录（文档在视图出现前就被关闭/发布）。 */
      function cancelTrackedRecent(documentId: string): void {
        recentTracked.get(documentId)?.();
        recentTracked.delete(documentId);
      }

      /**
       * 字节预算收敛：最近记录之外的字节不再保留。
       *
       * 已关闭文档的字节**暂时**留在内存里，这样「最近文件 ▸ 重开」能真的用原字节重开；
       * 一旦索引按条数/累计预算把它逐出，或用户移除记录，对应字节立刻释放。仍在打开的
       * 文档无论有没有记录都保留字节（保存/导出要用）。规则见 `planReleasedBytes`。
       */
      function pruneRetainedBytes(): void {
        const released = planReleasedBytes({
          bytes: fileBytes.keys(),
          recorded: recentFiles.snapshot().entries.map((entry) => entry.id),
          open: registry.snapshotState().entries.map((entry) => entry.id)
        });
        for (const id of released) fileBytes.delete(id);
      }

      /**
       * 保存成功后刷新宿主持有的字节（U04）。
       *
       * 打开时持有的是**打开那一刻**的字节；用户保存工程后磁盘上的内容已经前进。若不同步，
       * 「最近文件 ▸ 重开」会静默打开保存前的旧内容——记录还在、名字一样，内容却是旧的。
       * 判定规则见 `bytesAfterProjectSave`（修订必须与冻结产物一致）。
       */
      function refreshHeldBytes(documentId: string): void {
        const controller = session.resource(documentId)?.controller;
        const held = heldBytesAfterSave({
          currentRevision: controller?.currentView().document?.revision ?? null,
          frozen: controller?.frozenArtifacts() ?? null
        });
        if (!held) return;
        fileBytes.set(documentId, held);
        const existing = recentFiles.snapshot().entries.find((entry) => entry.id === documentId);
        // 只刷新同一条记录的字节数与时间；身份/尺寸/名称不变。
        if (existing) {
          recentFiles.record({
            id: documentId,
            name: existing.name,
            width: existing.width,
            height: existing.height,
            bytes: held
          });
        }
        publish();
      }

      /**
       * 用户显式移除一条最近记录。
       *
       * 只释放**已关闭**文档的字节：仍打开的文档还要用它保存/导出，记录消失不等于内容消失。
       */
      function forgetRecent(documentId: string): void {
        cancelTrackedRecent(documentId);
        recentFiles.remove(documentId);
        if (!session.resource(documentId)) fileBytes.delete(documentId);
        publish();
      }

      /**
       * 重开一条最近文件（U04）。
       *
       * 前置判定与面板共用同一份纯规则；字节只从宿主内存取（浏览器不授予路径权限），
       * 取不到就如实说「需重新选择」，不静默退回新建。
       */
      async function reopenRecent(entry: RecentFileEntry): Promise<{ ok: true } | { ok: false; reason: string }> {
        if (disposed) return { ok: false, reason: "工作区已释放" };
        const held = fileBytes.get(entry.id) ?? null;
        const plan = planReopenRecent(recentFiles.snapshot(), entry.id, { hasBytes: held !== null, busy: activeDocumentBusy() });
        if (!plan.ok) return { ok: false, reason: plan.reason };
        // 记录对应的文档还开着（例如刚切走）：激活它，不为同一份内容再开一个 tab。
        if (session.resource(entry.id)) {
          activateDocument(entry.id);
          return { ok: true };
        }
        const capacity = canOpenDocument(registry.snapshotState().entries.length);
        if (!capacity.ok) return { ok: false, reason: capacity.reason };
        const classified = classifyOpenFile({ name: entry.name });
        if (!classified.ok) return { ok: false, reason: classified.reason };
        setBusy(true);
        setNotice(null);
        try {
          const opened = session.openFile({ fileName: entry.name, bytes: held!, kind: classified.kind });
          if (!opened.ok) return { ok: false, reason: opened.reason };
          fileBytes.set(opened.documentId, held!);
          // 记录跟着新文档 id 走：旧 id 的条目与字节一并释放，列表只留一条。
          cancelTrackedRecent(entry.id);
          recentFiles.remove(entry.id);
          trackRecent(opened.documentId, entry.name, held!);
          pruneRetainedBytes();
          const presented = await enterDocumentPresentation(opened.documentId, { preserveOverviewReturn: false });
          return presented ? { ok: true } : { ok: false, reason: "文件已打开，但进入编辑视图失败" };
        } finally {
          setBusy(false);
        }
      }

      /** 活动文档是否有未结算草稿或正在保存（重开/新建前必须结算）。 */
      function activeDocumentBusy(): boolean {
        const resource = session.active();
        if (!resource?.controller) return false;
        const phase = resource.controller.currentState().phase;
        if (phase === "saving" || phase === "freezing") return true;
        return resource.controller.hasActiveDraft();
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
          // U04：打开/新建的 `.pcraft` 与归一后的图片字节都记入最近文件（只记身份与大小）。
          // 尺寸取自内核视图（异步出现），因此不在这里直接记录。
          trackRecent(opened.documentId, file.name, bytes);
          await enterDocumentPresentation(opened.documentId, { preserveOverviewReturn: false });
        } catch (error) {
          setNotice({ message: error instanceof Error ? error.message : "无法打开文件，请重试", tone: "error" });
        } finally {
          setBusy(false);
        }
      }

      /**
       * 新建空白文档（change: 2026-10-22-add-photocraft-file-workflows，U01）。
       *
       * 编辑器在**独立候选实例**上建好文档并序列化成自包含 `.pcraft` 字节后交到这里；
       * 宿主只需用自己的既有打开路径把它落成一个独立文档/标签。这样：
       * - 不把新建解释成新建画布，也不伪造节点文档；
       * - 已有文档时可以再建一份（每份都有自己的条目、控制器与撤销栈）；
       * - 容量上限、命名、tab 注册与呈现全部沿用既有实现，不复制第二套状态。
       */
      async function openBlankDocument(input: { bytes: Uint8Array; name: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
        if (disposed) return { ok: false, reason: "工作区已释放" };
        if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
          return { ok: false, reason: "新文档没有可打开的工程字节" };
        }
        const capacity = canOpenDocument(registry.snapshotState().entries.length);
        if (!capacity.ok) return { ok: false, reason: capacity.reason };
        setBusy(true);
        setNotice(null);
        try {
          const fileName = `${input.name.trim() || "未命名"}.pcraft`;
          const opened = session.openFile({ fileName, bytes: input.bytes, kind: "project" });
          if (!opened.ok) return { ok: false, reason: opened.reason };
          fileBytes.set(opened.documentId, input.bytes);
          // U04：新建文档也进入最近文件（与「打开文件」同一条记录路径）。
          trackRecent(opened.documentId, fileName, input.bytes);
          const presented = await enterDocumentPresentation(opened.documentId, { preserveOverviewReturn: false });
          return presented ? { ok: true } : { ok: false, reason: "新文档已创建，但进入编辑视图失败" };
        } finally {
          setBusy(false);
        }
      }

      /** 显式“置入图片”：只往当前活动文档加层，不建新文档。 */
      function placeImage(): void {
        if (disposed || typeof document === "undefined") return;
        void (async () => {
          const file = await pickFile(PLACE_IMAGE_ACCEPT);
          if (!file) return;
          const resource = session.active();
          if (!resource?.controller) {
            setNotice({ message: "没有可置入的活动文档", tone: "error" });
            return;
          }
          const entry = registry.entry(resource.documentId);
          if (entry && !entry.writable) {
            setNotice({ message: "当前文档只读，无法置入", tone: "error" });
            return;
          }
          setBusy(true);
          try {
            const outcome = await placeImageFile(resource.controller, file);
            if (!outcome.ok) {
              setNotice({ message: outcome.reason, tone: "error" });
              return;
            }
            setNotice({ message: `已置入 ${outcome.name}`, tone: "info" });
          } finally {
            setBusy(false);
          }
        })();
      }

      /** 导入 PSD：内核预检 + 候选文档；默认拒绝不可编辑结构，可显式选择扁平副本。 */
      function importPsd(): void {
        if (disposed) return;
        void (async () => {
          const picked = await pickPsd();
          if (!picked.ok) {
            if (picked.reason !== "已取消") setNotice({ message: picked.reason, tone: "error" });
            return;
          }
          const capacity = canOpenDocument(registry.snapshotState().entries.length);
          if (!capacity.ok) {
            setNotice({ message: capacity.reason, tone: "error" });
            return;
          }
          // PSD 先经内核预检，再决定是否作为新文档打开。
          const opened = session.openFile({ fileName: picked.file.name, bytes: picked.file.bytes, kind: "project" });
          if (!opened.ok) {
            setNotice({ message: opened.reason, tone: "error" });
            return;
          }
          fileBytes.set(opened.documentId, picked.file.bytes);
          trackRecent(opened.documentId, picked.file.name, picked.file.bytes);
          await enterDocumentPresentation(opened.documentId, { preserveOverviewReturn: false });
        })();
      }

      /** 导出 PSD：只交付文件副本，不影响工程保存基线。 */
      function exportPsd(): void {
        if (disposed) return;
        void (async () => {
          const resource = session.active();
          if (!resource?.controller) {
            setNotice({ message: "没有可导出的活动文档", tone: "error" });
            return;
          }
          setBusy(true);
          try {
            const inspected = resource.controller.inspectPsdExport();
            if (!inspected.ok) {
              setNotice({ message: inspected.message, tone: "error" });
              return;
            }
            const report = inspected.value as { editable?: boolean; blocking?: number; rasterizable?: number } | null;
            const rasterize = report ? report.blocking === 0 && (report.rasterizable ?? 0) > 0 : false;
            const exported = resource.controller.exportPsd({ rasterizeLossy: rasterize });
            if (!exported.ok) {
              setNotice({ message: exported.message, tone: "error" });
              return;
            }
            const base = (resource.kind === "file" ? resource.view.fileName : "photocraft").replace(/\.[^.]+$/, "") || "photocraft";
            const delivered = await deliverPsd(
              createBrowserFilePort(() => base),
              { bytes: exported.value.bytes, fileName: `${base}.psd` }
            );
            if (!delivered.ok) {
              setNotice({ message: delivered.message ?? "PSD 导出失败，文档保留", tone: "error" });
              return;
            }
            const exportReport = exported.value.report as {
              rasterized?: boolean;
              viewLosses?: Array<{ feature?: string; reason?: string }>;
            } | null;
            const rasterized = exportReport?.rasterized === true;
            // PSD 没有参考线颜色/标尺原点/计数分组的通道：这些是文档级数据，不挂在图层上，
            // 只报「已导出可编辑 PSD」会让用户以为全保住了。把视图损失一并说清楚。
            const viewLosses = exportReport?.viewLosses ?? [];
            const baseText = rasterized
              ? "已导出栅格化 PSD 副本；原工程未保存状态不变"
              : "已导出可编辑 PSD；原工程未保存状态不变";
            setNotice({
              message: viewLosses.length === 0
                ? baseText
                : `${baseText}。另：${viewLosses.map(item => item.reason ?? item.feature).join("；")}`,
              // 宿主通知只有 info/error 两档；这不是失败，因此用 info，把损失详情写进文案。
              tone: "info"
            });
          } finally {
            setBusy(false);
          }
        })();
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
            // U04：保存过的内容成为新的「可直接重开」字节；不更新会让重开打开旧内容。
            if (kind === "project") refreshHeldBytes(resource.documentId);
            setNotice({ message: "已发起下载；请确认文件已保存到目标位置（未自动标记为已保存）", tone: "info" });
            return;
          }
          session.setStatus(resource.documentId, resource.controller.isDirty() ? "dirty" : "clean");
          if (kind === "project") refreshHeldBytes(resource.documentId);
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
          // 内容已经变成画布节点文档：文件字节不再需要，记录同步移除（否则会出现一条
          // 名为文件、实际指向节点文档的记录）。
          forgetRecent(resource.documentId);
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
        // 没有未保存改动时「应用到节点」不产生新版本是正确的，但必须说清楚，不能看起来
        // 像保存成功（A2：点了按钮、刷新后什么都没变）。
        if (!controller) return { ok: false, message: "文档尚未就绪，无法保存" };
        if (!controller.isDirty()) return { ok: false, message: "没有未保存的改动" };
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
          // 成功写入后基线已经过期：换新会话，否则下一次保存必定被判基线冲突（A2）。
          rotateEditSession(resource);
        } else {
          session.setStatus(resource.documentId, outcome.code === "conflict" ? "conflict" : "error", outcome.message);
          // 冲突是「节点已被别的写入更新」：丢弃旧基线，下次保存重新 begin 才能写进去。
          if (outcome.code === "conflict") {
            resource.begin = null;
            resource.requestId = null;
            rotateEditSession(resource);
          }
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
      /**
       * 关闭一个文档并返回结果（供单个关闭与批量串行结算共用）。
       *
       * 返回 `{ok:false}` 时**保留现场**：文档、草稿与保存状态都不变。批量关闭依赖这个
       * 返回值在首个失败处停止，不能把「用户取消」或「保存失败」当成已关闭继续往下走。
       */
      async function closeDocumentStep(documentId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        const resource = session.resource(documentId);
        const entry = registry.entry(documentId);
        if (!resource || !entry) return { ok: true };
        const outcome = await settleDocument({
          ...settlementItemOf(resource, entry),
          scope: "close",
          ui: {
            confirm: async (reason) => confirmInWorkspace(entry.name, reason),
            abandon: async (reason) => confirmInWorkspace(entry.name, reason)
          }
        });
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        const closed = session.close(documentId);
        if (!closed.ok) return { ok: false, reason: closed.reason };
        // 关闭**不**立刻丢字节：最近文件靠它重开（见 `pruneRetainedBytes`）。只取消
        // 尚未成立的记录（文档在视图出现前就关了，从未真正打开过）。
        cancelTrackedRecent(documentId);
        pruneRetainedBytes();
        const next = session.activeId();
        // 关闭活动项：优先左邻；最后一项关闭后返回画布（不保存）。
        if (next === null) ctx.canvasNavigation.exitNodeFocus();
        else await enterDocumentPresentation(next, { preserveOverviewReturn: true });
        return { ok: true };
      }

      async function closeDocument(documentId: string): Promise<void> {
        if (disposed) return;
        setBusy(true);
        try {
          const outcome = await closeDocumentStep(documentId);
          // 用户主动取消（取消保存/取消关闭）不是错误，不弹红色提示。
          if (!outcome.ok && outcome.reason !== "已取消") setNotice({ message: outcome.reason, tone: "error" });
        } finally {
          setBusy(false);
        }
      }

      /**
       * 关闭其他文档（U03）：保留活动项，其余逐文档串行结算。
       *
       * 关闭顺序先算成计划再执行：活动项**不动**，所以结算期间不会因为切换活动文档而改变
       * 目标集合。首个失败（未确认草稿、保存失败、用户取消）立即停止，其余文档保持原状。
       */
      async function closeOtherDocuments(): Promise<void> {
        if (disposed) return;
        const state = registry.snapshotState();
        const activeId = state.activeId ?? state.entries[0]?.id ?? null;
        if (activeId === null) return;
        const targets = state.entries
          .filter((entry) => entry.id !== activeId)
          .map((entry) => ({ id: entry.id, dirty: session.dirtyState(entry.id)?.dirty ?? false, gate: session.dirtyState(entry.id)?.pendingDraft ?? null }));
        const plan = planCloseOthers(targets, activeId);
        if (!plan.ok) {
          if (plan.code !== "empty") setNotice({ message: plan.reason, tone: "error" });
          return;
        }
        setBusy(true);
        try {
          const outcome = await runClosePlan(plan.order, closeDocumentStep);
          const failed = outcome.failed;
          if (failed && failed.reason !== "已取消") {
            setNotice({ message: failed.reason, tone: "error" });
          }
        } finally {
          setBusy(false);
        }
      }

      /**
       * 关闭全部文档（U03）：活动项最后关闭，避免中途没有活动文档导致呈现切换抖动。
       *
       * 与「关闭其他」相同：串行 + 首个失败即停止，不隐式保存、不丢弃未确认草稿。
       */
      async function closeAllDocuments(): Promise<void> {
        if (disposed) return;
        const state = registry.snapshotState();
        const activeId = state.activeId ?? state.entries[0]?.id ?? null;
        if (activeId === null) return;
        const targets = state.entries.map((entry) => ({
          id: entry.id,
          dirty: session.dirtyState(entry.id)?.dirty ?? false,
          gate: session.dirtyState(entry.id)?.pendingDraft ?? null
        }));
        const plan = planCloseAll(targets, activeId);
        if (!plan.ok) {
          if (plan.code !== "empty") setNotice({ message: plan.reason, tone: "error" });
          return;
        }
        setBusy(true);
        try {
          const outcome = await runClosePlan(plan.order, closeDocumentStep);
          const failed = outcome.failed;
          if (failed && failed.reason !== "已取消") {
            setNotice({ message: failed.reason, tone: "error" });
          }
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
        save: async (view, controller) => {
          // 保存必须落到**发起这次保存的文档**，不能改取当前活动文档：多标签下切过 tab 之后，
          // 「应用到节点」会把另一篇文档写回目标节点，或者静默写到错误节点（A2）。
          const resource = session.findByController(controller) ?? session.findByView(view) ?? session.active();
          if (!resource?.controller) return { ok: false, message: "没有活动文档" };
          if (resource.kind === "file") {
            // 独立文件的“保存/应用”= 保存工程到本地；不写节点、不产生版本。
            const baseName = resource.view.fileName.replace(/\.[^.]+$/, "") || "photocraft";
            const outcome = await resource.controller.deliverFile("project", { fileName: `${baseName}.pcraft` });
            return outcome.ok ? { ok: true } : { ok: false, message: outcome.message ?? "保存失败" };
          }
          const saved = await persistNode(resource);
          if (!saved.ok) setNotice({ message: saved.message ?? "保存失败", tone: "error" });
          else setNotice(null);
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
            onTransfer={transferLayers}
            store={store}
            projectPort={background ? { ...projectPort, renderCanvasBackground: background } : projectPort}
            onActivateDocument={activateDocument}
            onCloseDocument={(documentId) => void closeDocument(documentId)}
            onReorderDocument={(documentId, targetDocumentId) => {if(registry.reorder(documentId, targetDocumentId)) publish();}}
            onOpenFile={openFile}
            onRequestDocumentSlot={openBlankDocument}
            onCloseAllDocuments={() => void closeAllDocuments()}
            onCloseOtherDocuments={() => void closeOtherDocuments()}
            onPlaceImage={placeImage}
            onOpenPsd={importPsd}
            onExportPsd={exportPsd}
            recentFiles={store.getSnapshot().recentFiles}
            recentFilesError={store.getSnapshot().recentFilesError}
            onReopenRecent={reopenRecent}
            onRemoveRecent={forgetRecent}
            hasRecentBytes={(entry) => fileBytes.has(entry.id)}
          />
        );
      };

      const removeOverlay = ctx.slots.register("canvas.focus-workspace", {
        id: IMAGE_EDITOR_WORKSPACE_ID,
        owner: IMAGE_EDITOR_PLUGIN_ID,
        kind: "image",
        /**
         * 编辑工作区对**所有**图片节点聚焦都可用（A8）。
         *
         * 这里曾经是「至少一个文档已打开」：双击后的第一帧文档还没打开，唯一的工作区贡献就被
         * 过滤掉，聚焦宿主先渲染「此节点的工作区不可用 / 请检查对应扩展是否已启用」，等异步打开
         * 完成才换成编辑器（2026-10-24 审片 A8，几乎每条镜头开头都有，约 10 秒）。
         *
         * 可用性只表达「这个 kind 有工作区」，内容就绪与否由工作区自己呈现（准备中/加载中/
         * 打开失败都各有可读状态）；视频与模型编辑器也按同一契约注册。
         */
        available: () => true,
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
        setHistoryOverride: (override, nodeId) => {
          // 历史只属于节点文档；文件文档没有节点版本。
          //
          // 目标节点优先用调用方给的身份：多标签时 `active()` 可能是另一篇文档，只改活动
          // 文档会让预览「点了没反应」，标题栏也停在「当前版本」（A3）。显式 nodeId 找不到时
          // 退回到活动节点（单文档路径行为不变）。
          const resource = nodeId ? session.findByNode(nodeId) ?? session.active() : session.active();
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

      // 最近文件索引变化（记录/移除/逐出）也要推到界面：列表属工作区，不挂在某个文档上。
      const unsubscribeRecent = recentFiles.subscribe(() => publish());

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
          // 端口是模块级注册点：卸载时清掉，避免下一个宿主实例沿用旧端口（含旧取消标记）。
          setAnimationCodecPort(null);
          unsubscribeNav();
          preparation.dispose();
          unregisterEntryGuard();
          removeReadinessOverlay();
          unsubscribeCanonical();
          unsubscribeSession();
          unsubscribeRecent();
          for (const cancel of recentTracked.values()) cancel();
          recentTracked.clear();
          unregisterViewport();
          unsubscribeRect();
          removeOverlay();
          removeDocumentWorkspace();
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
