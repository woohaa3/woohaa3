import { useSyncExternalStore } from "react";
import type { ScreenRect } from "@woohaa3/contracts";
import type { EditorReadiness } from "@woohaa3/frontend/plugin-api";
import "./node-editor-readiness.css";

type Props = {
  runtime: { subscribeViewport(listener: () => void): () => void; viewportVersion(): number; nodeScreenRect(id: string): ScreenRect | null };
  nodeIds: readonly string[];
  readiness: EditorReadiness;
  activeNodeId: string | null;
  onSelect(id: string | null): void;
  onManage(): void;
  onRetry(): void;
};

/** One status vocabulary for every image node; screen geometry remains owned by the renderer. */
export function NodeEditorReadiness({ runtime, nodeIds, readiness, activeNodeId, onSelect, onManage, onRetry }: Props) {
  useSyncExternalStore(runtime.subscribeViewport, runtime.viewportVersion, runtime.viewportVersion);
  if (!activeNodeId || readiness.phase === "ready") return null;
  return <div className="node-editor-readiness-layer">
    {nodeIds.map(id => {
      const rect = runtime.nodeScreenRect(id);
      if (!rect || rect.width < 48 || rect.height < 32 || rect.left + rect.width < 0 || rect.top + rect.height < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return null;
      const expanded = activeNodeId === id;
      return <div key={id} className="node-editor-readiness" data-readiness-node={id} data-phase={readiness.phase}
        style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - (expanded ? 296 : 180))), top: Math.max(8, Math.min(rect.top + rect.height - 30, window.innerHeight - (expanded ? 170 : 38))) }}>
        <button className="node-editor-readiness__badge" title={readiness.tip} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); onSelect(expanded ? null : id); }}>
          <span className="node-editor-readiness__mark" {...(readiness.phase === "loading" ? { "data-loading": true } : {})}>{readiness.phase === "loading" ? "" : "!"}</span>
          <span>{readiness.label}</span>
        </button>
        {expanded ? <div className="node-editor-readiness__tip" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
          <p>{readiness.tip}</p>
          <div className="node-editor-readiness__actions">
            {readiness.phase !== "loading" ? <button onClick={onManage}>{readiness.phase === "missing" ? "安装组件" : "组件设置"}</button> : null}
            {readiness.phase === "failed" ? <button onClick={onRetry}>重试</button> : null}
            <button className="node-editor-readiness__dismiss" onClick={() => onSelect(null)}>取消</button>
          </div>
        </div> : null}
      </div>;
    })}
  </div>;
}
