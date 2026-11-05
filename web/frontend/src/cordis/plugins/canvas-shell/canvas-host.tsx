import { SceneExperienceBar } from "../scene-experience/experience-bar.js";
import { CanvasAssetRail } from "./canvas-asset-rail.js";
/**
 * Canvas React Host（change: adopt-frontend-cordis-plugin-runtime，design D2/D8）。
 *
 * 只负责 DOM canvas 挂载与 slot 渲染；不创建 Canvas socket、run client、catalog cache 或
 * 业务工作流。controller 生命周期由 canvas-shell plugin 持有。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { CanvasRenderWarnings } from "./canvas-render-warnings.js";
import { Button } from "@woohaa3/ui/primitives";
import { mountBevyCanvas, unmountBevyCanvas } from "./bevy-canvas-element.js";
import { useOptionalService, useService } from "../../react.js";
import { useSyncStatusView } from "../../use-sync-status.js";
import {
  CanvasFocusNodeHistoryHost,
  CanvasFocusSidePanelHost,
  CanvasOverlayHost,
  CanvasPanelHost,
  CanvasToolbarHost,
  CanvasTopBarHost,
  DocumentWorkspaceHost
} from "../../host.js";
import type { CanvasPresentationSnapshot } from "../../navigation/contracts.js";
import { FocusWorkspace } from "../../focus/workspace.js";
import { FocusWorkspaceHost, resolveFocusWorkspace } from "../../focus/host.js";
import { NodeActionSettingsHost } from "./node-action-settings-host.js";
import ContextMenuHost from "../canvas-menu/canvas-context-menu-host.js";

export function CanvasHost({ canvasId }: { canvasId: string }) {
  const cameraEditing = useSyncExternalStore(worldCameraEditorStore.subscribe,
    () => worldCameraEditorStore.getSnapshot()?.canvasId === canvasId, () => false);
  const canvasRuntime = useService("canvasRuntime");
  const canvasSession = useService("canvasSession");
  const canvasNavigation = useService("canvasNavigation");
  const canvasState = useService("canvasState");
  // 资源栏「图片」面板的数据源：当前画布的图片（见 image-library.ts）。
  // 可选读取：没有它（如不带完整服务的测试宿主）时「图片」条目退化为只有选中态。
  const imageSource = useOptionalService("imageLibrary");
  // 目录只读一次当前画布的 `sync`：它区分「属于远端且链路在」（synced）与
  // 「属于远端但本机没有上游链路」（unlinked，见 CanvasSyncState）。右下角气泡需要后者，
  // 否则宿主→远端整条断掉时气泡仍显示「已同步」。
  const catalog = useService("canvasCatalog");
  const catalogEntry = useSyncExternalStore(
    catalog.subscribe,
    () => catalog.getState().entries.find((entry) => entry.id === canvasId) ?? null,
    () => null
  );
  // 进入画布时强制取一次目录：缓存命中时 load() 不会重新请求，沿用启动时的 sync 结论
  // 会让「链路上游断了」和「已经恢复」都延迟到用户下次打开切换器才可见。
  useEffect(() => {
    void catalog.load(true);
  }, [catalog, canvasId]);
  // 模态门禁：宿主从 Dialog Service 派生**通用**布尔，供聚焦工作区贡献在模态打开时暂停/停止
  // 自身瞬态；宿主不知道任何具体业务。只在 React 侧订阅，不写入 Navigation 状态。
  const dialogs = useService("dialogs");
  const slots = useService("slots");
  const diagnostic = useSyncExternalStore(canvasNavigation.subscribe,
    () => canvasNavigation.getDiagnostic?.() ?? null, () => null);
  const modalActive = useSyncExternalStore(
    dialogs.subscribe,
    () => dialogs.getSnapshot().isModalActive,
    () => false
  );
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // 父页面的输入 canvas 跨 scope 复用；每页 renderer 在独立 iframe 中持有自己的 canvas。
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const sessionStatus = useSyncExternalStore(canvasSession.subscribe, canvasSession.getStatus, canvasSession.getStatus);
  const runtimeStatus = useSyncExternalStore(canvasRuntime.subscribe, canvasRuntime.getStatus, canvasRuntime.getStatus);
  const presentation: CanvasPresentationSnapshot = useSyncExternalStore(
    canvasNavigation.subscribe,
    canvasNavigation.getSnapshot,
    canvasNavigation.getSnapshot
  );
  // 工具栏属于 presentation UI，显隐读取 Navigation 的权威 mode。这样退出 transition
  // 发布 overview 时必定恢复，不受 runtime projection 通知先后顺序影响。

  // 先挂载输入表面，再创建本页 renderer，避免绑定到上一页尚未移除的宿主。
  useEffect(() => {
    const host = surfaceRef.current;
    if (!host) return undefined;
    const canvas = mountBevyCanvas(host);
    canvasRef.current = canvas;
    return () => {
      unmountBevyCanvas(host);
      if (canvasRef.current === canvas) canvasRef.current = null;
    };
  }, [canvasRuntime]);

  useEffect(() => {
    void canvasRuntime.load().catch(() => undefined);
  }, [canvasRuntime]);

  // DOM canvas 挂载：创建 interaction controller + texture sync（由 shell plugin 持有）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    if (runtimeStatus.phase !== "ready") return undefined;
    return canvasRuntime.attach(canvas);
  }, [canvasRuntime, runtimeStatus.phase]);

  const bootError = runtimeStatus.phase === "error";
  const canvasError = sessionStatus.phase === "error";
  const ready = runtimeStatus.phase === "ready" && sessionStatus.phase === "ready";
  const revision = sessionStatus.remote.confirmedRevision ?? 0;
  const writable = canvasSession.isWritable();
  // 顶部不再常驻同步/revision 胶囊：状态改由右下角控件面板承载
  // （change: move-sync-status-to-corner-panel）。
  const sync = useSyncStatusView({
    mode: sessionStatus.remote.mode,
    phase: sessionStatus.remote.phase,
    pendingCount: sessionStatus.remote.pendingCount,
    error: sessionStatus.remote.error,
    revision,
    // 断线来源与重建中标志决定气泡文案和按钮置灰
    // （change: 2026-10-21-recover-canvas-connection-explicitly）。
    offlineReason: sessionStatus.remote.offlineReason ?? null,
    reconnecting: sessionStatus.remote.reconnecting ?? false,
    // 权限只读（服务端判定）与断线无关：链路正常也要在进入画布时提示，
    // 并让生成/编辑入口按 session.isWritable() 置灰。
    readOnly: sessionStatus.remote.readOnly ?? false,
    readOnlyReason: sessionStatus.remote.readOnlyReason ?? null,
    // 上游（宿主→远端）链路缺失：与浏览器↔宿主那段无关，必须单独表达。
    ...(catalogEntry?.sync === "unlinked" ? { upstream: "unlinked" as const } : {})
  });
  const snapshotFocus = presentation.mode.type === "node-focus"
    ? { nodeId: presentation.mode.nodeId, kind: presentation.mode.kind }
    : null;
  // 独立文档工作区呈现（编辑扩展工作区）：与节点聚焦互斥，
  // 走自己的 slot；宿主不伪造节点 focus。
  const documentFocus = presentation.mode.type === "document-workspace"
    ? { documentId: presentation.mode.documentId }
    : null;
  const focused = snapshotFocus !== null || documentFocus !== null || cameraEditing;
  // 显式重连入口交给两个状态气泡宿主（右下角工具栏与桌面横栏）。
  const slotProps = {
    revision,
    writable,
    sync,
    modalActive,
    onReconnect: () => { void canvasSession.reconnect(); }
  };

  // 通用聚焦工作区：唯一 owner 由 `cordis/focus` 解析语义裁决（Navigation preflight、Runtime
  // owner watcher 与 React 宿主共用同一语义）。宿主按通用 kind/contribution 处理，MUST NOT
  // import 具体 editor 或按业务类型分支（change: 2026-10-12-unify-node-editors-and-focus-transitions，
  // design D3/D4/D5）。聚焦期间隐藏普通画布邻居（工具栏/面板/提示/菜单）；是否保留 2D 媒体取景
  // 与通用 overlay 由 `FocusWorkspaceHost` 按贡献的 `exclusive` 与聚焦身份统一决定。
  const focusSlotProps = { ...slotProps, canvas: canvasState.getWorkingCanvas() ?? canvasState.getCanvas(), focus: snapshotFocus };
  const workspace = snapshotFocus ? resolveFocusWorkspace(slots, focusSlotProps) : undefined;
  // 聚焦侧栏：当前 route 是否为声明 `focusPresentation: "sidebar"` 的 panel（如 Agent 详情）。
  // 公共容器据此与工作区检查器互斥、共用唯一侧栏占位（design D6a）。
  const sidePanel = snapshotFocus && presentation.panel
    ? canvasNavigation.resolvePanel(presentation.panel.type)?.focusPresentation === "sidebar"
    : false;
  const contextMenu = !focused && presentation.menu
    ? <ContextMenuHost menu={presentation.menu} writable={writable} />
    : null;
  const overlays = (
    <>
      <CanvasOverlayHost {...slotProps} />
      {contextMenu}
    </>
  );

  return (
    <FocusWorkspace presentation={presentation} runtime={canvasRuntime} surfaceRef={surfaceRef} sidePanel={sidePanel}>
      {/* 单例 canvas 的容器：尺寸 owner。canvas 元素由 effect 命令式挂入。 */}
      <div ref={surfaceRef} className="bevy-canvas-surface" data-testid="bevy-canvas-surface" />
      {/* 主题 curtain：realm 确认首个 themed 画面已 render 前，用不透明主题底色盖住整个画布
          表面，避免新建 iframe/原生 surface 的默认浅色清屏在暗色切换时露白。 */}
      <div className="bevy-canvas-curtain" aria-hidden="true" data-testid="bevy-canvas-curtain" />
      <SceneExperienceBar key={canvasId} canvasId={canvasId} surfaceRef={surfaceRef} ready={ready} hidden={focused} />
      {/* 左侧资源轨：概览态才有位置，聚焦 / 文档工作区里由各自的工作区界面接管 */}
      <CanvasAssetRail hidden={focused} imageSource={imageSource} currentCanvasId={canvasId} />
      <CanvasTopBarHost {...slotProps} overview={presentation.mode.type === "overview" && !cameraEditing} />
      {diagnostic && ready ? <aside className="canvas-render-warnings" role="alert" aria-label="工作区提示">{diagnostic}</aside> : null}

      {!ready ? (
        <div className="status-overlay" role="status">
          {canvasError ? (
            <>
              <div className="status-title">画布加载失败</div>
              <pre className="status-detail">{sessionStatus.error}</pre>
              <Button onClick={() => void canvasSession.retry()}>重试加载</Button>
            </>
          ) : bootError ? (
            <>
              <div className="status-title">启动失败</div>
              <pre className="status-detail">{runtimeStatus.error}</pre>
            </>
          ) : (
            <div className="status-title">正在启动画布…</div>
          )}
        </div>
      ) : cameraEditing ? overlays : snapshotFocus ? (
        // 聚焦：渲染唯一匹配的通用工作区贡献（缺失/重复/校验失败时由宿主兜底诊断与受控返回）；
        // 普通画布邻居不呈现。工作区自带公共顶部栏，兜底不渲染顶部栏（design D5）。
        // 聚焦侧栏 panel（如 Agent 详情）与工作区检查器共用唯一侧栏容器（design D6a）。
        <>
          <FocusWorkspaceHost
            {...focusSlotProps}
            workspace={workspace}
            overlays={overlays}
            mediaOverlays={<CanvasOverlayHost {...slotProps} />}
          />
          <CanvasFocusSidePanelHost writable={writable} />
          <CanvasFocusNodeHistoryHost writable={writable} />
        </>
      ) : documentFocus ? (
        // 独立文档工作区（编辑扩展工作区）：
        // 唯一活动文档贡献自行呈现不透明背景与取景；底层节点媒体 overlay 与节点历史不呈现，
        // 因此不存在输入穿透、旧纹理覆盖或双主图。
        <DocumentWorkspaceHost {...slotProps} document={documentFocus} />
      ) : (
        <>
          <CanvasToolbarHost {...slotProps} />
          <CanvasPanelHost writable={writable} />
          {overlays}
          <NodeActionSettingsHost />
        </>
      )}

      <CanvasRenderWarnings runtime={canvasRuntime.runtime?.() ?? null} onRetry={() => {
        canvasRuntime.runtime()?.retryFailedModels?.();
        canvasRuntime.runtime()?.retryRuntimeIssues?.();
        // 资源恢复：请求失效，由下一帧以最新状态重建（design D2 错误恢复）。
        canvasRuntime.controller()?.invalidate("retry-failed-models");
      }} />
    </FocusWorkspace>
  );
}
