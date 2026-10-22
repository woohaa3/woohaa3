/**
 * 工程编辑面板：把 React 编辑器挂进文档呈现
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/3.3/3.4/4.3 / design D1/D2/D3/D7；
 *   change: 2026-10-21-add-photocraft-document-workspace，design D3：面板只认 `EditorDocumentView`，
 *   不再绑定节点工作区类型，使节点文档与独立文件文档共用同一界面）。
 *
 * 进入方式由 [decideEditorEntry] 判定（纯函数，可回归）：
 * - 图片已携带工程定义 → `openProject`（`.pcraft` 字节由宿主经受控同源 URL 取回）；
 * - 纯媒体图片 / 独立文件 → `openImage`，以原图为背景层开一个新工程；
 * - 旧 v1 标注 → `openImage` 后把每条标注渲染成一个像素层（design D7 的本地转换）。
 *
 * 面板不自行读取凭据、不接收任意 URL：字节加载函数由宿主注入。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@woohaa3/photocraft-editor/ui";
import type { DialogsService } from "@woohaa3/frontend/plugin-api";
import type { EditorDisplayControls } from "@woohaa3/photocraft-editor";
import type { EditorPreview } from "@woohaa3/photocraft-editor";
import type { ImageFocusViewport } from "./focus-session.js";
import type { EditorDocumentView } from "./document-view.js";
import { EditorWorkspaceController } from "./editor-workspace.js";
import { PhotoEditorApp } from "@woohaa3/photocraft-editor";
import { annotationAssetId, rasterizeAnnotation } from "./annotation-raster.js";
import type { EditorEntry } from "@woohaa3/photocraft-editor";
import { normalizeEditorImage } from "@woohaa3/photocraft-editor";

/**
 * 一次“应用/保存”的结果（面板只关心成功与否与原因）。
 *
 * 具体的节点回执、本地交付与去重语义留在工作区；面板不用理解 `ProjectSaveOutcome` 的
 * 详细字段（change: 2026-10-21-add-photocraft-document-workspace，D3/D5）。
 */
export type EditorApplyOutcome = { ok: true } | { ok: false; message: string };

/** 宿主注入的工程编辑端口。 */
export type ProjectEditorPort = {
  dialogs?: DialogsService;
  /** 用按需界面模块提供的构造器创建会话，宿主注入保存依赖。 */
  createController: (view: EditorDocumentView, Controller: typeof EditorWorkspaceController) => EditorWorkspaceController;
  /** 取回工程对象字节（受控同源 URL）。 */
  loadProjectBytes: (storageKey: string) => Promise<Uint8Array | null>;
  /** 取回原图字节（受控同源 URL）；独立文件文档返回它自己的字节。 */
  loadBaseImageBytes: (view: EditorDocumentView) => Promise<Uint8Array | null>;
  /** 在当前文档的目的地写回一次（节点写原节点；独立文件保存工程到本地）。 */
  save: (view: EditorDocumentView, controller: EditorWorkspaceController) => Promise<EditorApplyOutcome>;
  /** 离开聚焦工作区（释放编辑器并恢复进入前视口）；独立文件文档返回画布。 */
  exit: (controller: EditorWorkspaceController) => void;
  /** 文档是否只提供本地文件交付（无节点写回）。 */
  fileDestination?: boolean;
  /**
   * 文档菜单能力（change: 2026-10-21-add-photocraft-document-workspace，D2）。
   *
   * 打开文件 / 关闭 / 文档清单属于菜单，不放在文档标签条上。
   */
  documents?: import("@woohaa3/photocraft-editor").EditorDocumentsMenu;
  /** 像素呈现端口（文件文档用 Canvas 画自己的预览；节点文档省略，由 Bevy 呈现）。 */
  renderCanvasBackground?: (origin: { x: number; y: number }, zoom: number) => import("react").ReactNode;
};

/** React 编辑器的进入方式（判定见 `editor-entry.ts`）。 */
export type { EditorEntry };

export type ProjectEditorPaneProps = {
  display?: EditorDisplayControls;
  view: EditorDocumentView;
  writable: boolean;
  port: ProjectEditorPort;
  entry: EditorEntry;
  /** 文档已在别处绑定控制器（工作区持有）时复用；缺省由面板创建并释放。 */
  controller?: EditorWorkspaceController | null;
  /**
   * 像素呈现端口（独立文件文档用 Canvas 画自己的 RGBA 预览；节点文档省略，由 Bevy 呈现）。
   */
  renderCanvasBackground?: (origin: { x: number; y: number }, zoom: number) => import("react").ReactNode;
};

type BaseAssetView = { id?: unknown; metadata?: Record<string, unknown> };

/** 基底资产 id（工程/标注/纯媒体共用）。 */
function baseAssetIdOf(view: EditorDocumentView): string {
  const asset = view.baseAsset() as BaseAssetView | null;
  const id = asset?.id;
  return typeof id === "string" && id.length > 0 ? id : "";
}

/** 只读历史预览时不允许写操作。 */
export function ProjectEditorPane({ view, writable, port, entry, display, controller: provided, renderCanvasBackground }: ProjectEditorPaneProps) {
  // 菜单随工作区快照更新；它的端口包装变化不代表重新打开文档。
  const { createController, loadProjectBytes, loadBaseImageBytes, fileDestination } = port;
  const controller = useMemo(
    () => provided ?? createController(view, EditorWorkspaceController),
    [createController, view, provided]
  );
  // 工作区持有的控制器随文档存活：面板卸载不得释放它（change: 2026-10-21，design D3）。
  const ownsController = provided == null;
  useEffect(() => () => { if (ownsController) controller.dispose(); }, [controller, ownsController]);
  const [status, setStatus] = useState<string | null>("正在加载编辑内核…");
  const [failed, setFailed] = useState(false);

  useSyncExternalStore(view.subscribe, useCallback(() => view.revisionState(), [view]));
  const changeViewport = useCallback((viewport: ImageFocusViewport) => view.setViewport(viewport), [view]);
  const publishPreview = useCallback((preview: EditorPreview, size: { width: number; height: number }) => view.setEditorPreview(preview, size), [view]);
  const publishDetails = useCallback((frame: import("@woohaa3/photocraft-editor").DetailFrame | null) => view.setEditorDetails(frame), [view]);
  useEffect(() => () => view.setEditorPreview(null), [view]);
  useEffect(() => { if (failed) view.setEditorPreview(null); }, [failed, view]);

  // 打开：工程字节或原图字节 → 内核；失败保留只读查看能力（design D2）。
  useEffect(() => {
    let cancelled = false;
    let cancelWait: (() => void) | null = null;
    // 先完成进入取景，再运行不可抢占的 WASM 打开，避免解析挤占缩放动画。
    const waitForTransition = () => {
      if (!view.isTransitioning?.()) return Promise.resolve();
      return new Promise<void>(resolve => {
        const finish = () => { stop(); cancelWait = null; resolve(); };
        const stop = view.subscribe(() => { if (!view.isTransitioning()) finish(); });
        cancelWait = finish;
        if (!view.isTransitioning()) finish();
      });
    };
    const open = async () => {
      if (entry.mode === "none") {
        setStatus(entry.reason);
        setFailed(true);
        return;
      }
      const baseAssetId = baseAssetIdOf(view);
      // 节点文档必须有稳定原图身份；独立文件文档没有资产 id，用自己的字节开工程。
      if (!baseAssetId && fileDestination !== true) {
        setStatus("原图不可用，无法进入编辑器");
        setFailed(true);
        return;
      }
      if (entry.mode === "project") {
        const document_ = view.projectDocument();
        if (!document_) {
          setStatus("该图片没有可编辑的工程");
          setFailed(true);
          return;
        }
        const bytes = await loadProjectBytes(document_.project.storageKey).catch(() => null);
        if (cancelled) return;
        if (!bytes) {
          setStatus("工程对象不可读取，仅可查看合成图");
          setFailed(true);
          return;
        }
        await waitForTransition();
        if (cancelled) return;
        const opened = await controller.openProject({ bytes, baseAssetId: document_.baseAssetId });
        if (cancelled) return;
        setStatus(opened.ok ? null : opened.message);
        setFailed(!opened.ok);
        return;
      }

      // 纯媒体、独立文件与 v1 标注：以原图为背景层开新工程。
      const bytes = await loadBaseImageBytes(view).catch(() => null);
      if (cancelled) return;
      if (!bytes) {
        setStatus("原图字节不可读取，无法进入编辑器");
        setFailed(true);
        return;
      }
      const normalized = await normalizeEditorImage(bytes);
      if (cancelled) return;
      await waitForTransition();
      if (cancelled) return;
      const opened = await controller.openImage({ name: "image", assetId: baseAssetId || "file-image", bytes: normalized });
      if (cancelled) return;
      if (!opened.ok) {
        setStatus(opened.message);
        setFailed(true);
        return;
      }
      if (entry.mode === "annotations") {
        const converted = await convertAnnotations(view, controller);
        if (cancelled) return;
        if (converted) {
          setStatus(converted);
          setFailed(true);
          return;
        }
        // 转换完成：会话切到工程分支，退出聚焦不再写 v1 定义。
        view.project.beginProjectConversion();
      }
      // 打开不是修改：把刚打开（或刚转换）的内容建立为进入基线。
      view.project.establishBaseline();
      setStatus(null);
      setFailed(false);
    };
    void open().catch((error) => { if (!cancelled) { setStatus(error instanceof Error ? error.message : "无法打开图片，请重试"); setFailed(true); } });
    return () => {
      cancelled = true;
      cancelWait?.();
    };
  }, [controller, entry, loadProjectBytes, loadBaseImageBytes, fileDestination, view]);

  const apply = useCallback(async (): Promise<void> => {
    const outcome = await port.save(view, controller);
    setStatus(outcome.ok ? null : outcome.message);
  }, [controller, port, view]);

  /**
   * 返回：不自动保存（返回画布保留文档与草稿），仅释放本视图。
   *
   * 有未保存修改时由工作区的关闭/离开结算处理；这里只把控制权交回导航。
   */
  const close = useCallback(async (): Promise<void> => {
    const draft = controller.hasLayerProperties?.() ? "请先确认或取消图层属性编辑"
      : controller.hasAdjustment?.() ? "请先确认或取消调整参数编辑"
        : controller.hasText?.() ? "请先确认或取消文字编辑"
          : controller.hasTransform() ? "请先确认或取消自由变换"
            : null;
    if (draft) { setStatus(draft); return; }
    port.exit(controller);
  }, [controller, port]);

  if (failed) {
    return (
      <div className="photo-editor photo-editor--unavailable" role="status">
        <p>{status ?? "编辑器不可用"}</p>
        <Button size="sm" tone="ghost" onClick={() => void close()}>返回查看</Button>
      </div>
    );
  }

  return (
    <div className="photo-editor-host">
      {status ? <p className="photo-editor-host__status">{status}</p> : null}
      <PhotoEditorApp
        dialogs={port.dialogs}
        display={display}
        controller={controller}
        canvasView={{ contentSize: view.detailViewportSize(), viewport: view.focus.viewportState(), fitZoom: view.focus.currentFitZoom(), transitioning: view.isTransitioning(), onChange: changeViewport }}
        onPreview={publishPreview}
        onDetailPreview={publishDetails}
        {...(renderCanvasBackground ? { renderCanvasBackground } : {})}
        onApply={apply}
        readonly={!writable}
        {...(port.documents ? { documents: port.documents } : {})}
      />
    </div>
  );
}

/**
 * v1 标注 → 每标注一个像素层。
 *
 * 返回 `null` 表示转换完成；返回字符串表示失败原因（调用方保留旧标注，不丢弃定义）。
 */
async function convertAnnotations(
  view: EditorDocumentView,
  controller: EditorWorkspaceController
): Promise<string | null> {
  const annotated = view.project.annotationDocument();
  if (!annotated) return null;
  const { sourceWidth: width, sourceHeight: height } = annotated;
  for (const shape of annotated.shapes) {
    const png = await rasterizeAnnotation(shape, width, height);
    if (!png) return "标注无法渲染为图层，保留旧标注编辑";
    const placed = await controller.placeImage({
      name: shape.id,
      assetId: annotationAssetId(shape.id),
      bytes: png,
      retainSource: false
    });
    if (!placed.ok) return placed.message;
  }
  return null;
}
