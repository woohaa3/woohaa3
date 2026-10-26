/**
 * 应用根 React Host（change: adopt-frontend-cordis-plugin-runtime，design D4/D5/D8；
 *   change: unify-canvas-presentation-navigation，task 2.2 / design D1）。
 *
 * 两层 RuntimeProvider：
 * - AppRoot 提供 App scope（Router/Theme/Dialog/Slots）；
 * - PageHost 提供当前 page scope（Canvas 或 Task History）。
 *
 * 所有 `useService` 必须位于**对应 scope 的 RuntimeProvider 之内**：App 能力用 App runtime
 * 读取，页面能力（canvasRuntime/inputScopes/canvasNavigation…）用 page runtime 读取。
 */
import { Suspense, useSyncExternalStore } from "react";
import { lazy } from "react";
import { DialogHost } from "./services/dialogs/DialogHost.js";
import { ThemeProvider } from "./services/theme/index.js";
import { UiProvider } from "../shared/ui/UiProvider.js";
import { CanvasHost } from "./plugins/canvas-shell/canvas-host.js";
import { Button } from "../shared/ui/Button.js";
import { CanvasRecoveryPage } from "./canvas-recovery.js";
import { AppErrorBoundary } from "./app-error-boundary.js";
import { InputScopeHost } from "./input-scope-host.js";
import { RuntimeProvider, useRuntimeContext, useService, useRuntimeStatus } from "./react.js";
import { RouteHost } from "./host.js";
import { RuntimeDiagnosticsPanel } from "./diagnostics-panel.js";
import { HostConnectivityOverlay } from "./services/host-connectivity-overlay.js";
import { SafeModeBanner } from "./services/safe-mode-banner.js";
import type { FrontendRuntime } from "./kernel.js";
import type { AppRuntime, AppRuntimeSnapshot } from "./page-scope.js";
import type { AppPageId, AppPageLocation } from "./navigation/app-router.js";
import type { CanvasRecoveryService } from "./contract/canvas-catalog.js";

/**
 * 旧 ID 迁移准备态 chrome 只在真正展示准备页时加载（独立 chunk），不进入首屏 eager
 * 入口（change: 2026-10-12-add-extension-online-canvas-migration，任务 5.8）。
 */
const TaskMonitorRoute = lazy(() => import("../pages/task-monitor/route.js").then((module) => ({ default: module.TaskMonitorRoute })));

const CanvasPreparationPage = lazy(() =>
  import("./canvas-preparation.js").then((module) => ({ default: module.CanvasPreparationPage }))
);

/** 应用根：提供 App scope，并渲染当前 page scope 内容。 */
export function AppRoot({ app }: { app: AppRuntime }) {
  return (
    <RuntimeProvider runtime={app.app}>
      <AppContent app={app} />
    </RuntimeProvider>
  );
}

/** App scope 内容：Theme + Dialog stack + 当前页面。 */
function AppContent({ app }: { app: AppRuntime }) {
  // page 与 location 必须来自同一次原子快照读取：否则会用新 canvasId 渲染旧 scope。
  const { page, location, settingsError }: AppRuntimeSnapshot = useSyncExternalStore(
    app.subscribe,
    app.getSnapshot,
    app.getSnapshot
  );
  const theme = useService("theme");
  const dialogs = useService("dialogs");
  return (
    <ThemeProvider service={theme}>
      <UiProvider>
        {page && location ? (
          // 页面级兜底：任一页面子树 render 失败时显示可诊断错误与刷新入口，
          // 而不是卸载整个 React root 变成白屏。resetKey 用页面身份，切页后自动重试。
          <AppErrorBoundary resetKey={`${location.page}:${location.canvasId ?? ""}`}>
            <PageHost page={page} pageId={location.page} location={location} app={app} />
          </AppErrorBoundary>
        ) : null}
        <DialogHost dialogs={dialogs} />
        {/* 宿主重连遮罩 / 「扩展已更新」提示与安全模式提示条（change: 2026-10-21-harden-extension-fault-isolation）。 */}
        <HostConnectivityOverlay connectivity={app.hostConnectivity} />
        <SafeModeBanner connectivity={app.hostConnectivity} />
        {/* 旧 `/settings` 兼容打开失败：可识别错误 + 显式重试（不自动重试、不改页面）。 */}
        {settingsError ? (
          <div className="settings-intent-error" role="alert" data-testid="settings-intent-error">
            <span>设置没有打开：{settingsError}</span>
            <Button size="sm" onClick={() => void app.retrySettingsIntent()}>
              重试打开设置
            </Button>
          </div>
        ) : null}
        <RuntimeDiagnosticsPanel />
      </UiProvider>
    </ThemeProvider>
  );
}


/** 单页面 scope Host：页面能力（services/slots）由 page runtime 解析。 */
function PageHost({
  page,
  pageId,
  location,
  app
}: {
  page: FrontendRuntime;
  pageId: AppPageId;
  location: AppPageLocation;
  app: AppRuntime;
}) {
  return (
    <RuntimeProvider runtime={page}>
      <PageContent pageId={pageId} location={location} app={app} />
    </RuntimeProvider>
  );
}

function PageContent({
  pageId,
  location,
  app
}: {
  pageId: AppPageId;
  location: AppPageLocation;
  app: AppRuntime;
}) {
  const status = useRuntimeStatus();
  const slots = useService("slots");
  const ctx = useRuntimeContext();

  useSyncExternalStore(
    (listener) => slots.subscribe("app.route", listener),
    () => slots.version(),
    () => slots.version()
  );

  if (status.phase === "failed") {
    return (
      <div className="app app--failed" role="alert" data-testid="runtime-failed">
        <div className="status-overlay">
          <div className="status-title">启动失败</div>
          <pre className="status-detail">{status.error}</pre>
        </div>
        <RuntimeDiagnosticsPanel />
      </div>
    );
  }

  // 页面 identity 由 App Router 决定（单一权威），不再从浏览器 pathname 二次推断。
  // Canvas 页面没有 app.route contribution；设置是画布壳内的模态工作区（不注册 route）。
  // 历史页与遥测复盘页都由各自 page scope 的插件注册 app.route，这里只取当前 scope 的那一条
  // （change: 2026-10-20-add-local-client-telemetry，design D9）。
  const route = pageId === "task-history" || pageId === "telemetry" ? slots.list("app.route")[0] : undefined;
  const recovery = pageId === "canvas"
    ? (ctx as unknown as { canvasRecovery?: CanvasRecoveryService }).canvasRecovery
    : undefined;
  if (recovery) {
    return (
      <div className="app">
        <CanvasRecoveryPage
          recovery={recovery}
          navigate={(target) => app.router.navigate(target)}
        />
      </div>
    );
  }
  const preparationView = pageId === "canvas"
    ? (ctx as unknown as { canvasPreparationView?: { canvasId: string; jobId: string | null } }).canvasPreparationView
    : undefined;
  if (preparationView) {
    return (
      <div className="app">
        <Suspense fallback={<div className="app" data-testid="canvas-preparation-pending" />}>
          <CanvasPreparationPage view={preparationView} app={app} />
        </Suspense>
      </div>
    );
  }
  return (
    <div className="app">
      {pageId === "task-monitor" ? (
        <Suspense fallback={<div className="status-overlay">正在加载任务监控…</div>}>
          <TaskMonitorRoute />
        </Suspense>
      ) : route ? (
        <RouteHost path={route.path} navigate={(to) => app.router.navigatePath(to)} />
      ) : (
        <>
          <CanvasHost canvasId={location.canvasId ?? ""} />
          <InputScopeHost />
        </>
      )}
    </div>
  );
}
