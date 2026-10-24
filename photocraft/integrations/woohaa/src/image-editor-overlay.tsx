/**
 * 文档工作区 renderer（image-editor 完整界面）
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history；
 *   change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D3/D4；
 *   change: 2026-10-16-integrate-photocraft-image-editing，design D1/D2/D7；
 *   change: 2026-10-21-add-photocraft-document-workspace，design D2/D3/D4：多文档 tab、节点/文件
 *   两种来源共用同一编辑器，只有活动文档发布呈现）。
 *
 * 界面是 PhotoCraft 子项目的 React 编辑器（`@woohaa3/photocraft-editor`）：本组件只负责选择
 * 渲染哪一个界面并把公共顶部栏接上，不画标注、不做命中测试、不持有内容。
 *
 * 只有活动文档被挂载：切走的文档保留控制器、内核与撤销，卸载视图不销毁文档
 * （不能靠多份隐藏编辑器保留状态）。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import type { SurfaceRect } from "@woohaa3/photocraft-editor";
import type { EditorDocumentView } from "./document-view.js";
import { useFocusLayout } from "@woohaa3/frontend/plugin-api";
import { FocusHeader } from "@woohaa3/frontend/plugin-api";
import { useOptionalService } from "@woohaa3/frontend/plugin-api";
import type { ProjectEditorPort, ProjectEditorPaneProps } from "./project-editor-pane.js";
import type { EditorWorkspaceController } from "./editor-workspace.js";
import { Button } from "@woohaa3/photocraft-editor/ui";
import { decideEditorEntry } from "@woohaa3/photocraft-editor";
import { DocumentTabs } from "./document-tabs.js";
import { FileDocumentActionsBar, DocumentPreviewCanvas, type FileDocumentActions } from "./file-document-surface.js";
import type { FileDocumentWorkspace } from "./file-document-workspace.js";
import type { DocumentWorkspaceStore } from "./workspace-store.js";
import type { RecentFileEntry, RecentFileStore } from "@woohaa3/photocraft-protocol";
import "./image-editor.css";
import "./document-workspace.css";
import { editorDisplayLayout, useEditorDisplay } from "@woohaa3/photocraft-editor";

const IMAGE_HELP = "V 移动 · M 选框 · L 套索 · W 选择 · B 画笔 · E 橡皮 · J 修复 · S 仿制 · P 钢笔 · T 文字；Shift+工具键切换同组工具；空格临时平移；Ctrl/Cmd+Tab 切换文档；Ctrl/Cmd+S 保存当前文档；Ctrl/Cmd+0 适合窗口，Ctrl/Cmd+1 实际大小；Tab 显隐工具与面板。系统占用快捷键时可用菜单。";
const IMAGE_HINT = "双指滑动平移 / 捏合缩放 / 空格拖动视图";
/** 文档 tab 条高度（与 document-workspace.css 的 .photo-document-tabs 保持一致）。 */
const DOCUMENT_TABS_HEIGHT = 34;
/** 无 Navigation service（Showcase / 单组件测试）时的稳定空订阅与空快照。 */
const NO_SUBSCRIBE = () => () => undefined;
const NO_SNAPSHOT = () => null;

/** 活动文档的界面绑定（工作区按活动项提供，见 `workspace-store`）。 */
export type ActiveDocumentBinding = {
  documentId: string;
  /** 呈现（节点或独立文件）。 */
  view: EditorDocumentView;
  /** 工作区持有的控制器（不随视图卸载释放）。 */
  controller: EditorWorkspaceController | null;
  /** 文档条目名称与来源补充（tab 与标题区）。 */
  name: string;
  detail: string | null;
  /** 节点文档为 true；独立文件为 false。 */
  nodeDocument: boolean;
  writable: boolean;
  contentRevision: number;
  /** 文件文档的动作（保存工程/导出/添加到画布）；节点文档为 null。 */
  fileActions: FileDocumentActions | null;
  fileStatus: string | null;
  fileStatusTone: "error" | "info";
  fileBusy: boolean;
};

export type DocumentWorkspaceProps = {
  onTransfer?: (id: string) => void;
  store: DocumentWorkspaceStore;
  projectPort?: ProjectEditorPort | null;
  rect?: () => SurfaceRect;
  /** 文档工作区取景变化（文件文档平移/缩放，只有活动项接收）。 */
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  onActivateDocument: (documentId: string) => void;
  onCloseDocument: (documentId: string) => void;
  onReorderDocument?: (documentId: string, targetDocumentId: string) => void;
  onOpenFile?: () => void;
  /**
   * 新建空白文档（change: 2026-10-22-add-photocraft-file-workflows，U01）。
   *
   * 编辑器产出自包含工程字节，由宿主用既有打开路径落成独立文档/标签。
   */
  onRequestDocumentSlot?: (input: { bytes: Uint8Array; name: string }) =>
    | { ok: true }
    | { ok: false; reason: string }
    | Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * 最近文件端口（change: 2026-10-22-add-photocraft-file-workflows，U04）。
   *
   * 索引与字节都在宿主：工作区只转交快照与动作，编辑器面板不缓存内容字节。
   */
  recentFiles?: RecentFileStore | null;
  /** 索引本机持久化诊断（写失败/快照损坏）；非空时面板如实提示「仅本次会话」。 */
  recentFilesError?: string | null;
  onReopenRecent?: (entry: RecentFileEntry) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onRemoveRecent?: (id: string) => void;
  hasRecentBytes?: (entry: RecentFileEntry) => boolean;
  /** 关闭全部文档（U03）：逐文档串行结算，首个失败即停止。 */
  onCloseAllDocuments?: () => void;
  /** 关闭其他文档（U03）：保留活动项，其余串行结算。 */
  onCloseOtherDocuments?: () => void;
  /** 置入图片到当前文档（与打开文件分开，任务 4.4）。 */
  onPlaceImage?: () => void;
  /** 导入 PSD（任务 5.3）。 */
  onOpenPsd?: () => void;
  /** 导出 PSD 副本（任务 5.4）。 */
  onExportPsd?: () => void;
};

/**
 * 工作区贡献：由 `canvas.focus-workspace`（节点文档）与 `canvas.document-workspace`
 * （独立文件）共同渲染。差异全部由活动绑定表达，不按 kind 分支界面。
 */
export function ImageEditorWorkspace({ store, projectPort, onActivateDocument, onCloseDocument, onReorderDocument, onOpenFile, onPlaceImage, onOpenPsd, onExportPsd, onTransfer, onRequestDocumentSlot, onCloseAllDocuments, onCloseOtherDocuments, recentFiles, recentFilesError, onReopenRecent, onRemoveRecent, hasRecentBytes }: DocumentWorkspaceProps) {
  const ui = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const active = ui.active;
  const view = active?.view ?? null;
  const beforeLayoutChange = useCallback(() => view?.preserveNextLayoutViewport(), [view]);
  const display = useEditorDisplay(beforeLayoutChange);
  // 公共标题栏下的工具选项区高度 = 编辑器自身的菜单+工具栏（96/44）+ 文档 tab 条。
  // 编辑器把菜单/工具栏绝对定位到内容矩形之外，tab 条也是同样的外扩控制区；不计入预留
  // 高度就会与菜单栏重叠（tab 被菜单盖住或反之）。tab 高度固定 34px（见 document-workspace.css）。
  useFocusLayout(useMemo(() => {
    const layout = editorDisplayLayout(display.state);
    return { ...layout, toolbar: (layout.toolbar ?? 0) + DOCUMENT_TABS_HEIGHT };
  }, [display.state]));
  useSyncExternalStore(
    useCallback((listener) => view?.subscribe(listener) ?? (() => undefined), [view]),
    useCallback(() => view?.revisionState() ?? 0, [view])
  );
  const contentRevision = view?.contentRevisionState() ?? 0;
  // 只有设为当前后的内容替换才重开内核；取景、预览和保存不重开。
  const entry = useMemo(() => view && projectPort
    ? decideEditorEntry({
        // 独立文件按自己的类型声明打开方式；节点文档仍由工程定义推断。
        hasProject: view.openMode ? view.openMode() === "project" : view.projectDocument() !== null,
        phase: view.project.currentPhase(),
        conversionFallback: view.project.conversionFallbackReason() !== null
      })
    : null, [view, projectPort, contentRevision]);
  // 历史只读预览期间暂停写操作（保留当前草稿，退出预览恢复）。
  const ready = view?.isPresentationReady() ?? false;
  const editable = ready && active !== null && active.writable && !view?.isReadOnlyPreview();
  // 节点版本抽屉打开时隐藏编辑器界面：历史在右侧抽屉里浏览。
  const navigation = useOptionalService("canvasNavigation");
  const panel = useSyncExternalStore(
    navigation?.subscribe ?? NO_SUBSCRIBE,
    navigation ? navigation.getSnapshot : NO_SNAPSHOT,
    navigation ? navigation.getSnapshot : NO_SNAPSHOT
  )?.panel ?? null;
  const nodeId = active?.nodeDocument ? active.view.nodeId : null;
  const historyOpen = nodeId !== null && panel?.type === "node-history" && panel.nodeId === nodeId;
  const fileView = active && !active.nodeDocument ? active.view as FileDocumentWorkspace : null;
  // 打开文件 / 关闭 / 文档清单是**菜单**能力（文件、窗口），不挂在文档标签条上。
  const documents = useMemo(() => ({
    ...(onTransfer ? {transfer: {enabled: editable, onSelect: onTransfer}} : {}),
    ...(onOpenFile ? { onOpenFile } : {}),
    ...(onPlaceImage ? { onPlaceImage } : {}),
    ...(onOpenPsd ? { onOpenPsd } : {}),
    ...(onExportPsd ? { onExportPsd } : {}),
    ...(fileView && active?.fileActions ? {
      onSave: active.fileActions.saveProject,
      saveLabel: "保存工程",
      onExportPng: active.fileActions.exportPng
    } : active ? { saveLabel: "应用到节点" } : {}),
    ...(active ? { onCloseDocument: () => onCloseDocument(active.documentId) } : {}),
    // 批量关闭是工作区操作：逐文档串行结算，内核侧只有单文档 `file.close`。
    ...(onCloseOtherDocuments ? { onCloseOthers: onCloseOtherDocuments } : {}),
    ...(onCloseAllDocuments ? { onCloseAll: onCloseAllDocuments } : {}),
    list: ui.documents.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      active: entry.id === ui.documents.activeId,
      status: entry.status === "dirty" ? "未保存" : entry.status === "saving" ? "保存中" : entry.status === "error" ? "保存失败" : null
    })),
    onActivateDocument
  }), [active, editable, fileView, onTransfer, onActivateDocument, onCloseDocument, onOpenFile, onPlaceImage, onOpenPsd, onExportPsd, onCloseAllDocuments, onCloseOtherDocuments, ui.documents]);
  // `ProjectEditorPane` only reopens the WASM document when its actual inputs change. A fresh
  // wrapper on every viewport/preview update would retrigger that open effect and erase tool state.
  const editorPort = useMemo(
    () => projectPort
      ? {
          ...projectPort,
          documents,
          ...(onRequestDocumentSlot ? { onRequestDocumentSlot } : {}),
          ...(recentFiles === undefined ? {} : { recentFiles }),
          ...(recentFilesError ? { recentFilesError } : {}),
          ...(onReopenRecent ? { onReopenRecent } : {}),
          ...(onRemoveRecent ? { onRemoveRecent } : {}),
          ...(hasRecentBytes ? { hasRecentBytes } : {})
        }
      : null,
    [projectPort, documents, onRequestDocumentSlot, recentFiles, recentFilesError, onReopenRecent, onRemoveRecent, hasRecentBytes]
  );
  return (
    <div className="image-edit-presentation" style={{ visibility: ready ? undefined : "hidden" }}>
      <FocusHeader
        fallbackTitle="图片"
        help={IMAGE_HELP}
        hint={IMAGE_HINT}
        {...(active && !active.nodeDocument ? { documentTitle: active.name, documentDetail: active.detail } : {})}
      />
      <div className="image-edit-workspace" data-image-edit-workspace="true"
        data-document-kind={active?.nodeDocument ? "node" : active ? "file" : undefined}
        data-image-edit-history={view?.isReadOnlyPreview() ? "true" : undefined}>
        {/* 文档标签紧贴画布顶部；菜单和工具选项位于其上方。 */}
        <DocumentTabs
          snapshot={ui.documents}
          onActivate={onActivateDocument}
          onClose={onCloseDocument}
          onReorder={onReorderDocument}
        />
        <div className="image-edit-workspace__body">
        {active && editorPort && entry && entry.mode !== "none" ? (
          <div className={fileView ? "photo-document-surface__body" : "image-edit-workspace__editor"}
            hidden={!fileView && (historyOpen || (view?.isReadOnlyPreview() ?? false))}
            data-document-body={fileView ? "true" : undefined}>
            <DeferredProjectEditor
              key={`${active.documentId}:${contentRevision}`}
              view={active.view}
              writable={editable}
              port={editorPort}
              entry={entry}
              display={display}
              controller={active.controller}
              {...(fileView ? { renderCanvasBackground: fileBackgroundPort(fileView) } : {})}
            />
          </div>
        ) : (
          <div className="image-edit-workspace__notice" role="status">
            <p>{entry && entry.mode === "none" ? entry.reason : active ? "图片尚不可编辑" : "没有打开的文档"}</p>
            <p className="image-edit-workspace__notice-hint">当前版本仍可查看；返回后可用历史版本恢复。</p>
          </div>
        )}
        {view?.historyOverrideState() ? (
          <div className="image-edit-workspace__history-preview">
            {view.previewStatus() ? <p>{view.previewStatus()}</p> : null}
            <span>历史版本 · 只读预览</span>
          </div>
        ) : historyOpen ? (
          <div className="image-edit-workspace__history-preview">
            <span>在右侧选择版本预览；关闭后返回编辑</span>
          </div>
        ) : null}
        {ui.notice ? (
          <div className="image-edit-workspace__toast" data-tone={ui.notice.tone} role="status">
            <p>{ui.notice.message}</p>
          </div>
        ) : null}
        {fileView && active?.fileActions ? (
          <FileDocumentActionsBar
            view={fileView}
            actions={active.fileActions}
            status={active.fileStatus}
            statusTone={active.fileStatusTone}
            busy={active.fileBusy || ui.busy}
            readonly={!active.writable}
          />
        ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 文件文档的背景渲染端口：编辑器画布是透明交互层，由这里画出文件自己的 RGBA 预览；
 * 容器（`.photo-document-surface__body`）提供不透明底色与棋盘格，底层画布不会透出。
 */
export function fileBackgroundPort(view: FileDocumentWorkspace): (origin: { x: number; y: number }, zoom: number) => React.ReactNode {
  return (origin, zoom) => {
    const preview = view.previewState();
    return preview
      ? <DocumentPreviewCanvas preview={preview.preview} width={preview.width} height={preview.height} zoom={zoom} origin={origin} />
      : null;
  };
}

/** 只在进入可编辑图片时请求界面模块；失败不替换原节点图片。 */
function DeferredProjectEditor(props: ProjectEditorPaneProps) {
  const [Pane, setPane] = useState<ComponentType<ProjectEditorPaneProps> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void import("./project-editor-pane.js").then((module) => {
      if (active) setPane(() => module.ProjectEditorPane);
    }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  return Pane ? <Pane {...props} /> : <div className="image-edit-workspace__notice">
    <p>{failed ? "图片编辑界面加载失败，请重试。" : "正在加载图片编辑界面…"}</p>
    {failed ? <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>重试加载</Button> : null}
  </div>;
}
