import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { IconButton } from "@woohaa3/ui/primitives";
import { CloseIcon, FitScreenIcon, MinusIcon, RefreshIcon, RestoreWindowIcon } from "@woohaa3/ui/icons";
import { controlWindow, desktopBootstrap, type WindowAction } from "./window-controls.js";
import "./canvas-window-controls.css";

/**
 * 桌面窗口横栏的右侧读数槽位：位于画布控件之后、窗口按钮之前。
 */
export type DesktopCanvasBarProps = {
  children?: ReactNode;
  /** `canvas.topbar-status` 读数分组（靠右，紧邻窗口按钮）。 */
  status?: ReactNode;
};

/** 画布拥有可见性：Tauri 桌面壳始终渲染窗口装饰。 */
export function DesktopCanvasBar({ children, status }: DesktopCanvasBarProps) {
  if (!desktopBootstrap(globalThis)) return null;
  return <WindowControls status={status}>{children}</WindowControls>;
}

function WindowControls({ children, status }: DesktopCanvasBarProps) {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const update = () => { void controlWindow("state").then((state) => {
      if (active) setMaximized(state.maximized);
    }).catch(() => undefined); };
    update();
    window.addEventListener("resize", update);
    return () => { active = false; window.removeEventListener("resize", update); };
  }, []);

  async function act(action: WindowAction) {
    setError("");
    // Dragging can last until mouse-up; do not disable the window buttons for it.
    if (action !== "drag") setBusy(true);
    try { setMaximized((await controlWindow(action)).maximized); }
    catch { setError("窗口操作失败，请重试"); }
    finally { setBusy(false); }
  }

  function drag(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("button, a, input, select, textarea, [data-no-window-drag]")) return;
    event.preventDefault();
    void act(event.detail === 2 ? "toggle-maximize" : "drag");
  }

  return (
    <header className="desktop-canvas-bar" onMouseDown={drag} onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      <span className="desktop-canvas-bar__brand">WooHaa3</span>
      <div className="desktop-canvas-bar__content">{children}</div>
      {status ? <div className="desktop-canvas-bar__trailing" data-no-window-drag>{status}</div> : null}
      <div className="desktop-canvas-bar__actions">
        <IconButton size="sm" label="刷新页面" title="刷新页面" onClick={() => window.location.reload()}>
          <RefreshIcon size={12} />
        </IconButton>
        <IconButton size="sm" label="最小化" title="最小化" disabled={busy} onClick={() => void act("minimize")}>
          <MinusIcon size={12} />
        </IconButton>
        <IconButton size="sm" label={maximized ? "还原窗口" : "最大化"} title={maximized ? "还原窗口" : "最大化"}
          disabled={busy} onClick={() => void act("toggle-maximize")}>
          {maximized ? <RestoreWindowIcon size={12} /> : <FitScreenIcon size={12} />}
        </IconButton>
        <IconButton size="sm" label="关闭窗口" title="关闭窗口" disabled={busy}
          className="desktop-canvas-bar__close" onClick={() => void act("close")}><CloseIcon size={12} /></IconButton>
      </div>
      {error ? <span className="desktop-canvas-bar__error">{error}</span> : null}
    </header>
  );
}
