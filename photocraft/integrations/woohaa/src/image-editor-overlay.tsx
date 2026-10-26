import {WorkspaceNotification,type WorkspaceNotice} from "./workspace-notification.js";
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
import "./image-editor.css";
import "./document-workspace.css";
import { editorDisplayLayout, useEditorDisplay,usePasteboardAppearance } from "@woohaa3/photocraft-editor";

const IMAGE_HELP = "V 移动 · Ctrl/Cmd+T 自由变换· M 选框（Shift+M 切换椭圆）· L 套索 · B 画笔 · E 橡皮 · T 文字；空格临时平移；[ / ] 调整笔刷大小，Shift+[ / ] 调整硬度；Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 重做，Ctrl/Cmd+S 应用到节点；Ctrl/Cmd+0 适合窗口，Ctrl/Cmd+1 实际大小；Ctrl/Cmd+H 显隐选区边界，Tab 显隐工具与面板，Shift+Tab 显隐侧栏。系统占用快捷键时可用菜单。";
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
  store: DocumentWorkspaceStore;
  projectPort?: ProjectEditorPort | null;
  rect?: () => SurfaceRect;
  /** 文档工作区取景变化（文件文档平移/缩放，只有活动项接收）。 */
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  onActivateDocument: (documentId: string) => void;
  onCloseDocument: (documentId: string) => void;
  /** 取消一次仍在读取/解码中的打开（占位标签）。 */
  onCancelOpenDocument?:(documentId:string)=>void;
  onCloseAllDocuments?:()=>void;
  onCloseOtherDocuments?:(documentId?:string)=>void;
  onReorderDocument?:(documentId:string,beforeId:string|null,generation:number,beforeGeneration?:number)=>void;
  onOpenFile?: () => void;
  onDuplicateDocument?:()=>void;
  onDismissNotice?:(notice:WorkspaceNotice)=>void;
  getPurge?:()=>import("@woohaa3/photocraft-editor").WorkspacePurgePort;
};

/**
 * 工作区贡献：由 `canvas.focus-workspace`（节点文档）与 `canvas.document-workspace`
 * （独立文件）共同渲染。差异全部由活动绑定表达，不按 kind 分支界面。
 */
export function ImageEditorWorkspace({ store, projectPort, onActivateDocument, onCloseDocument, onCancelOpenDocument, onCloseAllDocuments,onCloseOtherDocuments,onReorderDocument,onOpenFile,onDuplicateDocument,onDismissNotice, getPurge }: DocumentWorkspaceProps) {
  const emptyAppearance=usePasteboardAppearance();
  const ui = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const active = ui.active;
  const purge=getPurge?.();
  const controller=active?.controller??null;
  const editorSnapshot=useSyncExternalStore(useCallback(listener=>controller?.subscribe(listener)??(()=>undefined),[controller]),useCallback(()=>controller?.snapshot()??null,[controller]));
  const document=editorSnapshot?.view.document;
  const activeLayer=document?.layers.find(layer=>layer.id===document.activeLayerId);
  const activeEntry=ui.documents.entries.find(entry=>entry.id===active?.documentId);
  const tabContext=active && activeEntry && document?{documentId:active.documentId,generation:activeEntry.generation,zoom:active.view.focus.viewportState().zoom,layer:activeLayer?.name??null,target:document.editTarget,mode:document.mode,depthBits:document.depthBits,dirty:controller?.isDirty()??false,...(editorSnapshot?.state?.savePercent===undefined?{}:{savePercent:editorSnapshot.state.savePercent})}:null;
  /**
   * 标签关闭按钮：打开中的占位标签走取消打开，其余走正常关闭结算。
   *
   * 两者必须分开：取消打开只是丢弃还在读取的文件，已完成的文档必须经过未保存保护。
   */
  const onCancelOrCloseDocument = useCallback((documentId: string) => {
    const entry = ui.documents.entries.find(item => item.id === documentId);
    if (entry?.status === "opening") { onCancelOpenDocument?.(documentId); return; }
    onCloseDocument(documentId);
  }, [onCancelOpenDocument, onCloseDocument, ui.documents.entries]);
  const view = active?.view ?? null;
  const beforeLayoutChange = useCallback(() => view?.preserveNextLayoutViewport(), [view]);
  const display = useEditorDisplay(beforeLayoutChange);
  // 公共标题栏下的工具选项区高度 = 编辑器自身的菜单+工具栏（96/44）+ 文档 tab 条。
  // 编辑器把菜单/工具栏绝对定位到内容矩形之外，tab 条也是同样的外扩控制区；不计入预留
  // 高度就会与菜单栏重叠（tab 被菜单盖住或反之）。tab 高度为34px，大标签42px（见 document-workspace.css）。
  useFocusLayout(useMemo(() => {
    const layout = editorDisplayLayout(display.state);
    return { ...layout, toolbar: (layout.toolbar ?? 0) + (!display.state.screenMode || display.state.screenMode==="standard" ? DOCUMENT_TABS_HEIGHT+(display.state.largeDocumentTabs?8:0) : 0) };
  }, [display.state]));
  useSyncExternalStore(
    useCallback((listener) => view?.subscribe(listener) ?? (() => undefined), [view]),
    useCallback(() => view?.revisionState() ?? 0, [view])
  );
  const contentRevision = view?.contentRevisionState() ?? 0;
  // 只有设为当前后的内容替换才重开内核；取景、预览和保存不重开。
  const entry = useMemo(() => view && projectPort
    ? decideEditorEntry({
        hasProject: view.projectDocument() !== null,
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
    ...(onOpenFile ? { onOpenFile } : {}),
    ...(active && onDuplicateDocument?{onDuplicateDocument,duplicateDisabled:ui.busy || !!ui.documents.activeGate || !controller?.canDuplicateDocument?.()}:{}),
    ...(onCloseAllDocuments?{onCloseAllDocuments}:{}),
    ...(onCloseOtherDocuments?{onCloseOtherDocuments}:{}),
    ...(active ? { onCloseDocument: () => onCloseDocument(active.documentId) } : {}),
    list: ui.documents.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      active: entry.id === ui.documents.activeId,
      status: entry.status === "dirty" ? "未保存" : entry.status === "saving" ? "保存中" : entry.status === "error" ? "保存失败" : null
    })),
    onActivateDocument,
    ...(purge?{purge}:{})
  }), [active, onActivateDocument, onCloseDocument,onCloseAllDocuments,onCloseOtherDocuments,onOpenFile,onDuplicateDocument,controller,editorSnapshot,ui.busy, ui.documents,purge]);
  return (
    <div className="image-edit-presentation" data-screen-mode={display.state.screenMode??"standard"} style={{ visibility: ready ? undefined : "hidden" }}>
      <FocusHeader
        fallbackTitle="图片"
        help={IMAGE_HELP}
        hint={IMAGE_HINT}
        {...(active && !active.nodeDocument ? { documentTitle: active.name, documentDetail: active.detail } : {})}
      />
      <div className="image-edit-workspace" data-image-edit-workspace="true"
        data-document-kind={active?.nodeDocument ? "node" : active ? "file" : undefined}
        data-image-edit-history={view?.isReadOnlyPreview() ? "true" : undefined}>
        {/* tab 条位于菜单/选项栏下方的宿主预留区，不占用画布内容矩形。 */}
        <div data-document-tabs-wrap="true" hidden={!!display.state.screenMode && display.state.screenMode!=="standard"}>
        <DocumentTabs
          snapshot={ui.documents} activeContext={tabContext} large={display.state.largeDocumentTabs}
          onActivate={onActivateDocument}
          onClose={onCancelOrCloseDocument} onCloseAll={onCloseAllDocuments} onCloseOthers={onCloseOtherDocuments} onReorder={onReorderDocument}
        /></div>
        <div className="image-edit-workspace__body" style={!active?emptyAppearance:undefined} onDoubleClick={event=>{
          if(active || ui.busy || ui.documents.entries.length || !onOpenFile || (event.target as Element).closest("button,input,textarea,select,a"))return;
          event.preventDefault();event.stopPropagation();onOpenFile();
        }}>
        {active && projectPort && entry && entry.mode !== "none" ? (
          <div className={fileView ? "photo-document-surface__body" : "image-edit-workspace__editor"}
            hidden={!fileView && (historyOpen || (view?.isReadOnlyPreview() ?? false))}
            data-document-body={fileView ? "true" : undefined}>
            <DeferredProjectEditor
              key={`${active.documentId}:${contentRevision}`}
              view={active.view}
              writable={editable}
              port={{ ...projectPort, documents }}
              entry={entry}
              display={display}
              controller={active.controller}
              {...(fileView ? { renderCanvasBackground: fileBackgroundPort(fileView) } : {})}
            />
          </div>
        ) : (
          <div className="image-edit-workspace__notice" role="status">
            <p>{entry && entry.mode === "none" ? entry.reason : active ? "图片尚不可编辑" : "没有打开的文档"}</p>
            {!active && onOpenFile ? <><p className="image-edit-workspace__notice-hint">双击空白处或打开文件开始编辑。</p><Button size="sm" tone="ghost" disabled={ui.busy} onClick={onOpenFile}>打开文件…</Button></> : <p className="image-edit-workspace__notice-hint">当前版本仍可查看；返回后可用历史版本恢复。</p>}
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
        {ui.notice?<WorkspaceNotification notice={ui.notice} onDismiss={onDismissNotice}/>:null}
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
