/**
 * 应用级生命周期 owner
 * （change: adopt-frontend-cordis-plugin-runtime，design D1/D2；
 *   change: unify-canvas-presentation-navigation，task 2.1 / design D1）。
 *
 * 启动 App scope（Router/Theme/Dialog/Slots）与当前页面 scope；路由切换由 App Runtime
 * 释放 outgoing scope 再挂载 incoming scope。`beforeunload`、测试 teardown 与 HMR dispose
 * 统一释放。React StrictMode 重放不得创建第二个 App runtime 或页面 scope。
 */
import { beginLifecycleSpan, measureLifecycle } from "./cordis/performance/lifecycle-performance.js";
import { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppRoot } from "./cordis/app-host.js";
import { startApp, type AppRuntime } from "./cordis/page-scope.js";
import "./index.css";
import { installPerformanceRecorder } from "./cordis/performance/record-performance.js";

const disposePerformanceRecorder = installPerformanceRecorder();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root 缺失");
}

let appRuntime: AppRuntime | null = null;
let unmount: (() => void) | null = null;
let startupController: AbortController | null = null;

function CommitMarker() {
  useLayoutEffect(() => { endReactCommit(); }, []);
  return null;
}
let endReactCommit: () => void = () => {};
async function boot(): Promise<void> {
  // 启动取消信号：teardown/HMR 在 `startApp` 返回前 abort 尚未完成的启动，
  // 避免迟到 root 覆盖较新的一次启动（design D8）。
  const controller = new AbortController();
  startupController = controller;
  const started = await measureLifecycle("app-start", () => startApp({ signal: controller.signal }));
  if (controller.signal.aborted) {
    await started.dispose();
    return;
  }
  appRuntime = started;
  endReactCommit = beginLifecycleSpan("react-commit");

  const root = createRoot(rootElement as HTMLElement);
  root.render(
    <StrictMode>
      <AppRoot app={appRuntime} />
      <CommitMarker />
    </StrictMode>
  );
  unmount = () => root.unmount();
}

void boot().catch((error: unknown) => {
  if (startupController?.signal.aborted) return;
  const message = error instanceof Error ? error.message : String(error);
  rootElement.innerHTML = "";
  const overlay = document.createElement("div");
  overlay.className = "status-overlay";
  overlay.setAttribute("role", "alert");
  overlay.innerHTML = `<div class="status-title">启动失败</div><pre class="status-detail"></pre>`;
  const detail = overlay.querySelector(".status-detail");
  if (detail) detail.textContent = message;
  rootElement.appendChild(overlay);
});

async function teardown(): Promise<void> {
  disposePerformanceRecorder();
  startupController?.abort();
  startupController = null;
  unmount?.();
  unmount = null;
  const current = appRuntime;
  appRuntime = null;
  await current?.dispose();
}

globalThis.addEventListener?.("beforeunload", () => {
  void teardown();
});

// Vite HMR：开发期替换 composition root 时释放页面级资源。
const hot = (import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot;
hot?.dispose(() => {
  void teardown();
});

/** 测试/排障：暴露应用运行时状态（生产无副作用）。 */
(globalThis as unknown as { __frontendApp?: () => unknown }).__frontendApp = () => appRuntime ?? null;
