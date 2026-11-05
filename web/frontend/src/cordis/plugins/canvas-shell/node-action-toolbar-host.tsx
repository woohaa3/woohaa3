import type { Context } from "@deepseek-ai/cordis";
import { nodeActionToolbarLayout, type BevyNodeActionsPresentation, type ScreenRect } from "@woohaa3/contracts";
import { BoxIcon, ChevronDownIcon, DownloadIcon, PenIcon } from "@woohaa3/ui/icons";
import { Fragment, useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { CanvasRuntimeService } from "../../contract/canvas-runtime.js";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { activateNodeAction, readNodeActionToolbars } from "./node-action-bridge.js";
import "./node-action-toolbar.css";

/** Uses the accepted runtime projection in CSS pixels; no second world camera or hit geometry. */
export function nodeActionToolbarScreenLayout(node: ScreenRect, canvas: ScreenRect, presentation: BevyNodeActionsPresentation) {
  return nodeActionToolbarLayout({
    node: { x: node.left, y: node.top, width: node.width, height: node.height },
    ...presentation,
    viewport: { x: -canvas.left, y: -canvas.top, zoom: 1 },
    surface: canvas
  });
}

export function NodeActionToolbarHost({ ctx }: { ctx: Context }) {
  const subscribe = useCallback((notify: () => void) => {
    const runtime = ctx.canvasRuntime;
    const off = [woohaa3CanvasStore.subscribe(notify), nodeSelectionStore.subscribe(notify),
      ctx.canvasNavigation.subscribe(notify), ctx.canvasSession.subscribe(notify), worldCameraEditorStore.subscribe(notify),
      ctx.slots.subscribe("canvas.node-action", notify), runtime.subscribe(notify),
      runtime.subscribeScene?.(notify), runtime.subscribeFrame?.(notify)];
    return () => off.forEach(dispose => dispose?.());
  }, [ctx]);
  // A value snapshot keeps frame notifications cheap and avoids React updates for unchanged descriptions.
  const snapshot = useSyncExternalStore(subscribe, () => JSON.stringify([...readNodeActionToolbars()]), () => "[]");
  const entries = JSON.parse(snapshot) as [string, BevyNodeActionsPresentation][];
  const entry = entries[0];
  return entry ? <NodeActionToolbar key={entry[0]} runtime={ctx.canvasRuntime} nodeId={entry[0]} presentation={entry[1]} /> : null;
}

export function NodeActionToolbar({ runtime, nodeId, presentation }: {
  runtime: CanvasRuntimeService; nodeId: string; presentation: BevyNodeActionsPresentation;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const canvas = document.getElementById("bevy-canvas");
    if (!element || !canvas) return;
    const layout = () => {
      const node = runtime.nodeScreenRect(nodeId, "action-toolbar");
      const next = node ? nodeActionToolbarScreenLayout(node, canvas.getBoundingClientRect(), presentation) : null;
      element.style.visibility = next ? "visible" : "hidden";
      if (!next) return;
      element.style.left = `${next.bar.x}px`;
      element.style.top = `${next.bar.y}px`;
    };
    const resize = new ResizeObserver(layout);
    resize.observe(canvas);
    const off = [runtime.subscribeViewport(layout), runtime.subscribeScene?.(layout), runtime.subscribeFrame?.(layout)];
    window.addEventListener("resize", layout);
    layout();
    return () => { resize.disconnect(); off.forEach(dispose => dispose?.()); window.removeEventListener("resize", layout); };
  }, [runtime, nodeId, presentation]);
  // Same fixed screen metrics as the previous toolbar, now with native DOM buttons and hover states.
  const layout = nodeActionToolbarLayout({ node: { x: 0, y: 0, width: 0, height: 0 }, ...presentation });
  if (!layout) return null;
  return <div ref={ref} className="node-action-toolbar" data-node-id={nodeId}
    style={{ visibility: "hidden", width: layout.bar.width, height: layout.bar.height }}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onWheel={event => event.stopPropagation()}>
    {layout.summary && <span className="node-action-toolbar__summary" title={presentation.summary}
      style={{ width: layout.summary.rect.width }}>{layout.summary.text}</span>}
    {presentation.actions.map((action, index) => <Fragment key={action.id}>
      {index > 0 && <span className="node-action-toolbar__separator" />}
      <button type="button" className={`node-action-toolbar__button${action.tone === "primary" ? " is-primary" : ""}`}
        title={action.label} disabled={!action.enabled} style={{ width: layout.actions[index]!.width }}
        onClick={() => activateNodeAction({ nodeId, actionId: action.id, menu: false })}>
        {action.icon && <ActionIcon icon={action.icon} />}
        {!action.iconOnly && action.label}
      </button>
      {action.menu && <button type="button" className="node-action-toolbar__button node-action-toolbar__menu"
        title={`${action.label}设置`} onClick={() => activateNodeAction({ nodeId, actionId: action.id, menu: true })}>
        <ChevronDownIcon size={14} />
      </button>}
    </Fragment>)}
  </div>;
}

function ActionIcon({ icon }: { icon: NonNullable<BevyNodeActionsPresentation["actions"][number]["icon"]> }) {
  if (icon === "download") return <DownloadIcon size={16} />;
  if (icon === "edit") return <PenIcon size={16} />;
  if (icon === "box") return <BoxIcon size={16} />;
  const paths: Record<string, string> = {
    "arrange-horizontal": "M5 3v18M12 3v18M19 3v18",
    "arrange-vertical": "M3 5h18M3 12h18M3 19h18",
    "arrange-grid": "M3 3h18v18H3zM3 12h18M12 3v18",
    "arrange-diagonal-down": "M2 2h5v5H2zM9.5 9.5h5v5h-5zM17 17h5v5h-5z",
    "arrange-diagonal-up": "M2 17h5v5H2zM9.5 9.5h5v5h-5zM17 2h5v5h-5z",
    "collapse-groups": "M4 3v18M20 3v18M12 4v12m-5-5 5 5 5-5",
    "expand-groups": "M4 3v18M20 3v18M12 20V8m-5 5 5-5 5 5"
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[icon]} /></svg>;
}
